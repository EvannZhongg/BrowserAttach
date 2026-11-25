import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, captureChooser } from './helpers/controller-fixture.mjs';

test('PNG capture supports viewport and bounded full-page screenshots', async () => {
  const f = fixture(); await f.claim();
  await assert.rejects(f.exec('screenshot', {name:'Submit'}), /name requires an element selector/);
  assert.match((await f.exec('screenshot')).data, /^iVBOR/);
  const full = await f.exec('screenshot', { full_page: true, include_indicators: true });
  assert.equal(full.capture.agent_indicators_included, true);
  const calls = f.calls.filter(call => call.method === 'Page.captureScreenshot');
  assert.equal(calls[1].args.clip.height, 1800);
  assert.ok(!f.calls.some(call => call.method === 'Runtime.evaluate' && call.args.expression.includes('__localBrowserAttachVisual')));
});

test('a hidden-page screenshot timeout leaves the native group marker and tab queue usable', async () => {
  const f = fixture(); await f.claim();
  const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = (target, method, args) => method === 'Page.captureScreenshot'
    ? new Promise(() => {}) : send(target, method, args);
  await assert.rejects(f.exec('screenshot'), /Screenshot did not finish within 5 seconds/);
  assert.ok(f.tabs.get(9).groupId >= 0);
  assert.ok((await f.exec('snapshot')).snapshot);
  await f.exec('release_tab');
  assert.equal(f.controller.claimedCount(), 0);
});

test('a screenshot after click hides transient feedback before capture and then restores visibility', async () => {
  const f = fixture(); await f.claim();
  await f.exec('click', { x: 20, y: 30 });
  const result = await f.exec('screenshot');
  assert.equal(result.capture.agent_indicators_included, false);
  const hidden = f.calls.findIndex(call => call.method === 'Runtime.evaluate' && call.args.expression.includes('?.visible(false)'));
  const capture = f.calls.findIndex(call => call.method === 'Page.captureScreenshot');
  assert.ok(hidden >= 0 && hidden < capture);
  assert.ok(f.calls.slice(capture + 1).some(call => call.method === 'Runtime.evaluate' && call.args.expression.includes('?.visible(true)')));
});

test('only explicit capture intercepts choosers, then restores manual selection before upload', async () => {
  const f = fixture(); await f.claim();
  assert.ok(!f.calls.some(call => call.method === 'Page.setInterceptFileChooserDialog'));
  await f.exec('click', { x: 20, y: 30 });
  assert.ok(!f.calls.some(call => call.method === 'Page.setInterceptFileChooserDialog'));
  const click = await captureChooser(f, { backendNodeId: 77, mode: 'selectMultiple', frameId: 'main' });
  assert.equal(click.file_chooser.pending, true);
  assert.deepEqual(f.calls.filter(call => call.method === 'Page.setInterceptFileChooserDialog').map(call => call.args.enabled), [true, false]);
  assert.equal((await f.exec('snapshot')).file_chooser.mode, 'selectMultiple');
  const result = await f.exec('upload_file', { files: ['C:\\fixtures\\中文 file.txt', 'C:\\fixtures\\empty.txt'] });
  assert.equal(result.assignment_acknowledged, true); assert.equal(result.requested_count, 2);
  assert.equal(result.observed_count, 2); assert.equal(result.count_verified, true);
  assert.equal(result.method, 'native'); assert.equal(result.events_trusted, null);
  assert.equal(result.application_result, 'not_checked');
  assert.equal(result.file_chooser, undefined);
  assert.deepEqual(f.calls.find(call => call.method === 'DOM.setFileInputFiles').args,
    { objectId: 'file-input', files: ['C:\\fixtures\\中文 file.txt', 'C:\\fixtures\\empty.txt'] });
  await assert.rejects(f.exec('upload_file', { files: [] }), /No pending file chooser/);
});

test('direct upload retains backend refs; [] clears and file chooser state expires on navigation and release', async () => {
  const f = fixture(); await f.claim();
  const ref = f.ref(await f.exec('snapshot'));
  const cleared = await f.exec('upload_file', { ref, files: [] });
  assert.equal(cleared.requested_count, 0); assert.equal(cleared.observed_count, 0); assert.equal(cleared.count_verified, true);
  assert.equal(cleared.events_trusted, false); assert.equal(cleared.method, 'dom');
  assert.equal(cleared.application_result, 'not_checked');
  assert.equal((await f.exec('upload_file', { ref, files: [] })).count_verified, true);
  await captureChooser(f, { backendNodeId: 77, mode: 'selectSingle' });
  f.api.debugger.onEvent.emit({ tabId: 9 }, 'Page.frameNavigated', { frame: { id: 'main' } });
  await assert.rejects(f.exec('upload_file', { files: [] }), /No pending/);
  await captureChooser(f, { backendNodeId: 77 });
  await f.exec('release_tab'); await f.claim();
  assert.equal((await f.exec('snapshot')).file_chooser, undefined);
});

test('capture awaits asynchronous choosers and disables interception before post-action waits', async () => {
  const f = fixture(); await f.claim();
  const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => {
    if (method === 'Runtime.evaluate' && args.expression === 'location.href') {
      f.calls.push({ target, method, args });
      return { result: { value: 'http://localhost:8000/' } };
    }
    const result = await send(target, method, args);
    if (method === 'Input.dispatchMouseEvent' && args.type === 'mouseReleased') setTimeout(() => {
      f.api.debugger.onEvent.emit(target, 'Page.fileChooserOpened', { backendNodeId: 77, frameId: 'main' });
    }, 20);
    return result;
  };
  const clicked = await f.exec('click', { x: 20, y: 30, capture_file_chooser: true, wait_for: { checks: [{ condition: 'url', expected: 'localhost' }], timeout_ms: 200 } });
  assert.equal(clicked.file_chooser.pending, true);
  assert.equal(clicked.wait_result.status, 'pass');
  const disabled = f.calls.findIndex(call => call.method === 'Page.setInterceptFileChooserDialog' && !call.args.enabled);
  const waiting = f.calls.findIndex((call, index) => index > disabled && call.method === 'Runtime.evaluate' && call.args.expression.includes('location.href'));
  assert.ok(disabled >= 0 && waiting > disabled);
});

test('missing chooser retains the click receipt, restores manual selection and ignores late events', async () => {
  const f = fixture(); await f.claim();
  const result = await f.exec('click', { x: 20, y: 30, capture_file_chooser: true, timeout_ms: 100 });
  assert.equal(result.delivery_verified, true);
  assert.equal(result.file_chooser.pending, false);
  assert.equal(result.file_chooser.reason, 'not_opened');
  assert.equal(f.calls.filter(call => call.method === 'Input.dispatchMouseEvent' && call.args.type === 'mouseReleased').length, 1);
  assert.deepEqual(f.calls.filter(call => call.method === 'Page.setInterceptFileChooserDialog').map(call => call.args.enabled), [true, false]);
  f.api.debugger.onEvent.emit({ tabId: 9 }, 'Page.fileChooserOpened', { backendNodeId: 77 });
  await assert.rejects(f.exec('upload_file', { files: [] }), /No pending/);
});

test('capture setup and input failures restore interception without replaying input', async () => {
  for (const stage of ['enable', 'input']) {
    const f = fixture(); await f.claim();
    const send = f.api.debugger.sendCommand;
    f.api.debugger.sendCommand = async (target, method, args) => {
      if (stage === 'enable' && method === 'Page.setInterceptFileChooserDialog' && args.enabled) throw new Error('Enable failed');
      if (stage === 'input' && method === 'Runtime.callFunctionOn' && args.functionDeclaration.includes('function installGuard')) throw new Error('Input preparation failed');
      return send(target, method, args);
    };
    await assert.rejects(f.exec('click', { x: 20, y: 30, capture_file_chooser: true, timeout_ms: 100 }));
    assert.ok(f.calls.some(call => call.method === 'Page.setInterceptFileChooserDialog' && !call.args.enabled));
    assert.ok(!f.calls.some(call => call.method === 'Input.dispatchMouseEvent' && call.args.type === 'mouseReleased'));
  }
});

test('capture cleanup failures retain action evidence and explicit manual recovery', async () => {
  const f = fixture(); await f.claim();
  const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => {
    if (method === 'Page.setInterceptFileChooserDialog' && !args.enabled) throw new Error('Disable failed');
    return send(target, method, args);
  };
  await assert.rejects(captureChooser(f, { backendNodeId: 77 }), error => {
    assert.equal(error.input_dispatched, true);
    assert.equal(error.post_action.action_result.delivery_verified, true);
    assert.match(error.file_chooser_cleanup.error, /Disable failed/);
    assert.match(error.file_chooser_cleanup.recovery, /Release this tab/);
    return true;
  });
  assert.equal(f.calls.filter(call => call.method === 'Input.dispatchMouseEvent' && call.args.type === 'mouseReleased').length, 1);
});

test('capture ends on detach and does not retain a pending selection', async () => {
  const f = fixture(); await f.claim();
  const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => {
    const result = await send(target, method, args);
    if (method === 'Input.dispatchMouseEvent' && args.type === 'mouseReleased') setTimeout(() => f.api.debugger.onDetach.emit(target), 10);
    return result;
  };
  const clicked = await f.exec('click', { x: 20, y: 30, capture_file_chooser: true });
  assert.equal(clicked.file_chooser.pending, false);
  assert.match(clicked.file_chooser.observation_error, /control changed/);
  assert.equal(f.controller.claimedCount(), 0);
});

test('capture reports unsupported chooser events without leaving interception enabled', async () => {
  const f = fixture(); await f.claim();
  const clicked = await captureChooser(f, { mode: 'selectSingle' });
  assert.equal(clicked.file_chooser.pending, false);
  assert.equal(clicked.file_chooser.reason, 'unsupported_chooser');
  assert.equal(f.calls.filter(call => call.method === 'Page.setInterceptFileChooserDialog').at(-1).args.enabled, false);
});

test('capture option is validated before any dispatch or interception', async () => {
  const f = fixture(); await f.claim();
  await assert.rejects(f.exec('click', { x: 20, y: 30, capture_file_chooser: 'true' }), /must be boolean/);
  assert.ok(!f.calls.some(call => call.method === 'Page.setInterceptFileChooserDialog' || call.method === 'Input.dispatchMouseEvent'));
});

test('upload validation failure never dispatches native file assignment', async () => {
  const f = fixture(); await f.claim();
  const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => {
    if (method === 'Runtime.callFunctionOn' && args.functionDeclaration.includes("input.type !== 'file'"))
      return { exceptionDetails: { text: 'Single-file input cannot accept multiple files' } };
    return send(target, method, args);
  };
  const ref = f.ref(await f.exec('snapshot'));
  await assert.rejects(f.exec('upload_file', { ref, files: ['C:\\a', 'C:\\b'] }), /Single-file/);
  assert.ok(!f.calls.some(call => call.method === 'DOM.setFileInputFiles'));
});

test('upload separates acknowledged assignment from reset, changed and detached selection without replay', async () => {
  for (const count of [0, 2, null]) {
    const f = fixture(); await f.claim();
    const send = f.api.debugger.sendCommand;
    f.api.debugger.sendCommand = async (target, method, args) => {
      if (method === 'Runtime.callFunctionOn' && args.functionDeclaration.includes('this.files?.length')) return { result: { value: count } };
      return send(target, method, args);
    };
    const result = await f.exec('upload_file', { selector: '#file', files: ['C:\\fixtures\\one.txt'] });
    assert.equal(result.assignment_acknowledged, true); assert.equal(result.requested_count, 1);
    assert.equal(result.observed_count, count); assert.equal(result.count_verified, count == null ? null : false);
    assert.equal(result.application_result, 'not_checked'); assert.equal(result.events_trusted, null);
    assert.equal(result.observation_error?.reason, count == null ? 'file_selection_unavailable' : undefined);
    assert.equal(f.calls.filter(call => call.method === 'DOM.setFileInputFiles').length, 1);
  }
});

test('upload observation failures preserve assignment acknowledgement without replay', async () => {
  const f = fixture(); await f.claim();
  const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => {
    if (method === 'Runtime.callFunctionOn' && args.functionDeclaration.includes('this.files?.length')) throw new Error('Context destroyed during file readback');
    return send(target, method, args);
  };
  const result = await f.exec('upload_file', { selector: '#file', files: ['C:\\fixtures\\one.txt'] });
  assert.equal(result.assignment_acknowledged, true); assert.equal(result.observed_count, null); assert.equal(result.count_verified, null);
  assert.match(result.observation_error.error, /Context destroyed/); assert.equal(result.application_result, 'not_checked');
  assert.equal(f.calls.filter(call => call.method === 'DOM.setFileInputFiles').length, 1);
});

test('upload assignment timeout remains an uncertain error and late acknowledgement cannot repeat it', async () => {
  const f = fixture(); await f.claim(); const send = f.api.debugger.sendCommand;
  let finish, assignments = 0;
  f.api.debugger.sendCommand = (target, method, args) => {
    if (method === 'DOM.setFileInputFiles') { assignments++; return new Promise(resolve => { finish = () => resolve({}); }); }
    return send(target, method, args);
  };
  await assert.rejects(f.exec('upload_file', { selector: '#file', files: ['C:\\fixtures\\one.txt'], timeout_ms: 150 }), error => {
    assert.equal(error.input_dispatched, true); assert.equal(error.outcome_unknown, true); return true;
  });
  finish(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(assignments, 1);
  assert.ok((await f.exec('snapshot')).snapshot);
  assert.ok(!f.calls.some(call => call.args?.functionDeclaration?.includes('this.files?.length')));
});

test('element capture uses its box and retains the document offset instead of full-page origin', async () => {
  const f=fixture();await f.claim();const send=f.api.debugger.sendCommand;
  f.api.debugger.sendCommand=async(target,method,args)=>{
    if(method==='DOM.getBoxModel')return {model:{border:[10,20,110,20,110,60,10,60]}};
    const result=await send(target,method,args);
    if(method==='Runtime.evaluate'&&args.expression.includes('scroll_x: scrollX'))result.result.value.scroll_y=100;
    return result;
  };
  const result=await f.exec('screenshot',{selector:'#box'});
  assert.equal(result.capture.scope,'element');assert.deepEqual(result.capture.image_origin_css,{x:10,y:120});assert.equal(result.capture.css_width,100);
  await assert.rejects(f.exec('screenshot',{selector:'#box',full_page:true}),/mutually exclusive/);
});
