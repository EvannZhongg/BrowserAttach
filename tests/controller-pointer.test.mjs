import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/controller-fixture.mjs';
import { inspectTarget } from '../extension/actionability.js';
import { installGuard, clickOptions } from '../extension/click.js';

test('disabled hover retains target preparation and trusted pointer receipt without enabling clicks', async () => {
  const f = fixture(); await f.claim();
  const send = f.api.debugger.sendCommand;
  const element = { isConnected: true, tagName: 'BUTTON', matches: () => true, hasAttribute: () => false,
    getRootNode: () => ({}), getBoundingClientRect: () => ({ x: 10, y: 10, width: 90, height: 40 }),
    ownerDocument: { defaultView: { getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) } } };
  let binding;
  f.api.debugger.sendCommand = async (target, method, args) => {
    if (method === 'Runtime.addBinding') binding = args.name;
    if (method === 'Runtime.callFunctionOn' && args.functionDeclaration.includes('function inspectTarget')) {
      return { result: { value: inspectTarget.apply(element, args.arguments.map(arg => arg.value)) } };
    }
    if (method === 'Input.dispatchMouseEvent' && args.type === 'mouseMoved') {
      f.api.debugger.onEvent.emit(target, 'Runtime.bindingCalled', { name: binding, executionContextId: 42, payload: '{"matched":true}' });
    }
    return send(target, method, args);
  };
  const hovered = await f.exec('hover', { selector: '#disabled' });
  assert.equal(hovered.delivery_verified, true); assert.equal(hovered.target_verified, true);
  assert.deepEqual(f.calls.filter(call => call.method === 'Input.dispatchMouseEvent').map(call => call.args.type), ['mouseMoved']);
  f.calls.length = 0;
  await assert.rejects(f.exec('click', { selector: '#disabled', timeout_ms: 100 }), error => {
    assert.equal(error.input_dispatched, false); assert.equal(error.diagnostics.reason, 'disabled'); return true;
  });
  assert.ok(!f.calls.some(call => call.method.startsWith('Input.')));
  element.hasAttribute = name => name === 'inert';
  assert.equal(inspectTarget.call(element, false, true).reason, 'inert');
});

test('hover guard accepts disabled trusted pointermove only on the verified path; click guard still blocks', () => {
  for (const hover of [true, false]) {
    const listeners = new Map(), reports = [];
    const win = { addEventListener: (type, listener) => listeners.set(type, listener), removeEventListener: type => listeners.delete(type),
      setTimeout: () => 1, clearTimeout() {}, receipt: payload => reports.push(JSON.parse(payload)) };
    const element = { nodeType: 1, isConnected: true, ownerDocument: { defaultView: win }, getRootNode: () => ({}), matches: () => true, closest: () => null };
    const guard = installGuard.call(element, 'receipt', { ...clickOptions({}), hover }, 100, true);
    let prevented = false;
    const event = { type: hover ? 'pointermove' : 'click', button: 0, isTrusted: false, composedPath: () => [element],
      preventDefault: () => { prevented = true; }, stopImmediatePropagation() {} };
    const listener = listeners.get(event.type);
    listener(event); assert.equal(reports.length, 0);
    listener({ ...event, isTrusted: true });
    assert.equal(reports[0].matched, hover); assert.equal(prevented, !hover);
    if (hover) { listener({ ...event, isTrusted: true, composedPath: () => [] }); assert.equal(reports.at(-1).matched, false); }
    guard.stop(); assert.equal(listeners.size, 0); assert.equal(win.receipt, undefined);
  }
});

test('coordinate click returns a bounded hit identity by default without another renderer read', async () => {
  const f = fixture(); await f.claim(); const send = f.api.debugger.sendCommand;
  const hit = { tag: 'span', id: 'label', role: null, classes: ['large'], rect: { width: 10 }, text: 'x'.repeat(300), disabled: false, clickable_hint: true,
    clickable_target: { tag: 'button', id: 'delete', role: 'button', classes: ['danger'], text: 'Delete' } };
  let reads = 0;
  f.api.debugger.sendCommand = async (target, method, args) => {
    if (method === 'Runtime.callFunctionOn' && args.functionDeclaration.includes('function describeHit')) { reads++; return { result: { value: hit } }; }
    return send(target, method, args);
  };
  const compact = await f.exec('click', { x: 20, y: 20 });
  assert.equal(compact.target_verified, null); assert.equal(compact.delivery_verified, true); assert.equal(reads, 1);
  assert.equal(compact.hit_target.tag, 'span'); assert.equal(compact.hit_target.text.length, 120);
  assert.equal(compact.hit_target.clickable_target.id, 'delete'); assert.equal(compact.hit_target.rect, undefined); assert.equal(compact.hit_target.classes, undefined);
  const detailed = await f.exec('click', { x: 20, y: 20, detailed: true });
  assert.deepEqual(detailed.hit_target, hit); assert.equal(reads, 2);
});

test('inactive left single click verifies ref, selector and coordinate delivery without activation', async () => {
  for (const target of ['ref', 'selector', 'viewport', 'document']) {
    const f = fixture(); await f.claim(); const ref = f.ref(await f.exec('snapshot'));
    f.tabs.get(9).active = false;
    f.api.windows.get = async () => ({ focused: false, state: 'normal' });
    const send = f.api.debugger.sendCommand;
    f.api.debugger.sendCommand = async (tab, method, args) => method === 'Runtime.evaluate' && args.expression.includes('visibility_state: document.visibilityState')
      ? { result: { value: { visibility_state: 'hidden', has_focus: false } } } : send(tab, method, args);
    const args = target === 'ref' ? { ref } : target === 'selector' ? { selector: '#submit' } :
      { x: 55, y: 30, ...(target === 'document' ? { coordinate_space: 'document' } : {}) };
    const result = await f.exec('click', { ...args, detailed: true, button: 'left', click_count: 1, modifiers: [] });
    assert.equal(result.delivery_verified, true); assert.equal(result.events_trusted, true);
    assert.equal(result.target_verified, ['ref', 'selector'].includes(target) ? true : null);
    assert.deepEqual(result.page_state, { visibility_state: 'hidden', has_focus: false, tab_active: false, window_focused: false });
    assert.equal(f.tabs.get(9).active, false);
    assert.ok(!f.calls.some(c => ['Page.bringToFront', 'tabs.update', 'windows.update'].includes(c.method)));
    assert.deepEqual(f.calls.filter(c => c.method === 'Input.dispatchMouseEvent').map(c => c.args.type), ['mouseMoved', 'mousePressed', 'mouseReleased']);
  }
});

test('inactive hover, drag and other click variants remain unavailable before input', async () => {
  const actions = [
    ['hover', { x: 20, y: 20 }],
    ...['pointer', 'html5'].map(mode => ['drag', { source: { x: 20, y: 20 }, destination: { x: 80, y: 20 }, mode }]),
    ...[{ button: 'right' }, { button: 'middle' }, { click_count: 2 },
      ...['Alt', 'Control', 'Meta', 'Shift'].map(key => ({ modifiers: [key] }))].map(options => ['click', { x: 20, y: 20, ...options }]),
  ];
  for (const [action, args] of actions) {
    const f = fixture(); await f.claim(); f.tabs.get(9).active = false; f.calls.length = 0;
    await assert.rejects(f.exec(action, args), error => {
      assert.match(error.message, /TAB_NOT_READY.*tab not active.*No input was dispatched/);
      assert.equal(error.input_dispatched, false); return true;
    });
    assert.ok(!f.calls.some(c => c.method.startsWith('Input.')));
    assert.ok(!f.calls.some(c => ['Page.bringToFront', 'tabs.update', 'windows.update'].includes(c.method)));
  }
});

test('final click readiness permits a tab switch only for a left single click and still rejects suspension', async () => {
  for (const change of ['inactive', 'right_inactive', 'frozen', 'discarded']) {
    const f = fixture(); await f.claim(); const send = f.api.debugger.sendCommand;
    f.api.debugger.sendCommand = async (target, method, args) => {
      const result = await send(target, method, args);
      if (method === 'Runtime.callFunctionOn' && args.functionDeclaration.includes('function installGuard')) {
        f.tabs.get(9).active = false;
        if (['frozen', 'discarded'].includes(change)) f.tabs.get(9)[change] = true;
      }
      return result;
    };
    const action = f.exec('click', { x: 20, y: 20, detailed: true, ...(change === 'right_inactive' ? { button: 'right' } : {}) });
    if (change === 'inactive') assert.equal((await action).page_state.tab_active, false);
    else {
      await assert.rejects(action, /TAB_NOT_READY.*No input was dispatched/);
      assert.ok(!f.calls.some(c => c.method.startsWith('Input.')));
    }
  }
});

test('active occluded and unfocused native click verifies delivery without bringing the page forward', async () => {
  for (const state of [{ visibility_state: 'hidden', has_focus: false }, { visibility_state: 'visible', has_focus: false }]) {
    const f = fixture(); await f.claim(); const send = f.api.debugger.sendCommand;
    f.api.windows.get = async () => ({ focused: false, state: 'maximized' });
    f.api.debugger.sendCommand = async (target, method, args) => method === 'Runtime.evaluate' && args.expression.includes('visibility_state: document.visibilityState')
      ? { result: { value: state } } : send(target, method, args);
    const result = await f.exec('click', { x: 10, y: 10, detailed: true });
    assert.equal(result.target_verified, null); assert.equal(result.delivery_verified, true);
    assert.deepEqual(result.target_verification, { basis: 'coordinate_hit', hit_relation: null });
    assert.equal(result.page_state.visibility_state, state.visibility_state);
    assert.equal(result.page_state.window_focused, false);
    assert.ok(!f.calls.some(call => ['Page.bringToFront', 'tabs.update', 'windows.update'].includes(call.method)));
  }
  const f = fixture(); await f.claim(); f.calls.length = 0;
  f.api.windows.get = async () => ({ focused: false, state: 'minimized' });
  await assert.rejects(f.exec('click', { x: 10, y: 10 }), /TAB_NOT_READY.*minimized/);
  assert.equal(f.calls.length, 0);
  for (const property of ['discarded', 'frozen']) {
    const f = fixture(); await f.claim(); f.tabs.get(9).active = false; f.tabs.get(9)[property] = true; f.calls.length = 0;
    await assert.rejects(f.exec('click', { selector: '#submit' }), /TAB_NOT_READY.*renderer suspended/);
    assert.equal(f.calls.length, 0);
  }
});

test('claim shows a native tab-group marker; clicks retain only transient feedback without activation', async () => {
  const f = fixture(); await f.claim();
  assert.ok(f.calls.some(call => call.method === 'badge' && call.args.text === 'RUN' && call.args.tabId === 9));
  assert.ok(f.calls.some(call => call.method === 'tabGroups.update' && call.args.title === '' && call.args.color === 'red'));
  assert.ok(!f.calls.some(call => call.method === 'Runtime.evaluate' && call.args.expression.includes('__localBrowserAttachClickVisual')));
  await f.exec('click', { x: 20, y: 30 });
  assert.ok(!f.calls.some(call => call.method === 'Page.addScriptToEvaluateOnNewDocument'));
  assert.ok(!f.calls.some(call => call.method === 'Runtime.evaluate' && call.args.expression.includes('__localBrowserAttachVisual')));
  assert.ok(f.calls.some(call => call.method === 'Runtime.evaluate' && call.args.expression.includes('__localBrowserAttachClickVisual.click(20,30)')));
  assert.ok(!f.calls.some(call => call.method === 'Page.bringToFront'));
  await f.exec('release_tab');
  assert.ok(f.calls.some(call => call.method === 'tabs.ungroup'));
  assert.ok(f.calls.some(call => call.method === 'badge' && call.args.text === ''));
});

test('stalled click feedback cannot block release or draw a late marker after detach', async () => {
  const f = fixture(); await f.claim();
  const send = f.api.debugger.sendCommand;
  let finishSetup;
  f.api.debugger.sendCommand = (target, method, args) => {
    if (method === 'Page.createIsolatedWorld' && args.worldName === 'local-browser-attach-click-visual') {
      return new Promise(resolve => { finishSetup = resolve; });
    }
    return send(target, method, args);
  };
  await f.exec('click', { x: 20, y: 30 });
  await f.exec('release_tab');
  assert.equal(f.controller.claimedCount(), 0);
  finishSetup({ executionContextId: 43 });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(!f.calls.some(call => call.method === 'Runtime.evaluate' && call.args.expression.includes('__localBrowserAttachClickVisual.click(')));
});

test('mouse acknowledgments cannot serialize dispatch; mismatched events never report clicked', async () => {
  const f = fixture(); await f.claim();
  const send = f.api.debugger.sendCommand;
  let releaseMove;
  f.api.debugger.sendCommand = (target, method, args) => {
    if (method === 'Input.dispatchMouseEvent' && args.type === 'mouseMoved') {
      void send(target, method, args);
      return new Promise(resolve => { releaseMove = resolve; });
    }
    if (method === 'Input.dispatchMouseEvent' && args.type === 'mouseReleased') releaseMove({});
    return send(target, method, args);
  };
  const result = await f.exec('click', { x: 55, y: 30 });
  assert.equal(result.target_verified, null); assert.equal(result.delivery_verified, true);
  assert.equal(result.application_result, 'not_checked');
  const inputs = f.calls.filter(call => call.method === 'Input.dispatchMouseEvent');
  assert.deepEqual(inputs.map(call => call.args.buttons), [0, 1, 0]);
  const listener = f.api.debugger.onEvent.emit;
  f.api.debugger.onEvent.emit = (target, method, args) => listener(target, method,
    method === 'Runtime.bindingCalled' ? { ...args, payload: '{"matched":false}' } : args);
  await assert.rejects(f.exec('click', { x: 55, y: 30 }), error => {
    assert.match(error.message, /target changed/); assert.equal(error.input_dispatched, true);
    assert.equal(error.diagnostics.reason, 'target_changed');
    assert.equal(error.post_action.delivery, 'unknown'); return true;
  });
  assert.ok((await f.exec('snapshot')).snapshot);
});

test('missing trusted click events time out explicitly and the tab remains usable', async () => {
  const f = fixture(); await f.claim(); f.tabs.get(9).active = false;
  const emit = f.api.debugger.onEvent.emit;
  f.api.debugger.onEvent.emit = (target, method, args) => {
    if (method !== 'Runtime.bindingCalled') emit(target, method, args);
  };
  await assert.rejects(f.exec('click', { x: 55, y: 30 }), /Outcome is unknown/);
  assert.equal(f.calls.filter(c => c.method === 'Input.dispatchMouseEvent').length, 3);
  assert.ok((await f.exec('snapshot')).snapshot);
});

test('native drag keeps ordering, includes all requested moves and releases only once', async () => {
  const f = fixture(); await f.claim(); const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => {
    const result = await send(target, method, args);
    if (method === 'Runtime.callFunctionOn' && args.functionDeclaration.includes('function installDragReceipt')) return { result: { objectId: 'drag-guard' } };
    if (method === 'Input.dispatchMouseEvent') {
      const binding = f.calls.findLast(c => c.method === 'Runtime.addBinding')?.args.name;
      const type = { mousePressed: 'pointerdown', mouseReleased: 'pointerup', mouseMoved: 'pointermove' }[args.type];
      f.api.debugger.onEvent.emit(target, 'Runtime.bindingCalled', { name: binding, executionContextId: 42, payload: JSON.stringify({ type }) });
    }
    return result;
  };
  const result = await f.exec('drag', { source: { selector: '#source' }, destination: { selector: '#destination' }, steps: 5 });
  assert.equal(result.delivery_verified, true);
  const events = f.calls.filter(c => c.method === 'Input.dispatchMouseEvent').map(c => c.args.type);
  assert.deepEqual(events, ['mouseMoved', 'mousePressed', ...Array(6).fill('mouseMoved'), 'mouseReleased']);
  assert.equal(f.calls.filter(c => c.method === 'DOM.scrollIntoViewIfNeeded').length, 2);
  assert.ok(!f.calls.some(c => c.method === 'Input.dispatchDragEvent'));
});

test('optional click offset uses the verified hit point; settle timeout cannot dispatch late input', async () => {
  const f = fixture(); await f.claim();
  const result = await f.exec('click', { selector: '#go', offset: { x_ratio: .25, y_ratio: .75 }, settle_ms: [1, 1] });
  assert.deepEqual(result.clicked, { x: 32.5, y: 40 });
  assert.equal(result.target_verified, true);
  const events = f.calls.filter(c => c.method === 'Input.dispatchMouseEvent');
  assert.equal(events.length, 3);
  assert.ok(events.every(c => c.args.x === 32.5 && c.args.y === 40));
  f.calls.length = 0;
  await assert.rejects(f.exec('click', { x: 10, y: 10, settle_ms: 200, timeout_ms: 100 }), /no input was dispatched/);
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.ok(!f.calls.some(c => c.method.startsWith('Input.')));
});

test('detach during an optional settle cancels the pending click before dispatch', async () => {
  const f = fixture(); await f.claim(); const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => {
    const result = await send(target, method, args);
    if (method === 'Runtime.callFunctionOn' && args.functionDeclaration.includes('function installGuard')) {
      setTimeout(() => f.api.debugger.onDetach.emit({ tabId: 9 }), 10);
    }
    return result;
  };
  await assert.rejects(f.exec('click', { x: 10, y: 10, settle_ms: 80 }), /detached during click/);
  assert.ok(!f.calls.some(c => c.method.startsWith('Input.')));
});

test('optional drag trajectory reaches the requested point and a timeout releases without resuming moves', async () => {
  for (const timeout of [false, true]) {
    const f = fixture(); await f.claim(); const send = f.api.debugger.sendCommand;
    f.api.debugger.sendCommand = async (target, method, args) => {
      const result = await send(target, method, args);
      if (method === 'Runtime.callFunctionOn' && args.functionDeclaration.includes('function installDragReceipt')) return { result: { objectId: 'drag-guard' } };
      if (method === 'Input.dispatchMouseEvent') {
        const binding = f.calls.findLast(c => c.method === 'Runtime.addBinding')?.args.name;
        f.api.debugger.onEvent.emit(target, 'Runtime.bindingCalled', { name: binding, executionContextId: 42,
          payload: JSON.stringify({ type: { mousePressed: 'pointerdown', mouseReleased: 'pointerup', mouseMoved: 'pointermove' }[args.type] }) });
      }
      return result;
    };
    const operation = f.exec('drag', { source: { x: 50, y: 50 }, destination: { x: 200, y: 50 }, steps: 8,
      trajectory: { curve_px: 12, duration_ms: timeout ? 600 : 100 }, timeout_ms: timeout ? 150 : 5000 });
    if (timeout) await assert.rejects(operation, /Outcome is unknown/);
    else assert.deepEqual((await operation).to, { x: 200, y: 50 });
    const events = f.calls.filter(c => c.method === 'Input.dispatchMouseEvent').map(c => c.args);
    assert.equal(events.filter(e => e.type === 'mouseReleased').length, 1);
    assert.equal(events.at(-1).type, 'mouseReleased');
    assert.ok(events.some(e => e.type === 'mouseMoved' && e.y > 50));
    const count = events.length;
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.equal(f.calls.filter(c => c.method === 'Input.dispatchMouseEvent').length, count);
  }
});

test('document drag endpoints share a viewport and preserve both coordinate deltas before dispatch', async () => {
  for (const [a, b, initial] of [
    [{x:200,y:1000},{x:200,y:1200},{x:0,y:0}],
    [{x:200,y:1200},{x:200,y:1000},{x:0,y:0}],
    [{x:1400,y:200},{x:1600,y:200},{x:0,y:0}],
    [{x:1600,y:1200},{x:1400,y:1000},{x:1300,y:900}],
  ]) {
    const f = fixture(); await f.claim(); const send = f.api.debugger.sendCommand;
    let scroll = initial;
    f.api.debugger.sendCommand = async (target, method, args) => {
      const result = await send(target, method, args);
      if (method === 'Runtime.evaluate' && args.expression.startsWith('scrollTo(')) {
        const [,x,y] = args.expression.match(/left:([^,]+),top:([^,]+)/);
        scroll = {x:Number(x),y:Number(y)};
      }
      if (method === 'Runtime.evaluate' && args.expression.includes('scroll_x: scrollX'))
        result.result.value = {...result.result.value,scroll_x:scroll.x,scroll_y:scroll.y};
      if (method === 'Runtime.callFunctionOn' && args.functionDeclaration.includes('function installDragReceipt')) return {result:{objectId:'drag-guard'}};
      if (method === 'Input.dispatchMouseEvent') {
        const binding = f.calls.findLast(c=>c.method==='Runtime.addBinding')?.args.name;
        const type = {mousePressed:'pointerdown',mouseReleased:'pointerup',mouseMoved:'pointermove'}[args.type];
        f.api.debugger.onEvent.emit(target,'Runtime.bindingCalled',{name:binding,executionContextId:42,payload:JSON.stringify({type})});
      }
      return result;
    };
    const result = await f.exec('drag',{source:{...a,coordinate_space:'document'},destination:{...b,coordinate_space:'document'},steps:3});
    assert.equal(result.to.x-result.from.x,b.x-a.x); assert.equal(result.to.y-result.from.y,b.y-a.y);
    const inputAt = f.calls.findIndex(c=>c.method==='Input.dispatchMouseEvent');
    assert.ok(!f.calls.slice(inputAt).some(c=>c.args?.expression?.startsWith('scrollTo(')));
    assert.ok(f.calls.filter(c=>c.args?.expression?.startsWith('scrollTo(')).length<=1);
    const down = f.calls.find(c=>c.method==='Input.dispatchMouseEvent'&&c.args.type==='mousePressed').args;
    const up = f.calls.find(c=>c.method==='Input.dispatchMouseEvent'&&c.args.type==='mouseReleased').args;
    assert.equal(up.y-down.y,b.y-a.y); assert.equal(up.x-down.x,b.x-a.x);
    await assert.rejects(f.exec('drag',{source:{x:-1,y:100,coordinate_space:'document'},destination:{x:20,y:100,coordinate_space:'document'}}),/nonnegative/);
  }
});

test('an HTML5 drag without interception never invents payload or switches modes and cleans up', async () => {
  const f = fixture(); await f.claim(); const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => method === 'Runtime.callFunctionOn' && args.functionDeclaration.includes('function installDragReceipt')
    ? { result: { objectId: 'drag-guard' } } : send(target, method, args);
  await assert.rejects(f.exec('drag', { source: { selector: '#source' }, destination: { selector: '#destination' }, mode: 'html5', timeout_ms: 300 }), /Outcome is unknown/);
  assert.ok(f.calls.some(c => c.method === 'Input.cancelDragging'));
  assert.deepEqual(f.calls.filter(c => c.method === 'Input.setInterceptDrags').map(c => c.args.enabled), [true, false]);
  assert.equal(f.calls.filter(c => c.method === 'Input.dispatchMouseEvent' && c.args.type === 'mouseReleased').length, 1);
  assert.ok(!f.calls.some(c => c.method === 'Input.dispatchDragEvent'));
  assert.ok((await f.exec('snapshot')).snapshot);
});

test('drag stops after document change and does not resolve or act on a new destination', async () => {
  const f = fixture(); await f.claim(); const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => {
    if (method === 'Runtime.callFunctionOn' && args.functionDeclaration.includes('function installDragReceipt')) return { result: { objectId: 'drag-guard' } };
    const result = await send(target, method, args);
    if (method === 'Input.dispatchMouseEvent' && args.type === 'mousePressed') f.api.debugger.onEvent.emit(target, 'DOM.documentUpdated');
    return result;
  };
  await assert.rejects(f.exec('drag', { source: { selector: '#source' }, destination: { selector: '#destination' } }), /changed during drag|document.frame changed/);
  assert.ok(!f.calls.some(c => c.args?.expression?.includes('("#destination"')));
  assert.equal(f.calls.filter(c => c.method === 'Input.dispatchMouseEvent' && c.args.type === 'mouseReleased').length, 1);
});
