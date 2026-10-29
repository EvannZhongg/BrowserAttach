import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { waitFor, waitOptions } from '../extension/wait.js';
import { validateSteps } from '../extension/batch.js';
import { fixture } from './helpers/controller-fixture.mjs';

function field(properties = {}) {
  return { nodeType: 1, isConnected: true, tagName: 'INPUT', type: 'text', value: '', innerText: '',
    getAttribute: () => null, matches: () => false, closest: () => null, hasAttribute: () => false, getRootNode: () => ({ host: null }),
    getBoundingClientRect: () => ({ x: 10, y: 10, width: 20, height: 20 }),
    ownerDocument: { defaultView: { getComputedStyle: () => ({ visibility: 'visible', display: 'block' }) } }, ...properties };
}

function harness(query, options = {}) {
  const calls = [];
  let polls = 0;
  const cdp = async (target, method, args) => {
    calls.push({ target, method, args });
    if (options.onCall) {
      const result = await options.onCall(target, method, args);
      if (result !== undefined) return result;
    }
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 2 };
    if (method === 'Accessibility.getFullAXTree') return { nodes: options.roles ?? [] };
    if (method === 'DOM.resolveNode') return { object: { objectId: String(args.backendNodeId) } };
    if (method === 'DOM.describeNode') return { node: { backendNodeId: 11 } };
    if (method === 'Runtime.callFunctionOn') {
      const node = options.nodes?.[args.objectId];
      return { result: { value: vm.runInNewContext(`(${args.functionDeclaration}).call(node, args)`, { node, args: args.arguments?.[0]?.value }) } };
    }
    if (method === 'Runtime.evaluate') {
      if (args.expression === 'location.href') return { result: { value: 'https://test/result' } };
      polls++;
      const result = vm.runInNewContext(args.expression, { document: { querySelectorAll: selector => query(selector, polls),
        evaluate: selector => { const nodes = query(selector, polls); return { snapshotLength: nodes.length, snapshotItem: index => nodes[index] }; } },
        XPathResult: { ORDERED_NODE_SNAPSHOT_TYPE: 7 } });
      return { result: args.returnByValue ? { value: JSON.parse(JSON.stringify(result)) } : { objectId: 'selector-node' } };
    }
    return {};
  };
  const sessions = { frames: async () => { options.onFrames?.(); return options.frames ?? [{ id: 'main' }]; }, target: () => ({ tabId: 1 }) };
  const network = { networkStatus: () => ({ inflight: 0, idle_ms: 1000, tracking_overflow: false, ...options.network }) };
  const pointer = { prepare: async () => {} };
  return { calls, get polls() { return polls; }, run: (checks, timeout_ms = 150, context = {}) =>
    waitFor(cdp, result => result.result.value, sessions, network, pointer, 1, { checks, timeout_ms }, context) };
}

test('verification prevalidates every check and effective batch dialog policy', () => {
  const valid = { selector: '#rows', condition: 'count', expected: 0 };
  waitOptions({ checks: [valid, { selector: '#name', condition: 'value_present', expected: false, not: true }] });
  for (const args of [
    { checks: [] }, { checks: Array(31).fill(valid) }, { checks: [valid], condition: 'url' },
    { checks: [valid], selector: '#a' }, { checks: [valid], idle_ms: 500 }, { checks: [valid], dialog_policy: 'accept' },
    ...[{ ...valid, expected: -1 }, { ...valid, expected: 1.5 }, { ...valid, nth: 0 }, { ...valid, ref: 'r' },
      { ...valid, not: 'true' }, { ...valid, condition: 'value_present', expected: '' },
      { ...valid, condition: 'text', expected: 'a', idle_ms: 100 }, { ...valid, checks: [valid] }].map(check => ({ checks: [check] })),
  ]) assert.throws(() => waitOptions(args));
  const steps = [{ action: 'click', selector: '#submit' }, { action: 'wait', checks: [valid] }];
  assert.throws(() => validateSteps(steps, 0, 'accept'), /dialog_policy=ask/);
  validateSteps([steps[0], { ...steps[1], dialog_policy: 'ask' }], 0, 'accept');
});

test('one DOM sample returns complete expected/actual results without field values or exact expectations', async () => {
  const h = harness(selector => selector === '#name' ? [field({ value: 'secret-value' })] : [field(), field()]);
  const result = await h.run([
    { selector: '#name', condition: 'value_present', expected: true },
    { selector: '#rows', condition: 'count', expected: 3 },
    { selector: '#name', condition: 'value', expected: 'secret-expectation' },
  ]);
  assert.equal(result.status, 'fail'); assert.equal(result.timed_out, true); assert.equal(result.retry_safe, true);
  assert.deepEqual(result.failed, [1, 2]); assert.deepEqual(result.unavailable, []);
  assert.equal(result.results[1].expected, 3); assert.equal(result.results[1].actual.count, 2);
  assert.equal(result.results[0].actual.present, true); assert.equal(result.results[2].actual.matches, false);
  assert.ok(!JSON.stringify(result).includes('secret-'));
  assert.ok(h.calls.filter(call => call.method === 'Runtime.evaluate').every(call => call.args.expression.includes('function inspectChecks')));
  assert.ok(!h.calls.some(call => call.method.startsWith('Input.') || call.method === 'DOM.scrollIntoViewIfNeeded'));
});

test('checks must pass in the same round and never latch alternating successes', async () => {
  const h = harness((selector, poll) => (selector === '#a') === (poll % 2 === 1) ? [field()] : []);
  const result = await h.run(['#a', '#b'].map(selector => ({ selector, condition: 'attached' })), 200);
  assert.ok(h.polls >= 2); assert.equal(result.status, 'fail'); assert.equal(result.failed.length, 1);
  assert.equal(result.results.filter(item => item.status === 'pass').length, 1);
});

test('negation preserves unavailable state and missing scalar targets; boolean false is explicit', async () => {
  const h = harness(selector => selector === '#missing' ? [] : [field({ innerText: 'Ready', value: ' ' })]);
  const result = await h.run([
    { selector: '#missing', condition: 'text', expected: 'Error', not: true },
    { selector: '#state', condition: 'checked', expected: false, not: true },
    { selector: '#state', condition: 'text', expected: 'Error', not: true },
    { selector: '#state', condition: 'value_present', expected: false },
    { selector: '#missing', condition: 'attached', not: true },
    { selector: '#state', condition: 'value_present', expected: true },
  ]);
  assert.equal(result.status, 'fail'); assert.deepEqual(result.unavailable, [0, 1]); assert.deepEqual(result.failed, [3]);
  assert.equal(result.results[2].status, 'pass'); assert.equal(result.results[4].status, 'pass');
  assert.equal(result.results[5].status, 'pass');
});

test('count allows sets in CSS/XPath/AX without relaxing ordinary selector uniqueness', async () => {
  const nodes = [field(), field()];
  const h = harness(() => nodes, { roles: [
    { nodeId: '1', backendDOMNodeId: 11, role: { value: 'option' }, name: { value: 'A' } },
    { nodeId: '2', backendDOMNodeId: 12, role: { value: 'option' }, name: { value: 'B' } },
    { nodeId: '3', backendDOMNodeId: 11, role: { value: 'option' }, name: { value: 'A' } },
    { nodeId: '4', backendDOMNodeId: 14, role: { value: 'option' }, ignored: true },
  ] });
  const result = await h.run([
    { selector: '.row', condition: 'count', expected: 2 },
    { selector: '//li', selector_type: 'xpath', condition: 'count', expected: 2 },
    { selector: 'option', selector_type: 'role', condition: 'count', expected: 2 },
  ]);
  assert.equal(result.status, 'pass'); assert.equal(result.timed_out, false);
  assert.ok(!h.calls.some(call => call.method === 'DOM.resolveNode'));
  await assert.rejects(h.run([{ selector: '.row', condition: 'attached' }]), error => error.diagnostics.reason === 'selector_ambiguous');
  await assert.rejects(h.run([{ selector: 'option', selector_type: 'role', condition: 'absent' }]), error => error.diagnostics.reason === 'selector_ambiguous');
  const textNodes = harness(() => [{ nodeType: 3 }]);
  await assert.rejects(textNodes.run([{ selector: '//text()', selector_type: 'xpath', condition: 'count', expected: 1 }]), /elements/);
});

test('missing frames and unavailable AX do not prevent healthy DOM checks', async () => {
  const h = harness(() => [field()], { onCall: async (target, method) => {
    if (method === 'Accessibility.getFullAXTree') throw new Error('AX unavailable');
  } });
  const result = await h.run([
    { selector: '#field', frame: { url: 'https://missing/' }, condition: 'absent' },
    { selector: 'textbox', selector_type: 'role', condition: 'value_present', expected: true },
    { selector: '#healthy', condition: 'attached' },
  ]);
  assert.equal(result.status, 'unavailable'); assert.deepEqual(result.unavailable, [0, 1]);
  assert.equal(result.results[2].status, 'pass');
});

test('a slow group cannot starve another frame; incomplete rounds never reuse old successes', async () => {
  const h = harness(() => [field()], { frames: [{ id: 'main' }, { id: 'slow' }], onCall: async (target, method, args) => {
    if (method === 'Page.createIsolatedWorld' && args.frameId === 'slow') return await new Promise(() => {});
  } });
  const result = await h.run([
    { selector: '#slow', frame_id: 'slow', condition: 'attached' },
    { selector: '#healthy', condition: 'attached' },
  ], 320);
  assert.equal(result.results[0].status, 'unavailable');
  assert.ok(h.calls.some(call => call.method === 'Runtime.evaluate' && call.args.expression.includes('function inspectChecks')));
  if (result.results[1].status !== 'pass') assert.equal(result.results[1].actual.reason, 'not_observed_in_round');
  assert.equal(result.results[0].actual.reason, 'observation_timeout');
});

test('document/frame changes during a round invalidate sampled results and control loss stays an error', async () => {
  for (const scope of ['document', 'frame']) {
    let version = 0;
    const h = harness(() => { version++; return [field()]; });
    const context = scope === 'document' ? { documentVersion: () => version } : { frameVersion: () => version };
    const result = await h.run([{ selector: '#field', condition: 'attached' }], 120, context);
    assert.equal(result.status, 'unavailable'); assert.equal(result.results[0].actual.reason, `${scope}_changed_during_round`);
  }
  let owned = true;
  const h = harness(() => { owned = false; return [field()]; });
  await assert.rejects(h.run([{ selector: '#field', condition: 'attached' }], 150, {
    assertClaim() { if (!owned) throw new Error('Control ended'); },
  }), /Control ended/);
});

test('role checks re-resolve live properties, reject disconnected nodes and release temporary objects', async () => {
  const node = field({ type: 'checkbox', checked: false });
  let reads = 0;
  const h = harness(() => [], { roles: [{ nodeId: '1', backendDOMNodeId: 11, role: { value: 'checkbox' } }], nodes: { 11: node },
    onCall: async (target, method) => {
      if (method === 'Runtime.callFunctionOn') { reads++; node.isConnected = reads > 1; node.checked = true; }
    } });
  const result = await h.run([{ selector: 'checkbox', selector_type: 'role', condition: 'checked', expected: true }], 300);
  assert.equal(result.status, 'pass'); assert.ok(reads >= 2);
  assert.ok(h.calls.some(call => call.method === 'Runtime.releaseObjectGroup'));
});

test('a later AX group cannot overwrite the frame identity of an earlier DOM sample', async () => {
  let version = 0, resolutions = 0;
  const h = harness(() => [field()], { roles: [{ nodeId: '1', backendDOMNodeId: 11, role: { value: 'textbox' } }],
    onFrames() { if (++resolutions % 2 === 0) version++; } });
  const result = await h.run([
    { selector: '#field', condition: 'attached' },
    { selector: 'textbox', selector_type: 'role', condition: 'count', expected: 1 },
  ], 150, { frameVersion: () => version });
  assert.equal(result.status, 'unavailable'); assert.deepEqual(result.unavailable, [0, 1]);
  assert.ok(result.results.every(item => item.actual.reason === 'frame_changed_during_round'));
});

test('actionability requires stable geometry and a read-only hit check, including negation', async () => {
  const h = harness(() => [field()]);
  const positive = await h.run([{ selector: '#button', condition: 'actionable' }], 300);
  assert.equal(positive.status, 'pass'); assert.ok(h.polls >= 2);
  const disabled = harness(() => [field({ matches: () => true })]);
  assert.equal((await disabled.run([{ selector: '#button', condition: 'actionable', not: true }])).status, 'pass');
  assert.ok(!h.calls.some(call => call.method.startsWith('Input.') || call.method === 'DOM.scrollIntoViewIfNeeded'));
});

test('global checks retain expected/actual and network overflow cannot pass negation', async () => {
  const h = harness(() => [], { network: { tracking_overflow: true } });
  const result = await h.run([{ condition: 'url', expected: '/result' }, { condition: 'network_idle', not: true }]);
  assert.equal(result.status, 'unavailable'); assert.equal(result.results[0].actual.url, 'https://test/result');
  assert.deepEqual(result.unavailable, [1]);
});

test('batch stops at verification fail/unavailable and rejects unsafe policy before the first input', async () => {
  for (const state of ['fail', 'unavailable']) {
    const f = fixture(); await f.claim(); const send = f.api.debugger.sendCommand;
    f.api.debugger.sendCommand = async (target, method, args) => {
      if (method === 'Runtime.evaluate' && args.expression.includes('function inspectChecks')) return { result: { value: [state === 'fail'
        ? { satisfied: false, count: 0 } : { satisfied: false, state: 'unavailable' }] } };
      return send(target, method, args);
    };
    const checks = [{ selector: '#row', condition: 'count', expected: 1 }];
    const steps = [{ action: 'click', selector: '#before' }, { action: 'wait', checks, timeout_ms: 100 }, { action: 'click', selector: '#after' }];
    await assert.rejects(f.exec('batch', { steps, dialog_policy: 'accept' }), /dialog_policy=ask/);
    assert.ok(!f.calls.some(call => call.method.startsWith('Input.')));
    const result = await f.exec('batch', { steps });
    assert.equal(result.completed, false); assert.equal(result.failed_step, 1); assert.equal(result.results.length, 1);
    assert.equal(result.verification.status, state); assert.equal(result.retry_failed_step_safe, true);
    assert.equal(f.calls.filter(call => call.method === 'Input.dispatchMouseEvent' && call.args.type === 'mousePressed').length, 1);
  }
});

test('verification leaves an existing dialog untouched and returns unavailable through the controller', async () => {
  const f = fixture(); await f.claim();
  f.api.debugger.onEvent.emit({ tabId: 9 }, 'Page.javascriptDialogOpening', { type: 'confirm', message: 'Leave untouched' });
  const result = await f.exec('wait', { checks: [{ condition: 'url', expected: 'localhost' }], timeout_ms: 100 });
  assert.equal(result.status, 'unavailable'); assert.equal(result.results[0].actual.reason, 'dialog_open');
  assert.equal(result.retry_safe, true); assert.ok(!f.calls.some(call => call.method === 'Page.handleJavaScriptDialog'));
});
