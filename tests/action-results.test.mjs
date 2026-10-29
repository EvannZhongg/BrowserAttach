import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/controller-fixture.mjs';
import { createEvaluations } from '../extension/evaluate.js';
import { errorData } from '../extension/errors.js';

test('completed JSON survives source changes as bounded historical evidence, never as a new cursor or ref', async () => {
  for (const kind of ['json', 'element']) {
    let finish;
    const evaluations = createEvaluations(() => new Promise(resolve => { finish = resolve; }));
    const pending = evaluations.read(9, { expression: 'once()', result_type: kind, max_chars: 3, evaluation_frame: 'main' });
    evaluations.invalidate(9, 'same_document_navigation');
    finish({ result: kind === 'element' ? { subtype: 'node', objectId: 'old-node' } : { value: { value: [1, 2], truncated: false } } });
    if (kind === 'element') await assert.rejects(pending, error => error.diagnostics.reason === 'evaluation_source_changed');
    else {
      const result = await pending;
      assert.equal(result.execution_completed, true); assert.equal(result.source_current, false);
      assert.equal(result.source_changed, 'same_document_navigation'); assert.deepEqual(result.value, [1]);
      assert.equal(result.has_more, true); assert.equal(result.continuation_unavailable, true); assert.equal(result.next_cursor, null);
    }
    await assert.rejects(evaluations.read(9, { cursor: 'anything' }), /stale/);
  }
});

test('controller distinguishes ordinary mutations, route changes and control loss during evaluation', async () => {
  for (const change of ['mutation', 'route', 'document', 'detach']) {
    const f = fixture(); await f.claim(); const send = f.api.debugger.sendCommand;
    let executions = 0;
    f.api.debugger.sendCommand = async (target, method, args) => {
      if (method === 'Runtime.evaluate' && args.awaitPromise) {
        executions++;
        if (change === 'detach') f.api.debugger.onDetach.emit(target);
        else f.api.debugger.onEvent.emit(target, change === 'mutation' ? 'DOM.childNodeInserted' : change === 'route' ? 'Page.navigatedWithinDocument' : 'DOM.documentUpdated', { frameId: 'main' });
        return { result: { value: { value: 7, truncated: false } } };
      }
      return send(target, method, args);
    };
    const pending = f.exec('evaluate', { expression: 'once()' });
    if (change === 'detach') await assert.rejects(pending, /control ended/);
    else { const result = await pending; assert.equal(result.value, 7); assert.equal(result.source_current, change === 'mutation'); }
    assert.equal(executions, 1);
  }
});

function waitFixture() {
  const f = fixture(), send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => {
    if (method === 'Runtime.evaluate' && args.expression === 'location.href') return { result: { value: f.tabs.get(9)?.url } };
    return send(target, method, args);
  };
  return f;
}

test('one click waits across route/document replacement, preserves the queue and observes only afterwards', async () => {
  for (const sameDocument of [true, false]) {
    const f = waitFixture(); await f.claim(); const send = f.api.debugger.sendCommand;
    let waiting = false;
    f.api.debugger.sendCommand = async (target, method, args) => {
      const result = await send(target, method, args);
      if (method === 'Input.dispatchMouseEvent' && args.type === 'mouseReleased') {
        setTimeout(() => {
          f.tabs.get(9).url = 'http://localhost:8000/result';
          f.api.debugger.onEvent.emit(target, sameDocument ? 'Page.navigatedWithinDocument' : 'Page.frameNavigated', { frameId: 'main', frame: { id: 'main', url: f.tabs.get(9).url } });
        }, 50);
      }
      if (method === 'Runtime.evaluate' && args.expression === 'location.href') waiting = true;
      return result;
    };
    const action = f.exec('click', { selector: '#submit', timeout_ms: 1500, wait_for: { checks: [{ condition: 'url', expected: '/result' }], timeout_ms: 1000 }, observe: { diff_since: 'latest' } });
    const queuedRead = f.exec('snapshot').then(result => { assert.equal(waiting, true); return result; });
    const result = await action;
    assert.equal(result.delivery_verified, true); assert.equal(result.wait_result.status, 'pass');
    assert.equal(result.observation.available, true); await queuedRead;
    assert.equal(f.calls.filter(call => call.method === 'Input.dispatchMouseEvent' && call.args.type === 'mousePressed').length, 1);
  }
});

test('unmet or unavailable waits preserve action receipt; batch stops without replaying that step', async () => {
  for (const batch of [true, false]) {
    const f = waitFixture(); await f.claim();
    const input = { selector: '#submit', wait_for: { checks: [{ condition: 'url', expected: '/missing' }], timeout_ms: 150 } };
    const result = await f.exec(batch ? 'batch' : 'click', batch ? { steps: [{ action: 'click', ...input }, { action: 'click', selector: '#other' }] } : input);
    const receipt = batch ? result.results[0] : result;
    assert.equal(receipt.delivery_verified, true); assert.equal(receipt.wait_result.status, 'fail');
    if (batch) { assert.equal(result.completed, false); assert.equal(result.retry_failed_step_safe, false); assert.equal(result.failed_step, 0); }
    assert.equal(f.calls.filter(call => call.method === 'Input.dispatchMouseEvent' && call.args.type === 'mousePressed').length, 1);
  }
  const f = waitFixture(); await f.claim(); const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => {
    const result = await send(target, method, args);
    if (method === 'Input.dispatchMouseEvent' && args.type === 'mouseReleased') f.api.debugger.onDetach.emit(target);
    return result;
  };
  const result = await f.exec('click', { x: 20, y: 20, wait_for: { checks: [{ condition: 'url', expected: '/result' }] } });
  assert.equal(result.delivery_verified, true); assert.equal(result.wait_result.status, 'unavailable');
});

test('wait_for is validated before any batch input and its budget cannot restart the action deadline', async () => {
  const f = waitFixture(); await f.claim();
  await assert.rejects(f.exec('batch', { steps: [{ action: 'click', selector: '#submit' }, { action: 'click', selector: '#other', wait_for: { checks: [{ condition: 'url' }] } }] }), /url wait requires/);
  assert.ok(!f.calls.some(call => call.method.startsWith('Input.')));
  const start = Date.now();
  const result = await f.exec('click', { selector: '#submit', timeout_ms: 200, wait_for: { checks: [{ condition: 'url', expected: '/missing' }], timeout_ms: 10000 } });
  assert.equal(result.delivery_verified, true); assert.notEqual(result.wait_result.status, 'pass');
  assert.ok(Date.now() - start < 1500);
});

test('post-action waits never inherit automatic dialog handling, even in a batch', async () => {
  const f = waitFixture(); await f.claim(); const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => {
    if (method === 'Runtime.evaluate' && args.expression === 'location.href') f.api.debugger.onEvent.emit(target, 'Page.javascriptDialogOpening', { type: 'confirm', message: 'During wait' });
    return send(target, method, args);
  };
  const result = await f.exec('batch', { dialog_policy: 'accept', steps: [{ action: 'click', selector: '#submit', wait_for: { checks: [{ condition: 'url', expected: '/missing' }], timeout_ms: 150 } }] });
  assert.equal(result.results[0].delivery_verified, true); assert.equal(result.results[0].wait_result.status, 'unavailable');
  assert.ok(!f.calls.some(call => call.method === 'Page.handleJavaScriptDialog'));
});

test('successful click receipts are compact by default, detailed on demand; recovery hints remain specific', async () => {
  const f = fixture(); await f.claim();
  const compact = await f.exec('click', { selector: '#submit' });
  const detailed = await f.exec('click', { selector: '#submit', detailed: true });
  assert.equal(compact.delivery_verified, true); assert.equal(compact.hit_target, undefined); assert.equal(compact.page_state, undefined); assert.equal(compact.title, undefined);
  assert.ok(detailed.hit_target); assert.ok(detailed.page_state);
  assert.ok(errorData(Object.assign(new Error('value'), { diagnostics: { reason: 'value_not_retained' } })).recovery.includes('profile="fields"'));
  assert.equal(errorData(new Error('unrelated')).recovery, undefined);
});

test('source changes during evaluation preparation prevent expression execution', async () => {
  const f = fixture(); await f.claim(); const send = f.api.debugger.sendCommand;
  let executions = 0;
  f.api.debugger.sendCommand = async (target, method, args) => {
    const result = await send(target, method, args);
    if (method === 'Page.getFrameTree') f.api.debugger.onEvent.emit(target, 'Page.navigatedWithinDocument', { frameId: 'main' });
    if (method === 'Runtime.evaluate' && args.awaitPromise) executions++;
    return result;
  };
  await assert.rejects(f.exec('evaluate', { expression: 'write()' }), error => error.input_dispatched === false && /no expression was executed/.test(error.message));
  assert.equal(executions, 0);
});

test('a post-action condition can pass without converting an unknown input receipt into success', async () => {
  const f = waitFixture(); await f.claim(); const send = f.api.debugger.sendCommand;
  const emit = f.api.debugger.onEvent.emit;
  f.api.debugger.onEvent.emit = (target, method, args) => { if (method !== 'Runtime.bindingCalled') emit(target, method, args); };
  f.api.debugger.sendCommand = async (target, method, args) => {
    const result = await send(target, method, args);
    if (method === 'Input.dispatchMouseEvent' && args.type === 'mouseReleased') f.tabs.get(9).url = 'http://localhost:8000/result';
    return result;
  };
  await assert.rejects(f.exec('click', { selector: '#submit', timeout_ms: 3000, wait_for: { checks: [{ condition: 'url', expected: '/result' }] } }), error => {
    const wire = errorData(error);
    assert.equal(wire.input_dispatched, true); assert.equal(wire.outcome_unknown, true);
    assert.equal(wire.wait_result.status, 'pass'); assert.equal(wire.diagnostics.reason, 'delivery_unverified'); return true;
  });
  assert.equal(f.calls.filter(call => call.method === 'Input.dispatchMouseEvent' && call.args.type === 'mousePressed').length, 1);
});

test('post-action verification rechecks access before reading a new document', async () => {
  const f = waitFixture(); await f.claim(); const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => {
    const result = await send(target, method, args);
    if (method === 'Input.dispatchMouseEvent' && args.type === 'mouseReleased') f.tabs.get(9).url = 'file:///C:/private.html';
    return result;
  };
  f.api.extension.isAllowedFileSchemeAccess = async () => false;
  const result = await f.exec('click', { selector: '#submit', wait_for: { checks: [{ condition: 'url', expected: 'private.html' }] } });
  assert.equal(result.delivery_verified, true); assert.equal(result.wait_result.status, 'unavailable');
  assert.match(result.wait_result.error, /Local file access/);
});

test('a source change while waiting after evaluation cannot return a stale continuation as current', async () => {
  const f = waitFixture(); await f.claim(); const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => {
    if (method === 'Runtime.evaluate' && args.awaitPromise) {
      setTimeout(() => {
        f.tabs.get(9).url = 'http://localhost:8000/result';
        f.api.debugger.onEvent.emit(target, 'Page.navigatedWithinDocument', { frameId: 'main' });
      }, 50);
      return { result: { value: { value: [1, 2], truncated: false } } };
    }
    return send(target, method, args);
  };
  const result = await f.exec('evaluate', { expression: 'once()', max_chars: 3, wait_for: { checks: [{ condition: 'url', expected: '/result' }] } });
  assert.equal(result.wait_result.status, 'pass'); assert.equal(result.source_current, false);
  assert.equal(result.source_changed, 'source_changed_after_execution'); assert.equal(result.next_cursor, null);
  assert.equal(result.continuation_unavailable, true); assert.deepEqual(result.value, [1]);
});
