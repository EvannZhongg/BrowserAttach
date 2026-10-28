import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { selectElement, selectOptions } from '../extension/input.js';
import { waitFor, inspectWait, waitOptions } from '../extension/wait.js';
import { createNetworkTracker } from '../extension/network.js';

function selectFixture() {
  const events = [];
  class Select {
    set selectedIndex(index) { this.index = index; this.options.forEach((o, i) => { o.selected = i === index; }); }
    get selectedIndex() { return this.index; }
  }
  const field = new Select();
  Object.assign(field, { tagName: 'SELECT', isConnected: true, matches: () => false, closest: () => null,
    hasAttribute: () => false, getRootNode: () => ({}),
    options: [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }, { value: 'c', label: 'Beta' }],
    ownerDocument: { defaultView: { HTMLSelectElement: Select, Event: class { constructor(type) { this.type = type; this.isTrusted = false; } } } },
    dispatchEvent: event => events.push(event),
  });
  return { field, events };
}

test('select matches exact label/value/index, rejects ambiguity/disabled options and reports retained selection', () => {
  const { field, events } = selectFixture();
  assert.equal(selectElement.call(field, { label: 'Alpha' }).value_verified, true);
  assert.equal(selectElement.call(field, { value: 'b' }).index, 1);
  assert.throws(() => selectElement.call(field, { label: 'Beta' }), /matched 2/);
  field.options[2].disabled = true;
  assert.throws(() => selectElement.call(field, { index: 2 }), /disabled/);
  assert.equal(events.length, 4);assert.ok(events.every(e => e.isTrusted === false));
  field.dispatchEvent = () => { field.selectedIndex = 0; };
  assert.throws(() => selectElement.call(field, { value: 'b' }), /did not retain.*unknown/);
  for (const args of [{}, { value: 'a', index: 0 }, { index: -1 }]) assert.throws(() => selectOptions(args));
});

test('select preparation changes nothing and inherited inert across a slot or shadow host blocks selection', () => {
  const { field, events } = selectFixture();
  assert.equal(selectElement.call(field, { value: 'b' }, false), true);
  assert.equal(events.length, 0); assert.equal(field.selectedIndex, undefined);
  const host = { matches: () => false, hasAttribute: name => name === 'inert' };
  field.getRootNode = () => ({ host });
  assert.throws(() => selectElement.call(field, { value: 'b' }), /inert/);
  field.getRootNode = () => ({}); field.assignedSlot = host;
  assert.throws(() => selectElement.call(field, { value: 'b' }), /inert/);
  assert.equal(events.length, 0);
});

test('text wait without selector gives a condition-specific whole-page example', () => {
  assert.throws(() => waitOptions({ condition: 'text', expected: 'Ready' }), /text wait requires a reusable selector.*body/);
  waitOptions({ condition: 'text', selector: 'body', expected: 'Ready' });
});

test('wait failures include the requested condition and the last absent/hidden/disabled state', async () => {
  const sessions = { frames: async () => [{ id: 'main' }], target: () => ({ tabId: 1 }) };
  for (const [condition, state] of [['attached', 'absent'], ['visible', 'hidden'], ['actionable', 'disabled']]) {
    const calls = [];
    const cdp = async (target, method) => { calls.push(method); return method === 'Page.createIsolatedWorld' ? { executionContextId: 2 } : { result: { value: { satisfied: false, state } } }; };
    await assert.rejects(waitFor(cdp, r => r.result.value, sessions, null, null, 1, { selector: '#target', condition, timeout_ms: 100 }), error => {
      assert.match(error.message, new RegExp(`Wait for ${condition}.*#target.*current=.*${state}`)); return true;
    });
    assert.ok(!calls.some(m => m.startsWith('Input.') || m.startsWith('DOM.')));
  }
  for (const args of [{ condition: 'url' }, { condition: 'attached', ref: 'old' }, { condition: 'network_idle', selector: 'button' }]) assert.throws(() => waitOptions(args));
});

test('visible waits accept disabled elements while actionable waits report the disabled reason', () => {
  const field = { getBoundingClientRect: () => ({ width: 10, height: 10 }), ownerDocument: { defaultView: { getComputedStyle: () => ({ visibility: 'visible' }) } } };
  const query = () => field, inspect = () => ({ ready: false, reason: 'disabled' });
  assert.equal(inspectWait(query, inspect, { condition: 'visible' }).satisfied, true);
  assert.equal(inspectWait(query, inspect, { condition: 'actionable' }).reason, 'disabled');
});

test('network idle uses passive request tracking and does not claim quiet while a request is inflight', async () => {
  const network = createNetworkTracker();network.start(1);
  network.event({ tabId: 1 }, 'Network.requestWillBeSent', { requestId: 'a', request: { url: 'https://test/', method: 'GET' } });
  const run = () => waitFor(null, null, null, network, null, 1, { condition: 'network_idle', idle_ms: 100, timeout_ms: 150 });
  await assert.rejects(run(), /inflight.*1/);
  network.event({ tabId: 1 }, 'Network.loadingFinished', { requestId: 'a' });
  assert.equal((await run()).satisfied, true);
});


test('text waits can observe any change from full previous text without knowing the next value', () => {
  const field={innerText:'Before'},query=()=>field;
  assert.equal(inspectWait(query,null,{condition:'text',previous:'Before'}).satisfied,false);
  field.innerText='After';
  assert.equal(inspectWait(query,null,{condition:'text',previous:'Before'}).satisfied,true);
  waitOptions({condition:'text',selector:'#state',previous:''});
  assert.throws(()=>waitOptions({condition:'text',selector:'#state',previous:'old',expected:'new'}),/exactly one/);
});

test('text waits use rendered text for both substring and full previous-value comparisons', () => {
  const field = { innerText: 'Loading', textContent: 'Loading window.ready = true; Ready' }, query = () => field;
  assert.equal(inspectWait(query, null, { condition: 'text', expected: 'Ready' }).satisfied, false);
  assert.equal(inspectWait(query, null, { condition: 'text', previous: 'Loading' }).satisfied, false);
  field.innerText = 'Ready';
  assert.equal(inspectWait(query, null, { condition: 'text', expected: 'Ready' }).satisfied, true);
  assert.equal(inspectWait(query, null, { condition: 'text', previous: 'Loading' }).satisfied, true);
  field.innerText = 'x'.repeat(600) + ' Ready';
  assert.equal(inspectWait(query, null, { condition: 'text', expected: 'Ready' }).satisfied, true);
  assert.equal(inspectWait(query, null, { condition: 'text', previous: field.innerText }).satisfied, false);
  assert.equal(inspectWait(query, null, { condition: 'text', expected: 'Ready' }).text.length, 500);
  const diagnostic = inspectWait(query, null, { condition: 'text', previous: field.innerText });
  assert.equal(diagnostic.total_chars, 606); assert.equal(diagnostic.text_truncated, true);
  assert.match(diagnostic.hint, /full rendered text.*result\/status container.*complete prior innerText/);
  field.innerText = '';
  assert.equal(inspectWait(query, null, { condition: 'text', expected: 'Ready' }).satisfied, false);
  assert.equal(inspectWait(query, null, { condition: 'text', expected: 'Ready' }).text_truncated, false);
});

test('state waits compare explicit native/ARIA state and never interpret missing state as false', () => {
  const check = (element, condition, expected) => inspectWait(() => element, null, { condition, expected });
  const input = { tagName: 'INPUT', type: 'checkbox', checked: false, indeterminate: true };
  assert.equal(check(input, 'checked', 'mixed').satisfied, true);
  assert.equal(check(input, 'checked', false).satisfied, false);
  input.indeterminate = false;
  assert.equal(check(input, 'checked', false).satisfied, true);
  input.type = 'radio'; input.checked = true;
  assert.equal(check(input, 'checked', true).satisfied, true);
  assert.equal(check({ tagName: 'OPTION', selected: true }, 'selected', true).satisfied, true);
  assert.equal(check({ tagName: 'DETAILS', open: false }, 'expanded', false).satisfied, true);
  for (const condition of ['checked', 'selected', 'expanded']) {
    for (const value of [null, '', 'invalid', 'undefined']) {
      const result = check({ getAttribute: () => value }, condition, false);
      assert.equal(result.satisfied, false); assert.equal(result.state, 'unavailable'); assert.equal(result.value, null);
    }
    for (const value of [false, true]) assert.equal(check({ getAttribute: () => String(value) }, condition, value).satisfied, true);
  }
  assert.equal(check({ getAttribute: () => 'mixed' }, 'checked', 'mixed').satisfied, true);
  for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
    const field = { tagName, value: 'exact value' };
    assert.equal(check(field, 'value', 'exact').satisfied, false);
    const result = check(field, 'value', 'exact value');
    assert.equal(result.satisfied, true); assert.ok(!JSON.stringify(result).includes('exact value'));
  }
  assert.equal(check({ isContentEditable: true, innerText: 'a\nb' }, 'value', 'a\nb').satisfied, true);
  assert.equal(check({ textContent: 'fake value' }, 'value', 'fake value').state, 'unavailable');
  assert.equal(check(null, 'checked', false).satisfied, false);
  assert.equal(check(null, 'absent').satisfied, true);
  assert.equal(check({}, 'absent').satisfied, false);
});

test('new wait arguments validate before batch input, including false and mixed without truthiness coercion', () => {
  for (const args of [
    { condition: 'value', expected: '' }, { condition: 'checked', expected: false },
    { condition: 'checked', expected: 'mixed' }, { condition: 'selected', expected: true },
    { condition: 'expanded', expected: false }, { condition: 'absent' },
  ]) waitOptions({ selector: '#field', ...args });
  for (const args of [
    { condition: 'value', expected: true }, { condition: 'checked', expected: 'false' },
    { condition: 'selected', expected: 'mixed' }, { condition: 'expanded' },
    { condition: 'absent', expected: false }, { condition: 'value', expected: 'x', previous: '' },
  ]) assert.throws(() => waitOptions({ selector: '#field', ...args }));
});

test('value and absence waits re-resolve replacement nodes and preserve ambiguity without issuing input', async () => {
  const sessions = { frames: async () => [{ id: 'main' }], target: () => ({ tabId: 1 }) };
  let fields = [{ tagName: 'INPUT', value: 'before', nodeType: 1 }], polls = 0;
  const calls = [];
  const cdp = async (target, method, args) => {
    calls.push(method);
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 2 };
    if (method === 'Runtime.evaluate') {
      polls++;
      if (polls === 2) fields = [{ tagName: 'INPUT', value: 'after', nodeType: 1 }];
      const result = vm.runInNewContext(args.expression, { document: { querySelectorAll: () => fields } });
      return { result: { value: result } };
    }
  };
  const run = args => waitFor(cdp, r => r.result.value, sessions, null, null, 1, { selector: '#field', timeout_ms: 300, ...args });
  assert.equal((await run({ condition: 'value', expected: 'after' })).satisfied, true);
  assert.equal(polls, 2);
  fields = [];
  assert.equal((await run({ condition: 'absent' })).satisfied, true);
  fields = [1, 2].map(() => ({ nodeType: 1, textContent: '', tagName: 'INPUT',
    getBoundingClientRect: () => ({ width: 10, height: 10 }), matches: () => false, closest: () => null,
    ownerDocument: { defaultView: { getComputedStyle: () => ({ visibility: 'visible' }) } } }));
  await assert.rejects(run({ condition: 'absent' }), /matched 2/);
  assert.ok(calls.every(method => ['Page.getFrameTree', 'Page.createIsolatedWorld', 'Runtime.evaluate'].includes(method)));
});

test('role absence and state waits use live AX targets, including missing-state timeout without leaking field values', async () => {
  const sessions = { frames: async () => [{ id: 'main' }], target: () => ({ tabId: 1 }) };
  let present = false;
  const cdp = async (target, method) => {
    if (method === 'Accessibility.getFullAXTree') return { nodes: present ? [{ nodeId: 'a', backendDOMNodeId: 12, role: { value: 'checkbox' } }] : [] };
    if (method === 'DOM.resolveNode') return { object: { objectId: 'node' } };
    if (method === 'Runtime.callFunctionOn') return { result: { value: { satisfied: false, state: 'unavailable' } } };
    return {};
  };
  const run = args => waitFor(cdp, r => r.result.value, sessions, null, null, 1, { selector: 'checkbox', selector_type: 'role', timeout_ms: 100, ...args });
  assert.equal((await run({ condition: 'absent' })).satisfied, true);
  present = true;
  await assert.rejects(run({ condition: 'checked', expected: false }), error => {
    assert.equal(error.input_dispatched, false); assert.equal(error.diagnostics.current.state, 'unavailable'); return true;
  });
  await assert.rejects(run({ condition: 'value', expected: 'secret-password' }), error => {
    assert.ok(!error.message.includes('secret-password')); return true;
  });
});

test('read-only role waits retry replaced nodes and do not accept state from a disconnected wrapper', async () => {
  const sessions = { frames: async () => [{ id: 'main' }], target: () => ({ tabId: 1 }) };
  let observations = 0;
  const cdp = async (target, method, args) => {
    if (method === 'Accessibility.getFullAXTree') {
      observations++;
      return { nodes: [{ nodeId: 'a', backendDOMNodeId: observations, role: { value: 'checkbox' } }] };
    }
    if (method === 'DOM.resolveNode') {
      if (observations === 1) throw new Error('No node with given id found');
      return { object: { objectId: 'node' } };
    }
    if (method === 'Runtime.callFunctionOn') return { result: { value: vm.runInNewContext(`(${args.functionDeclaration}).call(field, args)`, {
      field: { tagName: 'INPUT', type: 'checkbox', checked: true, isConnected: observations > 2 }, args: args.arguments[0].value,
    }) } };
    assert.equal(method, 'Runtime.releaseObjectGroup'); return {};
  };
  const result = await waitFor(cdp, r => r.result.value, sessions, null, null, 1,
    { selector: 'checkbox', selector_type: 'role', condition: 'checked', expected: true, timeout_ms: 500 });
  assert.equal(result.satisfied, true); assert.equal(observations, 3);
});
