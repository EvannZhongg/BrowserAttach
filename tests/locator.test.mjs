import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { queryElement, targetOptions, resolveSelector, resolveFrame, matchRole } from '../extension/locator.js';
import { deadline } from '../extension/actionability.js';

test('selector timeouts preserve the last count, nth and actual frame without a second DOM query', async () => {
  for (const type of ['css', 'xpath', 'label', 'placeholder', 'role']) {
    for (const count of [0, 2]) {
      const nodes = Array.from({ length: count }, (_, i) => ({ nodeType: 1, id: String(i), labels: [{ textContent: 'Row' }], getAttribute: () => 'Row' }));
      let queries = 0, reads = 0;
      const query = vm.runInNewContext(`(${queryElement.toString()})`, { document: {
        querySelectorAll: () => { queries++; return nodes; },
        evaluate: () => { queries++; return { snapshotLength: count, snapshotItem: i => nodes[i] }; },
      }, XPathResult: { ORDERED_NODE_SNAPSHOT_TYPE: 7 } });
      const cdp = async (target, method) => {
        if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 };
        if (method === 'Runtime.evaluate') { reads++; return { result: { type: 'number', value: query('Row', type, 3, { missing: 'count' }) } }; }
        if (method === 'Accessibility.getFullAXTree') return { nodes: nodes.map((node, i) => ({ nodeId: String(i), backendDOMNodeId: i + 1, role: { value: 'Row' } })) };
        throw new Error(`Unexpected diagnostic query: ${method}`);
      };
      const sessions = { frames: async () => [{ id: 'main' }, { id: 'child' }], target: () => ({ tabId: 9 }) };
      await assert.rejects(resolveSelector(cdp, r => r.result?.value, sessions, 9,
        { selector: 'Row', selector_type: type, nth: 3, frame_id: 'child' }, deadline(100)), error => {
        assert.equal(error.input_dispatched, false); assert.equal(error.diagnostics.matched, count);
        assert.equal(error.diagnostics.reason, count ? 'selector_nth_out_of_range' : 'selector_not_found');
        assert.equal(error.diagnostics.nth, 3); assert.equal(error.diagnostics.frame_id, 'child'); assert.equal(error.diagnostics.selector, 'Row');
        return true;
      });
      assert.equal(queries, reads);
      assert.equal(await resolveSelector(cdp, r => r.result?.value, sessions, 9,
        { selector: 'Row', selector_type: type, nth: 3 }, deadline(100), { wait: false }), null);
    }
  }
});

test('explicit nth selects CSS/XPath document order; omission remains strict', () => {
  const elements = ['first', 'second'].map((id, index) => ({ nodeType: 1, id, tagName: 'BUTTON', textContent: `Choice ${index}`,
    matches: () => index === 1, closest: () => null, getBoundingClientRect: () => ({ width: 10, height: index ? 0 : 10 }),
    ownerDocument: { defaultView: { getComputedStyle: () => ({ visibility: 'visible' }) } } }));
  const query = vm.runInNewContext(`(${queryElement.toString()})`, { document: {
    querySelectorAll: () => elements,
    evaluate: () => ({ snapshotLength: 2, snapshotItem: n => elements[n] }),
  }, XPathResult: { ORDERED_NODE_SNAPSHOT_TYPE: 7 } });
  for (const type of ['css', 'xpath']) {
    assert.throws(() => query('input', type), error => {
      assert.match(error.message, /matched 2/);
      assert.equal(error.diagnostics.reason, 'selector_ambiguous'); assert.equal(error.diagnostics.matched, 2);
      assert.match(error.message, /"nth":0,"tag":"button","text":"Choice 0","disabled":false,"visible":true/);
      assert.match(error.message, /"nth":1,"tag":"button","text":"Choice 1","disabled":true,"visible":false/);
      return true;
    });
    assert.equal(query('input', type, 0), elements[0]);
    assert.equal(query('input', type, 1), elements[1]);
    assert.throws(() => query('input', type, 2), /out of range.*matched 2/);
    assert.equal(query('input', type, 2, { missing: 'null' }), null);
    assert.equal(query('input', type, 2, { missing: 'count' }), 2);
  }
  for (const args of [{ ref: 'a', nth: 0 }, { x: 1, y: 1, nth: 0 }, { selector: 'input', nth: -1 }, { selector: 'input', nth: 1.5 }]) {
    assert.throws(() => targetOptions(args, { coordinates: true }), /nth/);
  }
});

test('ambiguity previews bound candidate count and text without losing total match count', () => {
  const element = { nodeType: 1, tagName: 'DIV', textContent: 'x'.repeat(1000), matches: () => false, closest: () => null,
    getBoundingClientRect: () => ({ width: 10, height: 10 }), ownerDocument: { defaultView: { getComputedStyle: () => ({ visibility: 'visible' }) } } };
  const query = vm.runInNewContext(`(${queryElement.toString()})`, { document: { querySelectorAll: () => Array(100).fill(element) } });
  assert.throws(() => query('div'), error => {
    assert.match(error.message, /matched 100/); assert.match(error.message, /90 more omitted/);
    assert.equal((error.message.match(/"nth":/g) || []).length, 10);
    assert.ok(error.message.length < 2500); return true;
  });
});

test('invalid CSS preserves the parser failure and provides semantic alternatives without translating the selector', () => {
  const queries = [];
  const query = vm.runInNewContext(`(${queryElement.toString()})`, { document: {
    querySelectorAll: selector => { queries.push(selector); throw new Error('Invalid selector syntax'); },
    evaluate: () => { throw new Error('Invalid XPath'); },
  }, XPathResult: { ORDERED_NODE_SNAPSHOT_TYPE: 7 } });
  assert.throws(() => query('button:has-text("Claim")'), error => {
    assert.equal(error.diagnostics.reason, 'selector_invalid');
    assert.match(error.message, /Invalid selector syntax.*browser-native CSS.*Playwright.*selector_type="role".*actual AX role.*label.*placeholder/);
    assert.match(error.diagnostics.hint, /browser_snapshot/); return true;
  });
  assert.deepEqual(queries, ['button:has-text("Claim")']);
  assert.throws(() => query('bad xpath', 'xpath'), error => {
    assert.equal(error.message, 'Invalid XPath'); assert.equal(error.diagnostics.hint, undefined); return true;
  });
});

test('role failure suggests bounded accessible-name matches without resolving or acting on them', async () => {
  const nodes = [
    { nodeId: 'partial', backendDOMNodeId: 1, role: { value: 'button' }, name: { value: 'Claim reward' } },
    { nodeId: 'exact', backendDOMNodeId: 2, role: { value: 'link' }, name: { value: 'Claim' } },
    { nodeId: 'hidden', backendDOMNodeId: 3, ignored: true, role: { value: 'link' }, name: { value: 'Claim hidden' } },
    { nodeId: 'no-dom', role: { value: 'link' }, name: { value: 'Claim no DOM' } },
    { nodeId: 'duplicate', backendDOMNodeId: 2, role: { value: 'link' }, name: { value: 'Claim' } },
    ...Array.from({ length: 15 }, (_, i) => ({ nodeId: `long-${i}`, backendDOMNodeId: 10 + i, role: { value: 'link' }, name: { value: `Claim ${'x'.repeat(200)}${i}` } })),
  ];
  const sessions = { frames: async () => [{ id: 'child' }], target: () => ({ tabId: 1 }) };
  const calls = [];
  const cdp = async (target, method) => { calls.push(method); return { nodes }; };
  for (const args of [{ selector: 'Claim' }, { selector: 'button', name: 'cLaIm' }]) {
    await assert.rejects(resolveSelector(cdp, r => r.result?.value, sessions, 1, { selector_type: 'role', ...args }, deadline(100)), error => {
      assert.equal(error.input_dispatched, false);
      assert.equal(error.diagnostics.reason, 'selector_not_found');
      assert.equal(error.diagnostics.frame_id, 'child');
      assert.equal(error.diagnostics.suggestions.length, 10);
      assert.equal(error.diagnostics.omitted_suggestions, 7);
      assert.deepEqual(error.diagnostics.suggestions[0], { role: 'link', name: 'Claim' });
      assert.equal(error.diagnostics.suggestions[2].name.length, 120);
      assert.equal(error.diagnostics.suggestions[2].name_truncated, true);
      assert.match(error.message, /selector is the actual AX role.*name is the exact accessible name.*diagnostic only/);
      return true;
    });
  }
  await assert.rejects(resolveSelector(cdp, r => r.result?.value, sessions, 1, { selector_type: 'role', selector: 'button', name: '' }, deadline(100)), error => {
    assert.deepEqual(error.diagnostics.suggestions, []); return true;
  });
  assert.ok(calls.length > 0 && calls.every(method => method === 'Accessibility.getFullAXTree'));
});

test('selector preparation waits for a later-rendered option, but never retries ambiguity or dispatches input', async () => {
  let samples = 0;
  const calls = [];
  const cdp = async (target, method) => {
    calls.push(method);
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 };
    if (method === 'Runtime.evaluate') return ++samples < 3 ? { result: { type: 'number', value: 0 } } : { result: { objectId: 'option' } };
    if (method === 'DOM.describeNode') return { node: { backendNodeId: 2 } };
    if (method === 'DOM.resolveNode') return { object: { objectId: 'page-option' } };
  };
  const sessions = { frames: async () => [{ id: 'main' }], target: () => ({ tabId: 1 }) };
  const value = result => { if (result.exceptionDetails) throw new Error(result.exceptionDetails.text); return result.result?.value; };
  const node = await resolveSelector(cdp, value, sessions, 1, { selector: '.option' }, deadline(500));
  assert.equal(samples, 3); assert.equal(node.objectId, 'page-option');
  assert.ok(!calls.some(method => method.startsWith('Input.')));
  let attempts = 0;
  await assert.rejects(resolveSelector(async (target, method) => method === 'Runtime.evaluate'
    ? (attempts++, { exceptionDetails: { text: 'Selector must match exactly one element; matched 2' } })
    : { executionContextId: 1 }, value, sessions, 1, { selector: '.option' }, deadline(500)), /matched 2/);
  assert.equal(attempts, 1);
  await assert.rejects(resolveSelector(async (target, method) => method === 'Runtime.evaluate'
    ? { result: { type: 'number', value: 0 } } : { executionContextId: 1 }, value, sessions, 1, { selector: '.missing' }, deadline(100)), /no input was dispatched/);
});


test('frame paths resolve each strict iframe selector, and exact URL/title match must be unique', async () => {
  const frames=[{id:'main',url:'https://test/'},{id:'child',url:'https://test/child'},{id:'nested',url:'https://test/nested'}];
  let current='main',paths=0;
  const sessions={frames:async()=>frames,target:(tabId,frameId)=>({tabId,frameId})};
  const cdp=async(target,method,args)=>{
    if(method==='Page.createIsolatedWorld'){current=args.frameId;return {executionContextId:args.frameId}}
    if(method==='Runtime.evaluate')return args.expression==='document.title'?{result:{value:current==='nested'?'Inner':'Outer'}}:{result:{objectId:`owner-${++paths}`}};
    if(method==='DOM.describeNode')return {node:{nodeName:'IFRAME',frameId:current==='main'?'child':'nested'}};
    return {};
  };
  const value=result=>result.result?.value;
  assert.equal(await resolveFrame(cdp,value,sessions,9,{frame:{path:['iframe[title="Outer"]','iframe[title="Inner"]']}},deadline(500)),'nested');
  assert.equal(paths,2);
  assert.equal(await resolveFrame(cdp,value,sessions,9,{frame:{url:'https://test/nested'}},deadline(500)),'nested');
  assert.equal(await resolveFrame(cdp,value,sessions,9,{frame:{title:'Inner'}},deadline(500)),'nested');
  await assert.rejects(resolveFrame(async(target,method,args)=>method==='Runtime.evaluate'?{result:{value:'Same'}}:cdp(target,method,args),value,sessions,9,{frame:{title:'Same'}},deadline(500)),/matched 2/);
  assert.throws(()=>targetOptions({selector:'button',frame_id:'old',frame:{title:'Inner'}}),/never both/);
});

test('failed frame paths and unknown ids report bounded current candidates and retain diagnostics on timeout', async () => {
  const frames = [{ id: 'main', url: 'https://test/' }, ...Array.from({ length: 20 }, (_, i) => ({ id: `child-${i}`, parentId: 'main', url: `https://test/${i}` }))];
  const sessions = { frames: async () => frames, target: tabId => ({ tabId }) };
  const cdp = async (target, method) => method === 'Runtime.evaluate'
    ? { exceptionDetails: { text: 'Selector must match exactly one element; matched 0' } } : { executionContextId: 1 };
  const value = result => { if (result.exceptionDetails) throw new Error(result.exceptionDetails.text); };
  await assert.rejects(resolveFrame(cdp, value, sessions, 9, { frame: { path: ['content_iframe'] } }, deadline(100)), error => {
    assert.equal(error.input_dispatched, false);
    assert.equal(error.diagnostics.path_index, 0); assert.equal(error.diagnostics.selector, 'content_iframe');
    assert.equal(error.diagnostics.candidates.length, 10); assert.equal(error.diagnostics.omitted_candidates, 11);
    assert.match(error.message, /CSS selectors.*#content_iframe.*child-0/); return true;
  });
  await assert.rejects(resolveFrame(cdp, value, sessions, 9, { frame_id: 'old' }, deadline(100)), error => {
    assert.equal(error.diagnostics.reason, 'frame_locator');
    assert.equal(error.diagnostics.candidates[0].frame_id, 'main'); return true;
  });
});

test('label locators use real control associations, normalize whitespace, and preserve strict ambiguity', () => {
  const field = labels => ({ nodeType: 1, tagName: 'INPUT', labels: labels.map(textContent => ({ textContent })),
    matches: () => false, closest: () => null, getBoundingClientRect: () => ({ width: 10, height: 10 }),
    ownerDocument: { defaultView: { getComputedStyle: () => ({ visibility: 'visible' }) } } });
  const first = field(['  工作\n 职责  ']), second = field(['工作 职责']), unlabeled = field([]);
  const query = vm.runInNewContext(`(${queryElement.toString()})`, { document: { querySelectorAll: () => [first, second, unlabeled] } });
  assert.equal(query('工作 职责', 'label', 1), second);
  assert.equal(query('工作职责', 'label', undefined, { missing: 'null' }), null);
  assert.throws(() => query('工作 职责', 'label'), /matched 2/);
  const placeholder = `Name ["quoted"]`;
  first.getAttribute = () => placeholder; second.getAttribute = () => `${placeholder} `; unlabeled.getAttribute = () => null;
  assert.equal(query(placeholder, 'placeholder'), first);
  assert.equal(query('Name', 'placeholder', undefined, { missing: 'null' }), null);
});

test('role locators use exact browser AX identities in tree order and re-resolve each call', async () => {
  const nodes = [
    { nodeId: 'root', childIds: ['second', 'first', 'hidden'] },
    { nodeId: 'first', backendDOMNodeId: 1, role: { value: 'option' }, name: { value: '2026' } },
    { nodeId: 'hidden', backendDOMNodeId: 3, ignored: true, role: { value: 'option' }, name: { value: '2026' } },
    { nodeId: 'second', backendDOMNodeId: 2, role: { value: 'option' }, name: { value: '2025' } },
  ];
  assert.equal(matchRole(nodes, { selector: 'option', nth: 0 }).backendDOMNodeId, 2);
  assert.equal(matchRole(nodes, { selector: 'option', name: '2026' }).backendDOMNodeId, 1);
  assert.equal(matchRole(nodes, { selector: 'option', name: '202' }), null);
  assert.throws(() => matchRole(nodes, { selector: 'option' }), error => {
    assert.match(error.message, /matched 2/);
    assert.equal(error.diagnostics.reason, 'selector_ambiguous'); assert.equal(error.diagnostics.selector_type, 'role'); return true;
  });
  let backend = 10;
  const sessions = { frames: async () => [{ id: 'main' }], target: () => ({ tabId: 9 }) };
  const cdp = async (target, method, params) => method === 'Accessibility.getFullAXTree'
    ? { nodes: [{ nodeId: 'option', backendDOMNodeId: backend++, role: { value: 'option' }, name: { value: '2026' } }] }
    : { object: { objectId: `node-${params.backendNodeId}` } };
  for (const id of [10, 11]) {
    const node = await resolveSelector(cdp, r => r.result?.value, sessions, 9, { selector: 'option', selector_type: 'role', name: '2026' }, deadline(500));
    assert.equal(node.backendNodeId, id); assert.equal(node.objectId, `node-${id}`);
  }
  for (const args of [{ selector: 'input', name: 'Name' }, { selector: 'textbox', selector_type: 'role', name: 1 }, { focused: true, selector: 'input' }, { focused: false }]) {
    assert.throws(() => targetOptions(args, { focused: true }));
  }
  targetOptions({ focused: true }, { focused: true });
  assert.throws(() => targetOptions({ focused: true }));
});
