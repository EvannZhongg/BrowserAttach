import { deadline, waitForTarget, delivery } from './actionability.js';
import { clickOptions } from './click.js';
import { timingOption, pause } from './motion.js';

const BUSY = 'Browser UI may be capturing input (a tab drag or native menu). Finish that interaction, then observe the page before deciding whether to try again. Never replay an unknown outcome automatically.';

export function inputMode(args) {
  const mode = args.mode ?? 'native';
  if (!['native', 'dom'].includes(mode)) throw new Error('mode must be native or dom');
  return mode;
}

async function bounded(operation, message, ms = 5000) {
  let timer;
  try { return await Promise.race([operation, new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`${message} Outcome is unknown. ${BUSY}`), { outcome_unknown: true })), ms);
  })]); }
  finally { clearTimeout(timer); }
}

export function createInput(cdp, value, sessions) {
  const pending = new Map();
  function event(tabId, method, params, sessionId) {
    const operation = pending.get(tabId);
    if (!operation) return;
    if (method === 'Page.javascriptDialogOpening') {
      operation.reject(Object.assign(new Error('The key action opened a JavaScript dialog. It may already have executed; use browser_snapshot and browser_handle_dialog before continuing.'), { outcome_unknown: true }));
    }
    if (method !== 'Runtime.bindingCalled' || params.name !== operation.name || !operation.contexts.has(JSON.stringify([sessionId, params.executionContextId]))) return;
    try { if (JSON.parse(params.payload).delivered === true) operation.resolve(); }
    catch (error) { operation.reject(error); }
  }
  function cancel(tabId) { pending.get(tabId)?.reject(Object.assign(new Error('Tab detached during keyboard input; outcome is unknown. Observe before retrying.'), { outcome_unknown: true })); }

  async function focusedNode(tabId, budget, worlds, frames) {
    frames ||= await budget.run(() => sessions.frames(tabId));
    let frameId = frames[0].id;
    const visited = new Set();
    while (true) {
      if (visited.has(frameId)) throw new Error('Focus frame cycle; no input was dispatched.');
      visited.add(frameId);
      let world = worlds?.get(frameId);
      if (!world) {
        if (worlds || !frames.some(frame => frame.id === frameId)) throw new Error('Focused frame is unavailable; no input was dispatched.');
        const target = sessions.target(tabId, frameId);
        const { executionContextId } = await budget.run(() => cdp(target, 'Page.createIsolatedWorld', { frameId, worldName: 'browser-attach-input' }));
        world = { target, contextId: executionContextId };
      }
      const active = await budget.run(() => cdp(world.target, 'Runtime.evaluate', { contextId: world.contextId,
        expression: `(${activeElement.toString()})()`, objectGroup: 'browser-attach' }));
      value(active);
      if (!active.result?.objectId) throw new Error('No focused page element is available; no input was dispatched.');
      const { node } = await budget.run(() => cdp(world.target, 'DOM.describeNode', { objectId: active.result.objectId }));
      if (node.frameId) frameId = node.frameId;
      else return { target: world.target, frameId, objectId: active.result.objectId, backendNodeId: node.backendNodeId };
    }
  }

  async function pressKey(tabId, chord, args = {}) {
    const budget = args.budget || deadline(args.timeout_ms);
    const send = (...params) => budget.run(() => cdp(...params));
    const { params, text } = args.character != null ? characterParameters(args.character) : keyParameters(chord);
    const name = `__attachKey_${crypto.randomUUID().replaceAll('-', '')}`;
    const contexts = new Set(), guards = [], omittedFrames = [];
    const receipt = new Promise((resolve, reject) => pending.set(tabId, { name, contexts, resolve, reject }));
    receipt.catch(() => {});
    try {
      const frames = await budget.run(() => sessions.frames(tabId, send));
      const worlds = new Map();
      for (const frame of frames) {
        const target = sessions.target(tabId, frame.id);
        let contextId;
        try {
          const { executionContextId } = await send(target, 'Page.createIsolatedWorld', { frameId: frame.id, worldName: 'browser-attach-input' });
          if (!executionContextId) throw new Error('Could not create keyboard verification context; no input was dispatched.');
          contextId = executionContextId;
          worlds.set(frame.id, { target, contextId, frameId: frame.id });
          contexts.add(JSON.stringify([target.sessionId, executionContextId]));
          await send(target, 'Runtime.addBinding', { name, executionContextId });
          const installed = await send(target, 'Runtime.evaluate', {
            contextId: executionContextId, expression: `(${installKeyReceipt.toString()})(${JSON.stringify(name)},${JSON.stringify(params)},${budget.remaining() + 500})`,
            objectGroup: 'browser-attach',
          });
          if (installed.exceptionDetails) value(installed);
          if (!installed.result?.objectId) throw new Error('Could not install keyboard verification; no input was dispatched.');
          guards.push({ target, objectId: installed.result.objectId });
        } catch (error) {
          if (frame.id === frames[0].id) throw error;
          contexts.delete(JSON.stringify([target.sessionId, contextId]));
          omittedFrames.push({ frame_id: frame.id, reason: error.message });
        }
      }
      const focused = await focusedNode(tabId, budget, worlds, frames);
      await waitForTarget(cdp, value, focused.target, focused, budget);
      if (args.expectedNode) {
        const expected = args.expectedNode;
        const matches = focused.frameId === expected.frameId && value(await send(expected.target, 'Runtime.callFunctionOn', { objectId: expected.objectId,
          functionDeclaration: 'function() { const a=this.getRootNode().activeElement; return this.isConnected && (a===this || this.contains(a)); }', returnByValue: true }));
        if (!matches) throw new Error('Typing target lost focus during key preparation; no further key was dispatched');
      }
      budget.dispatch();
      // Queue the complete chord before waiting for acknowledgements. Always
      // enqueue keyUp, even if keyDown fails or opens a modal.
      const commands = [send(focused.target, 'Input.dispatchKeyEvent', { type: args.character != null ? 'keyDown' : 'rawKeyDown', ...(args.character != null ? { text, unmodifiedText: text } : {}), ...params })];
      if (text != null && args.character == null) commands.push(send(focused.target, 'Input.dispatchKeyEvent', { type: 'char', text, unmodifiedText: text, ...params }));
      commands.push(send(focused.target, 'Input.dispatchKeyEvent', { type: 'keyUp', ...params }));
      await budget.run(() => delivery(Promise.all([Promise.all(commands), receipt])));
      return { sent: chord, method: 'native', delivery_verified: true, application_result: 'not_checked',
        ...(omittedFrames.length ? { verification_omitted_frames: omittedFrames } : {}), observe_again: true };
    } finally {
      pending.delete(tabId);
      const cleanup = guards.flatMap(({ target, objectId }) => [cdp(target, 'Runtime.removeBinding', { name }),
        cdp(target, 'Runtime.callFunctionOn', { objectId, functionDeclaration: 'function() { this.stop(); }' })]);
      await bounded(Promise.allSettled(cleanup), 'Keyboard verification cleanup timed out.', 250).catch(() => {});
    }
  }

  async function fill(tabId, node, args) {
    if (!node || typeof args.text !== 'string') throw new Error('fill requires ref or selector, and text');
    const mode = inputMode(args);
    const budget = args.budget || deadline(args.timeout_ms), target = node.target;
    const send = (method, params) => budget.run(() => cdp(target, method, params));
    await waitForTarget(cdp, value, target, node, budget, { editable: true });
    budget.dispatch();
    value(await send('Runtime.callFunctionOn', { objectId: node.objectId, returnByValue: true,
      functionDeclaration: prepareFill.toString(), arguments: [{ value: mode }, { value: args.text }] }));
    if (mode === 'native') {
      const selected = value(await send('Runtime.callFunctionOn', { objectId: node.objectId, returnByValue: true,
        functionDeclaration: verifyReplacementSelection.toString() }));
      if (selected !== true) throw Object.assign(new Error('Fill replacement selection was lost before text insertion; no replacement text was inserted. Observe the field before continuing.'), {
        outcome_unknown: true, diagnostics: { reason: 'fill_selection_lost', frame_id: node.frameId },
      });
      await send('Input.insertText', { text: args.text });
    }
    const matches = value(await send('Runtime.callFunctionOn', { objectId: node.objectId, returnByValue: true,
      functionDeclaration: verifyFill.toString(), arguments: [{ value: args.text }, { value: mode }] }));
    if (matches !== true) throw Object.assign(new Error(`Fill did not retain the requested text. Input may have been swallowed, focus may have moved, or the page may have reformatted it. Outcome is unknown. ${BUSY}`), {
      outcome_unknown: true, diagnostics: { reason: 'value_not_retained', frame_id: node.frameId },
    });
    return { filled: true, method: mode, value_verified: true, ...(mode === 'dom' ? { events_trusted: false } : {}), application_result: 'not_checked', observe_again: true };
  }

  async function domClick(tabId, node, args) {
    if (!node || args.x != null || args.y != null) throw new Error('DOM click requires ref or selector; coordinates are unsupported.');
    clickOptions(args);
    const budget = args.budget || deadline(args.timeout_ms), target = node.target;
    const send = (method, params) => budget.run(() => cdp(target, method, params));
    await waitForTarget(cdp, value, target, node, budget);
    budget.dispatch();
    const result = value(await send('Runtime.callFunctionOn', { objectId: node.objectId, returnByValue: true,
      functionDeclaration: clickElement.toString() }));
    return { ...result, method: 'dom', events_trusted: false, application_result: 'not_checked', observe_again: true };
  }
  async function selectOption(tabId, node, args) {
    selectOptions(args);
    const budget = args.budget || deadline(args.timeout_ms);
    const choice = { value: args.value, label: args.label, index: args.index };
    value(await budget.run(() => cdp(node.target, 'Runtime.callFunctionOn', {
      objectId: node.objectId, functionDeclaration: selectElement.toString(),
      arguments: [{ value: choice }, { value: false }], returnByValue: true,
    })));
    budget.dispatch();
    let result;
    try {
      result = value(await budget.run(() => cdp(node.target, 'Runtime.callFunctionOn', {
        objectId: node.objectId, functionDeclaration: selectElement.toString(),
        arguments: [{ value: choice }], returnByValue: true,
      })));
    } catch (error) { error.outcome_unknown = true; throw error; }
    return { ...result, method: 'dom', events_trusted: false, application_result: 'not_checked', observe_again: true };
  }
  async function typeText(tabId, node, args) {
    typeOptions(args);
    const budget = args.budget || deadline(args.timeout_ms);
    if (args.focused) node = await focusedNode(tabId, budget);
    await waitForTarget(cdp, value, node.target, node, budget, { editable: true });
    if (!args.focused) {
      budget.dispatch();
      value(await budget.run(() => cdp(node.target, 'Runtime.callFunctionOn', { objectId: node.objectId,
        functionDeclaration: 'function() { this.focus(); if (this.getRootNode().activeElement !== this && !this.contains(this.getRootNode().activeElement)) throw new Error("Field did not receive focus"); }', returnByValue: true })));
    }
    let typed = 0; const length = Array.from(args.text).length;
    for (const character of args.text) {
      const focused = value(await budget.run(() => cdp(node.target, 'Runtime.callFunctionOn', { objectId: node.objectId,
        functionDeclaration: 'function() { const a=this.getRootNode().activeElement; return this.isConnected && (a===this || this.contains(a)); }', returnByValue: true })));
      if (!focused) throw Object.assign(new Error(`Typing stopped after ${typed} characters: original field detached or lost focus. Outcome is unknown; do not replay.`), { outcome_unknown: true });
      try { await pressKey(tabId, character, { budget, character, expectedNode: node }); }
      catch (error) { error.outcome_unknown = true; error.message = `Typing stopped after ${typed} verified characters; the current character may already have been delivered. ${error.message}`; throw error; }
      typed++;
      if (typed < length) await pause(budget, args.delay_ms);
    }
    return { typed, method: 'native', events_trusted: true, delivery_verified: true, application_result: 'not_checked', observe_again: true };
  }
  return { pressKey, fill, typeText, domClick, selectOption, event, cancel };
}

function installKeyReceipt(name, params, expiryMs) {
  const report = globalThis[name];
  function listener(event) {
    const modifiers = (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
    if (event.isTrusted && event.code === params.code && event.key === params.key && modifiers === params.modifiers) {
      report(JSON.stringify({ delivered: true })); stop();
    }
  }
  let expiry;
  function stop() { clearTimeout(expiry); globalThis.removeEventListener('keydown', listener, true); delete globalThis[name]; }
  globalThis.addEventListener('keydown', listener, true);
  expiry = setTimeout(stop, expiryMs);
  return { stop };
}

const NAMED_KEYS = {
  Enter: [13, 'Enter'], Tab: [9, 'Tab'], Escape: [27, 'Escape'], Backspace: [8, 'Backspace'],
  Insert: [45, 'Insert'], Delete: [46, 'Delete'], ArrowLeft: [37, 'ArrowLeft'], ArrowRight: [39, 'ArrowRight'],
  ArrowUp: [38, 'ArrowUp'], ArrowDown: [40, 'ArrowDown'], Home: [36, 'Home'], End: [35, 'End'],
  PageUp: [33, 'PageUp'], PageDown: [34, 'PageDown'],
};
// Deterministic US keyboard mapping: [plain, shifted, virtual key, physical code].
const PRINTABLE_KEYS = [
  [' ', ' ', 32, 'Space'], ['0', ')', 48, 'Digit0'], ['1', '!', 49, 'Digit1'], ['2', '@', 50, 'Digit2'],
  ['3', '#', 51, 'Digit3'], ['4', '$', 52, 'Digit4'], ['5', '%', 53, 'Digit5'], ['6', '^', 54, 'Digit6'],
  ['7', '&', 55, 'Digit7'], ['8', '*', 56, 'Digit8'], ['9', '(', 57, 'Digit9'],
  [';', ':', 186, 'Semicolon'], ['=', '+', 187, 'Equal'], [',', '<', 188, 'Comma'], ['-', '_', 189, 'Minus'],
  ['.', '>', 190, 'Period'], ['/', '?', 191, 'Slash'], ['`', '~', 192, 'Backquote'],
  ['[', '{', 219, 'BracketLeft'], ['\\', '|', 220, 'Backslash'], [']', '}', 221, 'BracketRight'], ["'", '"', 222, 'Quote'],
];

export function keyParameters(chord) {
  if (typeof chord !== 'string') throw new Error('key must be a string');
  const modifiers = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Shift: 8 };
  const parts = chord.split('+');
  let key = parts.pop();
  // A literal plus may appear alone or at the end of a chord: +, Control++.
  if (key === '' && parts.at(-1) === '') { key = '+'; parts.pop(); }
  let mask = 0;
  for (const part of parts) {
    if (!Object.hasOwn(modifiers, part)) throw new Error(`Unknown modifier: ${part}`);
    mask |= modifiers[part];
  }
  let entry = Object.hasOwn(NAMED_KEYS, key) ? NAMED_KEYS[key] : null, text;
  if (!entry && /^F([1-9]|1[0-2])$/.test(key)) entry = [111 + Number(key.slice(1)), key];
  if (!entry && /^[a-zA-Z]$/.test(key)) {
    entry = [key.toUpperCase().charCodeAt(0), `Key${key.toUpperCase()}`];
    key = mask & 8 ? key.toUpperCase() : key.toLowerCase();
    if ((mask & ~8) === 0) text = key;
  }
  if (!entry) {
    const row = PRINTABLE_KEYS.find(([plain, shifted, , code]) => key === plain || key === shifted || key === code || (key === 'Plus' && shifted === '+'));
    if (row) {
      const [plain, shifted, vk, code] = row;
      if (plain !== shifted && (key === shifted || key === 'Plus')) mask |= 8;
      key = mask & 8 ? shifted : plain;
      entry = [vk, code];
      if ((mask & ~8) === 0) text = key;
    }
  }
  if (!entry) throw new Error('Unsupported key. Use F1-F12, a named navigation/editing key, ASCII letter/digit or US punctuation.');
  if ((mask & ~8) === 0 && key === 'Enter') text = '\r';
  if (mask === 0 && key === 'Tab') text = '\t';
  return { params: { key, code: entry[1], windowsVirtualKeyCode: entry[0], nativeVirtualKeyCode: entry[0], modifiers: mask }, text };
}

function prepareFill(mode, text) {
  const tag = this.tagName?.toLowerCase();
  if (!this.isConnected) throw new Error('Field is detached');
  if (this.disabled || this.readOnly || this.closest('[inert]')) throw new Error('Field is disabled, read-only or inert');
  if (!['input', 'textarea'].includes(tag) && !this.isContentEditable) throw new Error('Ref is not an editable field');
  if (tag === 'input' && !['text', 'search', 'email', 'password', 'tel', 'url', ''].includes(this.type)) throw new Error('Input type cannot be filled with text');
  if (mode === 'dom') {
    const win = this.ownerDocument.defaultView;
    if (this.isContentEditable) this.innerText = text;
    else {
      const prototype = tag === 'textarea' ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(this, text);
    }
    this.dispatchEvent(new win.InputEvent('input', { bubbles: true, composed: true, inputType: 'insertReplacementText', data: text }));
    this.dispatchEvent(new win.Event('change', { bubbles: true }));
  } else {
    this.focus();
    const active = this.getRootNode().activeElement;
    if (active !== this && !this.contains(active)) throw new Error('Field did not receive focus');
    if (this.isContentEditable) {
      const range = this.ownerDocument.createRange(); range.selectNodeContents(this);
      const selection = this.ownerDocument.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    } else this.select();
  }
  return true;
}

function verifyReplacementSelection() {
  if (!this.isConnected) return false;
  const active = this.getRootNode().activeElement;
  if (active !== this && !this.contains(active)) return false;
  if (!this.isContentEditable) return true;
  const selection = this.ownerDocument.getSelection();
  if (!selection || selection.rangeCount !== 1) return false;
  const expected = this.ownerDocument.createRange(); expected.selectNodeContents(this);
  const actual = selection.getRangeAt(0);
  return actual.compareBoundaryPoints(0, expected) === 0 && actual.compareBoundaryPoints(2, expected) === 0;
}

function verifyFill(text, mode) {
  if (!this.isConnected) return false;
  if (!this.isContentEditable) return this.value === text;
  let retained;
  if (mode === 'dom') retained = this.innerText;
  else {
    const active = this.getRootNode().activeElement;
    if (active !== this && !this.contains(active)) return false;
    const selection = this.ownerDocument.getSelection();
    if (!selection) return false;
    const { anchorNode, anchorOffset, focusNode, focusOffset } = selection;
    const range = this.ownerDocument.createRange(); range.selectNodeContents(this);
    try {
      // Chromium's selected text understands editing placeholders such as an
      // empty <div><br></div>; innerText counts their line breaks twice.
      selection.removeAllRanges(); selection.addRange(range);
      retained = selection.toString();
    } finally {
      selection.removeAllRanges();
      if (anchorNode?.isConnected && focusNode?.isConnected) selection.setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset);
    }
  }
  const actual = retained.replace(/\r\n?/g, '\n'), expected = text.replace(/\r\n?/g, '\n');
  if (actual.length !== expected.length) return false;
  for (let index = 0; index < expected.length; index++) {
    // Editors may preserve an inserted ordinary space as NBSP. Keep its position
    // and count, and still require an explicitly requested NBSP to be retained.
    if (actual[index] !== expected[index] && !(expected[index] === ' ' && actual[index] === '\u00a0')) return false;
  }
  return true;
}

function clickElement() {
  const element = this.nodeType === 3 ? this.parentElement : this;
  if (!element?.isConnected) throw new Error('Element is detached');
  if (element.matches(':disabled') || element.closest('[inert]')) throw new Error('Element is disabled or inert');
  const win = element.ownerDocument.defaultView, rect = element.getBoundingClientRect(), style = win.getComputedStyle(element);
  if (style.visibility !== 'visible' || !rect.width || !rect.height) throw new Error('Element is not visible');
  if (!(element instanceof win.HTMLElement)) throw new Error('DOM click supports HTML elements only; use native input for this ref.');
  win.HTMLElement.prototype.click.call(element);
  return { clicked: true };
}

function activeElement() {
  let element = document.activeElement;
  while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  return element;
}

export function selectOptions(args) {
  if (['value', 'label', 'index'].filter(key => args[key] != null).length !== 1) throw new Error('Provide exactly one of value, label or index');
  if (args.index != null && (!Number.isSafeInteger(args.index) || args.index < 0)) throw new Error('index must be a nonnegative safe integer');
  for (const key of ['value', 'label']) if (args[key] != null && typeof args[key] !== 'string') throw new Error(`${key} must be a string`);
}

export function selectElement(choice, apply = true) {
  if (this.tagName !== 'SELECT' || !this.isConnected) throw new Error('Target must be a connected HTML select');
  for (let parent = this; parent; parent = parent.assignedSlot || parent.parentElement || parent.getRootNode().host) {
    if (parent.matches(':disabled') || parent.hasAttribute('inert')) throw new Error('Select is disabled or inert');
  }
  const options = Array.from(this.options);
  const matches = options.filter((option, index) => choice.index != null ? index === choice.index : choice.value != null ? option.value === choice.value : option.label === choice.label);
  if (matches.length !== 1) throw new Error(`Option must match exactly once; matched ${matches.length}. Use an explicit index for duplicate labels/values. No value was set.`);
  const option = matches[0];
  if (option.disabled || option.parentElement?.tagName === 'OPTGROUP' && option.parentElement.disabled) throw new Error('Option is disabled; no value was set');
  if (!apply) return true;
  const win = this.ownerDocument.defaultView;
  const index = options.indexOf(option);
  Object.getOwnPropertyDescriptor(win.HTMLSelectElement.prototype, 'selectedIndex').set.call(this, index);
  this.dispatchEvent(new win.Event('input', { bubbles: true, composed: true }));
  this.dispatchEvent(new win.Event('change', { bubbles: true }));
  if (!this.isConnected || this.selectedIndex !== index || this.options[index] !== option || !option.selected) throw new Error('Select did not retain the requested option. Outcome is unknown; observe before continuing.');
  return { selected: true, index, value: option.value, label: option.label, value_verified: true };
}

export function typeOptions(args) {
  if (typeof args.text !== 'string') throw new Error('type text must be a string');
  if (args.text.length > 10000) throw new Error('type text must contain at most 10000 characters');
  if (/[\x00-\x1f]/.test(args.text)) throw new Error('type accepts printable characters only; use press_key with Enter for line breaks or Tab for tabs');
  timingOption(args.delay_ms ?? 0, 'delay_ms');
}

export function characterParameters(character) {
  if (typeof character !== 'string' || Array.from(character).length !== 1 || /[\r\n\t\x00-\x1f]/.test(character)) throw new Error('type accepts printable characters; use press_key for control keys');
  try {
    const result = keyParameters(/^[A-Z]$/.test(character) ? `Shift+${character}` : character);
    return { params: { ...result.params, key: character }, text: character };
  } catch {
    return { params: { key: character, code: '', windowsVirtualKeyCode: 0, nativeVirtualKeyCode: 0, modifiers: 0 }, text: character };
  }
}
