import { deadline, delivery } from './actionability.js';
import { offsetOption, timingOption, pause } from './motion.js';

// Native mouse dispatch stays in protocol order without serial compositor acknowledgments.
export function createClick(cdp, value, { prepare, assertReady }) {
  const pending = new Map();
  function event(tabId, method, params, sessionId) {
    const operation = pending.get(tabId);
    if (operation && method === 'Page.javascriptDialogOpening') {
      operation.reject(Object.assign(new Error('The action opened a JavaScript dialog. It may already have executed; use browser_snapshot and browser_handle_dialog before continuing.'), { outcome_unknown: true }));
      return;
    }
    if (method !== 'Runtime.bindingCalled' || !operation || params.name !== operation.name || !operation.contexts.has(JSON.stringify([sessionId, params.executionContextId]))) return;
    try {
      const receipt = JSON.parse(params.payload);
      if (receipt.matched === true) operation.resolve();
      else operation.reject(Object.assign(new Error('Click target changed or became covered during mouse dispatch. Further incorrect target input was blocked; outcome is unknown. Observe again before retrying.'), {
        outcome_unknown: true, diagnostics: { reason: 'target_changed' },
      }));
    } catch (error) { operation.reject(error); }
  }
  function cancel(tabId) { pending.get(tabId)?.reject(Object.assign(new Error('Tab detached during click; outcome is unknown. Observe before retrying.'), { outcome_unknown: true })); }
  async function click(tabId, node, args) {
    const options = { ...clickOptions(args), hover: args.hover === true };
    const budget = args.budget || deadline(args.timeout_ms);
    const prepared = await prepare(tabId, node, { ...args, budget });
    const { target, point: rootPoint, hitTarget, relation, frameId, backendNodeId, boundaries } = prepared;
    if (!options.hover && hitTarget.native_select) throw new Error("Native select popup is unsupported. No input was dispatched. Use browser_select_option by label/value/index; press Esc if a native popup is already open.");
    const name = `__attachClick_${crypto.randomUUID().replaceAll('-', '')}`;
    const guards = [], contexts = new Set();
    let failure;
    const receipt = new Promise((resolve, reject) => pending.set(tabId, { name, contexts, resolve, reject(error) { failure = error; reject(error); } }));
    receipt.catch(() => {});
    try {
      const targets = [{ target, frameId: node?.frameId || frameId, backendNodeId: node?.backendNodeId || backendNodeId, leaf: true }, ...boundaries];
      for (const item of targets) {
        const sendTo = (method, params) => budget.run(() => cdp(item.target, method, params));
        const frame = item.frameId;
        const { executionContextId } = await sendTo('Page.createIsolatedWorld', { frameId: frame, worldName: 'browser-attach-input' });
        if (!executionContextId) throw new Error('Could not create an isolated click verification context; no input was dispatched.');
        contexts.add(JSON.stringify([item.target.sessionId, executionContextId]));
        await sendTo('Runtime.addBinding', { name, executionContextId });
        const isolated = await sendTo('DOM.resolveNode', { backendNodeId: item.backendNodeId, executionContextId, objectGroup: 'browser-attach' });
        const installed = await sendTo('Runtime.callFunctionOn', {
          objectId: isolated.object.objectId, functionDeclaration: installGuard.toString(),
          arguments: [{ value: name }, { value: options }, { value: budget.remaining() + 500 }, { value: item.leaf === true }], objectGroup: 'browser-attach',
        });
        if (installed.exceptionDetails) value(installed);
        if (!installed.result?.objectId) throw new Error('Could not install click target verification; no input was dispatched.');
        guards.push({ target: item.target, objectId: installed.result.objectId });
      }
      // Recheck the root page after target preparation: a user may have changed
      // tabs/focus while we resolved a frame or installed the event guards.
      await pause(budget, args.settle_ms);
      if (failure) throw failure;
      const pageState = await assertReady(tabId, budget, options.hover ? 'hover' : 'click', args);
      if (failure) throw failure;
      budget.dispatch();
      const dispatch = params => budget.run(() => cdp(tabId, 'Input.dispatchMouseEvent', { ...params, ...rootPoint }));
      const commands = [dispatch({ type: 'mouseMoved', button: 'none', buttons: 0, modifiers: options.modifiers })];
      for (let count = 1; !options.hover && count <= options.click_count; count++) {
        commands.push(dispatch({ type: 'mousePressed', button: options.button, buttons: options.buttons, clickCount: count, modifiers: options.modifiers }));
        commands.push(dispatch({ type: 'mouseReleased', button: options.button, buttons: 0, clickCount: count, modifiers: options.modifiers }));
      }
      await budget.run(() => delivery(Promise.all([Promise.all(commands), receipt])));
      const verification = { target_verified: node ? true : null, delivery_verified: true, events_trusted: true,
        target_verification: { basis: node ? 'element' : 'coordinate_hit', hit_relation: relation } };
      if (options.hover) return { hovered: rootPoint, hit_target: hitTarget, page_state: pageState, ...verification, application_result: 'not_checked', observe_again: true };
      return { clicked: rootPoint, ...verification, application_result: 'not_checked', frame_id: node?.frameId || frameId,
        ...(!node && !args.detailed ? { hit_target: compactHit(hitTarget) } : {}),
        ...(args.detailed ? { hit_target: hitTarget, page_state: pageState, coordinate_space: 'viewport_css_pixels', button: options.button, click_count: options.click_count } : {}), observe_again: true };
    } finally {
      pending.delete(tabId);
      // A page handler may have opened a modal. Renderer cleanup can finish after
      // it is dismissed, but must not keep the tab queue locked until then.
      const cleanup = guards.flatMap(({ target, objectId }) => [cdp(target, 'Runtime.removeBinding', { name }),
        cdp(target, 'Runtime.callFunctionOn', { objectId, functionDeclaration: 'function() { this.stop(); }' })]);
      let cleanupTimer;
      try { await Promise.race([Promise.allSettled(cleanup),
        new Promise(resolve => { cleanupTimer = setTimeout(resolve, 250); })]); }
      finally { clearTimeout(cleanupTimer); }
    }
  }
  return { click, event, cancel };
}

export function installGuard(name, options, expiryMs, verifyDelivery) {
  const target = this.nodeType === 3 ? this.parentElement : this;
  const win = target.ownerDocument.defaultView, report = win[name];
  let rejected = false, completed = 0;
  // Disabled controls can receive pointer movement even when mouse clicks are suppressed.
  const types = options.hover ? ['pointermove'] : ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'auxclick', 'contextmenu', 'dblclick'];
  const listeners = [];
  function listener(event, expected) {
    if (!event.isTrusted) return;
    const element = target.nodeType === 3 ? target.parentElement : target;
    const modifiers = (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
    const matched = (options.hover || event.button === options.domButton) && modifiers === options.modifiers && !rejected && target.isConnected && (options.hover || !element.matches(':disabled')) && !element.closest('[inert]') &&
      event.composedPath().some(node => node === expected);
    if (!matched) {
      rejected = true; event.preventDefault(); event.stopImmediatePropagation();
      report(JSON.stringify({ matched: false }));
    } else {
      const terminal = options.hover ? 'pointermove' : options.button === 'right' ? 'contextmenu' : options.button === 'middle' ? 'auxclick' : options.click_count === 2 ? 'dblclick' : 'click';
      if (verifyDelivery && event.type === terminal && expected === target) {
        completed++;
        if (options.button === 'left' || completed === options.click_count) report(JSON.stringify({ matched: true }));
      }
    }

  }
  let expiry;
  function stop() {
    clearTimeout(expiry);
    for (const [root, callback] of listeners) for (const type of types) root.removeEventListener(type, callback, true);
    delete win[name];
  }
  // Window listeners see a closed shadow host, not its internal target. Check
  // each boundary in its own root so closed components remain controllable.
  let expected = target;
  while (true) {
    const root = expected.getRootNode(), receiver = root.host ? root : win;
    const localTarget = expected, callback = event => listener(event, localTarget);
    listeners.push([receiver, callback]);
    for (const type of types) receiver.addEventListener(type, callback, { capture: true, passive: false });
    if (!root.host) break;
    expected = root.host;
  }
  expiry = win.setTimeout(stop, expiryMs);
  return { stop };
}

function compactHit(hit) {
  const identity = ({ tag, id, role, text }) => ({ tag, id: id?.slice(0, 200) ?? null, role: role?.slice(0, 200) ?? null,
    text: text?.slice(0, 120), ...(text?.length > 120 ? { text_truncated: true } : {}) });
  return { ...identity(hit), disabled: hit.disabled, clickable_hint: hit.clickable_hint,
    clickable_target: hit.clickable_target ? identity(hit.clickable_target) : null };
}

export function clickOptions(args) {
  if (args.detailed != null && typeof args.detailed !== 'boolean') throw new Error('detailed must be boolean');
  offsetOption(args);
  if (args.settle_ms != null) {
    timingOption(args.settle_ms, 'settle_ms');
    if (args.mode === 'dom') throw new Error('settle_ms requires native pointer input');
  }
  const button = args.button ?? 'left', click_count = args.click_count ?? 1, modifiers = args.modifiers ?? [];
  const buttons = { left: [1, 0], middle: [4, 1], right: [2, 2] }, masks = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
  if (!Object.hasOwn(buttons, button)) throw new Error('button must be left, middle or right');
  if (![1, 2].includes(click_count)) throw new Error('click_count must be 1 or 2');
  if (!Array.isArray(modifiers) || modifiers.some(key => !Object.hasOwn(masks, key))) throw new Error('modifiers must contain Alt, Control, Meta or Shift');
  if (args.mode === 'dom' && (button !== 'left' || click_count !== 1 || modifiers.length)) throw new Error('DOM click supports only left single click without modifiers');
  return { button, click_count, modifiers: modifiers.reduce((mask, key) => mask | masks[key], 0), buttons: buttons[button][0], domButton: buttons[button][1] };
}
