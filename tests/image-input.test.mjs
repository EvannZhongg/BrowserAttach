import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/controller-fixture.mjs';
import { pngSize } from '../extension/screenshot.js';

function captureFixture() {
  const f = fixture(), send = f.api.debugger.sendCommand;
  const state = { view: { width: 1707, height: 842, scroll_x: 0, scroll_y: 0, device_pixel_ratio: 1.5 } };
  f.api.debugger.sendCommand = async (target, method, args) => {
    if (method === 'Runtime.evaluate' && args.expression.includes('device_pixel_ratio: devicePixelRatio')) {
      f.calls.push({ target, method, args }); return { result: { value: { ...state.view } } };
    }
    if (method === 'Page.captureScreenshot') {
      const header = Buffer.from([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,0,0,0,0,0]);
      header.writeUInt32BE(2561, 16); header.writeUInt32BE(1263, 20);
      return { data: header.toString('base64') };
    }
    return send(target, method, args);
  };
  return { ...f, state };
}

test('image input uses actual PNG axes and crop origin, preserving coordinate verification semantics', async () => {
  const f = captureFixture(); await f.claim();
  const shot = (await f.exec('screenshot')).capture;
  assert.equal(shot.image.width, 2561); assert.equal(shot.image.height, 1263);
  const clicked = await f.exec('click', { x: 150, y: 75, coordinate_space: 'image', screenshot_id: shot.screenshot_id });
  assert.deepEqual(clicked.clicked, { x: 150 * 1707 / 2561, y: 50 });
  assert.equal(clicked.delivery_verified, true); assert.equal(clicked.target_verified, null);
  await assert.rejects(f.exec('click', { x: 150, y: 75, coordinate_space: 'image', screenshot_id: shot.screenshot_id }), error => error.diagnostics.reason === 'stale_screenshot' && error.input_dispatched === false);
  const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => method === 'DOM.getBoxModel'
    ? { model: { border: [100, 200, 300, 200, 300, 300, 100, 300] } } : send(target, method, args);
  const crop = (await f.exec('screenshot', { selector: '#plan' })).capture;
  const croppedClick = await f.exec('click', { x: 1280.5, y: 631.5, coordinate_space: 'image', screenshot_id: crop.screenshot_id });
  assert.deepEqual(croppedClick.clicked, { x: 200, y: 250 });
});

test('stale, cross-tab, out-of-bounds and offscreen image coordinates never dispatch input', async () => {
  for (const change of ['replace', 'viewport', 'scroll', 'dpr', 'document', 'frame', 'release', 'bounds', 'offscreen', 'wrong_id']) {
    const f = captureFixture(); await f.claim();
    const shot = (await f.exec('screenshot', { full_page: change === 'offscreen' })).capture;
    if (change === 'replace') await f.exec('screenshot');
    if (change === 'viewport') f.state.view.width++;
    if (change === 'scroll') f.state.view.scroll_y++;
    if (change === 'dpr') f.state.view.device_pixel_ratio = 2;
    if (change === 'document') f.api.debugger.onEvent.emit({ tabId: 9 }, 'Page.navigatedWithinDocument', { frameId: 'main', url: 'http://localhost:8000/changed' });
    if (change === 'frame') f.api.debugger.onEvent.emit({ tabId: 9 }, 'Page.frameDetached', { frameId: 'child' });
    if (change === 'release') { await f.exec('release_tab'); await f.claim(); }
    f.calls.length = 0;
    await assert.rejects(f.exec('click', { x: change === 'bounds' ? 2561 : 100, y: change === 'offscreen' ? 1200 : 100,
      coordinate_space: 'image', screenshot_id: change === 'wrong_id' ? 'other-tab-capture' : shot.screenshot_id }), error => error.input_dispatched === false && /screenshot|image/i.test(error.message));
    assert.ok(!f.calls.some(c => c.method.startsWith('Input.')), change);
  }
});

test('image mapping cannot survive navigation during capture or viewport changes after preparation', async () => {
  for (const phase of ['capture', 'dispatch']) {
    const f = captureFixture(); await f.claim();
    const send = f.api.debugger.sendCommand;
    f.api.debugger.sendCommand = async (target, method, args) => {
      const result = await send(target, method, args);
      if (phase === 'capture' && method === 'Page.captureScreenshot') f.api.debugger.onEvent.emit({ tabId: 9 }, 'DOM.documentUpdated', {});
      if (phase === 'dispatch' && method === 'Runtime.callFunctionOn' && args.functionDeclaration.includes('function installGuard')) f.state.view.scroll_y++;
      return result;
    };
    if (phase === 'capture') await assert.rejects(f.exec('screenshot'), /source.*changed/);
    else {
      const shot = (await f.exec('screenshot')).capture;
      await assert.rejects(f.exec('click', { x: 100, y: 100, coordinate_space: 'image', screenshot_id: shot.screenshot_id }), error => error.input_dispatched === false && error.diagnostics.reason === 'stale_screenshot');
    }
    assert.ok(!f.calls.some(c => c.method.startsWith('Input.')));
  }
  assert.throws(() => pngSize('bad'), /invalid PNG/);
});

test('expected_target constrains coordinates without scrolling or falling back, retaining trusted guards', async () => {
  for (const mismatch of [false, true]) {
    const f = fixture(); await f.claim();
    if (mismatch) f.block();
    f.calls.length = 0;
    const action = f.exec('click', { x: 55, y: 30, expected_target: { selector: '#plan' } });
    if (mismatch) {
      await assert.rejects(action, error => error.input_dispatched === false && error.diagnostics.reason === 'suspected_mistarget' && error.diagnostics.suspected_mistarget === true);
      assert.ok(!f.calls.some(c => c.method.startsWith('Input.')));
    } else {
      const result = await action;
      assert.equal(result.target_verified, true); assert.equal(result.delivery_verified, true);
      assert.equal(result.target_verification.basis, 'expected_target'); assert.ok('hit_target' in result);
    }
    assert.ok(!f.calls.some(c => ['DOM.scrollIntoViewIfNeeded', 'tabs.update', 'windows.update'].includes(c.method)));
  }
});

test('screenshot mappings stay inside their claimed tab and reads preserve them while input clears them', async () => {
  const f = captureFixture(); await f.claim();
  const shot = (await f.exec('screenshot')).capture;
  f.tabs.set(10, { ...f.tabs.get(9), id: 10 });
  await f.exec('claim_tab', { tab_id: 10, tab_handle: 'second' });
  const point = { x: 100, y: 100, coordinate_space: 'image', screenshot_id: shot.screenshot_id };
  await assert.rejects(f.exec('click', { ...point, tab_id: 10, tab_handle: 'second' }), error => error.input_dispatched === false && error.diagnostics.reason === 'stale_screenshot');
  await f.exec('snapshot');
  assert.equal((await f.exec('click', point)).delivery_verified, true);
  const fresh = (await f.exec('screenshot')).capture;
  await f.exec('press_key', { key: 'Escape' });
  await assert.rejects(f.exec('click', { ...point, screenshot_id: fresh.screenshot_id }), /Screenshot is stale/);
  const resized = (await f.exec('screenshot')).capture;
  f.state.view.width++;
  await assert.rejects(f.exec('click', { ...point, screenshot_id: resized.screenshot_id }), /viewport changed/);
  f.state.view.width--;
  await assert.rejects(f.exec('click', { ...point, screenshot_id: resized.screenshot_id }), /Screenshot is stale/);
});
