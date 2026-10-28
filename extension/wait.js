import { deadline, inspectTarget } from './actionability.js';
import { queryElement, targetOptions, resolveSelector, resolveFrame } from './locator.js';
import { checkedValue } from './errors.js';

export const WAIT_CONDITIONS = ['attached', 'absent', 'visible', 'actionable', 'text', 'value', 'checked', 'selected', 'expanded', 'url', 'network_idle'];

export function waitOptions(args) {
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

export async function waitFor(cdp, value, sessions, network, pointer, tabId, args) {
  waitOptions(args);
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
  if (args.condition === 'value') {
    const text = ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) ? element.value : element.isContentEditable ? element.innerText : undefined;
    // Field values may contain credentials. Report the comparison, not its contents.
    return { satisfied: typeof text === 'string' && text === args.expected, state: typeof text === 'string' ? 'value' : 'unavailable' };
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
