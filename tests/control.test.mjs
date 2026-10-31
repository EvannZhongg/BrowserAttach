import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, withChildFrames } from './helpers/controller-fixture.mjs';
import { controlOptions, readControlDOM } from '../extension/control.js';
import { installKeyReceipt } from '../extension/input.js';
import { describeTarget } from '../extension/target-description.js';
import { errorData, errorFromData } from '../extension/errors.js';
import { validateSteps } from '../extension/batch.js';

const ax = (id, backend, role, name, childIds = [], properties = []) => ({ nodeId: id, backendDOMNodeId: backend, role: { value: role }, name: { value: name }, childIds, properties });
const state = (name, value) => ({ name, value: { value } });
const relation = (name, backendDOMNodeId, idref) => ({ name, value: { relatedNodes: [{ backendDOMNodeId, idref }] } });

test('control facts preserve raw DOM state and explicit description sources without inferring a disabled reason', async () => {
  const attrs = { 'aria-disabled': 'true', 'aria-readonly': 'false', 'aria-required': 'true', 'aria-invalid': 'grammar',
    'aria-description': 'Direct ARIA explanation', 'aria-describedby': 'reason missing reason', title: 'Title explanation' };
  const element = { nodeType: 1, tagName: 'BUTTON', isConnected: true, id: 'delete', disabled: true, innerText: 'Delete',
    getAttribute: name => attrs[name] ?? null, getBoundingClientRect: () => ({ width: 20, height: 20 }), contains: () => false,
    getRootNode: () => ({ activeElement: null, getElementById: id => id === 'reason' ? { textContent: 'Disable the app first' } : null }),
    ownerDocument: { defaultView: { getComputedStyle: () => ({ visibility: 'visible' }) } } };
  const dom = readControlDOM.call(element, 30);
  assert.equal(dom.disabled, true); assert.equal(dom.aria_disabled, 'true'); assert.equal(dom.aria_invalid, 'grammar');
  assert.equal(dom.aria_readonly, 'false'); assert.equal(dom.aria_required, 'true');
  assert.equal(dom.aria_description, attrs['aria-description']); assert.equal(dom.title, attrs.title);
  assert.deepEqual(dom.descriptions, [{ source: 'aria-describedby', id: 'reason', available: true, text: 'Disable the app first' },
    { source: 'aria-describedby', id: 'missing', available: false }]);
  assert.equal(dom.disabled_reason, undefined);
  const f = controlFixture(); await f.claim();
  f.nodes[2].description = { value: 'Browser-resolved explanation' };
  const result = await f.exec('read_control', { selector: '#education' });
  assert.equal(result.control.ax.description, 'Browser-resolved explanation');
});

test('description reads are bounded, stay in the owning root and retain unavailable references', () => {
  const ids = Array.from({ length: 10 }, (_, i) => `hint-${i}`), lookups = [];
  const element = { nodeType: 1, tagName: 'DIV', isConnected: true, innerText: '',
    getAttribute: name => name === 'aria-describedby' ? ids.join(' ') : null, contains: () => false,
    getBoundingClientRect: () => ({ width: 20, height: 20 }),
    getRootNode: () => ({ getElementById: id => { lookups.push(id); return { textContent: 'x'.repeat(2000) }; } }),
    ownerDocument: { defaultView: { getComputedStyle: () => ({ visibility: 'visible' }) } } };
  const result = readControlDOM.call(element, 30);
  assert.equal(result.descriptions.length, 8); assert.equal(result.omitted_descriptions, 2);
  assert.deepEqual(lookups, ids.slice(0, 8)); assert.equal(result.descriptions[0].text.length, 1000); assert.equal(result.descriptions[0].text_truncated, true);
});
function controlFixture() {
  const f = fixture(), send = f.api.debugger.sendCommand;
  const nodes = [ax('root', 1, 'RootWebArea', '', ['button', 'control', 'popup', 'unrelated']),
    ax('button', 12, 'button', 'Submit'),
    { ...ax('control', 13, 'combobox', '学历', [], [state('expanded', true), relation('controls', 20, 'portal'), relation('activedescendant', 22, 'master')]), value: { value: '本科' } },
    ax('popup', 20, 'listbox', '', ['one', 'two']),
    ax('one', 21, 'option', '本科', [], [state('selected', true)]), ax('two', 22, 'option', '硕士'),
    ax('unrelated', 30, 'listbox', '', ['wrong']), ax('wrong', 31, 'option', '日语')];
  f.nodes(nodes);
  f.api.debugger.sendCommand = async (target, method, args) => {
    if (method === 'DOM.describeNode' && args.objectId === 'selector-node') return { node: { backendNodeId: 13 } };
    if (method === 'Runtime.callFunctionOn' && args.functionDeclaration.includes('function readControlDOM')) {
      f.calls.push({ target, method, args });
      return { result: { value: { tag: 'input', type: 'text', value: '', value_source: 'native_value', text: '', visible: true } } };
    }
    return send(target, method, args);
  };
  return { ...f, nodes };
}

test('targeted control reads preserve refs, separate native/AX values and scope options to explicit relations', async () => {
  const f = controlFixture(); await f.claim();
  const snapshot = await f.exec('snapshot'), oldRef = f.ref(snapshot);
  const result = await f.exec('read_control', { selector: '#education', max_options: 1 });
  assert.equal(result.control.dom.value, ''); assert.equal(result.control.ax.value, '本科');
  assert.equal(result.control.ax.expanded, true); assert.deepEqual(result.control.ax.activedescendant, ['master']);
  assert.equal(result.popups[0].relation, 'controls'); assert.equal(result.popups[0].id, 'portal');
  assert.equal(result.active_option.ax.name, '硕士'); assert.equal(result.active_option_status, 'observed');
  assert.equal(result.observed_options, 2); assert.equal(result.omitted_options, 1);
  assert.deepEqual(result.selected_options.map(item => item.ax.name), ['本科']);
  assert.ok(!JSON.stringify(result).includes('日语'));
  assert.equal(result.application_result, 'not_checked');
  const again = await f.exec('read_control', { selector: '#education' });
  assert.equal(again.control.ref, result.control.ref); assert.equal(again.active_option.ref, result.active_option.ref);
  assert.equal((await f.exec('click', { ref: oldRef })).delivery_verified, true);
  assert.equal((await f.exec('click', { ref: result.active_option.ref, mode: 'dom' })).method, 'dom');
  assert.ok(f.calls.some(call => call.method === 'Runtime.releaseObjectGroup' && call.args.objectGroup === 'browser-attach-control'));
});

test('control observation budgets truncate options without losing the active item, and refs detect identity changes', async () => {
  const f = controlFixture(); await f.claim();
  for (let i = 0; i < 40; i++) {
    const id = `extra${i}`; f.nodes[3].childIds.push(id); f.nodes.push(ax(id, 100 + i, 'option', 'x'.repeat(1000)));
  }
  const result = await f.exec('read_control', { selector: '#education', max_options: 40, max_chars: 4000 });
  assert.ok(JSON.stringify(result).length < 4000); assert.ok(result.omitted_options > 0);
  assert.equal(result.active_option.ax.name, '硕士');
  f.nodes[5].name.value = 'Replaced meaning';
  await assert.rejects(f.exec('click', { ref: result.active_option.ref }), error => error.diagnostics.cause === 'identity_changed');
});

test('popup text is a bounded preview at the CDP boundary without shrinking control text or option facts', async () => {
  const f = controlFixture(); await f.claim(); const send = f.api.debugger.sendCommand;
  let popupText = '';
  f.api.debugger.sendCommand = async (target, method, args) => {
    if (method === 'Runtime.callFunctionOn' && args.functionDeclaration.includes('function readControlDOM')) {
      assert.equal(args.functionDeclaration, readControlDOM.toString());
      const popup = args.objectId === 'object-20';
      const element = { nodeType: 1, tagName: 'DIV', isConnected: true, id: popup ? 'portal' : 'education',
        innerText: popup ? popupText : 'c'.repeat(700), getAttribute: () => null, contains: () => false,
        getRootNode: () => ({ activeElement: null }), getBoundingClientRect: () => ({ x: 0, y: 0, width: 100, height: 887 }),
        ownerDocument: { defaultView: { getComputedStyle: () => ({ visibility: 'visible' }) } } };
      return { result: { value: readControlDOM.call(element, ...args.arguments.map(arg => arg.value)) } };
    }
    return send(target, method, args);
  };
  for (const length of [0, 120, 121, 700]) {
    popupText = 'p'.repeat(length);
    const before = f.calls.filter(call => call.method === 'Accessibility.getFullAXTree').length;
    const result = await f.exec('read_control', { selector: '#education' });
    assert.equal(result.popups[0].dom.text, popupText.slice(0, 120));
    assert.equal(result.popups[0].dom.text_truncated, length > 120 ? true : undefined);
    assert.equal(result.control.dom.text.length, 700); assert.equal(result.control.dom.text_truncated, undefined);
    assert.deepEqual(result.options.map(option => option.ax.name), ['本科', '硕士']);
    assert.equal(result.active_option.ax.name, '硕士'); assert.equal(result.selected_options[0].ax.name, '本科');
    assert.equal(f.calls.filter(call => call.method === 'Accessibility.getFullAXTree').length - before, 1);
  }
});

test('explicit popup scopes are honored, active descendants do not imply popup ownership, and non-options stay distinct', async () => {
  const f = controlFixture(); await f.claim();
  f.nodes[2].properties = f.nodes[2].properties.filter(property => property.name !== 'controls');
  const isolated = await f.exec('read_control', { selector: '#education' });
  assert.equal(isolated.options.length, 0); assert.equal(isolated.popups.length, 0);
  assert.equal(isolated.active_option.ax.name, '硕士');
  const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => {
    if (method === 'Runtime.evaluate' && args.expression.includes('"#other-popup"')) return { result: { objectId: 'other-popup' } };
    if (method === 'DOM.describeNode' && args.objectId === 'other-popup') return { node: { backendNodeId: 30 } };
    return send(target, method, args);
  };
  const explicit = await f.exec('read_control', { selector: '#education', popup_selector: '#other-popup' });
  assert.equal(explicit.popups[0].relation, 'explicit_selector');
  assert.deepEqual(explicit.options.map(item => item.ax.name), ['日语']);
  f.nodes[5].role.value = 'button';
  const nonOption = await f.exec('read_control', { selector: '#education' });
  assert.equal(nonOption.active_option, null); assert.equal(nonOption.active_option_status, 'non_option');
  assert.equal(nonOption.active_descendant.ax.role, 'button');
});

test('selected items beyond the ordinary option limit retain their own identity', async () => {
  const f = controlFixture(); await f.claim();
  f.nodes[4].properties = [state('selected', false)]; f.nodes[5].properties = [state('selected', true)];
  const result = await f.exec('read_control', { selector: '#education', max_options: 1 });
  assert.equal(result.options[0].ax.name, '本科');
  assert.equal(result.selected_options[0].ax.name, '硕士');
  assert.equal(result.selected_options[0].ref, result.active_option.ref);
});

test('control reads reject late document/frame/control changes and release their isolated handles', async () => {
  for (const change of ['document', 'frame', 'claim']) {
    const f = controlFixture(); withChildFrames(f); await f.claim();
    const send = f.api.debugger.sendCommand;
    f.api.debugger.sendCommand = async (target, method, args) => {
      const result = await send(target, method, args);
      if (method === 'Accessibility.getFullAXTree') {
        if (change === 'claim') f.api.debugger.onDetach.emit({ tabId: 9 });
        else f.api.debugger.onEvent.emit({ tabId: 9 }, change === 'document' ? 'DOM.documentUpdated' : 'Page.frameNavigated', { frame: { id: 'ad', parentId: 'main' } });
      }
      return result;
    };
    await assert.rejects(f.exec('read_control', { selector: '#education', ...(change === 'frame' ? { frame_id: 'ad' } : {}) }), /changed|detached/);
    assert.ok(f.calls.some(call => call.method === 'Runtime.releaseObjectGroup' && call.args.objectGroup === 'browser-attach-control'));
  }
});

test('action observations keep delivery evidence on read errors/timeouts and never replay input', async () => {
  for (const fail of ['error', 'timeout', null]) {
    const f = controlFixture(); await f.claim(); const send = f.api.debugger.sendCommand;
    f.api.debugger.sendCommand = async (target, method, args) => {
      if (method === 'Runtime.callFunctionOn' && args.functionDeclaration.includes('function readControlDOM')) {
        if (fail === 'error') throw new Error('Observation failed after delivery');
        if (fail === 'timeout') return await new Promise(() => {});
      }
      return send(target, method, args);
    };
    const result = await f.exec('click', { selector: '#button', observe: { selector: '#education', timeout_ms: 100 } });
    assert.equal(result.delivery_verified, true); assert.equal(result.observation.available, !fail);
    assert.equal(result.application_result, 'not_checked');
    assert.equal(f.calls.filter(call => call.method === 'Input.dispatchMouseEvent' && call.args.type === 'mouseReleased').length, 1);
    assert.equal(f.calls.filter(call => ['tabs.update', 'windows.update', 'Page.bringToFront'].includes(call.method)).length, 0);
  }
});

test('failed input can carry independent control evidence through error serialization', async () => {
  const f = controlFixture(); await f.claim(); const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => {
    const result = await send(target, method, args);
    if (method === 'Input.dispatchMouseEvent' && args.type === 'mouseReleased') throw new Error('Release acknowledgement lost');
    return result;
  };
  await assert.rejects(f.exec('click', { selector: '#button', observe: { selector: '#education' } }), error => {
    assert.equal(error.input_dispatched, true); assert.equal(error.observation.available, true);
    const wire = errorFromData(JSON.parse(JSON.stringify(errorData(error))));
    assert.deepEqual(wire.observation, error.observation); return true;
  });
  assert.equal(f.calls.filter(call => call.method === 'Input.dispatchMouseEvent' && call.args.type === 'mouseReleased').length, 1);
});

test('drag observations share the original action deadline and cannot restart a fresh read budget', async () => {
  const f = controlFixture(); await f.claim(); const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => {
    if (method === 'Runtime.callFunctionOn' && args.functionDeclaration.includes('function readControlDOM')) return await new Promise(() => {});
    const result = await send(target, method, args);
    if (method === 'Runtime.callFunctionOn' && args.functionDeclaration.includes('function installDragReceipt')) return { result: { objectId: 'drag-guard' } };
    if (method === 'Input.dispatchMouseEvent') {
      const binding = f.calls.findLast(call => call.method === 'Runtime.addBinding')?.args.name;
      f.api.debugger.onEvent.emit(target, 'Runtime.bindingCalled', { name: binding, executionContextId: 42,
        payload: JSON.stringify({ type: { mousePressed: 'pointerdown', mouseReleased: 'pointerup', mouseMoved: 'pointermove' }[args.type] }) });
    }
    return result;
  };
  const start = performance.now();
  const result = await f.exec('drag', { source: { x: 50, y: 50 }, destination: { x: 200, y: 50 }, steps: 2,
    timeout_ms: 1000, observe: { selector: '#education', timeout_ms: 5000 } });
  assert.equal(result.delivery_verified, true); assert.equal(result.observation.available, false);
  assert.ok(performance.now() - start < 3000);
  assert.equal(f.calls.filter(call => call.method === 'Input.dispatchMouseEvent' && call.args.type === 'mouseReleased').length, 1);
});

test('observation validation precedes batch writes; 30 steps and an observed suffix are accepted, 31 are rejected', async () => {
  const f = controlFixture(); await f.claim(); f.calls.length = 0;
  await assert.rejects(f.exec('batch', { steps: [{ action: 'click', selector: '#button' }, { action: 'press_key', key: 'Tab', observe: { selector: '#education', max_options: 0 } }] }), /max_options/);
  assert.equal(f.calls.length, 0);
  for (const args of [{}, { selector: 'x', timeout_ms: 6000 }, { selector: 'x', popup_selector: '' }]) assert.throws(() => controlOptions(args));
  const steps = Array.from({ length: 30 }, () => ({ action: 'press_key', key: 'Tab' }));
  validateSteps(steps); assert.throws(() => validateSteps([...steps, steps[0]]), /1..30/);
  const complete = await f.exec('batch', { steps });
  assert.equal(complete.completed, true); assert.equal(complete.results.length, 30);
  const result = await f.exec('batch', { steps, start_at: 29, observe: { selector: '#education' } });
  assert.equal(result.completed, true); assert.equal(result.results.length, 1); assert.equal(result.observation.available, true);
});

test('failed-step and whole-batch observations remain separate without replaying the failed step', async () => {
  const f = controlFixture(); await f.claim(); const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => {
    const result = await send(target, method, args);
    if (method === 'Input.dispatchMouseEvent' && args.type === 'mouseReleased') throw new Error('Lost acknowledgement');
    return result;
  };
  const result = await f.exec('batch', { steps: [{ action: 'click', selector: '#button', observe: { selector: '#education', max_options: 1 } }], observe: { selector: '#education', max_options: 2 } });
  assert.equal(result.completed, false); assert.equal(result.input_dispatched, true);
  assert.equal(result.failed_step_observation.options.length, 1); assert.equal(result.observation.options.length, 2);
  assert.equal(f.calls.filter(call => call.method === 'Input.dispatchMouseEvent' && call.args.type === 'mouseReleased').length, 1);
});

test('native control facts preserve empty values, mixed checkbox state and password redaction', () => {
  const input = { nodeType: 1, tagName: 'INPUT', isConnected: true, id: 'field', type: 'checkbox', value: '', innerText: '',
    checked: false, indeterminate: true, readOnly: false, getAttribute: () => null,
    getBoundingClientRect: () => ({ width: 10, height: 10 }), contains: () => false,
    getRootNode: () => ({ activeElement: null }), ownerDocument: { defaultView: { getComputedStyle: () => ({ visibility: 'visible' }) } } };
  const result = readControlDOM.call(input, 30);
  assert.equal(result.value, ''); assert.equal(result.checked, false); assert.equal(result.indeterminate, true);
  input.type = 'password'; input.value = 'secret'; input.getAttribute = () => 'secret';
  const password = readControlDOM.call(input, 30);
  assert.equal(password.value_redacted, true); assert.equal(password.value, undefined);
  assert.equal(password.aria_valuetext, undefined); assert.equal(password.aria_valuenow, undefined);
});

test('keyboard target guards refuse wrong focus before dispatch and report actual targets on delivery', async () => {
  const f = fixture(); await f.claim(); const send = f.api.debugger.sendCommand;
  let matches = false;
  f.api.debugger.sendCommand = async (target, method, args) => {
    if (method === 'Runtime.callFunctionOn' && args.functionDeclaration.startsWith('function matchesKeyboardFocus')) return { result: { value: matches } };
    return send(target, method, args);
  };
  await assert.rejects(f.exec('press_key', { selector: '#expected', key: 'Enter' }), error => {
    assert.equal(error.input_dispatched, false); assert.equal(error.diagnostics.reason, 'keyboard_focus_mismatch');
    assert.equal(error.diagnostics.focused_target.id, 'edit'); return true;
  });
  assert.equal(f.calls.filter(call => call.method === 'Input.dispatchKeyEvent').length, 0);
  matches = true;
  const result = await f.exec('press_key', { selector: '#expected', key: 'Enter' });
  assert.equal(result.delivery_verified, true); assert.equal(result.target_verified, true);
  assert.equal(result.keyboard_target.received.id, 'edit'); assert.equal(result.keyboard_target.frame_id, 'main');
});

test('a keyboard target change after dispatch remains an unknown outcome and still queues keyUp', async () => {
  const f = fixture(); await f.claim(); const emit = f.api.debugger.onEvent.emit;
  f.api.debugger.onEvent.emit = (target, method, params) => emit(target, method, method === 'Runtime.bindingCalled' ? {
    ...params, payload: JSON.stringify({ delivered: true, matched: false, target: { tag: 'body' } }),
  } : params);
  await assert.rejects(f.exec('press_key', { selector: '#expected', key: 'Enter' }), error => {
    assert.equal(error.input_dispatched, true); assert.equal(error.diagnostics.reason, 'keyboard_target_changed');
    assert.equal(error.diagnostics.received_target.tag, 'body'); return true;
  });
  assert.deepEqual(f.calls.filter(call => call.method === 'Input.dispatchKeyEvent').map(call => call.args.type), ['rawKeyDown', 'char', 'keyUp']);
});

test('an unavailable guard in the requested child frame fails before dispatch rather than omitting target verification', async () => {
  const f = fixture(); withChildFrames(f); await f.claim(); const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => {
    if (method === 'Page.createIsolatedWorld' && args.frameId === 'ad' && args.worldName === 'browser-attach-input') throw new Error('Expected frame verification unavailable');
    return send(target, method, args);
  };
  await assert.rejects(f.exec('press_key', { selector: 'input', frame_id: 'ad', key: 'Enter' }), error => {
    assert.equal(error.input_dispatched, false); assert.match(error.message, /Expected frame verification unavailable/); return true;
  });
  assert.ok(!f.calls.some(call => call.method === 'Input.dispatchKeyEvent'));
});

test('trusted key receipts use the composed event target and stop mismatches without reading input values', () => {
  const saved = { add: globalThis.addEventListener, remove: globalThis.removeEventListener }, reports = [];
  const target = { nodeType: 1, tagName: 'INPUT', id: 'actual', classList: [], getAttribute: () => null, type: 'password', value: 'secret' };
  let listener, prevented = false;
  globalThis.addEventListener = (type, callback) => { listener = callback; };
  globalThis.removeEventListener = () => {};
  globalThis.__testReceipt = payload => reports.push(JSON.parse(payload));
  try {
    const guard = installKeyReceipt('__testReceipt', { code: 'Enter', key: 'Enter', modifiers: 0 }, 1000, describeTarget, { isConnected: true });
    const event = { isTrusted: false, code: 'Enter', key: 'Enter', composedPath: () => [target], preventDefault() { prevented = true; }, stopImmediatePropagation() {} };
    listener(event); assert.equal(reports.length, 0);
    listener({ ...event, isTrusted: true }); guard.stop();
    assert.equal(prevented, true); assert.equal(reports[0].matched, false); assert.equal(reports[0].target.id, 'actual');
    assert.ok(!JSON.stringify(reports).includes('secret'));
  } finally { globalThis.addEventListener = saved.add; globalThis.removeEventListener = saved.remove; delete globalThis.__testReceipt; }
});
