import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { fixture } from './helpers/controller-fixture.mjs';

test('file discovery and claim check the current file access setting without activating the tab', async () => {
  const f = fixture();
  f.tabs.get(9).url = 'file:///C:/中文 folder/sample.html';
  let allowed = false;
  f.api.extension.isAllowedFileSchemeAccess = async () => allowed;
  assert.equal((await f.exec('list_tabs')).tabs[0].controllable, false);
  await assert.rejects(f.exec('claim_tab'), /Local file access is disabled.*Allow access to file URLs/);
  assert.equal(f.controller.claimedCount(), 0);
  assert.equal(f.calls.length, 0);
  allowed = true;
  assert.equal((await f.exec('list_tabs')).tabs[0].controllable, true);
  assert.equal((await f.exec('claim_tab')).activation_requested, false);
  await assert.rejects(f.exec('claim_tab', { tab_handle: 'other' }, 'two'), /another session/);
  assert.equal(f.calls.filter(c => c.method === 'attach').length, 1);
  assert.ok(!f.calls.some(c => ['tabs.update', 'windows.update', 'Page.bringToFront'].includes(c.method)));
});

test('file pages reuse AX refs, screenshot, native input, and navigation invalidation', async () => {
  const f = fixture(); f.tabs.get(9).url = 'file:///C:/sample.html'; await f.exec('claim_tab');
  const tree = await f.exec('snapshot', { max_nodes: 2 });
  assert.match(tree.snapshot, /button "Submit"/);
  assert.equal((await f.exec('screenshot')).data, 'image-data');
  const ref = f.ref(tree);
  assert.equal((await f.exec('click', { ref })).delivery_verified, true);
  await f.exec('press_key', { key: 'Enter' });
  assert.ok(f.calls.some(c => c.method === 'Input.dispatchKeyEvent'));
  const destination = 'file:///C:/中文 folder/next.html';
  const result = await f.exec('navigate', { url: destination });
  assert.equal(result.url, new URL(destination).href);
  assert.equal(f.calls.filter(c => c.method === 'Page.navigate').length, 1);
  await assert.rejects(f.exec('click', { ref }), /stale/);
  await assert.rejects(f.exec('snapshot', { cursor: tree.next_cursor }), /stale/);
  await f.exec('release_tab');
  assert.equal(f.controller.claimedCount(), 0);
  await assert.rejects(f.exec('snapshot'), /not claimed/);
});

test('revoked file permission blocks observations and input but preserves reliable release', async () => {
  const f = fixture(); f.tabs.get(9).url = 'file:///C:/sample.html'; await f.exec('claim_tab');
  await f.exec('snapshot');
  f.api.extension.isAllowedFileSchemeAccess = async () => false;
  const count = f.calls.length;
  for (const command of ['snapshot', 'screenshot', 'click', 'press_key', 'navigate']) {
    await assert.rejects(f.exec(command, { selector: '#submit', key: 'Enter', url: 'https://example.com/' }), /Local file access is disabled/);
  }
  assert.equal(f.calls.length, count);
  const detach = f.api.debugger.detach;
  f.api.debugger.detach = async () => { throw new Error('detach failed'); };
  await assert.rejects(f.exec('release_tab'), /detach failed/);
  assert.equal(f.controller.claimedCount(), 1);
  f.api.debugger.detach = detach;
  await f.exec('release_tab');
  assert.equal(f.controller.claimedCount(), 0);
});

test('file batch rechecks permission between dispatched steps without replay', async () => {
  const f = fixture(); f.tabs.get(9).url = 'file:///C:/sample.html'; await f.exec('claim_tab');
  let allowed = true;
  f.api.extension.isAllowedFileSchemeAccess = async () => allowed;
  const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => {
    const result = await send(target, method, args);
    if (method === 'Input.dispatchMouseEvent' && args.type === 'mouseReleased') allowed = false;
    return result;
  };
  const result = await f.exec('batch', { steps: [{ action: 'click', selector: '#submit' }, { action: 'press_key', key: 'Enter' }] });
  assert.equal(result.failed_step, 1); assert.equal(result.results.length, 1);
  assert.match(result.error, /Local file access is disabled/);
  assert.equal(f.calls.filter(c => c.method === 'Input.dispatchMouseEvent' && c.args.type === 'mouseReleased').length, 1);
  assert.ok(!f.calls.some(c => c.method === 'Input.dispatchKeyEvent'));
});

test('HTTP to file navigation requires file access before dispatch; restricted URLs remain unclaimable', async () => {
  const f = fixture(); await f.claim();
  f.api.extension.isAllowedFileSchemeAccess = async () => false;
  await assert.rejects(f.exec('navigate', { url: 'file:///C:/sample.html' }), /Local file access is disabled/);
  assert.ok(!f.calls.some(c => c.method === 'Page.navigate'));
  f.api.extension.isAllowedFileSchemeAccess = async () => true;
  assert.equal((await f.exec('navigate', { url: 'file:///C:/sample.html' })).url, 'file:///C:/sample.html');
  await f.exec('release_tab');
  for (const url of ['chrome://settings', 'edge://settings', 'chrome-extension://other/index.html', 'https://user:pass@example.com/', 'data:text/html,hello']) {
    f.tabs.get(9).url = url;
    assert.equal((await f.exec('list_tabs')).tabs[0].controllable, false);
    await assert.rejects(f.exec('claim_tab'), /Only http\(s\) and file/);
  }
});

test('tab_id claim tolerates title drift; explicitly supplied identity guards still fail', async () => {
  const f = fixture(); f.tabs.get(9).title = 'New title';
  await assert.rejects(f.claim(), /changed/);
  const claimed = await f.exec('claim_tab');
  assert.equal(claimed.title, 'New title');
  await assert.rejects(f.exec('click', { ref: 'old', selector: '#submit' }), /exactly one/);
  await assert.rejects(f.exec('click', { selector: '#submit', mode: 'dom', coordinate_space: 'document' }), /coordinate clicks only/);
});

test('an owned tab that becomes blank recovers in place without recreating, reattaching or activating', async () => {
  const f = fixture(); await f.claim();
  const ref = f.ref(await f.exec('snapshot'));
  f.tabs.get(9).url = 'about:blank';
  f.api.tabs.onUpdated.emit(9, { url: 'about:blank' });
  assert.equal((await f.exec('list_tabs')).tabs[0].controllable, false);
  const before = f.calls.length;
  for (const command of ['snapshot', 'evaluate', 'click']) {
    await assert.rejects(f.exec(command, { ref, expression: '1', kind: 'console' }), /claimed tab.*about:blank.*browser_navigate.*release or close/);
  }
  await assert.rejects(f.exec('navigate', { url: 'https://example.com/' }, 'two'), /not claimed/);
  assert.equal(f.calls.length, before);
  assert.equal(f.controller.claimedCount(), 1);

  const result = await f.exec('navigate', { url: 'https://example.com/' });
  assert.equal(result.url, 'https://example.com/');
  assert.equal(result.tab_id, 9);
  assert.match(result.snapshot, /button "Submit"/);
  assert.equal(f.controller.claimedCount(), 1);
  assert.equal(f.calls.filter(c => c.method === 'Page.navigate').length, 1);
  assert.equal(f.calls.filter(c => c.method === 'attach').length, 1);
  assert.ok(!f.calls.some(c => ['tabs.create', 'tabs.update', 'windows.update', 'Page.bringToFront'].includes(c.method)));
  await assert.rejects(f.exec('click', { ref }), /stale/);
});

test('blank discovery stays unclaimable and explains how to obtain a new claim', async () => {
  const f = fixture(); f.tabs.get(9).url = 'about:blank';
  assert.equal((await f.exec('list_tabs')).tabs[0].controllable, false);
  await assert.rejects(f.exec('claim_tab'), /about:blank.*cannot be claimed.*in the browser.*discover and claim/);
  assert.equal(f.controller.claimedCount(), 0);
  assert.ok(!f.calls.some(c => c.method === 'attach'));
  await assert.rejects(f.exec('navigate', { url: 'https://example.com/' }), /not claimed/);
});

test('blank recovery still validates destinations and current restricted pages remain blocked', async () => {
  const f = fixture(); await f.claim();
  f.tabs.get(9).url = 'about:blank';
  f.api.extension.isAllowedFileSchemeAccess = async () => false;
  for (const url of ['about:blank', 'chrome://settings/', 'edge://settings/', 'chrome-extension://other/index.html', 'data:text/html,hello', 'javascript:alert(1)', 'https://user:pass@example.com/']) {
    await assert.rejects(f.exec('navigate', { url }), /Only http\(s\) and file/);
  }
  await assert.rejects(f.exec('navigate', { url: 'file:///C:/sample.html' }), /Local file access is disabled/);
  assert.ok(!f.calls.some(c => c.method === 'Page.navigate'));
  assert.equal(f.tabs.get(9).url, 'about:blank');
  f.api.extension.isAllowedFileSchemeAccess = async () => true;
  assert.equal((await f.exec('navigate', { url: 'file:///C:/sample.html' })).url, 'file:///C:/sample.html');
  const dispatched = f.calls.filter(c => c.method === 'Page.navigate').length;
  for (const url of ['chrome://settings/', 'edge://settings/', 'chrome-extension://other/index.html', 'data:text/html,hello', 'about:srcdoc']) {
    f.tabs.get(9).url = url;
    await assert.rejects(f.exec('navigate', { url: 'https://example.com/' }), /Only http\(s\) and file/);
  }
  assert.equal(f.calls.filter(c => c.method === 'Page.navigate').length, dispatched);
});

test('history recovery from blank validates the selected entry before dispatch', async () => {
  const f = fixture(); await f.claim();
  f.tabs.get(9).url = 'about:blank';
  let destination = 'file:///C:/sample.html';
  const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => {
    if (method === 'Page.getNavigationHistory') return { currentIndex: 1, entries: [{ id: 1, url: destination }, { id: 2, url: 'about:blank' }] };
    if (method === 'Page.navigateToHistoryEntry') {
      f.calls.push({ method, args, target });
      f.tabs.get(9).url = destination;
      f.api.debugger.onEvent.emit(target, 'Page.navigatedWithinDocument', { frameId: 'main', url: destination });
      return {};
    }
    return send(target, method, args);
  };
  f.api.extension.isAllowedFileSchemeAccess = async () => false;
  await assert.rejects(f.exec('navigate', { direction: 'back' }), /Local file access is disabled/);
  destination = 'chrome://settings/';
  await assert.rejects(f.exec('navigate', { direction: 'back' }), /Only http\(s\) and file/);
  assert.ok(!f.calls.some(c => c.method === 'Page.navigateToHistoryEntry'));
  destination = 'https://example.com/';
  assert.equal((await f.exec('navigate', { direction: 'back', include_snapshot: false })).url, destination);
  assert.equal(f.calls.filter(c => c.method === 'Page.navigateToHistoryEntry').length, 1);
});

test('blank tabs retain cleanup and detach failures retain exclusive ownership', async () => {
  const f = fixture(); await f.claim(); f.tabs.get(9).url = 'about:blank';
  const detach = f.api.debugger.detach;
  f.api.debugger.detach = async () => { throw new Error('detach failed'); };
  await assert.rejects(f.exec('release_tab'), /detach failed/);
  assert.equal(f.controller.claimedCount(), 1);
  await assert.rejects(f.exec('claim_tab', { tab_handle: 'other' }, 'two'), /another session/);
  f.api.debugger.detach = detach;
  await f.exec('release_tab');
  assert.equal(f.controller.claimedCount(), 0);
  const closed = fixture(); await closed.claim(); closed.tabs.get(9).url = 'about:blank';
  assert.equal((await closed.exec('close_tab')).closed, true);
  assert.equal(closed.controller.claimedCount(), 0);
});

test('hasFocus false alone does not reject an active visible page in a focused window', async () => {
  const f = fixture(); await f.claim(); const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => method === 'Runtime.evaluate' && args.expression.includes('visibility_state: document.visibilityState')
    ? { result: { value: { visibility_state: 'visible', has_focus: false } } } : send(target, method, args);
  const result = await f.exec('click', { x: 10, y: 10, detailed: true });
  assert.equal(result.delivery_verified, true); assert.equal(result.page_state.has_focus, false); assert.equal(result.page_state.window_focused, true);
});

test('coordinate pseudo-element hits normalize to their originating element for hints and event guards', async () => {
  const f = fixture(); await f.claim(); const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => {
    if (method === 'DOM.resolveNode' && args.backendNodeId === 12) return { object: { objectId: 'pseudo', className: 'CSSPseudoElement' } };
    if (method === 'Runtime.callFunctionOn' && args.objectId === 'pseudo') {
      const result = vm.runInNewContext(`(${args.functionDeclaration})`).call({ element: { nodeType: 1 } });
      assert.equal(result.nodeType, 1);
      return { result: { objectId: 'origin' } };
    }
    if (method === 'DOM.describeNode' && args.objectId === 'origin') return { node: { backendNodeId: 99 } };
    if (method === 'Runtime.callFunctionOn' && args.functionDeclaration.includes('function describeHit')) {
      assert.equal(args.objectId, 'origin'); return { result: { value: { tag: 'button', clickable_hint: true } } };
    }
    return send(target, method, args);
  };
  const result = await f.exec('click', { x: 10, y: 10, detailed: true });
  assert.equal(result.delivery_verified, true); assert.equal(result.hit_target.pseudo_element, true);
  assert.ok(f.calls.some(call => call.method === 'DOM.resolveNode' && call.args.executionContextId === 42 && call.args.backendNodeId === 99));
});

test('batch uses one queue, fresh selector resolution and explicit native Tab for blur', async () => {
  const f = fixture(); await f.claim(); f.calls.length = 0;
  const batch = f.exec('batch', { steps: [
    { action: 'click', selector: '#open' }, { action: 'fill', selector: 'input', nth: 1, text: '2026' },
    { action: 'press_key', key: 'Tab' }, { action: 'click', selector: '.option' },
  ] });
  const later = f.exec('press_key', { key: 'Escape' });
  const result = await batch; await later;
  assert.equal(result.completed, true); assert.equal(result.results.length, 4);
  assert.equal(result.results[1].application_result, 'not_checked');
  const actions = f.calls.filter(c => c.method === 'Input.insertText' || c.method === 'Input.dispatchMouseEvent' && c.args.type === 'mouseReleased' || c.method === 'Input.dispatchKeyEvent' && c.args.type === 'rawKeyDown');
  assert.deepEqual(actions.map(c => c.args.text || c.args.key || 'click'), ['click', '2026', 'Tab', 'click', 'Escape']);
  const queries = f.calls.filter(c => c.method === 'Runtime.evaluate' && c.args.expression.includes('function queryElement'));
  assert.equal(queries.length, 3);
  const fields = [{ nodeType: 1, id: 'first' }, { nodeType: 1, id: 'second' }];
  assert.equal(vm.runInNewContext(queries[1].args.expression, { document: { querySelectorAll: () => fields } }), fields[1]);
});

test('batch accepts semantic selectors and focused type while prevalidating ambiguity in target options', async () => {
  const f = fixture(); await f.claim(); f.calls.length = 0;
  const invalid = [{ action: 'click', selector: 'button', selector_type: 'role', name: 'Submit' }, { action: 'type', focused: true, selector: 'input', text: 'x' }];
  await assert.rejects(f.exec('batch', { steps: invalid }), /exactly one/);
  assert.equal(f.calls.length, 0);
  const result = await f.exec('batch', { steps: [
    { action: 'click', selector: 'button', selector_type: 'role', name: 'Submit' }, { action: 'type', focused: true, text: 'x' },
  ] });
  assert.equal(result.completed, true); assert.equal(result.results[1].typed, 1);
  assert.ok(f.calls.some(c => c.method === 'Accessibility.getFullAXTree'));
});

test('batch validates all steps first; on a dispatched failure it returns prior results and never continues or replays', async () => {
  const f = fixture(); await f.claim(); f.calls.length = 0;
  await assert.rejects(f.exec('batch', { steps: [{ action: 'click', selector: '#open' }, { action: 'press_key', key: 'F99' }] }), /Unsupported key/);
  assert.equal(f.calls.length, 0);
  const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => {
    if (method === 'Runtime.callFunctionOn' && args.functionDeclaration.includes('function verifyFill')) return { result: { value: false } };
    return send(target, method, args);
  };
  const result = await f.exec('batch', { steps: [
    { action: 'click', selector: '#open' }, { action: 'fill', selector: '#edit', text: 'lost' }, { action: 'press_key', key: 'Enter' },
  ] });
  assert.equal(result.completed, false); assert.equal(result.failed_step, 1); assert.equal(result.results.length, 1);
  assert.match(result.error, /Outcome is unknown/);
  assert.equal(f.calls.filter(c => c.method === 'Input.insertText').length, 1);
  assert.ok(!f.calls.some(c => c.method === 'Input.dispatchKeyEvent'));
  assert.ok((await f.exec('snapshot')).snapshot);
});

test('batch shares one deadline and a late reply cannot start a subsequent step', async () => {
  const f = fixture(); await f.claim(); const send = f.api.debugger.sendCommand; let finish;
  f.api.debugger.sendCommand = async (target, method, args) => {
    if (method === 'Input.insertText') return await new Promise(resolve => { finish = resolve; });
    return send(target, method, args);
  };
  const result = await f.exec('batch', { timeout_ms: 100, steps: [
    { action: 'fill', selector: '#edit', text: 'once' }, { action: 'press_key', key: 'Enter' },
  ] });
  assert.equal(result.failed_step, 0); assert.match(result.error, /Outcome is unknown/);
  finish({}); await new Promise(resolve => setImmediate(resolve));
  assert.ok(!f.calls.some(c => c.method === 'Input.dispatchKeyEvent'));
  assert.ok((await f.exec('snapshot')).snapshot);
});

test('batch stops at navigation, detach, closure and dialogs instead of applying later selectors to a changed page', async () => {
  for (const change of ['navigation', 'detach', 'close', 'dialog']) {
    const f = fixture(); await f.claim(); const send = f.api.debugger.sendCommand;
    f.api.debugger.sendCommand = async (target, method, args) => {
      const result = await send(target, method, args);
      if (method === 'Input.insertText') {
        if (change === 'navigation') f.api.debugger.onEvent.emit(target, 'Page.frameNavigated', { frame: { id: 'main' } });
        if (change === 'detach') f.api.debugger.onDetach.emit(target);
        if (change === 'close') await f.api.tabs.remove(9);
        if (change === 'dialog') f.api.debugger.onEvent.emit(target, 'Page.javascriptDialogOpening', { type: 'alert', message: 'Stop' });
      }
      return result;
    };
    const result = await f.exec('batch', { steps: [{ action: 'fill', selector: '#edit', text: 'once' }, { action: 'press_key', key: 'Enter' }] });
    assert.equal(result.completed, false);
    assert.ok(!f.calls.some(c => c.method === 'Input.dispatchKeyEvent'));
  }
});

test('navigation retries transient observation once, never replays navigation or arbitrary observation failures', async () => {
  const f = fixture(); await f.claim(); const send = f.api.debugger.sendCommand; let reads = 0;
  f.api.debugger.sendCommand = async (target, method, args) => {
    if (method === 'Accessibility.getFullAXTree' && ++reads === 1) throw new Error('Execution context was destroyed');
    return send(target, method, args);
  };
  const result = await f.exec('navigate', { url: 'http://localhost:8000/new' });
  assert.ok(result.snapshot); assert.equal(reads, 2);
  assert.equal(f.calls.filter(call => call.method === 'Page.navigate').length, 1);
  f.api.debugger.sendCommand = async (target, method, args) => {
    if (method === 'Accessibility.getFullAXTree') { reads++; throw new Error('Permission denied'); }
    return send(target, method, args);
  };
  assert.match((await f.exec('navigate', { url: 'http://localhost:8000/fail' })).observation_error, /Permission denied/);
  assert.equal(reads, 3);
});

test('claim verifies title and URL before attaching; ownership is enforced', async () => {
  const f = fixture();
  await assert.rejects(f.exec('claim_tab', { expected_title: 'Wrong', expected_url: 'http://localhost:8000/' }), /changed/);
  assert.equal(f.calls.length, 0);
  await f.claim();
  await assert.rejects(f.exec('read_text', {}, 'two'), /not claimed/);
  assert.equal(f.controller.claimedCount(), 1);
});

test('coordinate actions are bounded by the viewport', async () => {
  const f = fixture(); await f.claim();
  await assert.rejects(f.exec('click', { x: -1, y: 0 }), /viewport/);
  await assert.rejects(f.exec('click', { x: 1024, y: 0 }), /viewport/);
  await f.exec('click', { x: 500, y: 300 });
  await f.exec('scroll', { delta_y: 300 });
});

test('release still works if the user navigates to a browser internal page', async () => {
  const f = fixture(); await f.claim();
  f.tabs.get(9).url = 'chrome://settings/';
  await f.exec('release_tab');
  assert.equal(f.controller.claimedCount(), 0);
  assert.ok(f.notices.some(notice => notice.type === 'detached'));
});

test('owner disconnect releases only that owner and debugger detach expires claims', async () => {
  const f = fixture(); await f.claim();
  await f.exec('release_owner', {}, 'two');
  assert.equal(f.controller.claimedCount(), 1);
  await f.exec('release_owner');
  assert.equal(f.controller.claimedCount(), 0);
  await f.claim();
  f.api.debugger.onDetach.emit({ tabId: 9 });
  await assert.rejects(f.exec('read_text'), /not claimed/);
});

test('releaseAll cleans other tabs but retains ownership when detach fails until an explicit retry', async () => {
  const f = fixture(); await f.claim();
  f.tabs.set(10, { ...f.tabs.get(9), id: 10 });
  await f.exec('claim_tab', { tab_id: 10, tab_handle: 'handle-two' }, 'two');
  const detach = f.api.debugger.detach;
  f.api.debugger.detach = async target => {
    if (target.tabId === 9) throw new Error('detach failed');
    return detach(target);
  };
  const result = await f.controller.releaseAll();
  assert.equal(result.released, 1);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /detach failed/);
  assert.equal(f.controller.claimedCount(), 1);
  assert.ok(f.notices.some(notice => notice.type === 'detached' && notice.tab_id === 10));
  assert.ok(!f.notices.some(notice => notice.type === 'detached' && notice.tab_id === 9));
  await assert.rejects(f.exec('claim_tab', {}, 'two'), /controlled by another/);
  f.api.debugger.detach = detach;
  assert.deepEqual(await f.controller.releaseAll(), { released: 1, errors: [] });
  assert.equal(f.controller.claimedCount(), 0);
});

test('user debugger detach restores the marker group without page cleanup access', async () => {
  const f = fixture(); await f.claim();
  assert.ok(f.tabs.get(9).groupId >= 0);
  f.api.debugger.onDetach.emit({ tabId: 9 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.tabs.get(9).groupId, -1);
  assert.equal(f.controller.claimedCount(), 0);
});

test('main-frame navigation and same-document navigation still invalidate the observation', async () => {
  for (const [method, params] of [
    ['Page.frameNavigated', { frame: { id: 'main' } }],
    ['Page.navigatedWithinDocument', { frameId: 'main' }],
  ]) {
    const f = fixture(); await f.claim(); const ref = f.ref(await f.exec('snapshot'));
    f.api.debugger.onEvent.emit({ tabId: 9 }, method, params);
    await assert.rejects(f.exec('click', { ref }), /stale/);
  }
});

test('tab lifecycle is explicit, HTTP(S)-only and requires ownership to activate or close', async () => {
  const f = fixture();
  await assert.rejects(f.exec('open_tab', { url: 'javascript:alert(1)' }), /http/);
  const opened = await f.exec('open_tab', { url: 'https://example.com/' });
  assert.equal(opened.tab_id, 10); assert.equal(opened.active, false);
  assert.equal(f.controller.claimedCount(), 0);
  assert.equal((await f.claim()).activation_requested, false);
  const snap = await f.exec('snapshot');
  await assert.rejects(f.exec('activate_tab', {}, 'two'), /not claimed/);
  await assert.rejects(f.exec('close_tab', {}, 'two'), /not claimed/);
  await f.exec('activate_tab', { focus_window: false });
  assert.ok(!f.calls.some(call => call.method === 'windows.update'));
  await f.exec('activate_tab');
  assert.deepEqual(f.calls.find(call => call.method === 'windows.update').args, { focused: true });
  await f.exec('click', { ref: f.ref(snap) });
  f.tabs.get(9).url = 'chrome://settings/';
  assert.equal((await f.exec('close_tab')).closed, true);
  assert.equal(f.controller.claimedCount(), 0);
  await assert.rejects(f.exec('read_text'), /not claimed/);
});

test('new-tab claim waits for its initial URL, accepts redirects and never navigates again', async () => {
  const f = fixture();
  const opened = await f.exec('open_tab', { url: 'https://requested.test/' });
  f.tabs.get(opened.tab_id).url = 'about:blank';
  const claim = f.exec('claim_tab', { tab_id: opened.tab_id, wait_for_page: true });
  setTimeout(() => { f.tabs.get(opened.tab_id).url = 'https://redirected.test/'; }, 10);
  assert.equal((await claim).url, 'https://redirected.test/');
  assert.equal(f.calls.filter(c => c.method === 'tabs.create').length, 1);
  assert.ok(!f.calls.some(c => c.method === 'Page.navigate'));
});

test('new-tab initial URL wait is bounded and restricted destinations remain unclaimable', async t => {
  const f = fixture();
  f.tabs.get(9).url = 'about:blank';
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const rejected = assert.rejects(f.exec('claim_tab', { wait_for_page: true }), /within 15000 ms/);
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(15000);
  await rejected;
  assert.equal(f.controller.claimedCount(), 0);
  f.tabs.get(9).url = 'chrome://settings/';
  await assert.rejects(f.exec('claim_tab', { wait_for_page: true }), /Only http/);
  assert.ok(!f.calls.some(c => c.method === 'attach'));
});

test('disconnect during debugger attachment queues release and cannot resurrect a claim after detach', async () => {
  const f = fixture();
  let finish, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  f.api.debugger.attach = async () => { entered(); await new Promise(resolve => { finish = resolve; }); };
  const claim = f.claim();
  await waiting;
  const release = f.exec('release_owner');
  finish(); await claim; await release;
  assert.equal(f.controller.claimedCount(), 0);
  assert.ok(f.calls.some(c => c.method === 'detach'));

  const detached = fixture(), send = detached.api.debugger.sendCommand;
  detached.api.debugger.sendCommand = async (target, method, args) => {
    const result = await send(target, method, args);
    if (method === 'Page.getFrameTree') detached.api.debugger.onDetach.emit(target);
    return result;
  };
  await assert.rejects(detached.claim(), /detached during claim/);
  assert.equal(detached.controller.claimedCount(), 0);
});

test('disconnect during the initial URL wait releases its reserved claim after preparation', async () => {
  const f = fixture();
  f.tabs.get(9).url = 'about:blank';
  const claim = f.exec('claim_tab', { wait_for_page: true });
  await new Promise(resolve => setImmediate(resolve));
  const release = f.exec('release_owner');
  f.tabs.get(9).url = 'https://ready.test/';
  await claim; await release;
  assert.equal(f.controller.claimedCount(), 0);
  assert.ok(f.calls.some(c => c.method === 'detach'));
});

test('39 seconds of navigation plus 7 seconds of observation fits the transport budget', async t => {
  const f = fixture(); await f.claim();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => {
    if (method === 'Page.navigate') await new Promise(resolve => setTimeout(resolve, 39000));
    if (method === 'Accessibility.getFullAXTree') await new Promise(resolve => setTimeout(resolve, 7000));
    return send(target, method, args);
  };
  const result = f.exec('navigate', { url: 'http://localhost:8000/slow', timeout_ms: 40000 });
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(39000); await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(7000); await new Promise(resolve => setImmediate(resolve));
  assert.ok((await result).snapshot);
  assert.equal(f.controller.claimedCount(), 1);
});

test('native select hits fail before dispatch and lost receipts free a long-budget queue within two seconds', async () => {
  const f = fixture(); await f.claim(); const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => {
    if (method === 'Runtime.callFunctionOn' && args.functionDeclaration.includes('function describeHit')) return { result: { value: { native_select: true } } };
    return send(target, method, args);
  };
  await assert.rejects(f.exec('click', { selector: 'select', timeout_ms: 30000 }), /No input was dispatched.*browser_select_option/);
  assert.ok(!f.calls.some(c => c.method.startsWith('Input.')));
  f.api.debugger.sendCommand = send;
  const emit = f.api.debugger.onEvent.emit;
  f.api.debugger.onEvent.emit = (...args) => { if (args[1] !== 'Runtime.bindingCalled') emit(...args); };
  const start = Date.now();
  await assert.rejects(f.exec('click', { x: 10, y: 10, timeout_ms: 30000 }), /Outcome is unknown.*press Esc/);
  assert.ok(Date.now() - start < 2000);
  assert.equal(f.calls.filter(c => c.method === 'Input.dispatchMouseEvent').length, 3);
  assert.ok((await f.exec('snapshot')).snapshot);
});

test('batch uses a child timeout for wait and resumes explicitly without replaying completed steps', async () => {
  const f=fixture();await f.claim();const send=f.api.debugger.sendCommand;
  f.api.debugger.sendCommand=async(target,method,args)=> method==='Runtime.evaluate'&&args.expression.includes('function inspectWait')
    ? {result:{value:[{satisfied:false,state:'absent'}]}} : send(target,method,args);
  const steps=[{action:'click',selector:'#first'},{action:'wait',selector:'#later',condition:'visible',timeout_ms:100},{action:'click',selector:'#last'}];
  const failed=await f.exec('batch',{steps,timeout_ms:5000});
  assert.equal(failed.failed_step,1);assert.equal(failed.retry_failed_step_safe,true);
  assert.equal(f.calls.filter(c=>c.method==='Input.dispatchMouseEvent'&&c.args.type==='mousePressed').length,1);
  const resumed=await f.exec('batch',{steps,start_at:2});assert.equal(resumed.completed,true);
  assert.equal(f.calls.filter(c=>c.method==='Input.dispatchMouseEvent'&&c.args.type==='mousePressed').length,2);
});

test('explicit dialog policy handles alerts and permits subsequent batch steps; ask still stops', async () => {
  const f=fixture();await f.claim();f.modal();const send=f.api.debugger.sendCommand;
  f.api.debugger.sendCommand=async(target,method,args)=>{
    if(method==='Page.handleJavaScriptDialog') {f.api.debugger.onEvent.emit(target,'Page.javascriptDialogClosed');return {};}
    const result=send(target,method,args);
    if(method==='Input.dispatchMouseEvent'&&args.type==='mouseReleased') {
      const binding=f.calls.findLast(c=>c.method==='Runtime.addBinding')?.args.name;
      f.api.debugger.onEvent.emit(target,'Runtime.bindingCalled',{name:binding,executionContextId:42,payload:'{"matched":true}'});
      return {};
    }
    return result;
  };
  const result=await f.exec('batch',{dialog_policy:'accept',steps:[{action:'click',selector:'#alert'},{action:'click',selector:'#next'}]});
  assert.equal(result.completed,true);assert.equal(result.dialogs.length,2);assert.ok(result.dialogs.every(d=>d.accepted&&d.handled));
});
