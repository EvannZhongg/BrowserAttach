import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { extractText, readText } from '../extension/text.js';
import { queryElement } from '../extension/locator.js';
import { renderAX } from '../extension/snapshot.js';

test('snapshots preserve AX value and invalid/selection signals without inferring validation or commit', () => {
  const entries = renderAX([
    { nodeId: '1', backendDOMNodeId: 1, role: { value: 'combobox' }, name: { value: '年份' }, value: { value: '2026' },
      properties: [{ name: 'invalid', value: { value: 'true' } }, { name: 'expanded', value: { value: true } }] },
    { nodeId: '2', backendDOMNodeId: 2, role: { value: 'textbox' }, name: { value: '公司名称' }, value: { value: '' },
      properties: [{ name: 'invalid', value: { value: 'false' } }] },
    { nodeId: '3', backendDOMNodeId: 3, role: { value: 'option' }, name: { value: '2026' }, properties: [{ name: 'selected', value: { value: true } }] },
  ], 'snapshot', new Map(), 'main');
  assert.match(entries[0].line, /invalid="true".*expanded=true.*value="2026"/);
  assert.match(entries[1].line, /invalid="false".*value=""/);
  assert.match(entries[2].line, /selected=true/);
});

test('strict CSS and XPath reject zero, multiple and non-element matches', () => {
  const element = { nodeType: 1, tagName: 'BUTTON', matches: () => false, closest: () => null,
    getBoundingClientRect: () => ({ width: 10, height: 10 }), ownerDocument: { defaultView: { getComputedStyle: () => ({ visibility: 'visible' }) } } };
  const context = vm.createContext({ document: { querySelectorAll: s => s === '#one' ? [element] : s === 'button' ? [element, element] : [],
    evaluate: () => ({ snapshotLength: 1, snapshotItem: () => element }) }, XPathResult: { ORDERED_NODE_SNAPSHOT_TYPE: 7 } });
  const query = vm.runInContext(`(${queryElement.toString()})`, context);
  assert.equal(query('#one'), element); assert.equal(query('//button', 'xpath'), element);
  assert.throws(() => query('button'), /matched 2/); assert.throws(() => query('#missing'), /matched 0/);
});

test('text modes page textarea values and distinguish virtual DOM text from full editor model', () => {
  const textarea = { tagName: 'TEXTAREA', value: 'all\nlines\nhere' };
  const editor = { innerText: 'visible line', contains: () => false };
  const context = vm.createContext({ document: { title: 'Demo', body: editor }, location: { href: 'http://fixture/' },
    monaco: { editor: { getEditors: () => [{ getDomNode: () => editor, getModel: () => ({ getValue: () => 'full model\nmore lines' }) }] } } });
  const read = vm.runInContext(`(${extractText.toString()})`, context);
  const args = { mode: 'value', selector: '#text', offset: 4, max_chars: 5 };
  const result = read(args, () => textarea);
  assert.equal(result.text, 'lines'); assert.equal(result.next_offset, 9); assert.equal(result.complete_source, true);
  const full = read({ ...args, mode: 'editor', offset: 0, max_chars: 100 }, () => editor);
  assert.equal(full.text, 'full model\nmore lines'); assert.equal(full.source, 'monaco_model'); assert.equal(full.complete_source, true);
  assert.equal(read({ ...args, mode: 'visible' }, () => editor).complete_source, false);
  assert.throws(() => read({ ...args, mode: 'editor' }, () => ({ contains: () => false })), /No supported editor model/);
  context.monaco = undefined;
  const cm = read({ ...args, mode: 'editor', offset: 0, max_chars: 100 }, () => ({ CodeMirror: { getValue: () => 'all CM lines' } }));
  assert.equal(cm.text, 'all CM lines'); assert.equal(cm.source, 'codemirror5_model'); assert.equal(cm.complete_source, true);
});

test('editor reads report unavailable models for missing, malformed or throwing public APIs', () => {
  const element = { contains: () => false };
  for (const monaco of [undefined, { _prevClass: 'private' }, { editor: { getEditors: 1 } },
    { editor: { getEditors: () => null } }, { editor: { getEditors() { throw new Error('private failure'); } } },
    { editor: { getEditors: () => [{ getDomNode: () => element, getModel: () => null }] } },
    { editor: { getEditors: () => [{ getDomNode: () => element, getModel: () => ({ getValue: 'not callable' }) }] } },
    { editor: { getEditors: () => [{ getDomNode: () => element, getModel: () => ({ getValue: () => 42 }) }] } },
  ]) {
    const context = vm.createContext({ document: { title: 'Demo' }, location: { href: 'http://fixture/' }, monaco });
    Object.defineProperty(context, '__ncMonacoEditorApi', { get() { throw new Error('Must not scan private globals'); } });
    const read = vm.runInContext(`(${extractText.toString()})`, context);
    assert.throws(() => read({ mode: 'editor', selector: '#editor', offset: 0, max_chars: 100 }, () => element), error => {
      assert.equal(error.diagnostics.reason, 'editor_model_unavailable');
      assert.match(error.message, /No supported editor model.*browser_evaluate.*proxy textarea/s);
      assert.doesNotMatch(error.message, /TypeError|private failure/); return true;
    });
  }
});

test('editor reads reject ambiguous Monaco containers without falling back to another model', () => {
  let fallbackReads = 0;
  const element = { contains: () => true, CodeMirror: { getValue() { fallbackReads++; return 'wrong model'; } } };
  const editor = { getDomNode: () => ({}), getModel: () => ({ getValue: () => 'model' }) };
  const context = vm.createContext({ monaco: { editor: { getEditors: () => [editor, editor] } } });
  const read = vm.runInContext(`(${extractText.toString()})`, context);
  assert.throws(() => read({ mode: 'editor', selector: '#container' }, () => element), error => {
    assert.equal(error.diagnostics.reason, 'editor_model_ambiguous'); assert.equal(error.diagnostics.matched, 2);
    assert.match(error.message, /scope the selector/); return true;
  });
  assert.equal(fallbackReads, 0);
});

test('selected-node editor read errors retain diagnostics across the CDP boundary', async () => {
  const calls = [], diagnostics = { reason: 'editor_model_unavailable', hint: 'Read the site model' };
  const cdp = async (target, method, args) => {
    calls.push({ method, args });
    if (method === 'Runtime.callFunctionOn' && args.objectId === 'editor') return { exceptionDetails: { exception: { objectId: 'error' } } };
    if (method === 'Runtime.callFunctionOn' && args.objectId === 'error') return { result: { value: diagnostics } };
    return {};
  };
  await assert.rejects(readText(cdp, result => {
    if (result.exceptionDetails) throw new Error('No supported editor model found');
    return result.result.value;
  }, 1, { node: { objectId: 'editor' }, selector: '#editor', mode: 'editor' }), error => error.diagnostics === diagnostics);
  assert.ok(calls.some(call => call.method === 'Runtime.releaseObject' && call.args.objectId === 'error'));
});
