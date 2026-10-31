import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/controller-fixture.mjs';

test('document coordinate click scrolls once and converts back to viewport before dispatch', async () => {
  const f = fixture(); await f.claim(); const send = f.api.debugger.sendCommand; let scrolled = false;
  f.api.debugger.sendCommand = async (target, method, args) => {
    const result = await send(target, method, args);
    if (method === 'Runtime.evaluate' && args.expression.startsWith('scrollTo(')) scrolled = true;
    if (scrolled && method === 'Runtime.evaluate' && args.expression.includes('scroll_x: scrollX')) result.result.value.scroll_y = 1200;
    return result;
  };
  const result = await f.exec('click', { x: 100, y: 1500, coordinate_space: 'document' });
  assert.deepEqual(result.clicked, { x: 100, y: 300 });
  assert.equal(f.calls.filter(call => call.args?.expression?.startsWith('scrollTo(')).length, 1);
  assert.ok(f.calls.filter(call => call.method === 'Input.dispatchMouseEvent').every(call => call.args.y === 300));
});

test('scroll defaults to DOM; explicit wheel uses viewport coordinates and never substitutes DOM', async () => {
  const f = fixture(); await f.claim();
  await assert.rejects(f.exec('scroll', {name:'Submit', delta_y:120}), /Provide exactly one of ref or selector/);
  const ref = f.ref(await f.exec('snapshot'));
  await f.exec('scroll', {delta_y:120});
  assert.ok(f.calls.some(call => call.method === 'Runtime.evaluate' && call.args.expression.includes('function scrollAtPoint')));
  assert.equal(f.calls.filter(call => call.method === 'Input.dispatchMouseEvent').length, 0);
  assert.equal((await f.exec('click', {ref})).target_verified, true);
  f.calls.length = 0;
  const result = await f.exec('scroll', {mode:'wheel',x:25,y:30,delta_x:-40,delta_y:120});
  const dispatch = f.calls.find(call => call.method === 'Input.dispatchMouseEvent');
  assert.deepEqual(dispatch.target, {tabId:9});
  assert.deepEqual(dispatch.args, {type:'mouseWheel',x:25,y:30,deltaX:-40,deltaY:120,button:'none',buttons:0,modifiers:0});
  assert.equal(result.method,'native_wheel'); assert.equal(result.application_result,'not_checked');
  assert.equal(result.scrolled, undefined);
  assert.ok(!f.calls.some(call => call.method === 'Runtime.evaluate' && call.args.expression.includes('function scrollAtPoint')));
  await assert.rejects(f.exec('scroll',{mode:'bad',delta_y:1}),/mode/);
  await assert.rejects(f.exec('scroll',{mode:'wheel',x:-1,delta_y:1}),/viewport/);
  await assert.rejects(f.exec('scroll',{mode:'wheel',delta_y:Infinity}),/finite/);
  assert.equal(f.calls.filter(call => call.method === 'Input.dispatchMouseEvent').length,1);
});

test('a stalled native wheel frees the queue, reports unknown outcome and never replays a late response', async () => {
  const f = fixture(); await f.claim();
  const send = f.api.debugger.sendCommand; let finish;
  f.api.debugger.sendCommand = (target,method,args) => {
    const result = send(target,method,args);
    if (method === 'Input.dispatchMouseEvent') return new Promise(resolve => { finish = () => resolve(result); });
    return result;
  };
  await assert.rejects(f.exec('scroll',{mode:'wheel',delta_y:100,timeout_ms:100}),/Outcome is unknown/);
  assert.ok((await f.exec('snapshot')).snapshot);
  finish(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.filter(call => call.method === 'Input.dispatchMouseEvent').length,1);
  assert.ok(!f.calls.some(call => call.method === 'Runtime.evaluate' && call.args.expression.includes('function scrollAtPoint')));
});

test('scroll search observes delayed matches and resumes after boundary growth without repeating unchanged scrolls', async () => {
  for (const grows of [false, true]) {
    const f = fixture(); await f.claim(); await f.exec('snapshot');
    const send = f.api.debugger.sendCommand;
    const initial = { x: 0, y: 0, width: 100, height: 100, client_width: 100, client_height: 100 };
    let scrolls = 0, boundaryAt;
    f.api.debugger.sendCommand = async (target, method, args) => {
      const result = await send(target, method, args);
      const loaded = boundaryAt != null && Date.now() - boundaryAt >= 200;
      if (method === 'Runtime.callFunctionOn' && args.functionDeclaration.includes('function findScrollText'))
        return { result: loaded && (!grows || scrolls === 2) ? { objectId: 'found' } : { subtype: 'null' } };
      if (method === 'Runtime.callFunctionOn' && args.functionDeclaration.includes('function scrollElement')) {
        scrolls++; boundaryAt ??= Date.now();
        return { result: { value: { scrolled: scrolls > 1, after: initial } } };
      }
      if (method === 'Runtime.callFunctionOn' && args.functionDeclaration.includes('function scrollState'))
        return { result: { value: { ...initial, height: grows && loaded ? 200 : 100 } } };
      if (method === 'DOM.describeNode' && args.objectId === 'found') return { node: { nodeType: 1, backendNodeId: 12 } };
      return result;
    };
    const result = await f.exec('scroll', { selector: '#list', until: { text: 'Later' }, max_steps: 3, timeout_ms: 1500 });
    assert.equal(result.found, true); assert.ok(result.ref);
    assert.equal(result.scroll_steps, grows ? 2 : 1); assert.equal(scrolls, grows ? 2 : 1);
    assert.ok(!f.calls.some(c => c.method.startsWith('Input.')));
  }
});

test('scroll boundary timeout stays uncertain, sends no repeated scroll and leaves the queue usable', async () => {
  const f = fixture(); await f.claim(); const send = f.api.debugger.sendCommand;
  const after = { x: 0, y: 0, width: 100, height: 100, client_width: 100, client_height: 100 };
  let scrolls = 0;
  f.api.debugger.sendCommand = async (target, method, args) => {
    const result = await send(target, method, args);
    if (method === 'Runtime.callFunctionOn' && args.functionDeclaration.includes('function findScrollText')) return { result: { subtype: 'null' } };
    if (method === 'Runtime.callFunctionOn' && args.functionDeclaration.includes('function scrollElement')) {
      scrolls++; return { result: { value: { scrolled: false, after } } };
    }
    if (method === 'Runtime.callFunctionOn' && args.functionDeclaration.includes('function scrollState')) return { result: { value: after } };
    return result;
  };
  await assert.rejects(f.exec('scroll', { selector: '#list', until: { text: 'Missing' }, timeout_ms: 250 }), error => {
    assert.equal(error.diagnostics.reason, 'scroll_search_stopped'); assert.equal(error.diagnostics.stop_reason, 'timeout');
    assert.equal(error.diagnostics.scroll_steps, 1); assert.equal(error.diagnostics.scroll_pending, false);
    assert.equal(error.diagnostics.boundary_observed, true); assert.deepEqual(error.diagnostics.last_scroll.after, after);
    assert.doesNotMatch(error.message, /verified delivery|Browser UI may be capturing/);
    assert.equal(error.post_action.delivery, 'unknown');
    assert.equal(error.post_action.assessment, 'observation_unavailable');
    assert.equal(error.post_action.dom_changed, null); assert.equal(error.post_action.observations.dom.available, false); return true;
  });
  assert.equal(scrolls, 1); assert.ok((await f.exec('snapshot')).snapshot);
});

test('scroll search distinguishes a step limit from a pending scroll timeout and never resumes late input', async () => {
  for (const pending of [false, true]) {
    const f = fixture(); await f.claim(); const send = f.api.debugger.sendCommand;
    let scrolls = 0, finish;
    f.api.debugger.sendCommand = async (target, method, args) => {
      if (method === 'Runtime.callFunctionOn' && args.functionDeclaration.includes('function findScrollText')) return { result: { subtype: 'null' } };
      if (method === 'Runtime.callFunctionOn' && args.functionDeclaration.includes('function scrollElement')) {
        scrolls++;
        const result = { result: { value: { scrolled: true, before: { y: 0 }, after: { y: 50 } } } };
        if (pending) return new Promise(resolve => { finish = () => resolve(result); });
        return result;
      }
      return send(target, method, args);
    };
    await assert.rejects(f.exec('scroll', { selector: '#list', until: { text: 'Missing' }, max_steps: 1, timeout_ms: 250 }), error => {
      const diagnostics = error.diagnostics;
      assert.equal(diagnostics.reason, 'scroll_search_stopped');
      assert.equal(diagnostics.stop_reason, pending ? 'timeout' : 'max_steps');
      assert.equal(diagnostics.scroll_steps, pending ? 0 : 1); assert.equal(diagnostics.scroll_pending, pending);
      assert.equal(diagnostics.boundary_observed, false); assert.equal(error.input_dispatched, true);
      assert.deepEqual(diagnostics.last_scroll, pending ? null : { scrolled: true, before: { y: 0 }, after: { y: 50 } });
      return true;
    });
    finish?.(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(scrolls, 1); assert.ok((await f.exec('snapshot')).snapshot);
  }
});

test('scroll search timeout supersedes old selector preparation diagnostics without claiming a scroll was dispatched', async () => {
  const f = fixture(); await f.claim(); const send = f.api.debugger.sendCommand;
  let queries = 0;
  f.api.debugger.sendCommand = async (target, method, args) => {
    if (method === 'Runtime.evaluate' && args.expression.startsWith('(function queryElement') && !queries++) return { result: { type: 'number', value: 0 } };
    if (method === 'Runtime.callFunctionOn' && args.functionDeclaration.includes('function findScrollText')) return new Promise(() => {});
    return send(target, method, args);
  };
  await assert.rejects(f.exec('scroll', { selector: '#list', until: { text: 'Missing' }, timeout_ms: 150 }), error => {
    assert.equal(error.input_dispatched, false); assert.equal(error.diagnostics.stop_reason, 'timeout');
    assert.equal(error.diagnostics.scroll_steps, 0); assert.equal(error.diagnostics.scroll_pending, false);
    assert.equal(error.diagnostics.last_scroll, null); return true;
  });
});

test('scroll search stops on document change with the completed scroll evidence', async () => {
  const f = fixture(); await f.claim(); const send = f.api.debugger.sendCommand;
  let scrolls = 0;
  f.api.debugger.sendCommand = async (target, method, args) => {
    if (method === 'Runtime.callFunctionOn' && args.functionDeclaration.includes('function findScrollText')) return { result: { subtype: 'null' } };
    if (method === 'Runtime.callFunctionOn' && args.functionDeclaration.includes('function scrollElement')) {
      scrolls++; f.api.debugger.onEvent.emit({ tabId: 9 }, 'Page.frameNavigated', { frame: { id: 'main' } });
      return { result: { value: { scrolled: true, after: { y: 50 } } } };
    }
    return send(target, method, args);
  };
  await assert.rejects(f.exec('scroll', { selector: '#list', until: { text: 'Missing' } }), error => {
    assert.equal(error.diagnostics.stop_reason, 'document_changed'); assert.equal(error.diagnostics.scroll_steps, 1);
    assert.equal(error.diagnostics.scroll_pending, false); return true;
  });
  assert.equal(scrolls, 1);
});

test('scrolled-page hit testing uses document coordinates while native input keeps viewport coordinates', async () => {
  const f = fixture(); await f.claim();
  const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => {
    const result = await send(target, method, args);
    if (method === 'Runtime.evaluate' && args.expression.includes('scroll_x: scrollX')) result.result.value.scroll_y = 500;
    return result;
  };
  await f.exec('click', { ref: f.ref(await f.exec('snapshot')) });
  assert.equal(f.calls.find(call => call.method === 'DOM.getNodeForLocation').args.y, 530);
  assert.equal(f.calls.find(call => call.method === 'Input.dispatchMouseEvent').args.y, 30);
});

test('document click preserves an already visible point and scrolls only the axis that needs it', async () => {
  for (const [x,y,expected] of [[300,400,0],[300,1500,1]]) {
    const f = fixture(); await f.claim(); const send = f.api.debugger.sendCommand; let scrolled = false;
    f.api.debugger.sendCommand = async (target,method,args)=>{
      const result=await send(target,method,args);
      if(method==='Runtime.evaluate'&&args.expression.startsWith('scrollTo('))scrolled=true;
      if(method==='Runtime.evaluate'&&args.expression.includes('scroll_x: scrollX'))
        result.result.value={...result.result.value,scroll_x:250,scroll_y:scrolled?1200:350};
      return result;
    };
    const result=await f.exec('click',{x,y,coordinate_space:'document'});
    assert.equal(result.clicked.x,50); assert.equal(result.clicked.y,expected?300:50);
    const scrolls=f.calls.filter(c=>c.args?.expression?.startsWith('scrollTo('));
    assert.equal(scrolls.length,expected); if(expected)assert.match(scrolls[0].args.expression,/left:250,/);
  }
});
