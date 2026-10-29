import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, withChildFrames } from './helpers/controller-fixture.mjs';
import { domCapture } from './helpers/fields-fixture.mjs';
import { actionObservationOptions } from '../extension/observation-options.js';
import { errorData, errorFromData } from '../extension/errors.js';

const nodes = value => [
  { nodeId: 'root', role: { value: 'RootWebArea' }, name: { value: 'Demo' }, childIds: ['button', 'field'] },
  { nodeId: 'button', backendDOMNodeId: 12, role: { value: 'button' }, name: { value: 'Submit' } },
  { nodeId: 'field', backendDOMNodeId: 13, role: { value: 'textbox' }, name: { value: 'Name' }, value: { value } },
];
const releases = f => f.calls.filter(call => call.method === 'Input.dispatchMouseEvent' && call.args.type === 'mouseReleased').length;
const reads = f => f.calls.filter(call => call.method === 'Accessibility.getFullAXTree').length;

test('latest establishes a full baseline, then resolves the current diff id without caller state', async () => {
  const f = fixture(); await f.claim();
  const first = await f.exec('snapshot', { diff_since: 'latest', profile: 'interactive' });
  assert.equal(first.mode, 'full'); assert.equal(first.reset_reason, 'no_baseline'); assert.equal(first.base_snapshot_id, undefined);
  const second = await f.exec('snapshot', { diff_since: 'latest' });
  assert.equal(second.mode, 'diff'); assert.equal(second.base_snapshot_id, first.snapshot_id); assert.deepEqual(second.changes, []);
  assert.equal(second.profile, 'interactive'); assert.equal(second.reset_reason, undefined);
  await assert.rejects(f.exec('snapshot', { diff_since: first.snapshot_id }), /baseline.*stale/);
  await f.exec('click', { ref: f.ref(first) });
  assert.deepEqual((await f.exec('snapshot', { diff_since: 'latest' })).changes, []);
});

test('latest resets on view changes and retires old refs only after a successful full result', async () => {
  const f = fixture(); await f.claim(); const first = await f.exec('snapshot', { profile: 'interactive' });
  await assert.rejects(f.exec('snapshot', { diff_since: 'latest', profile: 'full', max_chars: 1 }), /requires max_chars/);
  await f.exec('click', { ref: f.ref(first) });
  const second = await f.exec('snapshot', { diff_since: 'latest', profile: 'full' });
  assert.equal(second.mode, 'full'); assert.equal(second.reset_reason, 'view_changed'); assert.equal(second.profile, 'full');
  await assert.rejects(f.exec('click', { ref: f.ref(first) }), error => error.diagnostics?.cause === 'snapshot_replaced');
  await assert.rejects(f.exec('snapshot', { diff_since: second.snapshot_id, query: 'Submit' }), /original.*query/);
  const query = await f.exec('snapshot', { diff_since: 'latest', query: 'Submit' });
  assert.equal(query.reset_reason, 'view_changed'); assert.equal(query.query, 'Submit'); assert.equal(query.node_count, 1);
});

test('latest refuses unread pages and returns the surviving cursor even when the requested view changes', async () => {
  const f = fixture(); await f.claim(); const first = await f.exec('snapshot', { max_nodes: 1 });
  const count = reads(f);
  await assert.rejects(f.exec('snapshot', { diff_since: 'latest', profile: 'interactive' }), error => {
    assert.equal(error.diagnostics.cause, 'unread_pages'); assert.equal(error.diagnostics.snapshot_id, first.snapshot_id);
    assert.equal(error.diagnostics.next_cursor, first.next_cursor); return true;
  });
  assert.equal(reads(f), count);
  await f.exec('snapshot', { cursor: first.next_cursor });
  assert.equal((await f.exec('snapshot', { diff_since: 'latest' })).mode, 'diff');
});

test('latest reports a null cursor when earlier input expired an unfinished baseline', async () => {
  const f = fixture(); await f.claim(); const first = await f.exec('snapshot', { max_nodes: 2 });
  await f.exec('click', { ref: f.ref(first) });
  await assert.rejects(f.exec('snapshot', { diff_since: 'latest' }), error => error.diagnostics?.cause === 'unread_pages' && error.diagnostics.next_cursor === null);
});

test('fields and invalidated frame baselines reset explicitly; new frame read failures remain coverage facts', async () => {
  const f = fixture(); withChildFrames(f); await f.claim();
  const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => method === 'DOMSnapshot.captureSnapshot'
    ? domCapture([{ frameId: 'main', nodes: [] }]) : send(target, method, args);
  await f.exec('snapshot', { profile: 'fields' });
  const full = await f.exec('snapshot', { diff_since: 'latest' });
  assert.equal(full.mode, 'full'); assert.equal(full.reset_reason, 'unsupported_view'); assert.equal(full.profile, 'full');
  f.api.debugger.onEvent.emit({ tabId: 9 }, 'Page.frameNavigated', { frame: { id: 'ad', parentId: 'main' } });
  const reset = await f.exec('snapshot', { diff_since: 'latest' });
  assert.equal(reset.reset_reason, 'incomplete_frame_coverage');
  f.api.debugger.sendCommand = async (target, method, args) => {
    if (method === 'Accessibility.getFullAXTree' && args.frameId === 'ad') throw new Error('Frame unavailable');
    return send(target, method, args);
  };
  const incomplete = await f.exec('snapshot', { diff_since: 'latest' });
  assert.equal(incomplete.mode, 'full'); assert.equal(incomplete.reset_reason, 'incomplete_frame_coverage');
  assert.ok(incomplete.omitted_frames.some(frame => frame.frame_id === 'ad'));
  assert.equal(incomplete.changes, undefined);
});

test('latest recovers one document race with an explicit full reset and the same view', async () => {
  const f = fixture(); await f.claim(); const first = await f.exec('snapshot', { profile: 'interactive' });
  const send = f.api.debugger.sendCommand; let captured = 0;
  f.api.debugger.sendCommand = async (target, method, args) => {
    if (method === 'Accessibility.getFullAXTree' && ++captured === 1) f.api.debugger.onEvent.emit(target, 'DOM.documentUpdated');
    return send(target, method, args);
  };
  const reset = await f.exec('snapshot', { diff_since: 'latest' });
  assert.equal(reset.mode, 'full'); assert.equal(reset.reset_reason, 'document_changed'); assert.equal(reset.profile, 'interactive');
  assert.equal(captured, 2);
  await assert.rejects(f.exec('click', { ref: f.ref(first) }), error => error.diagnostics?.cause === 'document_updated');
});

test('latest never recovers across a lost claim or another owner', async () => {
  const f = fixture(); await f.claim(); await f.exec('snapshot');
  await assert.rejects(f.exec('snapshot', { diff_since: 'latest' }, 'two'), /not claimed/);
  const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => {
    if (method === 'Accessibility.getFullAXTree') f.api.debugger.onDetach.emit({ tabId: 9 });
    return send(target, method, args);
  };
  await assert.rejects(f.exec('snapshot', { diff_since: 'latest' }), error => error.diagnostics?.reason === 'control_changed');
});

test('snapshot observe validates its own shape without accepting implicit modes or control locators', () => {
  assert.equal(actionObservationOptions({ diff_since: 'latest' }), 'snapshot');
  assert.equal(actionObservationOptions({ selector: '#field' }), 'control');
  for (const args of ['auto', {}, { diff_since: null }, { diff_since: '' }, { diff_since: 'latest', selector: '#field' },
    { diff_since: 'latest', profile: 'fields' }, { diff_since: 'latest', cursor: 'x' }, { diff_since: 'latest', max_nodes: 0 },
    { diff_since: 'latest', timeout_ms: 30001 }, { diff_since: 'latest', max_chars: 0 }]) assert.throws(() => actionObservationOptions(args));
});

test('click plus latest observes once after dispatch, preserving delivery and stable refs', async () => {
  const f = fixture(); f.nodes(nodes('Old')); await f.claim(); const baseline = await f.exec('snapshot', { profile: 'interactive' });
  const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => {
    const result = await send(target, method, args);
    if (method === 'Input.dispatchMouseEvent' && args.type === 'mouseReleased') f.nodes(nodes('New'));
    return result;
  };
  const clicked = await f.exec('click', { ref: f.ref(baseline), observe: { diff_since: 'latest' } });
  assert.equal(clicked.delivery_verified, true); assert.equal(clicked.application_result, 'not_checked');
  assert.equal(clicked.observation.available, true); assert.equal(clicked.observation.kind, 'snapshot');
  assert.equal(clicked.observation.mode, 'diff'); assert.equal(clicked.observation.base_snapshot_id, baseline.snapshot_id);
  assert.match(JSON.stringify(clicked.observation.changes), /New/); assert.equal(releases(f), 1); assert.equal(reads(f), 2);
  await f.exec('click', { ref: f.ref(baseline) });
});

test('fill supports an explicit diff observation without replacing its successful value verification', async () => {
  const f = fixture(); f.nodes(nodes('Old')); await f.claim(); const baseline = await f.exec('snapshot');
  const field = baseline.snapshot.match(/\[([^\]]+)\] textbox/)[1], send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => {
    const result = await send(target, method, args);
    if (method === 'Runtime.callFunctionOn' && args.functionDeclaration.includes('function verifyFill')) f.nodes(nodes('Filled'));
    return result;
  };
  const filled = await f.exec('fill', { ref: field, text: 'Filled', observe: { diff_since: baseline.snapshot_id } });
  assert.equal(filled.filled, true); assert.equal(filled.value_verified, true); assert.equal(filled.observation.available, true);
  assert.match(JSON.stringify(filled.observation.changes), /Filled/);
  assert.equal(f.calls.filter(call => call.method === 'Input.insertText').length, 1);
});

test('unread or malformed observation requests fail before input and preserve pagination', async () => {
  const f = fixture(); await f.claim(); const baseline = await f.exec('snapshot', { max_nodes: 1 });
  await assert.rejects(f.exec('click', { selector: '#button', observe: { diff_since: 'latest' } }), error => {
    assert.equal(error.input_dispatched, false); assert.equal(error.diagnostics.next_cursor, baseline.next_cursor); return true;
  });
  for (const observe of [{ diff_since: 'stale' }, { diff_since: 'latest', selector: '#mixed' }, { diff_since: 'latest', max_nodes: 0 }]) {
    await assert.rejects(f.exec('click', { selector: '#button', observe }), error => error.input_dispatched === false);
  }
  assert.equal(releases(f), 0); assert.ok((await f.exec('snapshot', { cursor: baseline.next_cursor })).snapshot);
});

test('latest observation without a baseline captures full only after the action', async () => {
  const f = fixture(); await f.claim();
  const result = await f.exec('click', { selector: '#button', observe: { diff_since: 'latest' } });
  assert.equal(result.observation.mode, 'full'); assert.equal(result.observation.reset_reason, 'no_baseline');
  assert.equal(result.observation.available, true);
  assert.ok(f.calls.findIndex(call => call.method === 'Accessibility.getFullAXTree') > f.calls.findIndex(call => call.method === 'Input.dispatchMouseEvent' && call.args.type === 'mouseReleased'));
});

test('action navigation resets latest against the bound view, while an explicit id reports observation failure', async () => {
  for (const latest of [true, false]) {
    const f = fixture(); await f.claim(); const baseline = await f.exec('snapshot', { profile: 'interactive' });
    const send = f.api.debugger.sendCommand;
    f.api.debugger.sendCommand = async (target, method, args) => {
      const result = await send(target, method, args);
      if (method === 'Input.dispatchMouseEvent' && args.type === 'mouseReleased') f.api.debugger.onEvent.emit(target, 'DOM.documentUpdated');
      return result;
    };
    const clicked = await f.exec('click', { ref: f.ref(baseline), observe: { diff_since: latest ? 'latest' : baseline.snapshot_id } });
    assert.equal(clicked.delivery_verified, true); assert.equal(releases(f), 1);
    assert.equal(clicked.observation.available, latest);
    if (latest) {
      assert.equal(clicked.observation.mode, 'full'); assert.equal(clicked.observation.reset_reason, 'document_changed');
      assert.equal(clicked.observation.profile, 'interactive'); assert.equal(clicked.observation.base_snapshot_id, undefined);
    } else assert.equal(clicked.observation.diagnostics.reason, 'diff_baseline_invalid');
  }
});

test('snapshot read failure leaves the action successful and does not advance the baseline or replay input', async () => {
  const f = fixture(); await f.claim(); const baseline = await f.exec('snapshot'), send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => {
    if (method === 'Accessibility.getFullAXTree') throw new Error('Accessibility unavailable');
    return send(target, method, args);
  };
  const clicked = await f.exec('click', { ref: f.ref(baseline), observe: { diff_since: 'latest' } });
  assert.equal(clicked.delivery_verified, true); assert.equal(clicked.observation.available, false); assert.equal(releases(f), 1);
  f.api.debugger.sendCommand = send;
  assert.equal((await f.exec('snapshot', { diff_since: 'latest' })).base_snapshot_id, baseline.snapshot_id);
});

test('snapshot observation shares the action deadline and late AX cannot publish a new baseline', async () => {
  const f = fixture(); await f.claim(); const baseline = await f.exec('snapshot'), send = f.api.debugger.sendCommand;
  let finish;
  f.api.debugger.sendCommand = async (target, method, args) => {
    if (method === 'Accessibility.getFullAXTree') await new Promise(resolve => { finish = resolve; });
    return send(target, method, args);
  };
  const start = performance.now();
  const clicked = await f.exec('click', { ref: f.ref(baseline), timeout_ms: 500, observe: { diff_since: 'latest', timeout_ms: 30000 } });
  assert.ok(performance.now() - start < 2000); assert.equal(clicked.delivery_verified, true);
  assert.equal(clicked.observation.available, false); assert.equal(clicked.observation.diagnostics.reason, 'snapshot_timeout'); assert.equal(releases(f), 1);
  finish(); await new Promise(resolve => setImmediate(resolve)); f.api.debugger.sendCommand = send;
  assert.equal((await f.exec('snapshot', { diff_since: 'latest' })).base_snapshot_id, baseline.snapshot_id);
});

test('uncertain dispatched input can carry independent diff evidence through serialization without replay', async () => {
  const f = fixture(); f.nodes(nodes('Old')); await f.claim(); const baseline = await f.exec('snapshot'), send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => {
    const result = await send(target, method, args);
    if (method === 'Input.dispatchMouseEvent' && args.type === 'mouseReleased') { f.nodes(nodes('Changed')); throw new Error('Release acknowledgement lost'); }
    return result;
  };
  await assert.rejects(f.exec('click', { ref: f.ref(baseline), observe: { diff_since: 'latest' } }), error => {
    assert.equal(error.input_dispatched, true); assert.equal(error.observation.available, true); assert.equal(error.observation.mode, 'diff');
    assert.match(JSON.stringify(error.observation.changes), /Changed/);
    assert.deepEqual(errorFromData(JSON.parse(JSON.stringify(errorData(error)))).observation, error.observation); return true;
  });
  assert.equal(releases(f), 1);
});

test('batch binds one snapshot baseline before steps and observes only once at the end', async () => {
  const f = fixture(); await f.claim(); const baseline = await f.exec('snapshot');
  const batch = await f.exec('batch', { steps: [{ action: 'click', selector: '#one' }, { action: 'click', selector: '#two' }], observe: { diff_since: 'latest' } });
  assert.equal(batch.completed, true); assert.equal(batch.results.length, 2); assert.equal(releases(f), 2);
  assert.equal(batch.observation.available, true); assert.equal(batch.observation.base_snapshot_id, baseline.snapshot_id); assert.equal(reads(f), 2);
  await assert.rejects(f.exec('batch', { steps: [{ action: 'click', selector: '#one' }, { action: 'click', selector: '#two', observe: { diff_since: 'latest' } }] }), /target|selector|ref/i);
  assert.equal(releases(f), 2);
});

test('partial post-action diffs use ordinary snapshot cursors and cannot be silently skipped by latest', async () => {
  const f = fixture(); f.nodes(nodes('Old')); await f.claim(); const baseline = await f.exec('snapshot'), send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => {
    const result = await send(target, method, args);
    if (method === 'Input.dispatchMouseEvent' && args.type === 'mouseReleased') {
      const changed = nodes('New'); changed[1].name.value = 'Renamed'; f.nodes(changed);
    }
    return result;
  };
  const clicked = await f.exec('click', { ref: f.ref(baseline), observe: { diff_since: 'latest', max_nodes: 1 } });
  const first = clicked.observation; assert.equal(first.truncated, true); assert.ok(first.next_cursor);
  await assert.rejects(f.exec('snapshot', { diff_since: 'latest' }), error => error.diagnostics?.next_cursor === first.next_cursor);
  const next = await f.exec('snapshot', { cursor: first.next_cursor });
  assert.equal(next.mode, 'diff'); assert.equal(next.snapshot_id, first.snapshot_id); assert.equal(next.truncated, false);
});

test('latest never advertises an invalidated diff continuation as a usable cursor', async () => {
  const f = fixture(); withChildFrames(f); f.nodes(nodes('Old')); await f.claim(); await f.exec('snapshot');
  const changed = nodes('Changed'); changed[1].name.value = 'Renamed'; f.nodes(changed);
  const page = await f.exec('snapshot', { diff_since: 'latest', max_nodes: 1 }); assert.ok(page.next_cursor);
  f.api.debugger.onEvent.emit({ tabId: 9 }, 'Page.frameNavigated', { frame: { id: 'ad', parentId: 'main' } });
  await assert.rejects(f.exec('snapshot', { diff_since: 'latest' }), error => error.diagnostics?.cause === 'unread_pages' && error.diagnostics.next_cursor === null);
});
