import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { fixture } from './helpers/controller-fixture.mjs';

test('select assignment exceptions retain unknown-outcome evidence across the page CDP boundary', async () => {
  const f = fixture(); await f.claim();
  const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => {
    if (method === 'Runtime.callFunctionOn' && args.functionDeclaration.includes('function selectElement') && args.arguments.length === 1) {
      return { exceptionDetails: { text: 'Selection could not be verified' } };
    }
    return send(target, method, args);
  };
  await assert.rejects(f.exec('select_option', { selector: 'select', index: 0 }), error => {
    assert.equal(error.input_dispatched, true);
    assert.equal(error.post_action.delivery, 'unknown');
    return true;
  });
});

test('explicit DOM click remains available on a background tab without a native readiness check', async () => {
  const f = fixture(); await f.claim(); f.tabs.get(9).active = false;
  const result = await f.exec('click', { ref: f.ref(await f.exec('snapshot')), mode: 'dom' });
  assert.equal(result.method, 'dom'); assert.equal(result.events_trusted, false);
  assert.ok(!f.calls.some(call => call.method.startsWith('Input.') || call.args?.expression?.includes('visibility_state: document.visibilityState')));
});

test('fill uses a resolved node and text input; raw CDP remains unavailable', async () => {
  const f = fixture(); await f.claim();
  const snapshot = await f.exec('snapshot');
  const ref = snapshot.snapshot.match(/\[([^\]]+)\] textbox/)[1];
  await f.exec('fill', { ref, text: '中文 hello' });
  assert.deepEqual(f.calls.find(call => call.method === 'Input.insertText').args, { text: '中文 hello' });
  await assert.rejects(f.exec('send_cdp', { method: 'Runtime.evaluate' }), /Unknown operation/);
});

test('DOM fill bypasses native input and focus, notifies the page and verifies the retained value', async () => {
  const f = fixture(); await f.claim();
  const events = [];
  class Input { set value(text) { this.stored = text; } get value() { return this.stored; } }
  const field = new Input();
  Object.assign(field, { tagName: 'INPUT', type: 'text', isConnected: true, closest: () => null,
    focus() { throw new Error('DOM fill must not focus'); }, dispatchEvent(event) { events.push(event); } });
  field.ownerDocument = { defaultView: { HTMLInputElement: Input, Event: class { constructor(type) { this.type = type; } },
    InputEvent: class { constructor(type, init) { this.type = type; Object.assign(this, init); } } } };
  const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => {
    if (method === 'Runtime.callFunctionOn' && /function (prepareFill|verifyFill)/.test(args.functionDeclaration)) {
      return { result: { value: vm.runInNewContext(`(${args.functionDeclaration})`).call(field, ...args.arguments.map(arg => arg.value)) } };
    }
    return send(target, method, args);
  };
  const snap = await f.exec('snapshot'), ref = snap.snapshot.match(/\[([^\]]+)\] textbox/)[1];
  const result = await f.exec('fill', { ref, text: '中文 test', mode: 'dom' });
  assert.equal(field.value, '中文 test'); assert.equal(result.value_verified, true); assert.equal(result.events_trusted, false);
  assert.deepEqual(events.map(event => event.type), ['input', 'change']);
  assert.equal(f.calls.filter(call => call.method.startsWith('Input.')).length, 0);
  assert.equal((await f.exec('fill', { ref, text: 'again', mode: 'dom' })).value_verified, true);
});

test('contenteditable fill verifies the mode-specific text without hiding content changes', async t => {
  const cases = [
    ['native block line breaks', 'native', 'first\nsecond', 'first\nsecond', 'firstsecond', true],
    ['native CRLF', 'native', 'first\r\nsecond', 'first\nsecond', 'firstsecond', true],
    ['native CR', 'native', 'first\rsecond', 'first\nsecond', 'firstsecond', true],
    ['native space preserved as NBSP', 'native', ' a  b ', '\u00a0a \u00a0b\u00a0', '\u00a0a \u00a0b\u00a0', true],
    ['native explicit NBSP retained', 'native', 'a\u00a0b', 'a\u00a0b', 'a\u00a0b', true],
    ['native explicit NBSP lost', 'native', 'a\u00a0b', 'a b', 'a\u00a0b', false],
    ['native raw text cannot hide a paragraph break', 'native', 'ab', 'a\nb', 'ab', false],
    ['native collapsed space', 'native', 'a  b', 'a b', 'a  b', false],
    ['native missing leading space', 'native', ' ab', 'ab', ' ab', false],
    ['native extra blank line', 'native', 'a\nb', 'a\n\nb', 'a\nb', false],
    ['native missing blank line', 'native', 'a\n\nb', 'a\nb', 'a\n\nb', false],
    ['native changed character', 'native', 'interesting', 'interested', 'interesting', false],
    ['native empty', 'native', '', '', '', true],
    ['native Unicode', 'native', '中文🙂\n第二行', '中文🙂\n第二行', '中文🙂第二行', true],
    ['DOM collapsed whitespace cannot pass on raw text', 'dom', 'a\n b', 'a b', 'a\n b', false],
    ['DOM rendered line breaks', 'dom', 'a\nb', 'a\nb', 'ab', true],
    ['DOM space preserved as NBSP', 'dom', ' a ', '\u00a0a\u00a0', '\u00a0a\u00a0', true],
    ['DOM mixed spaces preserved as NBSP', 'dom', ' a  b ', '\u00a0a \u00a0b\u00a0', '\u00a0a \u00a0b\u00a0', true],
    ['DOM explicit NBSP retained', 'dom', 'a\u00a0b', 'a\u00a0b', 'a\u00a0b', true],
    ['DOM explicit NBSP lost', 'dom', 'a\u00a0b', 'a b', 'a\u00a0b', false],
    ['DOM missing leading space', 'dom', ' ab', 'ab', ' ab', false],
    ['DOM missing trailing space', 'dom', 'ab ', 'ab', 'ab ', false],
    ['DOM collapsed spaces', 'dom', 'a  b', 'a\u00a0b', 'a  b', false],
    ['DOM moved space', 'dom', ' ab', 'ab\u00a0', ' ab', false],
    ['DOM CRLF line breaks', 'dom', 'a\r\nb', 'a\nb', 'ab', true],
    ['DOM missing blank line', 'dom', 'a\n\nb', 'a\nb', 'a\n\nb', false],
  ];
  for (const [name, mode, text, innerText, textContent, matches] of cases) await t.test(name, async () => {
    const f = fixture(); await f.claim();
    const field = { isConnected: true, isContentEditable: true, innerText, textContent };
    const anchorNode = { isConnected: true }, focusNode = { isConnected: true };
    let restored;
    const selection = { anchorNode, anchorOffset: 2, focusNode, focusOffset: 1,
      removeAllRanges() {}, addRange() {}, toString: () => innerText,
      setBaseAndExtent(...args) { restored = args; } };
    field.getRootNode = () => ({ activeElement: field });
    field.ownerDocument = { getSelection: () => selection, createRange: () => ({ selectNodeContents() {} }) };
    // Readback represents the retained editor state, including synchronous page formatting.
    Object.defineProperty(field, 'textContent', {
      get() { throw new Error('Fill read the other input mode\'s text representation'); },
    });
    if (mode === 'native') Object.defineProperty(field, 'innerText', {
      get() { throw new Error('Native fill must use browser-selected text for editing placeholders'); },
    });
    const send = f.api.debugger.sendCommand;
    f.api.debugger.sendCommand = async (target, method, args) => {
      const result = await send(target, method, args);
      if (method === 'Runtime.callFunctionOn' && args.functionDeclaration.includes('function verifyFill')) {
        result.result.value = vm.runInNewContext(`(${args.functionDeclaration})`).call(field, ...args.arguments.map(arg => arg.value));
      }
      return result;
    };
    const operation = f.exec('fill', { selector: '#editor', text, mode });
    if (matches) assert.equal((await operation).value_verified, true);
    else await assert.rejects(operation, error => {
      assert.equal(error.diagnostics.reason, 'value_not_retained');
      assert.equal(error.input_dispatched, true); assert.equal(error.post_action.delivery, 'unknown');
      return true;
    });
    assert.equal(f.calls.filter(call => call.method === 'Input.insertText').length, mode === 'native' ? 1 : 0);
    assert.equal(f.calls.filter(call => call.args?.functionDeclaration?.includes('function prepareFill')).length, 1);
    if (mode === 'native') assert.deepEqual(restored, [anchorNode, 2, focusNode, 1]);
    else assert.equal(restored, undefined);
  });
});

test('native fill does not insert text after losing the replacement selection', async () => {
  const f = fixture(); await f.claim();
  const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => {
    const result = await send(target, method, args);
    if (method === 'Runtime.callFunctionOn' && args.functionDeclaration.includes('function verifyReplacementSelection')) result.result.value = false;
    return result;
  };
  await assert.rejects(f.exec('fill', { selector: '#editor', text: 'replacement' }), error => {
    assert.equal(error.diagnostics.reason, 'fill_selection_lost');
    assert.match(error.message, /no replacement text was inserted/);
    return true;
  });
  assert.equal(f.calls.filter(call => call.method === 'Input.insertText').length, 0);
});

test('DOM click invokes HTML activation once without native input, rejects coordinates and disabled targets', async () => {
  const f = fixture(); await f.claim();
  let clicks = 0, disabled = false;
  class Element { click() { clicks++; } }
  const element = new Element();
  Object.assign(element, { isConnected: true, matches: () => disabled, closest: () => null,
    getBoundingClientRect: () => ({ width: 20, height: 20 }),
    ownerDocument: { defaultView: { HTMLElement: Element, getComputedStyle: () => ({ visibility: 'visible' }) } } });
  const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => {
    if (method === 'Runtime.callFunctionOn' && args.functionDeclaration.includes('function clickElement')) {
      return { result: { value: vm.runInNewContext(`(${args.functionDeclaration})`).call(element) } };
    }
    return send(target, method, args);
  };
  const result = await f.exec('click', { ref: f.ref(await f.exec('snapshot')), mode: 'dom' });
  assert.equal(clicks, 1); assert.equal(result.events_trusted, false); assert.equal(result.target_verified, undefined);
  assert.equal(f.calls.filter(call => call.method.startsWith('Input.')).length, 0);
  await assert.rejects(f.exec('click', { x: 5, y: 5, mode: 'dom' }), /ref or selector/);
  await assert.rejects(f.exec('click', { ref: f.ref(await f.exec('snapshot')), mode: 'typo' }), /mode must/);
  disabled = true;
  await assert.rejects(f.exec('click', { ref: f.ref(await f.exec('snapshot')), mode: 'dom' }), /disabled/);
  assert.equal(clicks, 1);
});

test('swallowed keyboard events and forged page-world receipts cannot report delivery; timeout preserves the queue', async () => {
  const f = fixture(); await f.claim();
  const emit = f.api.debugger.onEvent.emit;
  f.api.debugger.onEvent.emit = (target, method, params) => emit(target, method,
    method === 'Runtime.bindingCalled' ? { ...params, executionContextId: 999 } : params);
  await assert.rejects(f.exec('press_key', { key: 'Z' }), /no verified receipt.*Outcome is unknown.*press Esc/);
  const keys = f.calls.filter(call => call.method === 'Input.dispatchKeyEvent');
  assert.deepEqual(keys.map(call => call.args.type), ['rawKeyDown', 'char', 'keyUp']);
  assert.equal(f.calls.filter(call => call.method === 'Runtime.removeBinding').length, 1);
  assert.ok((await f.exec('snapshot')).snapshot);
  await f.exec('release_tab');
});

test('keyboard dispatch always queues keyUp after a failed down acknowledgement', async () => {
  const f = fixture(); await f.claim();
  const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => {
    const result = await send(target, method, args);
    if (method === 'Input.dispatchKeyEvent' && args.type === 'rawKeyDown') throw new Error('Input blocked');
    return result;
  };
  await assert.rejects(f.exec('press_key', { key: 'Control+A' }), /Input blocked/);
  assert.deepEqual(f.calls.filter(call => call.method === 'Input.dispatchKeyEvent').map(call => call.args.type), ['rawKeyDown', 'keyUp']);
});

test('an inaccessible child frame does not prevent verified keyboard input in the main document', async () => {
  const f = fixture(); await f.claim();
  const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => {
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' }, childFrames: [{ frame: { id: 'remote' } }] } };
    if (method === 'Page.createIsolatedWorld' && args.frameId === 'remote') throw new Error('Frame belongs to another process');
    return send(target, method, args);
  };
  const result = await f.exec('press_key', { key: 'Enter' });
  assert.equal(result.delivery_verified, true);
  assert.equal(result.verification_omitted_frames[0].frame_id, 'remote');
});

test('type appends with native character keyDown text and keyUp, never insertText or a DOM fill setter', async () => {
  const f=fixture();await f.claim();
  const result=await f.exec('type',{selector:'#edit',text:'A中+',delay_ms:1});
  assert.equal(result.typed,3);assert.equal(result.events_trusted,true);
  const events=f.calls.filter(c=>c.method==='Input.dispatchKeyEvent').map(c=>c.args);
  assert.deepEqual(events.map(e=>e.type),['keyDown','keyUp','keyDown','keyUp','keyDown','keyUp']);
  assert.deepEqual(events.filter(e=>e.type==='keyDown').map(e=>e.text),['A','中','+']);
  assert.ok(!f.calls.some(c=>c.method==='Input.insertText'||c.args?.functionDeclaration?.includes('function prepareFill')));
});
