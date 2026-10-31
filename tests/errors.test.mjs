import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { checkedValue, errorData, errorFromData } from '../extension/errors.js';
import { fixture } from './helpers/controller-fixture.mjs';

test('isolated selector diagnostics survive action, wait, text and batch boundaries without input', async () => {
  const f = fixture(); await f.claim();
  const original = f.api.debugger.sendCommand;
  const remoteErrors = new Map();
  let released = 0;
  const element = { nodeType: 1, tagName: 'BUTTON', textContent: 'Choice', matches: () => false, closest: () => null,
    getBoundingClientRect: () => ({ width: 10, height: 10 }), ownerDocument: { defaultView: { getComputedStyle: () => ({ visibility: 'visible' }) } } };
  const document = { querySelectorAll(selector) { if (selector === '[') throw new SyntaxError('Invalid selector'); return selector === '.missing' ? [] : [element, element]; } };
  f.api.debugger.sendCommand = async (target, method, args) => {
    if (method === 'Runtime.evaluate' && args.expression.includes('function queryElement')) {
      try {
        const value = vm.runInNewContext(args.expression, { document });
        return { result: { value, type: typeof value, ...(value === null ? { subtype: 'null' } : {}) } };
      } catch (error) {
        const objectId = `error-${remoteErrors.size}`; remoteErrors.set(objectId, error);
        return { exceptionDetails: { exception: { objectId, description: error.message } } };
      }
    }
    if (method === 'Runtime.callFunctionOn' && remoteErrors.has(args.objectId)) {
      const value = vm.runInNewContext(`(${args.functionDeclaration})`).call(remoteErrors.get(args.objectId));
      return { result: { value: JSON.parse(JSON.stringify(value)) } };
    }
    if (method === 'Runtime.releaseObject' && remoteErrors.has(args.objectId)) { released++; return {}; }
    return original(target, method, args);
  };
  const cases = [
    ['click', { selector: 'button' }, 'selector_ambiguous'],
    ['fill', { selector: '[', text: 'secret' }, 'selector_invalid'],
    ['click', { selector: '.missing', timeout_ms: 100 }, 'selector_not_found'],
    ['click', { selector: 'button', nth: 3, timeout_ms: 100 }, 'selector_nth_out_of_range'],
    ['read_text', { selector: '.missing' }, 'selector_not_found'],
    ['read_text', { selector: 'button', nth: 3 }, 'selector_nth_out_of_range'],
    ['wait', { selector: 'button', condition: 'attached' }, 'selector_ambiguous'],
  ];
  for (const [command, args, reason] of cases) {
    await assert.rejects(f.exec(command, args), error => {
      assert.equal(error.diagnostics.reason, reason);
      assert.equal(error.diagnostics.frame_id, 'main');
      if (args.nth != null) { assert.equal(error.diagnostics.nth, args.nth); assert.equal(error.diagnostics.matched, 2); }
      if (command !== 'read_text') assert.equal(error.input_dispatched, false);
      const wire = errorFromData(JSON.parse(JSON.stringify(errorData(error))));
      assert.deepEqual(wire.diagnostics, error.diagnostics);
      return true;
    });
  }
  const frame = await f.exec('batch', { steps: [{ action: 'click', selector: 'button', frame: { path: ['button'] } }] });
  assert.equal(frame.diagnostics.reason, 'frame_locator');
  assert.equal(frame.diagnostics.cause, 'selector_ambiguous');
  assert.equal(frame.diagnostics.path_index, 0);
  assert.equal(frame.retry_failed_step_safe, true);
  const batch = await f.exec('batch', { steps: [{ action: 'click', selector: 'button' }] });
  assert.equal(batch.diagnostics.reason, 'selector_ambiguous');
  assert.equal(batch.failed_step, 0); assert.equal(batch.retry_failed_step_safe, true);
  assert.equal(released, remoteErrors.size);
  assert.ok(!f.calls.some(call => call.method.startsWith('Input.')));
});

test('unavailable remote diagnostics preserve the original exception and release its wrapper', async () => {
  const released = [];
  await assert.rejects(checkedValue({ exceptionDetails: { exception: { objectId: 'exception' } } }, async (method, args) => {
    if (method === 'Runtime.callFunctionOn') throw new Error('Context destroyed');
    released.push(args.objectId);
  }, () => { throw new Error('Original query error'); }), /Original query error/);
  assert.deepEqual(released, ['exception']);
});
