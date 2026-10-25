import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/controller-fixture.mjs';

test('PNG capture supports viewport and bounded full-page screenshots', async () => {
  const f = fixture(); await f.claim();
  await assert.rejects(f.exec('screenshot', {name:'Submit'}), /name requires an element selector/);
  assert.equal((await f.exec('screenshot')).data, 'image-data');
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

test('claim intercepts file choosers, click reports one, upload uses the native input and clears pending state', async () => {
  const f = fixture(); await f.claim();
  assert.ok(f.calls.some(call => call.method === 'Page.setInterceptFileChooserDialog' && call.args.enabled));
  f.api.debugger.onEvent.emit({ tabId: 9 }, 'Page.fileChooserOpened', { backendNodeId: 77, mode: 'selectMultiple', frameId: 'main' });
  assert.equal((await f.exec('snapshot')).file_chooser.mode, 'selectMultiple');
  const result = await f.exec('upload_file', { files: ['C:\\fixtures\\中文 file.txt', 'C:\\fixtures\\empty.txt'] });
  assert.equal(result.files_set, 2);
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
  assert.equal(cleared.cleared, true); assert.equal(cleared.files_set, 0);
  assert.equal(cleared.events_trusted, false); assert.equal(cleared.method, 'dom');
  assert.equal(cleared.application_result, 'not_checked');
  assert.equal((await f.exec('upload_file', { ref, files: [] })).cleared, true);
  f.api.debugger.onEvent.emit({ tabId: 9 }, 'Page.fileChooserOpened', { backendNodeId: 77, mode: 'selectSingle' });
  f.api.debugger.onEvent.emit({ tabId: 9 }, 'Page.frameNavigated', { frame: { id: 'main' } });
  await assert.rejects(f.exec('upload_file', { files: [] }), /No pending/);
  f.api.debugger.onEvent.emit({ tabId: 9 }, 'Page.fileChooserOpened', { backendNodeId: 77 });
  await f.exec('release_tab'); await f.claim();
  assert.equal((await f.exec('snapshot')).file_chooser, undefined);
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

test('upload readback detects reset or detached inputs and never repeats file assignment', async () => {
  for (const count of [0, null]) {
    const f = fixture(); await f.claim();
    const send = f.api.debugger.sendCommand;
    f.api.debugger.sendCommand = async (target, method, args) => {
      if (method === 'Runtime.callFunctionOn' && args.functionDeclaration.includes('this.files?.length')) return { result: { value: count } };
      return send(target, method, args);
    };
    await assert.rejects(f.exec('upload_file', { selector: '#file', files: ['C:\\fixtures\\one.txt'] }), error => {
      assert.equal(error.input_dispatched, true); assert.equal(error.outcome_unknown, true);
      assert.equal(error.diagnostics.reason, 'file_count_not_retained');
      assert.equal(error.diagnostics.observed_count, count); assert.equal(error.post_action.delivery, 'unknown');
      return true;
    });
    assert.equal(f.calls.filter(call => call.method === 'DOM.setFileInputFiles').length, 1);
  }
});

test('upload observation failures preserve dispatched uncertainty without replay', async () => {
  const f = fixture(); await f.claim();
  const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => {
    if (method === 'Runtime.callFunctionOn' && args.functionDeclaration.includes('this.files?.length')) throw new Error('Context destroyed during file readback');
    return send(target, method, args);
  };
  await assert.rejects(f.exec('upload_file', { selector: '#file', files: ['C:\\fixtures\\one.txt'] }), error => {
    assert.equal(error.input_dispatched, true); assert.equal(error.outcome_unknown, true);
    assert.equal(error.post_action.delivery, 'unknown'); return true;
  });
  assert.equal(f.calls.filter(call => call.method === 'DOM.setFileInputFiles').length, 1);
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
