import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/controller-fixture.mjs';

test('buffered logs remain readable after blank or restricted navigation and metadata failure without browser calls', async () => {
  const f = fixture(); await f.claim();
  assert.ok(!f.calls.some(call => call.method === 'Debugger.enable'));
  const emit = (method, params) => f.api.debugger.onEvent.emit({ tabId: 9 }, method, params);
  emit('Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'before failure' }] });
  emit('Network.requestWillBeSent', { requestId: 'r', frameId: 'main', loaderId: 'document', request: { url: 'https://fixture.test/', method: 'GET' } });
  const get = f.api.tabs.get;
  for (const url of ['about:blank', 'chrome://settings/', 'file:///C:/sample.html']) {
    f.tabs.get(9).url = url;
    emit('Page.frameNavigated', { frame: { id: 'main', loaderId: url, url } });
    f.api.extension.isAllowedFileSchemeAccess = async () => false;
    f.api.tabs.get = async () => { throw new Error('Tab metadata unavailable'); };
    f.calls.length = 0;
    assert.equal((await f.exec('logs', { kind: 'console' })).entries[0].text, 'before failure');
    assert.equal((await f.exec('logs', { kind: 'network' })).entries[0].request_id, 'r');
    assert.equal((await f.exec('logs', { kind: 'navigation' })).entries.at(-1).url, url);
    assert.deepEqual(f.calls, []);
    f.api.tabs.get = get;
  }
});

test('capture changes still require a supported current page and actual file access, including disabling capture', async () => {
  const f = fixture(); await f.claim();
  const get = f.api.tabs.get;
  for (const url of ['about:blank', 'chrome://settings/', 'file:///C:/sample.html']) {
    f.tabs.get(9).url = url;
    f.api.extension.isAllowedFileSchemeAccess = async () => false;
    f.calls.length = 0;
    for (const enabled of [true, false]) await assert.rejects(f.exec('logs', { kind: 'network', capture: { enabled } }), /about:blank|Only http|Local file access/);
    assert.deepEqual(f.calls, []);
  }
  f.api.tabs.get = async () => { throw new Error('Tab metadata unavailable'); };
  await assert.rejects(f.exec('logs', { kind: 'network', capture: { enabled: false } }), /metadata unavailable/);
  f.api.tabs.get = get;
  f.tabs.get(9).url = 'https://fixture.test/';
  f.calls.length = 0;
  assert.equal((await f.exec('logs', { kind: 'network', capture: { enabled: true } })).capture.enabled, true);
  assert.ok(f.calls.some(call => call.method === 'Network.enable'));
  assert.ok(!f.calls.some(call => call.method.startsWith('Runtime.') || call.method === 'Page.createIsolatedWorld'));
});

test('buffered logs preserve ownership, release ordering and detach/close cleanup', async () => {
  for (const cleanup of ['release', 'detach', 'close']) {
    const f = fixture(); await f.claim();
    f.api.debugger.onEvent.emit({ tabId: 9 }, 'Page.frameRequestedNavigation', { frameId: 'main', url: 'about:blank', reason: 'scriptInitiated' });
    await assert.rejects(f.exec('logs', { kind: 'navigation' }, 'two'), /not claimed/);
    await assert.rejects(f.exec('logs', { kind: 'console', tab_handle: 'wrong' }), /not claimed/);
    if (cleanup === 'release') {
      const release = f.exec('release_tab');
      const read = assert.rejects(f.exec('logs', { kind: 'navigation' }), /not claimed/);
      await release; await read;
    } else {
      if (cleanup === 'detach') f.api.debugger.onDetach.emit({ tabId: 9 });
      else await f.api.tabs.remove(9);
      await assert.rejects(f.exec('logs', { kind: 'navigation' }), /not claimed/);
    }
    if (cleanup !== 'close') {
      await f.claim();
      assert.equal((await f.exec('logs', { kind: 'navigation' })).latest_seq, 0);
    }
  }
});

test('buffered reads stay behind capture changes in the tab queue and reject irrelevant filters before changing capture', async () => {
  const f = fixture(); await f.claim();
  let finish, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => {
    if (method === 'Network.enable') { entered(); await new Promise(resolve => { finish = resolve; }); }
    return send(target, method, args);
  };
  const configure = f.exec('logs', { kind: 'network', capture: { enabled: true } });
  await ready;
  let readFinished = false;
  const read = f.exec('logs', { kind: 'network' }).then(result => { readFinished = true; return result; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(readFinished, false);
  finish(); await configure;
  assert.equal((await read).capture.enabled, true);
  f.calls.length = 0;
  await assert.rejects(f.exec('logs', { kind: 'network', level: 'error', capture: { enabled: false } }), /only valid for kind=console/);
  assert.deepEqual(f.calls, []);
  assert.equal((await f.exec('logs', { kind: 'network' })).capture.enabled, true);
});
