import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, withChildFrames } from './helpers/controller-fixture.mjs';

test('large AX observations page without exceeding the function argument limit', async () => {
  const f = fixture(); await f.claim();
  const count = 150000;
  f.nodes([{ nodeId: 'root', role: { value: 'RootWebArea' }, childIds: Array.from({ length: count }, (_, i) => String(i)) },
    ...Array.from({ length: count }, (_, i) => ({ nodeId: String(i), role: { value: 'button' }, name: { value: `Item ${i}` }, backendDOMNodeId: i + 1 }))]);
  const first = await f.exec('snapshot', { max_nodes: 1 });
  assert.equal(first.total_node_count, count + 1); assert.equal(first.node_count, 1); assert.equal(first.truncated, true);
  const second = await f.exec('snapshot', { cursor: first.next_cursor, max_nodes: 2 });
  assert.equal(second.total_node_count, count + 1);
  assert.match(second.snapshot, /button "Item 0"[\s\S]*button "Item 1"/);
  assert.equal(second.node_count, 2); assert.equal(second.truncated, true);
});

test('background right click fails before renderer work, keeps refs and can recover after explicit activation', async () => {
  const f = fixture(); await f.claim(); const ref = f.ref(await f.exec('snapshot'));
  f.tabs.get(9).active = false;
  f.calls.length = 0;
  await assert.rejects(f.exec('click', { ref, button: 'right', timeout_ms: 30000 }), error => {
    assert.match(error.message, /TAB_NOT_READY.*tab not active.*browser_tab_control action=activate.*No input was dispatched/);
    assert.doesNotMatch(error.message, /unknown/i); return true;
  });
  assert.equal(f.calls.length, 0);
  await f.exec('activate_tab');
  assert.equal((await f.exec('click', { ref, button: 'right' })).target_verified, true);
});

test('an unresponsive click preflight fails in 500ms without consuming the input timeout or dispatching late input', async t => {
  const f = fixture(); await f.claim(); t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const send = f.api.debugger.sendCommand; let finish;
  f.api.debugger.sendCommand = async (target, method, args) => {
    if (method === 'Runtime.evaluate' && args.expression.includes('visibility_state: document.visibilityState')) return await new Promise(resolve => {
      finish = () => resolve({ result: { value: { visibility_state: 'visible', has_focus: true } } });
    });
    return send(target, method, args);
  };
  const result = assert.rejects(f.exec('click', { x: 10, y: 10, timeout_ms: 30000 }), /TAB_NOT_READY.*within 500 ms.*No input was dispatched/);
  await new Promise(resolve => setImmediate(resolve)); t.mock.timers.tick(500); await result;
  finish(); await new Promise(resolve => setImmediate(resolve));
  assert.ok(!f.calls.some(call => call.method.startsWith('Input.')));
  assert.ok((await f.exec('snapshot')).snapshot);
});

test('window minimized during native preparation is caught by the final preflight without dispatch or fallback', async () => {
  const f = fixture(); await f.claim(); const send = f.api.debugger.sendCommand; let checks = 0;
  f.api.windows.get = async () => ({ focused: false, state: ++checks === 1 ? 'normal' : 'minimized' });
  f.api.debugger.sendCommand = async (target, method, args) => method === 'Runtime.evaluate' && args.expression.includes('visibility_state: document.visibilityState')
    ? { result: { value: { visibility_state: 'visible', has_focus: true } } } : send(target, method, args);
  await assert.rejects(f.exec('click', { x: 10, y: 10 }), /TAB_NOT_READY.*minimized/);
  assert.equal(checks, 2);
  assert.ok(!f.calls.some(call => call.method.startsWith('Input.') || call.args?.functionDeclaration?.includes('function clickElement')));
});

test('selectors resolve afresh per action, route isolated frame nodes and refuse ambiguous targets', async () => {
  const f = fixture(); await f.claim(); const send = f.api.debugger.sendCommand;
  let resolutions = 0;
  f.api.debugger.sendCommand = async (target, method, args) => {
    if (method === 'Runtime.evaluate' && args.expression.includes('function queryElement')) {
      resolutions++;
      if (args.expression.endsWith('("button","css",undefined,true)')) return { exceptionDetails: { text: 'Selector must match exactly one element; matched 2' } };
      return { result: { objectId: 'selector-node' } };
    }
    if (method === 'DOM.describeNode' && args.objectId === 'selector-node') return { node: { backendNodeId: 12 } };
    return send(target, method, args);
  };
  await f.exec('click', { selector: '#submit' });
  await f.exec('click', { selector: '//button[@id="submit"]', selector_type: 'xpath' });
  await f.exec('fill', { selector: '#name', text: 'controlled', mode: 'dom' });
  const dispatched = f.calls.filter(call => call.method === 'Input.dispatchMouseEvent').length;
  await assert.rejects(f.exec('click', { selector: 'button' }), /matched 2/);
  assert.equal(resolutions, 4);
  assert.equal(f.calls.filter(call => call.method === 'Input.dispatchMouseEvent').length, dispatched);
  await assert.rejects(f.exec('click', { selector: '#submit', frame_id: 'missing' }), /unknown/);
});

test('focused type needs no snapshot, never refocuses, and stops when its original field loses focus', async () => {
  const f = fixture(); await f.claim(); f.calls.length = 0;
  assert.equal((await f.exec('type', { focused: true, text: 'Ab中' })).typed, 3);
  assert.ok(!f.calls.some(c => c.method === 'Accessibility.getFullAXTree' || c.args?.functionDeclaration?.includes('this.focus()')));
  f.calls.length = 0;
  const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => {
    if (method === 'Runtime.callFunctionOn' && args.functionDeclaration.includes('const a=this.getRootNode().activeElement') &&
        f.calls.some(c => c.method === 'Input.dispatchKeyEvent' && c.args.type === 'keyDown')) return { result: { value: false } };
    return send(target, method, args);
  };
  await assert.rejects(f.exec('type', { focused: true, text: 'abc' }), /stopped after 1 characters.*lost focus/);
  assert.equal(f.calls.filter(c => c.method === 'Input.dispatchKeyEvent' && c.args.type === 'keyDown').length, 1);
  assert.ok(!f.calls.some(c => c.args?.functionDeclaration?.includes('this.focus()')));
});

test('AX backend identity survives consecutive inputs without another snapshot', async () => {
  const f = fixture(); await f.claim();
  const ref = f.ref(await f.exec('snapshot'));
  await f.exec('click', { ref });
  assert.equal(f.calls.filter(call => call.method === 'Input.dispatchMouseEvent').length, 3);
  await f.exec('click', { ref });
  assert.equal(f.calls.filter(call => call.method === 'Accessibility.getFullAXTree').length, 1);
  assert.equal(f.calls.filter(call => call.method === 'Input.dispatchMouseEvent').length, 6);
});

test('a new snapshot and navigation invalidate earlier element refs', async () => {
  const f = fixture(); await f.claim();
  const ref = f.ref(await f.exec('snapshot'));
  await f.exec('snapshot');
  await assert.rejects(f.exec('fill', { ref, text: 'test' }), error => {
    assert.equal(error.input_dispatched, false); assert.equal(error.diagnostics.cause, 'snapshot_replaced'); return true;
  });
  const current = f.ref(await f.exec('snapshot'));
  f.api.debugger.onEvent.emit({ tabId: 9 }, 'DOM.documentUpdated');
  await assert.rejects(f.exec('click', { ref: current }), error => {
    assert.equal(error.diagnostics.cause, 'document_updated'); return true;
  });
});

test('retired ref diagnostics are bounded and cleared on release, and missing backend nodes are explicit', async () => {
  const f = fixture(); await f.claim();
  f.nodes(Array.from({ length: 1002 }, (_, i) => ({ nodeId: String(i), backendDOMNodeId: i + 100,
    role: { value: 'button' }, name: { value: `Button ${i}` } })));
  const tree = await f.exec('snapshot', { max_nodes: 2000, max_chars: 100000 });
  const refs = [...tree.snapshot.matchAll(/\[([^\]]+)\] button/g)].map(match => match[1]);
  assert.equal(refs.length, 1002);
  await f.exec('snapshot');
  for (const [ref, cause] of [[refs[0], 'unknown_ref'], [refs.at(-1), 'snapshot_replaced']]) {
    await assert.rejects(f.exec('click', { ref }), error => { assert.equal(error.diagnostics.cause, cause); return true; });
  }
  await f.exec('release_tab'); await f.claim();
  await assert.rejects(f.exec('click', { ref: refs.at(-1) }), error => { assert.equal(error.diagnostics.cause, 'unknown_ref'); return true; });
  const ref = f.ref(await f.exec('snapshot'));
  const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => {
    if (method === 'DOM.resolveNode') throw new Error('No node with given id found');
    return send(target, method, args);
  };
  await assert.rejects(f.exec('click', { ref }), error => {
    assert.equal(error.input_dispatched, false); assert.equal(error.diagnostics.cause, 'element_detached'); return true;
  });
  assert.equal(f.calls.filter(call => call.method.startsWith('Input.')).length, 0);
});

test('document invalidation during ref identity resolution is diagnosed before dispatch', async () => {
  for (const failRead of [false, true]) {
    const f = fixture(); await f.claim(); const ref = f.ref(await f.exec('snapshot'));
    const send = f.api.debugger.sendCommand;
    f.api.debugger.sendCommand = async (target, method, args) => {
      const result = await send(target, method, args);
      if (method === 'Accessibility.getPartialAXTree') {
        f.api.debugger.onEvent.emit(target, 'DOM.documentUpdated');
        if (failRead) throw new Error('Cannot find context');
      }
      return result;
    };
    await assert.rejects(f.exec('click', { ref }), error => {
      assert.equal(error.input_dispatched, false); assert.equal(error.diagnostics.cause, 'document_updated'); return true;
    });
    assert.equal(f.calls.filter(call => call.method.startsWith('Input.')).length, 0);
  }
});

test('covered elements are refused before input is dispatched', async () => {
  const f = fixture(); await f.claim(); f.block();
  const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => method === 'Runtime.callFunctionOn' && args.functionDeclaration.includes('function describeHit')
    ? { result: { value: { tag: 'div', text: 'Loading overlay', clickable_hint: false } } } : send(target, method, args);
  const ref = f.ref(await f.exec('snapshot'));
  await assert.rejects(f.exec('click', { ref }), error => {
    assert.match(error.message, /covers.*hit_target=.*Loading overlay.*point=.*frame_id=.*No input was dispatched/);
    assert.equal(error.input_dispatched, false); assert.equal(error.post_action, undefined); return true;
  });
  const batch = await f.exec('batch', { steps: [{ action: 'click', selector: '#go' }] });
  assert.equal(batch.completed, false); assert.equal(batch.retry_failed_step_safe, true);
  assert.equal(f.calls.filter(call => call.method === 'Input.dispatchMouseEvent').length, 0);
});

test('native fill detects swallowed or reformatted text and never falls back or replays', async () => {
  const f = fixture(); await f.claim();
  const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => {
    const result = await send(target, method, args);
    if (method === 'Runtime.callFunctionOn' && args.functionDeclaration.includes('function verifyFill')) result.result.value = false;
    return result;
  };
  const snapshot = await f.exec('snapshot'), ref = snapshot.snapshot.match(/\[([^\]]+)\] textbox/)[1];
  await assert.rejects(f.exec('fill', { ref, text: 'lost' }), error => {
    assert.match(error.message, /did not retain.*Outcome is unknown/);
    assert.equal(error.diagnostics.reason, 'value_not_retained');
    assert.equal(error.input_dispatched, true);
    assert.equal(error.post_action.delivery, 'unknown');
    assert.ok(!JSON.stringify(error.diagnostics).includes('lost'));
    return true;
  });
  assert.equal(f.calls.filter(call => call.method === 'Input.insertText').length, 1);
  assert.ok((await f.exec('snapshot')).snapshot);
});

test('keyboard validates chords and emits key up; non-http navigation is refused', async () => {
  const f = fixture(); await f.claim();
  await f.exec('press_key', { key: 'Control+Shift+ArrowLeft' });
  const events = f.calls.filter(call => call.method === 'Input.dispatchKeyEvent');
  assert.equal(events[0].args.modifiers, 10);
  assert.equal(events[1].args.type, 'keyUp');
  await assert.rejects(f.exec('navigate', { url: 'javascript:alert(1)' }), /http/);
});

test('AX iframe owners expose remote frame coverage when the frame tree omits them', async () => {
  const f = fixture(); await f.claim();
  f.nodes([{ nodeId: '1', role: { value: 'RootWebArea' }, childIds: ['2'] },
    { nodeId: '2', role: { value: 'Iframe' }, backendDOMNodeId: 22, name: { value: 'Remote' } }]);
  const snapshot = await f.exec('snapshot');
  assert.equal(snapshot.omitted_frames[0].url, 'https://frame.test/');
  assert.match(snapshot.omitted_frames[0].reason, /another process/);
});

test('long AX names can be continued without loss, with stable refs and configurable budgets', async () => {
  const f = fixture(); await f.claim();
  const nodes = [{ nodeId: 'root', role: { value: 'RootWebArea' }, childIds: [] }];
  for (let i = 0; i < 80; i++) {
    nodes[0].childIds.push(String(i));
    nodes.push({ nodeId: String(i), role: { value: 'button' }, backendDOMNodeId: i + 1, name: { value: '长文本"\\'.repeat(200) } });
  }
  f.nodes(nodes);
  const snapshot = await f.exec('snapshot', { max_nodes: 3000, max_chars: 14000, verbose: true });
  assert.equal(snapshot.truncated, true);
  assert.equal(snapshot.truncation_reason, 'text_budget');
  assert.ok(JSON.stringify(snapshot).length < 16000);
  let page = snapshot, count = snapshot.node_count;
  while (page.next_cursor) {
    page = await f.exec('snapshot', { cursor: page.next_cursor, max_nodes: 3000, max_chars: 14000, verbose: true });
    assert.equal(page.snapshot_id, snapshot.snapshot_id);
    count += page.node_count;
  }
  assert.equal(count, 81);
  assert.equal(f.calls.filter(call => call.method === 'Accessibility.getFullAXTree').length, 1);
  const stale = await f.exec('snapshot', { max_chars: 14000 });
  await f.exec('click', { ref: stale.snapshot.match(/\[([^\]]+)\] button/)[1] });
  await assert.rejects(f.exec('snapshot', { cursor: stale.next_cursor }), /stale/);
});

test('compact AX represents 200 list items without duplicate inline text or lost interactive children', async () => {
  const f = fixture(); await f.claim();
  const nodes = [{ nodeId: 'root', role: { value: 'RootWebArea' }, childIds: [] }];
  for (let i = 1; i <= 200; i++) {
    nodes[0].childIds.push(`li${i}`);
    nodes.push({ nodeId: `li${i}`, role: { value: 'listitem' }, backendDOMNodeId: i, childIds: [`text${i}`] },
      { nodeId: `text${i}`, role: { value: 'StaticText' }, name: { value: `Row ${i}: alpha beta gamma delta epsilon` }, childIds: [`inline${i}`] },
      { nodeId: `inline${i}`, role: { value: 'InlineTextBox' }, name: { value: `Row ${i}: alpha beta gamma delta epsilon` } });
  }
  nodes[0].childIds.push('button');
  nodes.push({ nodeId: 'button', backendDOMNodeId: 500, role: { value: 'button' }, name: { value: 'Go' }, childIds: ['label'] },
    { nodeId: 'label', role: { value: 'StaticText' }, name: { value: 'Go' } });
  f.nodes(nodes);
  const page = await f.exec('snapshot');
  assert.equal(page.truncated, false);
  assert.equal(page.node_count, 202);
  assert.equal((page.snapshot.match(/Row /g) || []).length, 200);
  assert.doesNotMatch(page.snapshot, /InlineTextBox|StaticText/);
  assert.match(page.snapshot, /button "Go"/);
});

test('interactive snapshot reduces round trips and keeps one immutable view across pages', async () => {
  const f = fixture(); await f.claim();
  const nodes = [{ nodeId: 'root', role: { value: 'RootWebArea' }, childIds: [] }];
  for (let i = 1; i <= 200; i++) {
    nodes[0].childIds.push(`p${i}`);
    nodes.push({ nodeId: `p${i}`, role: { value: 'paragraph' }, backendDOMNodeId: i, childIds: [`t${i}`] },
      { nodeId: `t${i}`, role: { value: 'StaticText' }, name: { value: 'Long prose '.repeat(25) } });
  }
  nodes[0].childIds.push('button', 'edit');
  nodes.push({ nodeId: 'button', backendDOMNodeId: 500, role: { value: 'button' }, name: { value: 'Go' } },
    { nodeId: 'edit', backendDOMNodeId: 501, role: { value: 'textbox' }, name: { value: 'Edit' } });
  f.nodes(nodes);
  const full = await f.exec('snapshot');
  assert.equal(full.truncated, true);
  const compact = await f.exec('snapshot', { profile: 'interactive' });
  assert.equal(compact.profile, 'interactive'); assert.equal(compact.text_limit, 80);
  assert.equal(compact.total_node_count, 3); assert.equal(compact.truncated, false);
  assert.ok(compact.snapshot.length < full.snapshot.length / 20);
  assert.doesNotMatch(compact.snapshot, /paragraph/);
  const ref = f.ref(compact);
  await f.exec('click', { ref, mode: 'dom' }); await f.exec('click', { ref, mode: 'dom' });
  await assert.rejects(f.exec('snapshot', { profile: 'typo' }), /profile/);
  await f.exec('click', { ref, mode: 'dom' });
  const first = await f.exec('snapshot', { profile: 'interactive', text: false, max_nodes: 1, verbose: true });
  await assert.rejects(f.exec('snapshot', { cursor: first.next_cursor, profile: 'full' }), /original profile/);
  const next = await f.exec('snapshot', { cursor: first.next_cursor, verbose: true });
  assert.equal(next.profile, 'interactive'); assert.equal(next.text, false);
  assert.equal(next.snapshot_id, first.snapshot_id); assert.equal(next.node_count, 2);
});

test('snapshot query starts a fresh observation, returns actionable refs and binds query pagination', async () => {
  const f = fixture(); await f.claim();
  const oldRef = f.ref(await f.exec('snapshot'));
  const found = await f.exec('snapshot', { query: 'sUbMiT', max_nodes: 1 });
  assert.equal(found.profile, 'full'); assert.equal(found.node_count, 1); assert.equal(found.total_node_count, 1);
  assert.match(found.snapshot, /Frame main.*\n.*button "Submit"/);
  assert.doesNotMatch(found.snapshot, /textbox|RootWebArea/);
  assert.equal(found.next_cursor, null); assert.equal(found.viewport, undefined); assert.equal(found.snapshot_id, undefined);
  await assert.rejects(f.exec('click', { ref: oldRef }), /stale/);
  const ref = f.ref(found);
  await f.exec('click', { ref });
  await assert.rejects(f.exec('snapshot', { query: '   ' }), /query/);
  await f.exec('click', { ref });
  const page = await f.exec('snapshot', { query: 'm', max_nodes: 1 });
  const reads = f.calls.filter(call => call.method === 'Accessibility.getFullAXTree').length;
  await assert.rejects(f.exec('snapshot', { cursor: page.next_cursor, query: 'n' }), /original.*query/);
  const next = await f.exec('snapshot', { cursor: page.next_cursor, verbose: true });
  assert.equal(next.query, 'm'); assert.equal(next.node_count, 2); assert.equal(next.next_cursor, null);
  assert.ok(next.viewport.width); assert.equal(f.calls.filter(call => call.method === 'Accessibility.getFullAXTree').length, reads);
  f.nodes([{ nodeId: 'new', backendDOMNodeId: 12, role: { value: 'button' }, name: { value: 'New action' } }]);
  assert.match((await f.exec('snapshot', { query: 'new action' })).snapshot, /New action/);
  const empty = await f.exec('snapshot', { query: 'missing' });
  assert.equal(empty.snapshot, ''); assert.equal(empty.node_count, 0); assert.equal(empty.next_cursor, null);
});

test('navigate returns destination metadata and actionable snapshot in one operation', async () => {
  const f = fixture(); await f.claim();
  const old = f.ref(await f.exec('snapshot'));
  const result = await f.exec('navigate', { url: 'http://localhost:8000/destination' });
  assert.equal(result.title, 'Destination'); assert.equal(result.url, 'http://localhost:8000/destination');
  await assert.rejects(f.exec('click', { ref: old }), /stale/);
  await f.exec('click', { ref: f.ref(result) });
});

test('a document change during an AX read cannot resurrect invalidated refs and cursors', async () => {
  const f = fixture(); await f.claim();
  const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => {
    const result = await send(target, method, args);
    if (method === 'Accessibility.getFullAXTree') f.api.debugger.onEvent.emit(target, 'DOM.documentUpdated');
    return result;
  };
  await assert.rejects(f.exec('snapshot'), error => {
    assert.match(error.message, /Document changed/);
    assert.equal(error.diagnostics.reason, 'document_changed'); return true;
  });
  assert.equal(f.calls.filter(call => call.method === 'Accessibility.getFullAXTree').length, 2);
  await assert.rejects(f.exec('snapshot', { cursor: 'failed@1' }), /stale/);
});

test('a new snapshot retries one document race with fresh refs and preserves query/profile/pagination', async () => {
  for (const profile of ['full', 'interactive']) {
    const f = fixture(); await f.claim();
    const old = f.ref(await f.exec('snapshot'));
    const send = f.api.debugger.sendCommand;
    let reads = 0;
    f.api.debugger.sendCommand = async (target, method, args) => {
      const result = await send(target, method, args);
      if (method === 'Accessibility.getFullAXTree' && ++reads === 1) {
        f.api.debugger.onEvent.emit(target, 'Page.navigatedWithinDocument', { frameId: 'main' });
        f.nodes([0, 1].map(i => ({ nodeId: `current-${i}`, backendDOMNodeId: 20 + i, role: { value: 'button' }, name: { value: `Current ${i}` } })));
      }
      return result;
    };
    const first = await f.exec('snapshot', { profile, query: 'current', max_nodes: 1, verbose: true });
    assert.equal(reads, 2); assert.equal(first.profile, profile);
    assert.match(first.snapshot, /Current 0/); assert.doesNotMatch(first.snapshot, /Submit/);
    assert.equal(first.total_node_count, 2);
    const next = await f.exec('snapshot', { cursor: first.next_cursor, verbose: true });
    assert.equal(reads, 2); assert.equal(next.snapshot_id, first.snapshot_id);
    assert.match(next.snapshot, /Current 1/);
    await assert.rejects(f.exec('click', { ref: old }), /stale/);
    await f.exec('click', { ref: f.ref(first) });
    f.api.debugger.onEvent.emit({ tabId: 9 }, 'DOM.documentUpdated');
    await assert.rejects(f.exec('snapshot', { cursor: first.next_cursor }), /stale/);
    assert.equal(reads, 2);
  }
});

test('snapshot retries navigation context failures once but does not retry unrelated errors or navigation itself', async () => {
  for (const command of ['snapshot', 'navigate']) for (const transient of [true, false]) {
    const f = fixture(); await f.claim();
    const send = f.api.debugger.sendCommand;
    let reads = 0;
    f.api.debugger.sendCommand = async (target, method, args) => {
      if (method === 'Accessibility.getFullAXTree' && ++reads === 1) throw new Error(transient ? 'Cannot find context with specified id' : 'Accessibility is unavailable');
      return send(target, method, args);
    };
    const operation = f.exec(command, command === 'navigate' ? { url: 'http://localhost:8000/new' } : {});
    if (transient) assert.ok((await operation).snapshot);
    else if (command === 'snapshot') await assert.rejects(operation, /Accessibility is unavailable/);
    else assert.match((await operation).observation_error, /Accessibility is unavailable/);
    assert.equal(reads, transient ? 2 : 1);
    assert.equal(f.calls.filter(call => call.method === 'Page.navigate').length, command === 'navigate' ? 1 : 0);
  }
});

test('snapshot never publishes refs or retries after control ends during capture', async () => {
  const f = fixture(); await f.claim();
  const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => {
    const result = await send(target, method, args);
    if (method === 'Runtime.evaluate' && args.expression.includes('width: innerWidth')) f.api.debugger.onDetach.emit(target);
    return result;
  };
  await assert.rejects(f.exec('snapshot'), error => {
    assert.equal(error.diagnostics.reason, 'control_changed'); return true;
  });
  assert.equal(f.calls.filter(call => call.method === 'Accessibility.getFullAXTree').length, 1);
  f.api.debugger.sendCommand = send;
  await f.claim();
  await assert.rejects(f.exec('snapshot', { cursor: 'detached@1' }), /stale/);
});

test('navigate shares the observation retry cap and retries metadata without sending navigation again', async () => {
  for (const include_snapshot of [true, false]) {
    const f = fixture(); await f.claim();
    const send = f.api.debugger.sendCommand;
    let reads = 0;
    f.api.debugger.sendCommand = async (target, method, args) => {
      const observing = include_snapshot ? method === 'Accessibility.getFullAXTree'
        : method === 'Runtime.evaluate' && args.expression.includes('title: document.title');
      if (observing) {
        reads++;
        if (include_snapshot || reads === 1) throw new Error('Cannot find context with specified id');
      }
      return send(target, method, args);
    };
    const result = await f.exec('navigate', { url: 'http://localhost:8000/new', include_snapshot });
    assert.equal(reads, 2);
    if (include_snapshot) assert.match(result.observation_error, /Cannot find context/);
    else { assert.equal(result.title, 'Destination'); assert.equal(result.observation_error, undefined); }
    assert.equal(f.calls.filter(call => call.method === 'Page.navigate').length, 1);
  }
});

test('ordinary snapshot has one shared 30s budget and a late capture cannot publish refs', async t => {
  const f = fixture(); await f.claim();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const send = f.api.debugger.sendCommand;
  let finish, reads = 0;
  f.api.debugger.sendCommand = async (target, method, args) => {
    if (method === 'Accessibility.getFullAXTree') {
      reads++;
      if (reads === 1) {
        t.mock.timers.tick(29000);
        throw new Error('Cannot find context with specified id');
      }
      await new Promise(resolve => { finish = resolve; });
    }
    return send(target, method, args);
  };
  const pending = f.exec('snapshot');
  const rejected = assert.rejects(pending, error => {
    assert.equal(error.diagnostics.reason, 'snapshot_timeout');
    assert.equal(error.input_dispatched, false); return true;
  });
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(50); await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 2);
  t.mock.timers.tick(950); await rejected;
  finish(); await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(f.exec('snapshot', { cursor: 'late@1' }), /stale/);
  assert.equal(reads, 2);
});

test('iframe navigation preserves main refs, invalidates descendant refs and scopes chooser cleanup', async () => {
  const f = fixture(); withChildFrames(f); await f.claim();
  const snap = await f.exec('snapshot'), mainRef = f.ref(snap);
  const adRef = snap.snapshot.match(/\[([^\]]+)\] button "ad"/)[1];
  const nestedRef = snap.snapshot.match(/\[([^\]]+)\] button "nested"/)[1];
  const emit = (method, params) => f.api.debugger.onEvent.emit({ tabId: 9 }, method, params);
  emit('Page.fileChooserOpened', { backendNodeId: 77, mode: 'selectSingle', frameId: 'main' });
  emit('Page.frameNavigated', { frame: { id: 'ad', parentId: 'main' } });
  f.api.tabs.onUpdated.emit(9, { status: 'loading' });
  f.api.tabs.onUpdated.emit(9, { status: 'complete' });
  await assert.rejects(f.exec('click', { ref: adRef }), /stale/);
  await assert.rejects(f.exec('click', { ref: nestedRef }), /stale/);
  assert.equal((await f.exec('click', { ref: mainRef })).file_chooser.pending, true);
  emit('Page.fileChooserOpened', { backendNodeId: 77, frameId: 'nested' });
  emit('Page.navigatedWithinDocument', { frameId: 'ad' });
  await assert.rejects(f.exec('upload_file', { files: [] }), /No pending/);
});

test('iframe refresh during AX reading omits only its changed subtree and keeps main refs usable', async () => {
  const f = fixture(); withChildFrames(f); await f.claim();
  const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => {
    const result = await send(target, method, args);
    if (method === 'Accessibility.getFullAXTree' && args.frameId === 'nested') {
      f.api.debugger.onEvent.emit(target, 'Page.frameNavigated', { frame: { id: 'ad', parentId: 'main' } });
    }
    return result;
  };
  const snap = await f.exec('snapshot');
  assert.match(snap.snapshot, /button "Submit"/);
  assert.doesNotMatch(snap.snapshot, /button "ad"|button "nested"/);
  assert.deepEqual(snap.omitted_frames.map(frame => frame.frame_id), ['ad', 'nested']);
  await f.exec('click', { ref: f.ref(snap) });
});

test('iframe detach preserves cursor continuation and filters obsolete child entries', async () => {
  const f = fixture(); withChildFrames(f); await f.claim();
  f.nodes(Array.from({ length: 16 }, (_, i) => ({ nodeId: String(i), backendDOMNodeId: 100 + i,
    role: { value: 'button' }, name: { value: `Main ${i}` } })));
  const first = await f.exec('snapshot', { max_nodes: 10 });
  f.api.debugger.onEvent.emit({ tabId: 9 }, 'Page.frameDetached', { frameId: 'ad', reason: 'remove' });
  const next = await f.exec('snapshot', { cursor: first.next_cursor });
  assert.equal(next.total_node_count, 16);
  assert.equal(next.node_count, 6);
  assert.doesNotMatch(next.snapshot, /button "ad"|button "nested"/);
  await f.exec('click', { ref: f.ref(first) });
});

test('continuously moving refs exhaust the actionability deadline without dispatch', async () => {
  const f = fixture(); await f.claim(); const send = f.api.debugger.sendCommand;
  let sample = 0;
  f.api.debugger.sendCommand = async (target, method, args) => {
    const result = await send(target, method, args);
    if (method === 'Runtime.callFunctionOn' && args.functionDeclaration.includes('function inspectTarget')) result.result.value.x = ++sample;
    return result;
  };
  await assert.rejects(f.exec('click', { ref: f.ref(await f.exec('snapshot')), timeout_ms: 100 }), /no input was dispatched/);
  assert.ok(sample > 1);
  assert.equal(f.calls.filter(call => call.method === 'Input.dispatchMouseEvent').length, 0);
});

test('diagnostics are enabled on claim, survive navigation, keep refs and clear on release', async () => {
  const f = fixture(); await f.claim();
  for (const method of ['Runtime.enable', 'Log.enable', 'Network.enable']) assert.ok(f.calls.some(call => call.method === method));
  const emit = (method, params) => f.api.debugger.onEvent.emit({ tabId: 9 }, method, params);
  emit('Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'retained' }] });
  const ref = f.ref(await f.exec('snapshot'));
  assert.equal((await f.exec('logs', { kind: 'console' })).entries.length, 1);
  await f.exec('click', { ref });
  emit('Page.frameNavigated', { frame: { id: 'main' } });
  assert.equal((await f.exec('logs', { kind: 'console' })).entries[0].text, 'retained');
  await assert.rejects(f.exec('logs', { kind: 'console' }, 'two'), /not claimed/);
  await f.exec('release_tab'); await f.claim();
  assert.equal((await f.exec('logs', { kind: 'console' })).entries.length, 0);
});

test('a stalled post-navigation snapshot returns navigation success and never saves late refs', async t => {
  const f = fixture(); await f.claim();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const send = f.api.debugger.sendCommand;
  let finish;
  f.api.debugger.sendCommand = async (target, method, args) => {
    if (method === 'Accessibility.getFullAXTree') await new Promise(resolve => { finish = resolve; });
    return send(target, method, args);
  };
  const result = f.exec('navigate', { url: 'http://localhost:8000/slow', timeout_ms: 40000 });
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(10000); await new Promise(resolve => setImmediate(resolve));
  assert.equal((await result).navigated_to, 'http://localhost:8000/slow');
  assert.match((await result).observation_error, /Navigation observation timed out/);
  finish(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.controller.claimedCount(), 1);
  assert.equal(f.calls.filter(call => call.method === 'Page.navigate').length, 1);
  await assert.rejects(f.exec('snapshot', { cursor: 'late@1' }), /stale/);
});

test('OOPIF trees omitted from root frame metadata still invalidate the full subtree', async () => {
  const f = fixture(); await f.claim();
  const emit = f.api.debugger.onEvent.emit, root = {tabId:9}, child = {tabId:9,sessionId:'s1'};
  emit(root, 'Target.attachedToTarget', {sessionId:'s1',targetInfo:{type:'iframe',targetId:'child'}});
  emit(child, 'Target.attachedToTarget', {sessionId:'s2',targetInfo:{type:'iframe',targetId:'nested'}});
  const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => {
    const frame = target.sessionId === 's1' ? 'child' : target.sessionId === 's2' ? 'nested' : 'main';
    if (method === 'Page.getFrameTree') return {frameTree:{frame:{id:frame,url:'https://fixture.test/'}}};
    if (method === 'Accessibility.getPartialAXTree') return {nodes:[{backendDOMNodeId:12,role:{value:'button'},name:{value:frame}}]};
    if (method === 'Accessibility.getFullAXTree') return {nodes:[
      {nodeId:'button',backendDOMNodeId:12,role:{value:'button'},name:{value:frame}},
      ...(frame !== 'nested' ? [{nodeId:'iframe',backendDOMNodeId:14,role:{value:'Iframe'}}] : []),
    ]};
    if (method === 'DOM.describeNode' && args.backendNodeId === 14) return {node:{frameId:frame === 'main' ? 'child':'nested'}};
    return send(target,method,args);
  };
  const snap = await f.exec('snapshot');
  const ref = frame => snap.snapshot.split('\n').find(line => line.includes(`button "${frame}"`)).match(/\[([^\]]+)\]/)[1];
  assert.equal(snap.omitted_frames.length,0);
  emit(child,'Page.fileChooserOpened',{backendNodeId:77,frameId:'nested'});
  emit(child,'Page.frameNavigated',{frame:{id:'child'}});
  await assert.rejects(f.exec('click',{ref:ref('child')}),/stale/);
  await assert.rejects(f.exec('click',{ref:ref('nested')}),/stale/);
  assert.equal((await f.exec('click',{ref:ref('main')})).target_verified,true);
  await assert.rejects(f.exec('upload_file',{files:[]}),/No pending/);
});

test('hover uses the same hit checks but dispatches only one native move and preserves refs', async () => {
  const f = fixture(); await f.claim(); const ref = f.ref(await f.exec('snapshot'));
  const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => {
    const result = await send(target, method, args);
    if (method === 'Input.dispatchMouseEvent' && args.type === 'mouseMoved') {
      const binding = f.calls.findLast(c => c.method === 'Runtime.addBinding').args.name;
      f.api.debugger.onEvent.emit(target, 'Runtime.bindingCalled', { name: binding, executionContextId: 42, payload: '{"matched":true}' });
    }
    return result;
  };
  assert.equal((await f.exec('hover', { ref })).events_trusted, true);
  assert.deepEqual(f.calls.filter(c => c.method === 'Input.dispatchMouseEvent').map(c => c.args.type), ['mouseMoved']);
  assert.equal((await f.exec('click', { ref })).target_verified, true);
  assert.equal(f.calls.filter(c => c.method === 'Accessibility.getFullAXTree').length, 1);
});

test('a retained backend node repurposed with a different AX name is refused without guessing a replacement', async () => {
  const f = fixture();await f.claim();const ref=f.ref(await f.exec('snapshot'));
  const send=f.api.debugger.sendCommand;
  f.api.debugger.sendCommand=async (target,method,args)=> method==='Accessibility.getPartialAXTree'
    ? {nodes:[{backendDOMNodeId:12,role:{value:'button'},name:{value:'Different action'}}]} : send(target,method,args);
  await assert.rejects(f.exec('click',{ref}),/ref identity changed.*No input was dispatched/);
  assert.ok(!f.calls.some(c=>c.method.startsWith('Input.')));
});
