import { deadline, inspectTarget } from './actionability.js';
import { queryElement, targetOptions, resolveSelector, resolveFrame, matchRole, matchingRoles } from './locator.js';
import { checkedValue } from './errors.js';
import { boundedRead } from './outcomes.js';

export const WAIT_CONDITIONS = ['attached', 'absent', 'visible', 'actionable', 'text', 'value', 'checked', 'selected', 'expanded', 'url', 'network_idle'];
export const VERIFY_CONDITIONS = [...WAIT_CONDITIONS, 'count', 'value_present'];
export const MAX_WAIT_CHECKS = 30;
const locatorFields = ['selector', 'selector_type', 'name', 'frame_id', 'frame', 'nth'];
const checkFields = [...locatorFields, 'condition', 'expected', 'previous', 'idle_ms', 'not'];

export function waitOptions(args) {
  if (args.checks != null) {
    if (!Array.isArray(args.checks) || args.checks.length < 1 || args.checks.length > MAX_WAIT_CHECKS) throw new Error(`checks must contain 1..${MAX_WAIT_CHECKS} checks`);
    if ([...checkFields, 'ref'].some(key => args[key] != null)) throw new Error('checks is exclusive with single-condition and locator fields');
    if (args.dialog_policy != null && args.dialog_policy !== 'ask') throw new Error('Verification requires dialog_policy=ask; it never handles dialogs');
    for (const check of args.checks) {
      if (!check || typeof check !== 'object' || Array.isArray(check) || Object.keys(check).some(key => !checkFields.includes(key))) throw new Error('Invalid verification check fields');
      if (!VERIFY_CONDITIONS.includes(check.condition)) throw new Error('Unknown verification condition');
      if (check.not != null && typeof check.not !== 'boolean') throw new Error('not must be boolean');
      if (['count', 'value_present'].includes(check.condition)) {
        if (!check.selector) throw new Error(`${check.condition} requires a reusable selector`);
        targetOptions(check);
        if (check.previous != null || check.idle_ms != null) throw new Error('previous/idle_ms are not used by this condition');
        if (check.condition === 'count' && (!Number.isSafeInteger(check.expected) || check.expected < 0 || check.nth != null)) throw new Error('count requires a nonnegative safe integer expected and forbids nth');
        if (check.condition === 'value_present' && typeof check.expected !== 'boolean') throw new Error('value_present requires expected=true/false; whitespace is nonempty');
      } else {
        if (check.condition !== 'network_idle' && check.idle_ms != null) throw new Error('idle_ms is only valid for network_idle checks');
        waitOptions(check);
      }
    }
    return;
  }
  if (!WAIT_CONDITIONS.includes(args.condition)) throw new Error('Unknown wait condition');
  const element = !['url', 'network_idle'].includes(args.condition);
  if (element) {
    if (!args.selector || args.ref != null) throw new Error(`${args.condition} wait requires a reusable selector${args.condition === 'text' ? '; prefer the result/status container, or use selector="body" for whole-page rendered text' : ''}`);
    targetOptions(args);
  } else if (args.selector != null || args.ref != null || args.frame_id != null || args.frame != null || args.nth != null || args.selector_type != null || args.name != null) throw new Error('This wait condition does not use an element target');
  if (args.condition === 'text' && (Number(typeof args.expected === 'string') + Number(typeof args.previous === 'string') !== 1)) throw new Error('text wait requires exactly one of expected (substring) or previous (full prior text)');
  if (args.condition === 'url' && typeof args.expected !== 'string') throw new Error('url wait requires expected text (substring)');
  if (args.condition === 'value' && typeof args.expected !== 'string') throw new Error('value wait requires an exact expected string');
  if (['checked', 'selected', 'expanded'].includes(args.condition) && typeof args.expected !== 'boolean' && !(args.condition === 'checked' && args.expected === 'mixed')) throw new Error(`${args.condition} wait requires expected=true/false${args.condition === 'checked' ? ' or "mixed"' : ''}`);
  if (!['text', 'url', 'value', 'checked', 'selected', 'expanded'].includes(args.condition) && args.expected != null) throw new Error('expected is not used by this wait condition');
  if (args.condition !== 'text' && args.previous != null) throw new Error('previous is only valid for text waits');
  if (args.condition === 'network_idle' && (!Number.isInteger(args.idle_ms ?? 500) || (args.idle_ms ?? 500) < 100 || (args.idle_ms ?? 500) > 10000)) throw new Error('idle_ms must be 100..10000');
}

export async function waitFor(cdp, value, sessions, network, pointer, tabId, args, context = {}) {
  waitOptions(args);
  if (args.checks) return await verifyChecks(cdp, value, sessions, network, pointer, tabId, args, context);
  const budget = args.budget || deadline(args.timeout_ms ?? 5000, 'wait');
  let current = 'not observed', previous;
  const description = `${args.condition}${args.selector ? ` selector=${JSON.stringify(args.selector)}` : ''}${args.name != null ? ` name=${JSON.stringify(args.name)}` : ''}${args.expected != null && args.condition !== 'value' ? ` expected${['text', 'url'].includes(args.condition) ? ' substring' : ''}=${JSON.stringify(args.expected)}` : ''}${args.previous != null ? ` text different from=${JSON.stringify(args.previous).slice(0, 500)}` : ''}`;
  try {
    while (true) {
      if (args.condition === 'network_idle') {
        current = network.networkStatus(tabId);
        if (!current.tracking_overflow && current.inflight === 0 && current.idle_ms >= (args.idle_ms ?? 500)) return { satisfied: true, condition: args.condition, current };
      } else if (args.condition === 'url') {
        current = value(await budget.run(() => cdp(tabId, 'Runtime.evaluate', { expression: 'location.href', returnByValue: true })));
        if (current.includes(args.expected)) return { satisfied: true, condition: args.condition, current };
      } else {
        try {
          const frameId = await resolveFrame(cdp, value, sessions, tabId, args, budget);
          const target = sessions.target(tabId, frameId);
          if (args.selector_type === 'role') {
            const node = await resolveSelector(cdp, value, sessions, tabId, args, budget, { wait: false });
            try {
              current = node ? value(await budget.run(() => cdp(node.target, 'Runtime.callFunctionOn', { objectId: node.objectId, returnByValue: true,
                functionDeclaration: `function(args) { return (${inspectWait.toString()})(() => this, (${inspectTarget.toString()}), args); }`, arguments: [{ value: { selector: args.selector, condition: args.condition, expected: args.expected, previous: args.previous } }] }))) : { satisfied: args.condition === 'absent', state: 'absent' };
            } finally {
              if (node) await budget.run(() => cdp(node.target, 'Runtime.releaseObjectGroup', { objectGroup: 'browser-attach' }));
            }
          } else {
            const { executionContextId } = await budget.run(() => cdp(target, 'Page.createIsolatedWorld', { frameId, worldName: 'browser-attach-locator' }));
            const send = (method, params) => budget.run(() => cdp(target, method, params));
            current = await checkedValue(await send('Runtime.evaluate', { contextId: executionContextId, returnByValue: true,
              expression: `(${inspectWait.toString()})((${queryElement.toString()}),(${inspectTarget.toString()}),${JSON.stringify(args)})` }), send, value);
          }
          const stable = current?.ready && previous?.ready && JSON.stringify(current) === JSON.stringify(previous);
          if (current?.satisfied && (args.condition !== 'actionable' || stable)) {
            if (args.condition === 'actionable') {
              try {
                const node = await resolveSelector(cdp, value, sessions, tabId, args, budget);
                try {
                  await pointer.prepare(tabId, node, { budget, scroll: false });
                  current = { ...current, state: 'actionable' };
                } finally {
                  await budget.run(() => cdp(node.target, 'Runtime.releaseObjectGroup', { objectGroup: 'browser-attach' }));
                }
              } catch (error) {
                if (!/covers|no visible click point|detached before resolution/i.test(error.message)) throw error;
                current = { satisfied: false, reason: error.message, ...(error.diagnostics ? { diagnostics: error.diagnostics } : {}) };
              }
            }
            if (current.satisfied) return { satisfied: true, condition: args.condition, current };
          }
          previous = current;
        } catch (error) {
          if (!/context.*(destroyed|not found)|cannot find context|no frame with given id|inspected target navigated|detached before resolution|no node|could not find node|node.*(detached|not found)/i.test(error.message)) throw error;
          current = 'document/frame changing'; previous = null;
        }
      }
      await budget.run(() => new Promise(resolve => setTimeout(resolve, 50)));
    }
  } catch (error) {
    throw Object.assign(new Error(`Wait for ${description} failed: ${error.message}; current=${JSON.stringify(current)}`), {
      input_dispatched: false, diagnostics: error.diagnostics ?? { reason: 'wait_unsatisfied', condition: args.condition, current },
    });
  }
}

export function inspectWait(query, inspect, args) {
  if (args.condition === 'count') {
    const count = query(args.selector, args.selector_type ?? 'css', undefined, false, true);
    return { satisfied: count === args.expected, count };
  }
  const element = query(args.selector, args.selector_type ?? 'css', args.nth, true);
  if (!element) return { satisfied: args.condition === 'absent', state: 'absent' };
  if (element.isConnected === false) return { satisfied: false, state: 'detached_during_observation' };
  if (args.condition === 'attached') return { satisfied: true, state: 'attached' };
  if (args.condition === 'absent') return { satisfied: false, state: 'attached' };
  if (args.condition === 'text') {
    const text = element.innerText ?? '';
    return { satisfied: args.previous != null ? text !== args.previous : text.includes(args.expected), text: text.slice(0, 500),
      total_chars: text.length, text_truncated: text.length > 500,
      ...(text.length > 500 ? { hint: 'Comparison used the full rendered text; only this diagnostic preview is truncated. Scope selector to the result/status container and inspect it with browser_read_text. previous must be its complete prior innerText, not a truncated preview; text changes alone do not prove a new run completed.' } : {}) };
  }
  if (args.condition === 'value' || args.condition === 'value_present') {
    const text = ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) ? element.value : element.isContentEditable ? element.innerText : undefined;
    // Field values may contain credentials. Report the comparison, not its contents.
    if (typeof text !== 'string') return { satisfied: false, state: 'unavailable' };
    return args.condition === 'value_present'
      ? { satisfied: (text !== '') === args.expected, state: 'value', present: text !== '' }
      : { satisfied: text === args.expected, state: 'value', matches: text === args.expected };
  }
  if (['checked', 'selected', 'expanded'].includes(args.condition)) {
    let state, source = 'property';
    if (args.condition === 'checked' && element.tagName === 'INPUT' && ['checkbox', 'radio'].includes(element.type)) state = element.type === 'checkbox' && element.indeterminate ? 'mixed' : element.checked;
    else if (args.condition === 'selected' && element.tagName === 'OPTION') state = element.selected;
    else if (args.condition === 'expanded' && element.tagName === 'DETAILS') state = element.open;
    else {
      source = `aria-${args.condition}`;
      const attribute = element.getAttribute(source);
      state = attribute === 'true' ? true : attribute === 'false' ? false : args.condition === 'checked' && attribute === 'mixed' ? 'mixed' : undefined;
    }
    return { satisfied: state !== undefined && state === args.expected, state: state === undefined ? 'unavailable' : args.condition, value: state ?? null, source };
  }
  const bounds = inspect.call(element);
  if (args.condition === 'visible') return { ...bounds,
    // Visibility is independent of disabled/inert state.
    satisfied: element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0 && element.ownerDocument.defaultView.getComputedStyle(element).visibility === 'visible' };
  return { ...bounds, satisfied: !!bounds.ready };
}

function unavailable(reason, diagnostics) {
  return { satisfied: false, state: 'unavailable', reason, ...(diagnostics ? { diagnostics } : {}) };
}

function observationUnavailable(check, current) {
  return ['unavailable', 'detached_during_observation'].includes(current.state) ||
    current.state === 'absent' && !['attached', 'absent'].includes(check.condition);
}

function preview(text) {
  return text.length <= 500 ? text : { preview: text.slice(0, 500), total_chars: text.length, truncated: true };
}

function verificationResult(checks, observations, timedOut) {
  const results = checks.map((check, index) => {
    const { satisfied, ...actual } = observations[index];
    const expected = check.condition === 'value' ? { redacted: true, comparison: 'exact' }
      : check.previous != null ? { different_from: preview(check.previous) }
        : check.condition === 'network_idle' ? { inflight: 0, idle_ms: check.idle_ms ?? 500 }
          : typeof check.expected === 'string' ? preview(check.expected) : check.expected ?? true;
    return { index, condition: check.condition, ...Object.fromEntries(locatorFields.filter(key => check[key] != null).map(key => [key, check[key]])),
      expected, ...(check.not ? { not: true } : {}),
      status: observationUnavailable(check, observations[index]) ? 'unavailable' : (check.not ? !satisfied : satisfied) ? 'pass' : 'fail', actual };
  });
  const failed = results.filter(result => result.status === 'fail').map(result => result.index);
  const missing = results.filter(result => result.status === 'unavailable').map(result => result.index);
  return { status: failed.length ? 'fail' : missing.length ? 'unavailable' : 'pass', timed_out: timedOut,
    retry_safe: true, failed, unavailable: missing, results };
}

async function verifyChecks(cdp, value, sessions, network, pointer, tabId, args, context) {
  const checks = args.checks, budget = args.budget || deadline(args.timeout_ms ?? 5000, 'wait');
  const groups = new Map();
  checks.forEach((check, index) => {
    const key = ['url', 'network_idle'].includes(check.condition) ? `global-${check.condition}`
      : JSON.stringify([check.frame_id ?? null, check.frame ?? null, check.selector_type === 'role' ? 'ax' : 'dom']);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ check, index });
  });
  let observations = checks.map(() => unavailable('not_observed')), previous = [], previousFrames = new Map(), round = 0;
  while (budget.remaining() > 0) {
    context.assertClaim?.();
    const version = context.documentVersion?.(), frames = new Map();
    observations = checks.map(() => unavailable('not_observed_in_round'));
    try {
      if (context.checkAccess) await budget.run(context.checkAccess);
      for (const entries of groups.values()) {
        context.assertClaim?.();
        if (context.dialogOpen?.()) {
          for (const { index } of entries) observations[index] = unavailable('dialog_open');
          continue;
        }
        // Frame resolution and each group are single attempts. A missing or slow
        // frame must not consume the whole wait before other checks can run.
        const sampleBudget = budget.child(Math.max(250, entries.length * 100), 'wait');
        try {
          const sample = await sampleBudget.run(() => sampleChecks(cdp, value, sessions, network, pointer, tabId, entries,
            sampleBudget, previous, previousFrames, context, `browser-attach-verify-${round}-${entries[0].index}`));
          sample.values.forEach((current, offset) => { observations[entries[offset].index] = current; });
          if (sample.frameId != null && !frames.has(sample.frameId)) frames.set(sample.frameId, sample.version);
        } catch (error) {
          if (['selector_invalid', 'selector_ambiguous', 'selector_not_element'].includes(error.diagnostics?.reason) ||
              ['selector_invalid', 'selector_ambiguous', 'selector_not_element'].includes(error.diagnostics?.cause) ||
              error.diagnostics?.matched_frame_ids?.length > 1) throw error;
          for (const { index } of entries) observations[index] = unavailable(error.deadline_exceeded ? 'observation_timeout' : error.message, error.diagnostics);
        }
        if (budget.remaining() <= 0) break;
      }
    } catch (error) {
      if (!error.deadline_exceeded) throw Object.assign(error, { input_dispatched: false });
    }
    context.assertClaim?.();
    if (context.dialogOpen?.()) {
      observations = checks.map(() => unavailable('dialog_open'));
      previous = []; previousFrames.clear();
    } else if (context.documentVersion?.() !== version) {
      observations = checks.map(() => unavailable('document_changed_during_round'));
      previous = []; previousFrames.clear();
    } else {
      for (const [frameId, frameVersion] of frames) if (context.frameVersion?.(frameId) !== frameVersion) {
        for (let index = 0; index < observations.length; index++) if (observations[index].frame_id === frameId) observations[index] = unavailable('frame_changed_during_round');
      }
      previous = observations; previousFrames = frames;
    }
    const result = verificationResult(checks, observations, false);
    if (result.status === 'pass') return result;
    round++;
    try { await budget.run(() => new Promise(resolve => setTimeout(resolve, 50))); }
    catch (error) { if (!error.deadline_exceeded) throw error; }
  }
  context.assertClaim?.();
  return verificationResult(checks, observations, true);
}

async function sampleChecks(cdp, value, sessions, network, pointer, tabId, entries, budget, previous, previousFrames, context, objectGroup) {
  if (['url', 'network_idle'].includes(entries[0].check.condition)) {
    let url;
    if (entries.some(({ check }) => check.condition === 'url')) url = value(await budget.run(() => cdp(tabId, 'Runtime.evaluate', { expression: 'location.href', returnByValue: true })));
    return { values: entries.map(({ check }) => {
      if (check.condition === 'url') return { satisfied: url.includes(check.expected), url: preview(url) };
      const current = network.networkStatus(tabId);
      return { ...current, ...(current.tracking_overflow ? unavailable('network_tracking_overflow') : {
        satisfied: current.inflight === 0 && current.idle_ms >= (check.idle_ms ?? 500),
      }) };
    }) };
  }
  const frameId = await resolveFrame(cdp, value, sessions, tabId, entries[0].check, budget, { wait: false });
  const version = context.frameVersion?.(frameId), target = sessions.target(tabId, frameId);
  const send = (method, params) => budget.run(() => cdp(target, method, params));
  const dom = entries.filter(({ check }) => check.selector_type !== 'role'), values = new Map();
  if (dom.length) {
    const { executionContextId } = await send('Page.createIsolatedWorld', { frameId, worldName: 'browser-attach-locator' });
    const results = await checkedValue(await send('Runtime.evaluate', { contextId: executionContextId, returnByValue: true,
      expression: `(${inspectChecks.toString()})(${queryElement.toString()},${inspectWait.toString()},${inspectTarget.toString()},${JSON.stringify(dom.map(({ check }) => check))})` }), send, value);
    dom.forEach(({ index }, offset) => values.set(index, results[offset]));
  }
  const roles = entries.filter(({ check }) => check.selector_type === 'role');
  if (roles.length) {
    let hasObjects = false;
    try {
      const { nodes } = await send('Accessibility.getFullAXTree', { frameId });
      for (const { check, index } of roles) {
        if (check.condition === 'count') {
          const count = matchingRoles(nodes, check).length;
          values.set(index, { satisfied: count === check.expected, count });
          continue;
        }
        const node = matchRole(nodes, check);
        if (!node) { values.set(index, inspectWait(() => null, null, check)); continue; }
        try {
          hasObjects = true;
          const { object } = await send('DOM.resolveNode', { backendNodeId: node.backendDOMNodeId, objectGroup });
          if (!object?.objectId) throw new Error('Element detached during observation');
          values.set(index, await checkedValue(await send('Runtime.callFunctionOn', { objectId: object.objectId, returnByValue: true,
            functionDeclaration: `function(args) { return (${inspectWait.toString()})(() => this, (${inspectTarget.toString()}), args); }`, arguments: [{ value: check }] }), send, value));
        } catch (error) {
          if (error.deadline_exceeded) throw error;
          values.set(index, unavailable(error.message, error.diagnostics));
        }
      }
    } finally { if (hasObjects) await boundedRead(() => cdp(target, 'Runtime.releaseObjectGroup', { objectGroup }), 100).catch(() => {}); }
  }
  for (const { check, index } of entries) {
    let current = values.get(index);
    if (check.condition === 'actionable' && current.ready) {
      const old = previous[index];
      if (!old?.ready || previousFrames.get(frameId) !== version || !['x', 'y', 'width', 'height'].every(key => old[key] === current[key])) current = { ...current, ...unavailable('geometry_not_stable') };
      else {
        try {
          const node = await resolveSelector(cdp, value, sessions, tabId, { ...check, frame: undefined, frame_id: frameId }, budget, { wait: false });
          try { await pointer.prepare(tabId, node, { budget, scroll: false }); }
          finally { await boundedRead(() => cdp(target, 'Runtime.releaseObjectGroup', { objectGroup: 'browser-attach' }), 100).catch(() => {}); }
        } catch (error) {
          if (['obstructed', 'frame_obstructed', 'no_visible_click_point'].includes(error.diagnostics?.reason)) current = { satisfied: false, state: 'obstructed', diagnostics: error.diagnostics };
          else current = unavailable(error.message, error.diagnostics);
        }
      }
    }
    values.set(index, { ...current, frame_id: frameId });
  }
  return { frameId, version, values: entries.map(({ index }) => values.get(index)) };
}

function inspectChecks(query, inspect, inspectTarget, checks) {
  return checks.map(check => inspect(query, inspectTarget, check));
}
