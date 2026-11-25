import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { queryElement, targetOptions, resolveSelector } from '../extension/locator.js';
import { extractText } from '../extension/text.js';
import { inspectWait } from '../extension/wait.js';
import { deadline } from '../extension/actionability.js';

function fixture() {
  const make = (id, text, children = [], visible = true) => {
    const element = { nodeType: 1, tagName: 'DIV', id, innerText: text, textContent: text, parentElement: null,
      querySelectorAll: () => children.flatMap(child => [child, ...child.querySelectorAll('*')]),
      matches: () => false, closest: () => null, getBoundingClientRect: () => ({ width: 10, height: visible ? 10 : 0 }),
      ownerDocument: { defaultView: { getComputedStyle: () => ({ visibility: 'visible' }) } } };
    for (const child of children) child.parentElement = element;
    return element;
  };
  const price = make('price', '¥45'), plan = make('plan', '¥45', [price]), hidden = make('hidden', '¥45', [], false);
  const duplicate = make('duplicate', '¥45'), label = make('label', '选择\n  套餐'), fragment = make('fragment', '¥ 45');
  const plans = make('plans', '¥45\n选择\n  套餐\n¥ 45', [plan, hidden, label, fragment]);
  const root = make('root', '¥45\n选择 套餐\n¥ 45\n¥45', [plans, duplicate]);
  const document = { documentElement: root, body: root, title: 'Plans', querySelectorAll: selector => selector === '#plans' ? [plans] : selector === '.duplicate-scope' ? [plans, duplicate] : [] };
  const query = vm.runInNewContext(`(${queryElement.toString()})`, { document });
  return { query, document, price, plan, plans, duplicate, label, fragment };
}

test('text locators normalize whitespace, retain smallest rendered elements and never guess duplicates', () => {
  const f = fixture();
  assert.equal(f.query('¥45', 'text', undefined, { scope: '#plans' }), f.price);
  assert.equal(f.query('选择 套餐', 'text'), f.label);
  assert.equal(f.query('¥45', 'text', 1), f.duplicate);
  assert.equal(f.query('¥45', 'text', undefined, { countOnly: true }), 2);
  assert.throws(() => f.query('¥45', 'text'), error => error.diagnostics.reason === 'selector_ambiguous');
  assert.throws(() => f.query('¥45', 'text', undefined, { scope: '.duplicate-scope' }), /matched 2/);
  assert.equal(f.query('套餐', 'text', undefined, { missing: 'null' }), null);
  assert.equal(f.query('套餐', 'text', undefined, { text_match: 'contains' }), f.label);
  assert.equal(f.query('¥ 45', 'text'), f.fragment);
  assert.equal(f.query('不存在', 'text', undefined, { missing: 'count' }), 0);
  f.label.innerText = 'Plan';
  assert.equal(f.query('plan', 'text', undefined, { missing: 'null' }), null);
});

test('text locators bound traversal and constrain their extra options to text queries', () => {
  const f = fixture();
  f.plans.querySelectorAll = () => Array(10000).fill(f.price);
  assert.throws(() => f.query('¥45', 'text', undefined, { scope: '#plans' }), error => error.diagnostics.reason === 'text_locator_limit');
  for (const args of [{ ref: 'r', scope: '#plans' }, { selector: '#go', text_match: 'contains' }, { selector: '¥45', selector_type: 'text', text_match: 'fuzzy' }, { selector: '¥45', selector_type: 'text', scope: ' ' }]) assert.throws(() => targetOptions(args));
});

test('text locators share read_text, wait, count and live selector resolution', async () => {
  const f = fixture(), args = { selector: '¥45', selector_type: 'text', scope: '#plans' };
  const extract = vm.runInNewContext(`(${extractText.toString()})`, { document: f.document, location: { href: 'https://test/' } });
  assert.equal(extract({ ...args, mode: 'visible', offset: 0, max_chars: 100 }, f.query).text, '¥45');
  assert.equal(inspectWait(f.query, null, { ...args, condition: 'text', expected: '45' }).satisfied, true);
  assert.equal(inspectWait(f.query, null, { selector: '¥45', selector_type: 'text', condition: 'count', expected: 2 }).satisfied, true);
  const cdp = async (target, method, params) => {
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 2 };
    if (method === 'Runtime.evaluate') {
      const value = vm.runInNewContext(params.expression, { document: f.document });
      assert.equal(value, f.price); return { result: { objectId: 'price' } };
    }
    if (method === 'DOM.describeNode') return { node: { backendNodeId: 45 } };
    if (method === 'DOM.resolveNode') return { object: { objectId: 'price' } };
    throw new Error(method);
  };
  const resolved = await resolveSelector(cdp, r => r.result?.value, { frames: async () => [{ id: 'main' }], target: () => ({ tabId: 9 }) }, 9, args, deadline(1000));
  assert.equal(resolved.backendNodeId, 45);
});
