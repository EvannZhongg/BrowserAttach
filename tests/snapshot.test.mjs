import test from 'node:test';
import assert from 'node:assert/strict';
import { renderAX, snapshotOptions, snapshotPage } from '../extension/snapshot.js';

const node = (nodeId, role, name = '', childIds = [], extra = {}) =>
  ({ nodeId, role: { value: role }, name: { value: name }, childIds, ...extra });

test('popup semantics preserve browser-resolved idrefs without inventing ownership or changing ref identity', () => {
  const nodes = [node('category', 'menuitem', 'Category', [], { backendDOMNodeId: 2, properties: [
    { name: 'hasPopup', value: { value: 'menu' } }, { name: 'expanded', value: { value: false } },
    { name: 'controls', value: { value: 'popup missing', relatedNodes: [{ backendDOMNodeId: 3, idref: 'popup' }, { idref: 'popup' }, { backendDOMNodeId: 4 }] } },
    { name: 'owns', value: { relatedNodes: [{ idref: 'owned' }] } },
  ] }), node('leaf', 'menuitem', 'Leaf', [], { backendDOMNodeId: 5 })];
  for (const profile of ['full', 'interactive']) {
    const refs = new Map();
    const entries = renderAX(nodes, 'popup', refs, 'child', 's1', snapshotOptions({ profile, query: 'Category', text: false }));
    assert.match(entries[0].line, /expanded=false hasPopup="menu" controls=\["popup"\] owns=\["owned"\]/);
    assert.doesNotMatch(entries[0].line, /missing|backendDOMNodeId|undefined/);
    assert.equal(refs.size, 1); assert.deepEqual(refs.get('popup:1'), { backendNodeId: 2, frameId: 'child', sessionId: 's1', role: 'menuitem', name: 'Category' });
  }
  const leaf = renderAX(nodes, 'leaf', new Map(), 'main', undefined, snapshotOptions({ query: 'Leaf' }));
  assert.doesNotMatch(leaf[0].line, /hasPopup|controls|owns/);
});

test('interactive view removes prose with refs but preserves control ancestors, disabled and custom controls', () => {
  const nodes = [node('root', 'RootWebArea', 'Page', ['main']), node('main', 'main', '', ['prose', 'group']),
    node('prose', 'paragraph', '', ['body'], { backendDOMNodeId: 1 }), node('body', 'StaticText', 'Read me'),
    node('group', 'group', 'Settings', ['button', 'custom', 'ignored']),
    node('button', 'button', 'Save', ['label'], { backendDOMNodeId: 2, properties: [{ name: 'disabled', value: { value: true } }] }),
    node('label', 'StaticText', 'Save'),
    node('custom', 'generic', 'Custom', [], { backendDOMNodeId: 3, properties: [{ name: 'focusable', value: { value: true } }] }),
    node('ignored', 'button', 'Hidden', [], { backendDOMNodeId: 4, ignored: true })];
  const refs = new Map(), entries = renderAX(nodes, 'view', refs, 'main', undefined, snapshotOptions({ profile: 'interactive' }));
  const text = entries.map(entry => entry.line).join('\n');
  assert.match(text, /RootWebArea "Page"\n  main ""\n    group "Settings"\n      \[view:1\] button "Save" disabled=true/);
  assert.match(text, /generic "Custom"/);
  assert.doesNotMatch(text, /Read me|paragraph|Hidden|StaticText/);
  assert.equal(refs.size, 2);
  assert.match(renderAX(nodes, 'full', new Map(), 'main').map(e => e.line).join('\n'), /paragraph "Read me"/);
});

test('nearby field text survives interactive filtering and query without changing AX identity', () => {
  const nodes = [node('root', 'RootWebArea', '', ['row']), node('row', 'generic', '', ['label', 'wrapper']),
    node('label', 'generic', '', ['text']), node('text', 'StaticText', '性别'),
    node('wrapper', 'generic', '', ['field']), node('field', 'textbox', '必填项未填写', [], { backendDOMNodeId: 9 })];
  for (const options of [{ profile: 'interactive' }, { profile: 'interactive', text: false, query: '性别' }]) {
    const refs = new Map(), entries = renderAX(nodes, 'ctx', refs, 'main', undefined, snapshotOptions(options));
    assert.match(entries.map(e => e.line).join('\n'), /textbox "必填项未填写" context="性别"/);
    assert.equal(refs.get('ctx:1').name, '必填项未填写');
    assert.equal(refs.get('ctx:1').backendNodeId, 9);
  }
  nodes[1].childIds.push('other');
  nodes.push(node('other', 'textbox', '', [], { backendDOMNodeId: 10 }));
  assert.doesNotMatch(renderAX(nodes, 'multi', new Map(), 'main').map(e => e.line).join('\n'), /context=/);
});

test('AX query matches literal names, merged prose and values before previews, while keeping original ref identities', () => {
  const nodes = [node('root', 'RootWebArea', '', ['prose', 'button', 'field']),
    node('prose', 'paragraph', '', ['body'], { backendDOMNodeId: 1 }), node('body', 'StaticText', 'Long context with SAVE.* at the end'),
    node('button', 'button', 'Save.*', [], { backendDOMNodeId: 2 }),
    node('field', 'textbox', 'Name', [], { backendDOMNodeId: 3, value: { value: 'SAVE.*' } })];
  const refs = new Map();
  const entries = renderAX(nodes, 'query', refs, 'child', 's1', snapshotOptions({ query: 'save.*', text_limit: 4 }));
  assert.equal(entries.length, 3); assert.equal(refs.size, 3);
  assert.match(entries[0].line, /paragraph "Long…"/);
  assert.equal(refs.get('query:1').name, '');
  assert.equal(refs.get('query:2').name, 'Save.*');
  assert.equal(refs.get('query:3').frameId, 'child'); assert.equal(refs.get('query:3').sessionId, 's1');
  assert.equal(renderAX(nodes, 'empty', new Map(), 'main', undefined, snapshotOptions({ query: 'saveZZ' })).length, 0);
  assert.equal(renderAX(nodes, 'interactive', new Map(), 'main', undefined, snapshotOptions({ query: 'save.*', profile: 'interactive' })).length, 2);
  for (const query of ['', '  ', 3, 'a'.repeat(2001)]) assert.throws(() => snapshotOptions({ query }), /query/);
});

test('compact snapshot keeps coverage and pagination; verbose metadata can be requested on the same cursor', () => {
  const options = snapshotOptions({ query: 'Save' });
  const entries = renderAX([node('a', 'button', 'Save one'), node('b', 'button', 'Save two')], 's', new Map(), 'main', undefined, options);
  const state = { id: 's', options, entries, totalNodes: 2, invalidFrames: new Set(), metadata: { viewport: { width: 800 }, omitted_frames: [{ frame_id: 'ad', reason: 'unavailable' }] } };
  const first = snapshotPage(state, { max_nodes: 1 });
  assert.equal(first.viewport, undefined); assert.equal(first.snapshot_id, 's'); assert.equal(first.note, undefined);
  assert.equal(first.truncated, true); assert.equal(first.total_node_count, 2); assert.equal(first.omitted_frames.length, 1);
  assert.throws(() => snapshotPage(state, { cursor: first.next_cursor, query: 'Other' }), /original.*query/);
  const next = snapshotPage(state, { cursor: first.next_cursor, verbose: true });
  assert.equal(next.snapshot_id, 's'); assert.deepEqual(next.viewport, { width: 800 });
  assert.equal(next.query, 'Save'); assert.equal(next.next_cursor, null);
  assert.throws(() => snapshotPage(state, { verbose: 'yes' }), /verbose/);
});

test('text previews never shorten control identity, accessible names or values', () => {
  const name = 'Save '.repeat(30), content = 'Extra context '.repeat(30);
  const nodes = [node('root', 'RootWebArea', '', ['button']),
    node('button', 'button', name, ['label', 'extra'], { backendDOMNodeId: 2, value: { value: 'full value' } }),
    node('label', 'StaticText', name), node('extra', 'StaticText', content, [], { backendDOMNodeId: 3 })];
  const refs = new Map();
  const options = snapshotOptions({ profile: 'interactive', text_limit: 12 });
  const text = renderAX(nodes, 'view', refs, 'main', undefined, options).map(e => e.line).join('\n');
  assert.ok(text.includes(JSON.stringify(name)));
  assert.ok(text.includes(JSON.stringify(content.slice(0, 12) + '…')));
  assert.equal((text.match(/StaticText/g) || []).length, 1);
  assert.equal(refs.get('view:2').name, content);
  const hidden = renderAX(nodes, 'hidden', new Map(), 'main', undefined, { ...options, text: false }).map(e => e.line).join('\n');
  assert.doesNotMatch(hidden, /StaticText|Extra context/);
  assert.ok(hidden.includes(JSON.stringify(name))); assert.match(hidden, /value="full value"/);
  for (const args of [{ profile: 'bad' }, { text: 'false' }, { text_limit: -1 }, { text_limit: 0.5 }, { text_limit: 10001 }]) {
    assert.throws(() => snapshotOptions(args));
  }
});

test('deep AX traversal preserves preorder, refs and interactive text without recursion', () => {
  const depth = 15000;
  const nodes = [node('root', 'RootWebArea', '', ['g0'])];
  for (let i = 0; i < depth; i++) nodes.push(node(`g${i}`, 'group', '', [i + 1 < depth ? `g${i + 1}` : 'button']));
  nodes.push(node('button', 'button', 'Save', ['text0'], { backendDOMNodeId: 1 }));
  for (let i = 0; i < depth; i++) nodes.push(node(`text${i}`, 'generic', '', [i + 1 < depth ? `text${i + 1}` : 'label']));
  nodes.push(node('label', 'StaticText', 'Details', [], { backendDOMNodeId: 2 }), node('other', 'button', 'Other', [], { backendDOMNodeId: 3 }));
  for (const profile of ['full', 'interactive']) {
    const refs = new Map(), entries = renderAX(nodes, 'deep', refs, 'main', undefined, snapshotOptions({ profile }));
    assert.equal(entries.length, depth + 4);
    assert.match(entries[0].line, /^RootWebArea/);
    assert.match(entries[depth + 1].line, /\[deep:1\] button "Save"$/);
    assert.match(entries[depth + 2].line, /\[deep:2\] StaticText "Details"$/);
    assert.match(entries[depth + 3].line, /^\[deep:3\] button "Other"$/);
    assert.equal(refs.get('deep:2').backendNodeId, 2);
  }
});

test('deep prose merging preserves separators and stops at semantic children', () => {
  const depth = 15000;
  const nodes = [node('p', 'paragraph', '', ['g0', 'tail'], { backendDOMNodeId: 1 })];
  for (let i = 0; i < depth; i++) nodes.push(node(`g${i}`, 'generic', '', [i + 1 < depth ? `g${i + 1}` : 'leaf']));
  nodes.push(node('leaf', 'StaticText', 'Start'), node('tail', 'StaticText', 'End'));
  assert.match(renderAX(nodes, 'prose', new Map(), 'main')[0].line, /paragraph "Start End"$/);
  nodes[1].childIds.push('empty', 'extra');
  nodes.push(node('empty', 'generic'), node('extra', 'StaticText', 'Extra'));
  assert.match(renderAX(nodes, 'prose', new Map(), 'main')[0].line, /paragraph "Start  Extra End"$/);
  nodes[nodes.length - 1].role.value = 'button';
  const entries = renderAX(nodes, 'prose', new Map(), 'main');
  assert.equal(entries.length, 4);
  assert.match(entries[0].line, /paragraph ""$/);
  assert.match(entries[2].line, /button "Extra"$/);
});
