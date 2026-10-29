import test from 'node:test';
import assert from 'node:assert/strict';
import { snapshotDiff } from '../extension/snapshot-diff.js';
import { snapshotOptions, snapshotPage } from '../extension/snapshot.js';
import { fixture, withChildFrames } from './helpers/controller-fixture.mjs';
import { domCapture } from './helpers/fields-fixture.mjs';

const ax = (nodeId, role, name = '', childIds = [], extra = {}) =>
  ({ nodeId, role: { value: role }, name: { value: name }, childIds, ...extra });
const tree = () => [ax('root', 'RootWebArea', 'Demo', ['group', 'other']),
  ax('group', 'group', 'Results', ['a', 'b']),
  ax('a', 'button', 'Same', [], { backendDOMNodeId: 12 }),
  ax('b', 'textbox', 'Name', [], { backendDOMNodeId: 13, value: { value: '' } }),
  ax('other', 'button', 'Other', [], { backendDOMNodeId: 14 })];
const ref = (snapshot, role, name) => snapshot.snapshot.split('\n').find(line => line.includes(`${role} ${JSON.stringify(name)}`)).match(/\[([^\]]+)\]/)[1];
const stripRefs = text => text.replace(/\[[a-f\d]{8}:[^\]\n]+\]/g, '[ref]');

function applyChanges(before, pages) {
  const changes = new Map();
  for (const page of pages) for (const change of page.changes) {
    let combined = changes.get(change.start_line);
    if (!combined) changes.set(change.start_line, combined = { ...change, lines: [] });
    assert.equal(change.line_offset, combined.lines.length);
    if (change.snapshot) combined.lines.push(...change.snapshot.split('\n'));
    combined.complete = change.complete;
  }
  const lines = before ? before.split('\n') : [];
  for (const [start, change] of [...changes].sort((a, b) => b[0] - a[0])) {
    assert.equal(change.complete, true);
    lines.splice(start, change.delete_count, ...change.lines);
  }
  assert.equal(lines.length, pages.at(-1).line_count);
  return lines.join('\n');
}

test('semantic alignment reconstructs insertions, deletion, equal-looking replacement and sibling moves', () => {
  const before = ['root', 'a', 'b', 'c', 'd'].map(key => ({ key, node: true, frameId: 'main', line: key === 'root' ? 'root' : '  button "Same"' }));
  for (const ids of [[], ['root'], ['root', 'a', 'new', 'c', 'd'], ['root', 'd', 'b', 'c', 'a'], ['root', 'replacement', 'b', 'c', 'd']]) {
    const after = ids.map(key => ({ key, node: true, frameId: 'main', line: key === 'root' ? 'root' : '  button "Same"' }));
    const state = { id: 'next', baseId: 'base', entries: after, deltaEntries: snapshotDiff(before, after), options: snapshotOptions(), invalidFrames: new Set(), metadata: {}, totalNodes: after.length };
    const pages = [snapshotPage(state, { max_nodes: 1 })];
    while (pages.at(-1).next_cursor) pages.push(snapshotPage(state, { cursor: pages.at(-1).next_cursor, max_nodes: 1 }));
    assert.equal(applyChanges(before.map(entry => entry.line).join('\n'), pages), after.map(entry => entry.line).join('\n'));
    assert.ok(pages.some(page => page.changes.length));
  }
});

test('semantic patches reconstruct varied large reorderings without quadratic tree comparison', () => {
  let seed = 24821;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  const before = Array.from({ length: 1000 }, (_, i) => ({ key: `node:${i}`, node: true, line: `button "Item ${i}"`, frameId: 'main' }));
  for (let run = 0; run < 25; run++) {
    const after = before.filter(() => random() > 0.15).map(entry => ({ ...entry, line: random() > 0.85 ? entry.line + ' disabled=true' : entry.line }));
    for (let i = after.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [after[i], after[j]] = [after[j], after[i]]; }
    after.splice(20, 0, { key: `new:${run}`, node: true, line: 'button "New"', frameId: 'main' });
    const state = { id: 'next', baseId: 'base', entries: after, deltaEntries: snapshotDiff(before, after), options: snapshotOptions(), invalidFrames: new Set(), metadata: {}, totalNodes: after.length };
    const pages = [snapshotPage(state, { max_nodes: 73, max_chars: 2000 })];
    while (pages.at(-1).next_cursor) pages.push(snapshotPage(state, { cursor: pages.at(-1).next_cursor, max_nodes: 73, max_chars: 2000 }));
    assert.equal(applyChanges(before.map(entry => entry.line).join('\n'), pages), after.map(entry => entry.line).join('\n'));
    for (const page of pages) assert.ok(JSON.stringify(page.changes).length <= 2000);
  }
});

test('no-change diffs still collect fresh AX, advance the baseline and preserve actionable refs', async () => {
  const f = fixture(); f.nodes(tree()); await f.claim();
  const before = await f.exec('snapshot'); const button = f.ref(before);
  const after = await f.exec('snapshot', { diff_since: before.snapshot_id });
  assert.deepEqual(after.changes, []); assert.equal(after.node_count, 0); assert.equal(after.snapshot, undefined);
  assert.equal(after.base_snapshot_id, before.snapshot_id); assert.notEqual(after.snapshot_id, before.snapshot_id);
  assert.equal(applyChanges(before.snapshot, [after]), before.snapshot);
  assert.equal(f.calls.filter(call => call.method === 'Accessibility.getFullAXTree').length, 2);
  await f.exec('click', { ref: button });
  const reads = f.calls.length;
  await assert.rejects(f.exec('snapshot', { diff_since: before.snapshot_id }), /baseline.*stale/);
  assert.ok(!f.calls.slice(reads).some(call => call.method === 'Accessibility.getFullAXTree'));
  assert.deepEqual((await f.exec('snapshot', { diff_since: after.snapshot_id })).changes, []);
});

test('local values return one changed semantic row and leave other subtrees and refs intact', async () => {
  const f = fixture(); f.nodes(tree()); await f.claim();
  const before = await f.exec('snapshot', { profile: 'interactive' });
  const field = ref(before, 'textbox', 'Name'), button = f.ref(before);
  const next = tree(); next[3].value.value = 'Updated'; f.nodes(next);
  const after = await f.exec('snapshot', { diff_since: before.snapshot_id });
  assert.equal(after.profile, 'interactive'); assert.equal(after.changes.length, 1); assert.equal(after.node_count, 1);
  assert.match(after.changes[0].snapshot, /textbox "Name" value="Updated"/);
  assert.ok(after.changes[0].snapshot.includes(`[${field}]`)); assert.doesNotMatch(after.changes[0].snapshot, /Results|Other/);
  await f.exec('click', { ref: button });
  const current = await f.exec('snapshot', { profile: 'interactive' });
  assert.equal(stripRefs(applyChanges(before.snapshot, [after])), stripRefs(current.snapshot));
});

test('rename and same-looking replacement retire old refs, while moves keep node identities', async () => {
  const f = fixture(); f.nodes(tree()); await f.claim();
  const before = await f.exec('snapshot'), old = f.ref(before), field = ref(before, 'textbox', 'Name');
  const next = tree(); next[2].name.value = 'Renamed'; next[1].childIds.reverse(); f.nodes(next);
  const after = await f.exec('snapshot', { diff_since: before.snapshot_id });
  await assert.rejects(f.exec('click', { ref: old }), error => error.diagnostics?.cause === 'identity_changed' && error.input_dispatched === false);
  const reconstructed = applyChanges(before.snapshot, [after]);
  assert.ok(reconstructed.includes(`[${field}]`)); assert.match(reconstructed, /textbox "Name"[\s\S]*button "Renamed"/);
  const newRef = ref({ snapshot: reconstructed }, 'button', 'Renamed');
  const replacement = tree(); replacement[2].nodeId = 'replacement'; replacement[2].backendDOMNodeId = 99; replacement[2].name.value = 'Renamed'; replacement[1].childIds = ['replacement', 'b']; f.nodes(replacement);
  const replaced = await f.exec('snapshot', { diff_since: after.snapshot_id });
  await assert.rejects(f.exec('click', { ref: newRef }), error => error.diagnostics?.cause === 'element_detached');
  assert.ok(!applyChanges(reconstructed, [replaced]).includes(`[${newRef}]`));
});

test('diff insertions span pages with stable coordinates and exact reconstruction; deletion-only patches fit budgets', async () => {
  const f = fixture(); f.nodes(tree()); await f.claim();
  const before = await f.exec('snapshot');
  const next = tree(); next[1].childIds.push('x', 'y', 'z');
  for (const [i, id] of ['x', 'y', 'z'].entries()) next.push(ax(id, 'button', `Added ${id}`, [], { backendDOMNodeId: 20 + i }));
  f.nodes(next);
  const first = await f.exec('snapshot', { diff_since: before.snapshot_id, max_nodes: 1 });
  assert.equal(first.truncated, true); assert.equal(first.changes[0].complete, false);
  await assert.rejects(f.exec('snapshot', { diff_since: first.snapshot_id }), /unread pages/);
  const pages = [first];
  while (pages.at(-1).next_cursor) pages.push(await f.exec('snapshot', { cursor: pages.at(-1).next_cursor, max_nodes: 1 }));
  assert.deepEqual(pages.map(page => page.changes[0].line_offset), [0, 1, 2]);
  const reconstructed = applyChanges(before.snapshot, pages);
  f.nodes(tree());
  const removed = await f.exec('snapshot', { diff_since: pages.at(-1).snapshot_id, max_chars: 150 });
  assert.equal(removed.node_count, 0); assert.equal(removed.changes[0].delete_count, 3); assert.equal(removed.changes[0].snapshot, '');
  assert.equal(applyChanges(reconstructed, [removed]), before.snapshot);
});

test('unread baselines remain ineligible when an input expires their cursor', async () => {
  const f = fixture(); await f.claim(); const before = await f.exec('snapshot', { max_nodes: 2 });
  await f.exec('click', { ref: f.ref(before) });
  await assert.rejects(f.exec('snapshot', { cursor: before.next_cursor }), /stale/);
  await assert.rejects(f.exec('snapshot', { diff_since: before.snapshot_id }), /unread pages/);
});

test('invalid requests and view changes do not replace the baseline or perform AX reads', async () => {
  const f = fixture(); await f.claim(); const before = await f.exec('snapshot', { profile: 'interactive', query: 'Submit' });
  for (const args of [{ diff_since: '' }, { diff_since: 42 }, { diff_since: ' ' }, { diff_since: before.snapshot_id, cursor: 'x' },
    { diff_since: before.snapshot_id, profile: 'fields' }, { diff_since: before.snapshot_id, profile: 'full' },
    { diff_since: before.snapshot_id, query: 'Name' }, { diff_since: before.snapshot_id, max_nodes: 0 }, { diff_since: before.snapshot_id, verbose: 'yes' }]) {
    const reads = f.calls.filter(call => call.method === 'Accessibility.getFullAXTree').length;
    await assert.rejects(f.exec('snapshot', args));
    assert.equal(f.calls.filter(call => call.method === 'Accessibility.getFullAXTree').length, reads);
  }
  assert.deepEqual((await f.exec('snapshot', { diff_since: before.snapshot_id })).changes, []);
});

test('query membership and merged prose changes are diffed within the original view', async () => {
  const f = fixture(); f.nodes([ax('p', 'paragraph', '', ['text']), ax('text', 'StaticText', 'Target old')]); await f.claim();
  const before = await f.exec('snapshot', { query: 'target' });
  f.nodes([ax('p', 'paragraph', '', ['text']), ax('text', 'StaticText', 'Target new')]);
  const after = await f.exec('snapshot', { diff_since: before.snapshot_id });
  assert.match(after.changes[0].snapshot, /paragraph "Target new"/);
  f.nodes([ax('p', 'paragraph', '', ['text']), ax('text', 'StaticText', 'No match')]);
  const removed = await f.exec('snapshot', { diff_since: after.snapshot_id });
  assert.equal(applyChanges(applyChanges(before.snapshot, [after]), [removed]), '');
});

test('frame-local AX ids do not collide, and invalidated frames reject diffs without retiring main refs', async () => {
  const f = fixture(); withChildFrames(f); await f.claim(); const before = await f.exec('snapshot');
  assert.deepEqual((await f.exec('snapshot', { diff_since: before.snapshot_id })).changes, []);
  const current = await f.exec('snapshot'); const main = f.ref(current);
  f.api.debugger.onEvent.emit({ tabId: 9 }, 'Page.frameNavigated', { frame: { id: 'ad', parentId: 'main' } });
  await assert.rejects(f.exec('snapshot', { diff_since: current.snapshot_id }), /invalidated frame coverage/);
  await f.exec('click', { ref: main });
});

test('unavailable frame capture never becomes a deletion and failed diff does not advance its baseline', async () => {
  const f = fixture(); withChildFrames(f); await f.claim(); const before = await f.exec('snapshot');
  const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => {
    if (method === 'Accessibility.getFullAXTree' && args.frameId === 'ad') throw new Error('Frame unavailable');
    return send(target, method, args);
  };
  await assert.rejects(f.exec('snapshot', { diff_since: before.snapshot_id }), error => error.diagnostics?.reason === 'diff_incomplete');
  f.api.debugger.sendCommand = send;
  assert.deepEqual((await f.exec('snapshot', { diff_since: before.snapshot_id })).changes, []);
});

test('document change during diff cannot retry across the baseline boundary or publish captured refs', async () => {
  const f = fixture(); await f.claim(); const before = await f.exec('snapshot'), button = f.ref(before);
  const send = f.api.debugger.sendCommand; let reads = 0;
  f.api.debugger.sendCommand = async (target, method, args) => {
    if (method === 'Accessibility.getFullAXTree') { reads++; f.api.debugger.onEvent.emit(target, 'DOM.documentUpdated'); }
    return send(target, method, args);
  };
  await assert.rejects(f.exec('snapshot', { diff_since: before.snapshot_id }), error => error.diagnostics?.reason === 'diff_baseline_invalid');
  assert.equal(reads, 1);
  await assert.rejects(f.exec('click', { ref: button }), error => error.diagnostics?.cause === 'document_updated');
});

test('diff capture timeout preserves the old baseline and cannot publish late results', async t => {
  const f = fixture(); await f.claim(); const before = await f.exec('snapshot');
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const send = f.api.debugger.sendCommand; let finish;
  f.api.debugger.sendCommand = async (target, method, args) => {
    if (method === 'Accessibility.getFullAXTree') await new Promise(resolve => { finish = resolve; });
    return send(target, method, args);
  };
  const pending = assert.rejects(f.exec('snapshot', { diff_since: before.snapshot_id }), error => error.diagnostics?.reason === 'snapshot_timeout');
  await new Promise(resolve => setImmediate(resolve)); t.mock.timers.tick(30000); await pending;
  finish(); await new Promise(resolve => setImmediate(resolve));
  f.api.debugger.sendCommand = send;
  assert.deepEqual((await f.exec('snapshot', { diff_since: before.snapshot_id })).changes, []);
});

test('too-small diff output budget leaves the baseline available for a larger-budget retry', async () => {
  const f = fixture(); f.nodes(tree()); await f.claim(); const before = await f.exec('snapshot');
  const next = tree(); next[3].value.value = 'Changed'; f.nodes(next);
  await assert.rejects(f.exec('snapshot', { diff_since: before.snapshot_id, max_chars: 1 }), /requires max_chars/);
  const after = await f.exec('snapshot', { diff_since: before.snapshot_id });
  assert.match(after.changes[0].snapshot, /Changed/);
});

test('AX property ordering is not a semantic change; ignored identity changes retire old refs', async () => {
  const f = fixture(); const nodes = tree();
  nodes[2].properties = [{ name: 'disabled', value: { value: false } }, { name: 'expanded', value: { value: true } },
    { name: 'hasPopup', value: { value: 'menu' } }, { name: 'controls', value: { relatedNodes: [{ idref: 'menu' }] } }];
  f.nodes(nodes); await f.claim(); const before = await f.exec('snapshot'), button = f.ref(before);
  const next = structuredClone(nodes); next[2].properties.reverse(); f.nodes(next);
  const same = await f.exec('snapshot', { diff_since: before.snapshot_id }); assert.deepEqual(same.changes, []);
  next[2].ignored = true;
  const hidden = await f.exec('snapshot', { diff_since: same.snapshot_id });
  assert.ok(!applyChanges(before.snapshot, [hidden]).includes(`[${button}]`));
  await assert.rejects(f.exec('click', { ref: button }), error => error.diagnostics?.cause === 'identity_changed');
});

test('targeted element refs outside the query survive diffs only while their AX identity survives', async () => {
  const f = fixture(); f.nodes(tree()); await f.claim(); const before = await f.exec('snapshot', { query: 'Other' });
  const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => {
    if (method === 'Runtime.evaluate' && args.objectGroup === 'browser-attach-evaluation') return { result: { objectId: 'element', subtype: 'node' } };
    if (method === 'DOM.describeNode' && args.objectId === 'element') return { node: { nodeType: 1, backendNodeId: 12 } };
    return send(target, method, args);
  };
  const element = await f.exec('evaluate', { expression: 'document.querySelector("button")', result_type: 'element' });
  const after = await f.exec('snapshot', { diff_since: before.snapshot_id });
  assert.deepEqual(after.changes, []);
  await f.exec('click', { ref: element.ref });
  const next = tree(); next[2].name.value = 'Changed outside query'; f.nodes(next);
  const changed = await f.exec('snapshot', { diff_since: after.snapshot_id });
  assert.deepEqual(changed.changes, []);
  await assert.rejects(f.exec('click', { ref: element.ref }), error => error.diagnostics?.cause === 'identity_changed');
});

test('incomplete baseline and structured fields cannot enter a diff chain', async () => {
  const f = fixture(); withChildFrames(f); await f.claim();
  const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => {
    if (method === 'Accessibility.getFullAXTree' && args.frameId === 'ad') throw new Error('Frame unavailable');
    if (method === 'DOMSnapshot.captureSnapshot') return domCapture([{ frameId: 'main', nodes: [] }]);
    return send(target, method, args);
  };
  const incomplete = await f.exec('snapshot');
  await assert.rejects(f.exec('snapshot', { diff_since: incomplete.snapshot_id }), /incomplete.*frame coverage/);
  const fields = await f.exec('snapshot', { profile: 'fields' });
  await assert.rejects(f.exec('snapshot', { diff_since: fields.snapshot_id }), /full\/interactive/);
});

test('session reassignment during capture cannot publish a diff across frame sessions', async () => {
  const f = fixture(); withChildFrames(f); await f.claim(); const before = await f.exec('snapshot');
  const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => {
    const result = await send(target, method, args);
    if (method === 'Accessibility.getFullAXTree' && args.frameId === 'ad') {
      f.api.debugger.onEvent.emit({ tabId: 9 }, 'Target.attachedToTarget', { sessionId: 'replacement', targetInfo: { type: 'iframe', targetId: 'ad' } });
    }
    return result;
  };
  await assert.rejects(f.exec('snapshot', { diff_since: before.snapshot_id }), error => error.diagnostics?.reason === 'diff_incomplete');
  f.api.debugger.sendCommand = send;
  await assert.rejects(f.exec('snapshot', { diff_since: before.snapshot_id }), error => error.diagnostics?.reason === 'diff_baseline_invalid');
});

test('release during diff ends the baseline, and fresh snapshots replace preserved refs', async () => {
  const f = fixture(); await f.claim(); const before = await f.exec('snapshot'), button = f.ref(before);
  await f.exec('snapshot', { diff_since: before.snapshot_id }); await f.exec('snapshot');
  await assert.rejects(f.exec('click', { ref: button }), error => error.diagnostics?.cause === 'snapshot_replaced');
  const current = await f.exec('snapshot'), send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => {
    if (method === 'Accessibility.getFullAXTree') f.api.debugger.onDetach.emit({ tabId: 9 });
    return send(target, method, args);
  };
  await assert.rejects(f.exec('snapshot', { diff_since: current.snapshot_id }), /control ended/);
  assert.equal(f.controller.claimedCount(), 0);
});

test('frame invalidation during diff pagination fails rather than silently dropping patch lines', async () => {
  const f = fixture(); withChildFrames(f); f.nodes(tree()); await f.claim(); const before = await f.exec('snapshot');
  const next = tree(); next[2].name.value = 'Changed'; next[3].value.value = 'Changed'; f.nodes(next);
  const first = await f.exec('snapshot', { diff_since: before.snapshot_id, max_nodes: 1 }); assert.ok(first.next_cursor);
  f.api.debugger.onEvent.emit({ tabId: 9 }, 'Page.frameNavigated', { frame: { id: 'ad', parentId: 'main' } });
  await assert.rejects(f.exec('snapshot', { cursor: first.next_cursor }), error => error.diagnostics?.reason === 'diff_baseline_invalid');
});
