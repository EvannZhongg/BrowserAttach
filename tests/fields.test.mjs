import test from 'node:test';
import assert from 'node:assert/strict';
import { renderFields, createFieldReader } from '../extension/fields.js';
import { snapshotOptions, snapshotPage } from '../extension/snapshot.js';
import { fixture, withChildFrames } from './helpers/controller-fixture.mjs';
import { domCapture, axField } from './helpers/fields-fixture.mjs';

function render(nodes, dom, args = {}) {
  const capture = domCapture([{ frameId: 'main', nodes: dom }]), refs = new Map(), options = snapshotOptions({ profile: 'fields', ...args });
  return { options, refs, entries: renderFields(nodes, capture.documents[0].nodes, capture.strings, 'fields', refs, 'main', undefined, options) };
}

test('field AX facts expose popup type and resolved portal ids without requiring DOM ancestry', () => {
  const nodes = [axField(2, 'Search', 'combobox', { properties: [
    { name: 'hasPopup', value: { value: 'listbox' } }, { name: 'expanded', value: { value: true } },
    { name: 'controls', value: { relatedNodes: [{ idref: 'portal-list' }] } },
  ] })];
  for (const dom of [[], [{ tag: 'input', backend: 2, attrs: { id: 'search' }, value: '' }]]) {
    const field = render(nodes, dom, { query: 'Search' }).entries[0].field;
    assert.equal(field.ax.hasPopup, 'listbox'); assert.equal(field.ax.expanded, true);
    assert.deepEqual(field.ax.controls, ['portal-list']); assert.ok(field.ref);
  }
});

test('structured fields keep duplicate names, actual HTML label sources, nearby context and DOM/AX value distinctions', () => {
  const source = { nativeSource: 'labelfor', superseded: true, value: { value: 'Visa fee' } };
  const nodes = [axField(1, 'Root', 'RootWebArea', { childIds: ['row'] }),
    { nodeId: 'row', role: { value: 'generic' }, childIds: ['label', '2'] },
    { nodeId: 'label', role: { value: 'StaticText' }, name: { value: '签证费' } },
    axField(2, 'Amount', 'textbox', { name: { value: 'Amount', sources: [source] }, value: { value: '1,234.00' },
      properties: [{ name: 'readonly', value: { value: true } }] }), axField(3, 'Amount')];
  const dom = [{ tag: 'input', backend: 2, attrs: { id: 'jqx-random', name: 'TEXTS28' }, value: '1234.00' },
    { tag: 'input', backend: 3, attrs: { name: 'TEXTS29' }, value: '0' }];
  const result = render(nodes, dom);
  const [first, second] = result.entries.map(entry => entry.field);
  assert.equal(first.ax.name, second.ax.name); assert.equal(result.entries.length, 2);
  assert.equal(first.dom.name, 'TEXTS28'); assert.equal(first.dom.value, '1234.00'); assert.equal(first.ax.value, '1,234.00');
  assert.equal(first.ax.readonly, true); assert.deepEqual(first.labels, ['Visa fee']); assert.equal(first.context, '签证费');
  assert.equal(result.refs.get(first.ref).name, 'Amount'); assert.equal(result.refs.get(first.ref).backendNodeId, 2);
  for (const query of ['texts28', 'Visa fee', '签证费', 'jqx-random', '1234.00', '1,234.00']) {
    assert.equal(render(nodes, dom, { query }).entries.length, 1);
  }
});

test('native states and selected options preserve raw values while hidden and password values have explicit boundaries', () => {
  const nodes = [axField(2, 'Choice', 'listbox'), axField(3, 'Consent', 'checkbox', { properties: [{ name: 'checked', value: { value: 'mixed' } }] }),
    axField(4, 'Notes'), axField(5, 'Password', 'textbox', { value: { value: 'secret-value' } })];
  const dom = [{ tag: 'select', backend: 2, attrs: { multiple: '' } },
    { tag: 'option', parent: 0, attrs: { value: 'us', label: 'United States' }, selected: true },
    { tag: '#text', parent: 1, text: 'USA' },
    { tag: 'option', parent: 0, selected: true }, { tag: '#text', parent: 3, text: '  中国  ' },
    { tag: 'input', backend: 3, attrs: { type: 'checkbox' }, value: 'yes' },
    { tag: 'textarea', backend: 4, value: 'live\ntext' },
    { tag: '#text', parent: 6, text: 'default text' },
    { tag: 'input', backend: 5, attrs: { type: 'password' }, value: 'secret-value' },
    { tag: 'input', backend: 6, attrs: { type: 'hidden', name: 'rawFee' }, value: '1234' }];
  const fields = render(nodes, dom).entries.map(entry => entry.field);
  assert.equal(fields.length, 4);
  assert.deepEqual(fields[0].dom.selected_options, [{ value: 'us', label: 'United States' }, { value: '中国', label: '中国' }]);
  assert.equal(fields[0].dom.value, 'us'); assert.equal(fields[0].dom.multiple, true);
  assert.equal(fields[1].dom.checked, false); assert.equal(fields[1].ax.checked, 'mixed');
  assert.equal(fields[2].dom.value, 'live\ntext'); assert.equal(fields[2].dom.value_source, 'textarea_value');
  assert.equal(fields[3].dom.value_redacted, true); assert.ok(!JSON.stringify(fields).includes('secret-value'));
  assert.equal(render(nodes, dom, { query: 'secret-value' }).entries.length, 0);
  const hidden = render(nodes, dom, { include_hidden: true, query: 'rawFee' }).entries[0].field;
  assert.equal(hidden.ref, null); assert.equal(hidden.ax, null); assert.equal(hidden.dom.value, '1234');
  assert.equal(render(nodes, dom, { query: 'United States' }).entries.length, 1);
});

test('custom controls use observed AX facts, native outputs/editors use text content, and missing DOM identity is never guessed', () => {
  const nodes = [axField(2, 'Custom', 'combobox', { value: { value: 'shown' } }), axField(3, 'Editor'), axField(4, 'Total', 'status'),
    axField(5, 'Removed', 'textbox', { value: { value: 'unclassified-value' } }), axField(6, 'Save', 'button')];
  const dom = [{ tag: 'div', backend: 2, attrs: { id: 'custom', name: 'not-a-submit-contract' } },
    { tag: 'div', backend: 3, attrs: { contenteditable: '' } }, { tag: '#text', parent: 1, text: 'content' },
    { tag: 'output', backend: 4 }, { tag: '#text', parent: 3, text: '42' }, { tag: 'button', backend: 6 }];
  const result = render(nodes, dom), fields = result.entries.map(entry => entry.field);
  assert.equal(fields.length, 4); assert.equal(fields[0].dom.value, undefined); assert.equal(fields[0].ax.value, 'shown');
  assert.equal(fields[1].dom.value, 'content'); assert.equal(fields[2].dom.value, '42');
  assert.equal(fields[3].dom, null); assert.equal(result.refs.get(fields[3].ref).backendNodeId, 5);
  assert.equal(fields[3].ax.value, undefined);
});

test('field pagination keeps whole rows and immutable values, binds view options and filters invalidated frames', () => {
  const { entries, options } = render([axField(1, 'One'), axField(2, 'Two')], [{ tag: 'input', backend: 1, value: 'a' }, { tag: 'input', backend: 2, value: 'b' }]);
  entries[1].frameId = 'child'; entries[1].field.frame_id = 'child';
  const state = { id: 's', options, entries, totalNodes: 2, invalidFrames: new Set(), metadata: { omitted_frames: [] } };
  const first = snapshotPage(state, { max_nodes: 1 });
  assert.equal(first.fields.length, 1); assert.equal(first.snapshot, undefined); assert.equal(first.truncated, true);
  assert.throws(() => snapshotPage(state, { cursor: first.next_cursor, include_hidden: true }), /original/);
  const next = snapshotPage(state, { cursor: first.next_cursor });
  assert.equal(next.fields[0].dom.value, 'b'); assert.equal(next.next_cursor, null);
  assert.throws(() => snapshotPage(state, { max_chars: 1 }), /snapshot field requires max_chars/);
  const size = JSON.stringify(entries[0].field).length + 2;
  assert.equal(snapshotPage(state, { max_chars: size }).fields.length, 1);
  state.invalidFrames.add('child');
  assert.deepEqual(snapshotPage(state, { cursor: state.nextCursor }).fields, []);
  assert.throws(() => snapshotOptions({ include_hidden: true }), /fields only/);
});

test('session captures are shared within one observation, and file selection is read in isolation without reading contents', async () => {
  const capture = domCapture([{ frameId: 'main', nodes: [{ tag: 'input', backend: 1, attrs: { type: 'file' } }] },
    { frameId: 'child', nodes: [{ tag: 'input', backend: 2, value: 'child' }] }]);
  const calls = [];
  const send = async (target, method, args) => {
    calls.push({ target, method, args });
    if (method === 'DOMSnapshot.captureSnapshot') return capture;
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 42 };
    if (method === 'DOM.resolveNode') return { object: { objectId: 'file' } };
    if (method === 'Runtime.callFunctionOn') return { result: { value: { available: true, count: 2, names: ['a.pdf', 'b.pdf'] } } };
    return {};
  };
  const read = createFieldReader(send, result => result.result?.value), refs = new Map(), options = snapshotOptions({ profile: 'fields' });
  const entries = await read({ tabId: 9 }, 'main', [axField(1, 'Upload', 'button')], 's', refs, options);
  assert.equal(entries[0].field.dom.files.count, 2);
  await read({ tabId: 9 }, 'child', [axField(2, 'Child')], 's', refs, options);
  await read({ tabId: 9, sessionId: 'oopif' }, 'child', [axField(2, 'Child')], 's', refs, options);
  assert.equal(calls.filter(call => call.method === 'DOMSnapshot.captureSnapshot').length, 2);
  assert.ok(calls.some(call => call.method === 'DOM.resolveNode' && call.args.executionContextId === 42));
  assert.ok(calls.some(call => call.method === 'Runtime.releaseObjectGroup'));
  assert.ok(!calls.some(call => call.method.startsWith('Input.') || call.method.includes('FileInputFiles')));
});

function withFields(f) {
  withChildFrames(f); f.nodes([axField(13, 'Main')]);
  const original = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => {
    if (method === 'DOMSnapshot.captureSnapshot') {
      f.calls.push({ method, target, args });
      return domCapture(['main', 'ad', 'nested'].map((frameId, i) => ({ frameId, nodes: [{ tag: 'input', backend: [13, 70, 71][i], value: frameId }] })));
    }
    const result = await original(target, method, args);
    if (method === 'Accessibility.getFullAXTree' && args.frameId !== 'main') result.nodes[0].role.value = 'textbox';
    return result;
  };
}

test('field snapshots reuse ref lifetime and cursor invalidation; child navigation removes only that subtree', async () => {
  const f = fixture(); withFields(f); await f.claim();
  const first = await f.exec('snapshot', { profile: 'fields', max_nodes: 1 });
  assert.equal(first.total_node_count, 3); assert.equal(first.frames.length, 3);
  assert.equal(f.calls.filter(call => call.method === 'DOMSnapshot.captureSnapshot').length, 1);
  f.api.debugger.onEvent.emit({ tabId: 9 }, 'Page.frameNavigated', { frame: { id: 'ad', parentId: 'main' } });
  const next = await f.exec('snapshot', { cursor: first.next_cursor });
  assert.deepEqual(next.fields, []); assert.equal(next.omitted_frames.length, 2);
  const ref = first.fields[0].ref;
  assert.equal((await f.exec('fill', { ref, text: 'changed', mode: 'dom' })).value_verified, true);
  const second = await f.exec('snapshot', { profile: 'fields', max_nodes: 1 });
  await assert.rejects(f.exec('fill', { ref, text: 'old' }), /stale/);
  await f.exec('fill', { ref: second.fields[0].ref, text: 'new', mode: 'dom' });
  await assert.rejects(f.exec('snapshot', { cursor: second.next_cursor }), /stale/);
});

test('document changes during a DOM capture cannot resurrect refs; changed child fields are omitted', async () => {
  for (const main of [true, false]) {
    const f = fixture(); withFields(f); await f.claim();
    const original = f.api.debugger.sendCommand;
    f.api.debugger.sendCommand = async (target, method, args) => {
      const result = await original(target, method, args);
      if (method === 'DOMSnapshot.captureSnapshot') f.api.debugger.onEvent.emit(target, main ? 'DOM.documentUpdated' : 'Page.frameNavigated',
        main ? {} : { frame: { id: 'ad', parentId: 'main' } });
      return result;
    };
    if (main) await assert.rejects(f.exec('snapshot', { profile: 'fields' }), /Document changed/);
    else {
      const result = await f.exec('snapshot', { profile: 'fields' });
      assert.deepEqual(result.fields.map(field => field.frame_id), ['main']);
      assert.deepEqual(result.omitted_frames.map(frame => frame.frame_id), ['ad', 'nested']);
    }
  }
});
