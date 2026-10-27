// Browser operations live here; the WebSocket transport never exposes raw CDP.
import { createVisuals } from './visuals.js';
import { createClickVisuals } from './click-visuals.js';
import { createObservations, retryObservation } from './observation.js';
import { createNavigation } from './navigation.js';
import { createClick, clickOptions } from './click.js';
import { createPointer } from './pointer.js';
import { createInput, inputMode, fillOptions, selectOptions, typeOptions } from './input.js';
import { createEvaluations } from './evaluate.js';
import { targetOptions, resolveSelector, resolveFrame } from './locator.js';
import { readText } from './text.js';
import { createDiagnostics } from './diagnostics.js';
import { createNetworkTracker } from './network.js';
import { createSessions } from './sessions.js';
import { NAVIGATION_OBSERVATION_TIMEOUT_MS } from './limits.js';
import { deadline } from './actionability.js';
import { scrollOptions, createScrolling } from './scroll.js';
import { validateSteps } from './batch.js';
import { waitFor } from './wait.js';
import { boundedRead, createOutcomes } from './outcomes.js';
import { createDialogs } from './dialogs.js';
import { createDrag, dragOptions } from './drag.js';
import { createFetches } from './fetch.js';
import { createFetchPages } from './fetch-page.js';
import { errorData } from './errors.js';
import { pageUrl, httpUrl } from './page-url.js';
import { createScreenshots } from './screenshot.js';
import { createUploads } from './upload.js';

export function createController(api, notify = () => {}) {
  const claims = new Map();
  const queues = new Map();
  const dialogs = createDialogs((...args) => api.debugger.sendCommand(...args),
    (tabId, error) => navigation.cancel(tabId, error), (tabId, cause) => observations.invalidate(tabId, cause), tabId => claims.has(tabId));
  const visuals = createVisuals(api);
  const clickVisuals = createClickVisuals(api);
  const navigation = createNavigation(cdp, controlUrl);
  const network = createNetworkTracker();
  const diagnostics = createDiagnostics(cdp);
  const sessions = createSessions(cdp, (tabId, frameId) => observations.invalidateFrame(tabId, frameId), (tabId, sessionId) => {
    diagnostics.detach(tabId, sessionId);
    network.detach(tabId, sessionId);
    observations.detachSession(tabId, sessionId);
  }, tabId => diagnostics.networkOptions(tabId));
  const pointer = createPointer(cdp, value, viewport, position, sessions, tabId => api.tabs.get(tabId), windowId => api.windows.get(windowId));
  const mouse = createClick(cdp, value, pointer);
  const gestures = createDrag(cdp, value, pointer, viewport);
  const input = createInput(cdp, value, sessions);
  const evaluations = createEvaluations(cdp);
  const uploads = createUploads(cdp, value);
  const observations = createObservations(cdp, value, sessions, viewport, tabId => claims.get(tabId), (tabId, affected) => {
    if (affected) {
      for (const frameId of affected) evaluations.forgetFrame(tabId, frameId);
      uploads.forgetFrames(tabId, affected);
    } else { evaluations.forget(tabId); uploads.forget(tabId); }
  });
  const outcomes = createOutcomes(cdp, value, sessions, observations, tabId => api.tabs.get(tabId), tabId => dialogs.get(tabId));
  const fetchPages = createFetchPages(api, cdp, value, navigation, network, sessions, pointer, observations, { queued, attach, currentClaim: tabId => claims.get(tabId), forget });
  const fetches = createFetches(fetchPages.read);
  const scrolling = createScrolling(cdp, value, sessions, pointer, viewport, position, observations, tabId => claims.get(tabId));
  const screenshots = createScreenshots(cdp, value, viewport, sessions, clickVisuals, resolveNode);

  function resolveNode(tabId, args, budget) {
    return args.selector ? resolveSelector(cdp, value, sessions, tabId, args, budget) : observations.resolve(tabId, args.ref, budget);
  }

  function queued(tabId, operation) {
    const result = (queues.get(tabId) || Promise.resolve()).catch(() => {}).then(operation);
    queues.set(tabId, result);
    const done = () => { if (queues.get(tabId) === result) queues.delete(tabId); };
    result.then(done, done);
    return result;
  }

  async function controlUrl(url) {
    const normalized = pageUrl(url);
    if (normalized.startsWith('file:') && !await api.extension.isAllowedFileSchemeAccess()) {
      throw new Error('Local file access is disabled. Enable "Allow access to file URLs" in the BrowserAttach extension settings in Chrome/Edge.');
    }
    return normalized;
  }

  function cdp(target, method, params = {}) { return dialogs.send(target, method, params); }

  function value(result) {
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  }

  async function viewport(tabId) {
    return value(await cdp(tabId, 'Runtime.evaluate', {
      expression: '({width: innerWidth, height: innerHeight, scroll_x: scrollX, scroll_y: scrollY, device_pixel_ratio: devicePixelRatio})', returnByValue: true,
    }));
  }

  function position(view, x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= view.width || y >= view.height) {
      throw new Error(`Position must be inside the viewport (${view.width} x ${view.height} CSS pixels)`);
    }
    return { x, y };
  }

  async function release(tabId) {
    if (!claims.has(tabId)) return;
    // Forget only after detach; a failed detach must not silently grant another owner.
    try { await clickVisuals.remove(tabId, dialogs.has(tabId)); await visuals.remove(tabId); }
    finally { await api.debugger.detach({ tabId }); }
    claims.delete(tabId);
    evaluations.forget(tabId);
    observations.forget(tabId);
    dialogs.forget(tabId);
    uploads.forget(tabId);
    diagnostics.forget(tabId);
    network.forget(tabId);
    sessions.forget(tabId);
    notify({ type: 'detached', tab_id: tabId });
  }

  async function releaseMatching(predicate) {
    const targets = new Map([...claims, ...fetchPages.entries()].filter(([, claim]) => predicate(claim)));
    const outcomes = await Promise.allSettled([...targets].map(([tabId]) => queued(tabId, () => fetchPages.has(tabId) ? fetchPages.close(tabId) : release(tabId))));
    return { released: outcomes.filter(item => item.status === 'fulfilled').length,
      errors: outcomes.filter(item => item.status === 'rejected').map(item => String(item.reason)) };
  }

  function forget(tabId) {
    evaluations.forget(tabId);
    navigation.cancel(tabId);
    mouse.cancel(tabId);
    gestures.cancel(tabId);
    input.cancel(tabId);
    visuals.forget(tabId);
    clickVisuals.forget(tabId);
    claims.delete(tabId);
    observations.forget(tabId);
    dialogs.forget(tabId);
    uploads.forget(tabId);
    diagnostics.forget(tabId);
    network.forget(tabId);
    sessions.forget(tabId);
    notify({ type: 'detached', tab_id: tabId });
  }
  api.debugger.onDetach.addListener(source => { if (!source.sessionId) forget(source.tabId); });
  api.debugger.onEvent.addListener((source, method, params = {}) => {
    sessions.event(source, method, params);
    observations.contextEvent(source, method, params);
    if (!sessions.has(source)) return;
    const tracked = network.event(source, method, params);
    diagnostics.event(source, method, params, tracked);
    if (!source.sessionId) navigation.event(source.tabId, method, params);
    const autoDialog = method === 'Page.javascriptDialogOpening' && dialogs.willHandle(source.tabId);
    if (!autoDialog) {
      mouse.event(source.tabId, method, params, source.sessionId);
      gestures.event(source.tabId, method, params, source.sessionId);
      input.event(source.tabId, method, params, source.sessionId);
    }
    const mainNavigation = !source.sessionId && method === 'Page.frameNavigated' && params.frame && !params.frame.parentId;
    fetchPages.event(source, method, params);
    observations.event(source, method, params);
    if (method === 'Page.fileChooserOpened' && claims.has(source.tabId)) uploads.opened(source.tabId, params, source.sessionId);
    if (mainNavigation) clickVisuals.navigated(source.tabId);
    dialogs.event(source, method, params);
  });
  api.tabs.onRemoved.addListener(tabId => { fetchPages.removed(tabId); forget(tabId); });
  api.tabs.onUpdated.addListener((tabId, change) => {
    // A subframe reload can also set the TAB status to loading. CDP main-frame
    // events identify document changes; a status-only update carries no identity.
    if (change.url) {
      observations.documentChanged(tabId, 'tab_url_changed');
    }
  });

  async function action(tabId, command, args) {
    // Reading buffered diagnostics does not require a responsive renderer.
    if (command === 'logs') return await diagnostics.readDetails(tabId, args, sessions.targets(tabId));
    if (command === 'handle_dialog') return await dialogs.handle(tabId, args);
    if (dialogs.has(tabId)) {
      if (command === 'snapshot') return { dialog: dialogs.get(tabId), note: 'Use browser_handle_dialog to accept or dismiss this dialog.' };
      if (command !== 'release_tab') throw new Error('A JavaScript dialog is open. Observe browser_snapshot and use browser_handle_dialog.');
    }
    if (command === 'snapshot') return await observations.snapshot(tabId, args);
    if (command === 'batch') {
      validateSteps(args.steps, args.start_at ?? 0);
      const budget = deadline(args.timeout_ms ?? 15000), results = [];
      const claim = claims.get(tabId), documentVersion = observations.version(tabId);
      for (let index = args.start_at ?? 0; index < args.steps.length; index++) {
        const step = args.steps[index];
        try {
          if (claims.get(tabId) !== claim) throw new Error('Tab control ended during batch; observe before continuing');
          if (observations.version(tabId) !== documentVersion) throw new Error('Document changed during batch; observe before continuing');
          await budget.run(async () => controlUrl((await api.tabs.get(tabId)).url));
          const { action: command, ...inputArgs } = step;
          const stepBudget = budget.child(step.timeout_ms ?? 30000, command === 'wait' ? 'wait' : 'input');
          results.push(await perform(tabId, command, { ...inputArgs, dialog_policy: step.dialog_policy ?? args.dialog_policy ?? 'ask', budget: stepBudget }));
        } catch (error) {
          return { completed: false, results, started_at: args.start_at ?? 0, failed_step: index, next_unattempted_step: index + 1 < args.steps.length ? index + 1 : null, retry_failed_step_safe: error.input_dispatched === false, ...errorData(error),
            application_result: 'not_checked', observe_again: true };
        }
      }
      return { completed: true, results, application_result: 'not_checked', observe_again: true };
    }
    if (command === 'evaluate') {
      await args.observe_start?.();
      if (args.result_type != null && !['json', 'element'].includes(args.result_type)) throw new Error('result_type must be json or element');
      if (args.cursor == null) observations.expireCursor(tabId);
      if (args.cursor != null) return await evaluations.read(tabId, args);
      const budget = args.budget || deadline(args.timeout_ms ?? 10000, 'evaluation'), version = observations.version(tabId), claim = claims.get(tabId);
      const frameId = await resolveFrame(cdp, value, sessions, tabId, args, budget), target = sessions.target(tabId, frameId);
      const contextId = args.frame || args.frame_id ? observations.context(tabId, target.sessionId, frameId) : undefined;
      if ((args.frame || args.frame_id) && contextId == null) throw new Error('Page frame context is unavailable; observe again');
      let result;
      try { result = await budget.run(() => { budget.dispatch(); return evaluations.read(tabId, { ...args, evaluation_frame: frameId, target, context_id: contextId, timeout_ms: Math.max(100, Math.min(args.timeout_ms ?? 10000, budget.remaining())) }); }); }
      catch (error) { evaluations.forget(tabId); if (args.result_type === 'element') await boundedRead(() => cdp(target, 'Runtime.releaseObjectGroup', { objectGroup: 'browser-attach-evaluation' }), 100).catch(() => {}); throw error; }
      if (!result.element) return { ...result, frame_id: frameId, scope: args.frame || args.frame_id ? 'frame' : 'main_frame' };
      try {
      if (observations.version(tabId) !== version || claims.get(tabId) !== claim) throw new Error('Document or claim changed during evaluation; no element ref was created');
      const owner = value(await budget.run(() => cdp(target, 'Runtime.callFunctionOn', { objectId: result.element.objectId,
        functionDeclaration: 'function() { return this.nodeType === 1 && this.isConnected && this.ownerDocument === document; }', returnByValue: true })));
      if (!owner) throw new Error('Element must belong to the selected frame; use a frame locator');
      return { result_type: 'element', ...await observations.rememberElement(tabId, target, result.element.objectId, frameId, budget), observe_again: true };
      } finally { await boundedRead(() => cdp(target, 'Runtime.releaseObjectGroup', { objectGroup: 'browser-attach-evaluation' }), 100).catch(() => {}); }
    }
    if (command === 'wait') return await waitFor(cdp, value, sessions, network, pointer, tabId, args);
    if (command === 'drag') {
      dragOptions(args);
      args = { ...args, budget: deadline(args.timeout_ms ?? 5000) };
      await pointer.assertReady(tabId, args.budget, 'drag');
      await args.observe_start?.();
      const claim = claims.get(tabId), documentVersion = observations.version(tabId);
      for (const target of sessions.targets(tabId)) await args.budget.run(() => cdp(target, 'Runtime.releaseObjectGroup', { objectGroup: 'browser-attach' }));
      observations.expireCursor(tabId);
      return await gestures.drag(tabId, args, (target, budget) => target.selector ? resolveSelector(cdp, value, sessions, tabId, target, budget) : target.ref ? observations.resolve(tabId, target.ref, budget) : null, () => {
        if (claims.get(tabId) !== claim || observations.version(tabId) !== documentVersion) throw Object.assign(new Error('Tab control or document changed during drag; outcome is unknown. Observe before continuing.'), { outcome_unknown: true });
      });
    }
    if (command === 'read_text') {
      if (args.selector_type === 'role') {
        const budget = deadline(5000), node = await resolveSelector(cdp, value, sessions, tabId, args, budget);
        try { return { ...await budget.run(() => readText(cdp, value, node.target, { ...args, node })), scope: args.frame || args.frame_id ? 'frame' : 'main_frame', frame_id: node.frameId }; }
        finally { await boundedRead(() => cdp(node.target, 'Runtime.releaseObjectGroup', { objectGroup: 'browser-attach' }), 100).catch(() => {}); }
      }
      if (!args.frame && !args.frame_id) return await readText(cdp, value, tabId, args);
      const budget = deadline(5000), frameId = await resolveFrame(cdp, value, sessions, tabId, args, budget), target = sessions.target(tabId, frameId);
      const contextId = observations.context(tabId, target.sessionId, frameId);
      if (contextId == null) throw new Error('Page frame context is unavailable; observe again');
      return { ...await readText(cdp, value, target, { ...args, context_id: contextId }), scope: 'frame', frame_id: frameId };
    }
    if (command === 'screenshot') return await screenshots.capture(tabId, args);
    if (command === 'release_tab') { await release(tabId); return { released: true }; }
    if (command === 'navigate') {
      await args.observe_start?.();
      const url = args.direction != null ? undefined : args.url;
      if (args.direction != null && args.url != null) throw new Error('Provide url or direction, never both');
      evaluations.forget(tabId);
      observations.invalidate(tabId, 'navigation_requested');
      uploads.forget(tabId);
      const { document: navigationDocument, ...result } = await navigation.navigate(tabId, url, args);
      const budget = deadline(NAVIGATION_OBSERVATION_TIMEOUT_MS, 'observation');
      try {
        if (args.include_snapshot === false) {
          const metadata = await retryObservation(async () => value(await budget.run(() => cdp(tabId, 'Runtime.evaluate', {
            expression: '({title: document.title, url: location.href})', returnByValue: true,
          }))), budget);
          return { ...result, ...metadata };
        }
        return { ...result, ...await observations.snapshot(tabId, {}, budget) };
      } catch (error) {
        observations.invalidate(tabId, 'observation_failed');
        return { ...result, observation_error: error.message, observe_again: true };
      }
    }
    // Re-resolve backend identity for every action; document/frame events expire refs.
    if (command === 'click') inputMode(args);
    if (command === 'fill') fillOptions(args);
    if (command === 'select_option') selectOptions(args);
    if (command === 'type') typeOptions(args);
    if (command === 'scroll') scrollOptions(args);
    if (['scroll', 'upload_file'].includes(command) && ['ref', 'selector', 'frame', 'frame_id', 'selector_type', 'name', 'nth'].some(key => args[key] != null)) targetOptions(args);
    if (['click', 'fill', 'type', 'hover', 'select_option'].includes(command)) targetOptions(args, { coordinates: command === 'hover' || command === 'click' && inputMode(args) !== 'dom', focused: command === 'type' });
    if (command === 'click') clickOptions(args);
    if (['click', 'fill', 'type', 'press_key', 'scroll', 'hover', 'select_option', 'upload_file'].includes(command)) args = { ...args, budget: args.budget || deadline(args.timeout_ms) };
    // Reject unavailable input before renderer preparation or ref invalidation;
    // a lost receipt after dispatch must instead report an unknown outcome.
    if (command === 'hover' || command === 'click' && inputMode(args) === 'native') await pointer.assertReady(tabId, args.budget, command, args);
    await args.observe_start?.();
    // Reusable selectors permit many actions without a snapshot. Release the
    // previous operation's remote wrappers before resolving this one. Refs store
    // backend ids, not object handles; this cannot change their identity.
    if (args.budget) for (const target of sessions.targets(tabId)) {
      await args.budget.run(() => cdp(target, 'Runtime.releaseObjectGroup', { objectGroup: 'browser-attach' }));
    }
    const node = args.selector ? await resolveSelector(cdp, value, sessions, tabId, args, args.budget || deadline(30000)) :
      args.ref ? await observations.resolve(tabId, args.ref, args.budget || deadline(30000)) : null;
    observations.expireCursor(tabId);
    if (command === 'upload_file') return await uploads.upload(tabId, node, args);
    if (command === 'click') {
      if (inputMode(args) === 'dom') return await input.domClick(tabId, node, args);
      const result = await mouse.click(tabId, node, args);
      // Keep click feedback out of the input dispatch/verification path.
      void clickVisuals.click(tabId, result.clicked.x, result.clicked.y).catch(() => {});
      return result;
    }
    if (command === 'hover') return await mouse.click(tabId, node, { ...args, hover: true });
    if (command === 'select_option') return await input.selectOption(tabId, node, args);
    if (command === 'type') return await input.typeText(tabId, node, args);
    if (command === 'fill') return await input.fill(tabId, node, args);
    if (command === 'press_key') return await input.pressKey(tabId, args.key, args);
    if (command === 'scroll') return await scrolling.scroll(tabId, node, args);
    throw new Error(`Unknown operation: ${command}`);
  }

  async function perform(tabId, command, args) {
    if (!args.budget && (['click', 'fill', 'type', 'press_key', 'hover', 'scroll', 'select_option', 'upload_file'].includes(command) || command === 'evaluate' && args.cursor == null)) {
      args = { ...args, budget: deadline(args.timeout_ms ?? (command === 'evaluate' ? 10000 : 5000), command === 'evaluate' ? 'evaluation' : 'input') };
    }
    const state = dialogs.enter(tabId, args.dialog_policy);
    let outcome;
    try {
      outcome = await outcomes.begin(tabId, command, args);
      const result = await action(tabId, command, { ...args, observe_start: outcome.start });
      await dialogs.settle(state);
      return { ...result, ...(state.messages.length ? { dialogs: state.messages } : {}) };
    } catch (error) {
      if (error.input_dispatched == null && args.budget?.has_dispatched) error.input_dispatched = args.budget.has_dispatched();
      await dialogs.settle(state).catch(() => {});
      if (state.messages.some(d => d.type === 'beforeunload' && d.accepted === false && d.handled) && /ERR_ABORTED|cancel/i.test(error.message)) return { navigated: false, cancelled_by_dialog: true, dialogs: state.messages, observe_again: true };
      if (!await outcome?.enrich(error, state.messages) && state.messages.length) error.message += ` Dialogs: ${JSON.stringify(state.messages)}`;
      throw error;
    } finally {
      dialogs.exit(tabId, state);
      await outcome?.stop();
    }
  }

  async function attach(tabId, owner, args, tab, budget) {
    const run = operation => budget ? budget.run(operation) : operation();
    const claim = claims.get(tabId) ?? { owner, handle: args.tab_handle };
    if (claim.owner !== owner || claim.handle !== args.tab_handle) throw new Error('Tab is already controlled by another session');
    claims.set(tabId, claim);
    let attached = false;
    try {
      await run(() => api.debugger.attach({ tabId }, '1.3'));
      attached = true;
      if (claims.get(tabId) !== claim) throw new Error('Tab detached during claim');
      network.start(tabId);
      diagnostics.start(tabId);
      await run(() => sessions.start(tabId));
      const { frameTree } = await run(() => cdp(tabId, 'Page.getFrameTree'));
      if (claims.get(tabId) !== claim) throw new Error('Tab detached during claim');
      observations.initialize(tabId, frameTree);
      let visualWarning;
      try { if (!fetchPages.has(tabId)) await visuals.install(tabId); }
      catch (error) { visualWarning = error.message; }
      if (claims.get(tabId) !== claim) throw new Error('Tab detached during claim');
      return { claimed: true, activation_requested: false, title: tab.title, url: tab.url,
        ...(visualWarning ? { visual_warning: visualWarning } : {}) };
    } catch (error) {
      if (attached && claims.get(tabId) === claim && !fetchPages.has(tabId)) {
        try { await release(tabId); }
        catch (cleanup) {
          error.message += `; claim cleanup failed: ${cleanup.message}`;
          if (claims.get(tabId) === claim) error.diagnostics = { ...error.diagnostics, control_retained: true };
          throw error;
        }
      } else if (claims.get(tabId) === claim && !fetchPages.has(tabId)) forget(tabId);
      throw error;
    }
  }

  async function execute(owner, command, args) {
    if (command === 'fetch') return await fetches.fetch(owner, args);
    if (command === 'open_tab') {
      const url = httpUrl(args.url);
      if (args.active != null && typeof args.active !== 'boolean') throw new Error('active must be a boolean');
      const tab = await api.tabs.create({ url, active: args.active ?? false });
      return { opened: true, tab_id: tab.id, window_id: tab.windowId, active: tab.active };
    }
    if (command === 'list_tabs') {
      const tabs = (await api.tabs.query({})).filter(tab => !fetchPages.has(tab.id));
      const fileAccess = tabs.some(tab => tab.url?.startsWith('file:')) && await api.extension.isAllowedFileSchemeAccess();
      const controllable = url => {
        try { return !pageUrl(url).startsWith('file:') || fileAccess; }
        catch { return false; }
      };
      return { tabs: tabs.map(tab => ({ tab_id: tab.id, window_id: tab.windowId, title: tab.title || '', url: tab.url || '',
        active: tab.active, group_id: tab.groupId, controllable: controllable(tab.url) })) };
    }
    if (command === 'release_owner') { fetches.forget(owner); return await releaseMatching(claim => claim.owner === owner); }
    const tabId = args.tab_id;
    if (!Number.isInteger(tabId)) throw new Error('Invalid tab ID');
    return await queued(tabId, async () => {
      if (command === 'claim_tab') {
        if (fetchPages.has(tabId)) throw new Error('Tab is already controlled by a fetch operation');
        const existing = claims.get(tabId);
        if (existing && (existing.owner !== owner || existing.handle !== args.tab_handle)) throw new Error('Tab is already controlled by another session');
        const claim = existing ?? { owner, handle: args.tab_handle };
        claims.set(tabId, claim);
        try {
          const budget = args.wait_for_page ? deadline(15000, 'claim') : null;
          let tab = await (budget ? budget.run(() => api.tabs.get(tabId)) : api.tabs.get(tabId));
          if (args.wait_for_page) {
            // tabs.create may resolve before the initial URL has committed. Never navigate again.
            while (!tab.url || tab.url === 'about:blank') {
              if (claims.get(tabId) !== claim) throw new Error('Tab detached during claim');
              await budget.run(() => new Promise(resolve => setTimeout(resolve, 50)));
              tab = await budget.run(() => api.tabs.get(tabId));
            }
          }
          if ((args.expected_url != null && tab.url !== args.expected_url) || (args.expected_title != null && tab.title !== args.expected_title)) throw new Error('Tab title/URL changed. List tabs again or omit optional identity guards to claim by tab_id.');
          await controlUrl(tab.url);
          if (claims.get(tabId) !== claim) throw new Error('Tab detached during claim');
          if (existing) return { claimed: true };
          return await attach(tabId, owner, args, tab);
        } catch (error) {
          if (!existing && claims.get(tabId) === claim && !error.diagnostics?.control_retained) forget(tabId);
          throw error;
        }
      }
      const claim = claims.get(tabId);
      if (!claim || claim.owner !== owner || claim.handle !== args.tab_handle) throw new Error('Tab is not claimed by this connection');
      if (command === 'activate_tab') {
        if (args.focus_window != null && typeof args.focus_window !== 'boolean') throw new Error('focus_window must be a boolean');
        const tab = await api.tabs.update(tabId, { active: true });
        if (args.focus_window ?? true) {
          await api.windows.update(tab.windowId, { focused: true });
          // Explicit activation also restores the renderer focus, which can be
          // lost when a focused iframe navigates even if its tab stays active.
          await cdp(tabId, 'Page.bringToFront');
        }
        return { activated: true, window_focus_requested: args.focus_window ?? true, tab_id: tabId, window_id: tab.windowId };
      }
      if (command === 'close_tab') {
        await api.tabs.remove(tabId);
        if (claims.has(tabId)) forget(tabId);
        return { closed: true, tab_id: tabId };
      }
      if (command === 'release_tab') return await action(tabId, command, args);
      await controlUrl((await api.tabs.get(tabId)).url);
      const result = await perform(tabId, command, args);
      // A batch can stop because its tab closed. Preserve the partial results
      // instead of losing them to a metadata lookup on the vanished tab.
      if (command === 'batch') return { ...result, tab_id: tabId };
      const tab = await api.tabs.get(tabId);
      const chooser = uploads.pending(tabId);
      return { ...result, ...(chooser ? { file_chooser: { pending: true, mode: chooser.mode, frame_id: chooser.frame_id,
        note: 'Use browser_upload_file without ref; files: [] cancels the selection.' } } : {}),
        tab_id: tabId, title: result.title ?? tab.title, url: result.url ?? tab.url, active: tab.active };
    });
  }

  return { execute, releaseAll: () => { fetches.clear(); return releaseMatching(() => true); }, claimedCount: () => claims.size };
}
