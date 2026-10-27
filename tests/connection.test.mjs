import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnection } from '../extension/connection.js';
import { VERSION } from '../src/config.mjs';

async function fixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const sockets = [], local = {}, session = {};
  let cleanupError, cleanupRejection, diskVersion = VERSION, reloads = 0, executions = 0;
  class Socket {
    static OPEN = 1;
    readyState = 1;
    messages = [];
    constructor() { sockets.push(this); }
    send(value) { this.messages.push(JSON.parse(value)); }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  const originalSocket = globalThis.WebSocket;
  globalThis.WebSocket = Socket;
  t.after(() => { globalThis.WebSocket = originalSocket; });
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ version: diskVersion }) }));
  const storage = values => ({ get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, values[key]])),
    set: async data => Object.assign(values, data), remove: async key => { delete values[key]; } });
  const event = () => ({ addListener(listener) { this.listener = listener; } });
  const api = { storage: { local: storage(local), session: storage(session) },
    runtime: { id: 'test', getManifest: () => ({ version: '0.16.9' }), getURL: path => `chrome-extension://test/${path}`,
      reload: () => { reloads++; }, onMessage: event(), onStartup: event(), onInstalled: event() },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    alarms: { create: async () => {}, onAlarm: event() } };
  const controller = { releaseAll: async () => {
    if (cleanupRejection) throw new Error(cleanupRejection);
    return { released: 1, errors: cleanupError ? [cleanupError] : [] };
  },
    execute: async () => { executions++; return { ok: true }; }, claimedCount: () => 0 };
  createConnection(api, { url: 'ws://127.0.0.1:47831/extension', token: 'secret' }, controller);
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  await flush();
  const ws = sockets[0]; assert.ok(ws);
  ws.onopen();
  const command = async (command, args = {}) => {
    const id = ws.messages.length + 1;
    await ws.onmessage({ data: JSON.stringify({ id, command, arguments: args, owner: 'owner' }) });
    return ws.messages.find(message => message.id === id);
  };
  return { ws, local, sockets, flush, command, controller, get reloads() { return reloads; }, get executions() { return executions; },
    message: message => new Promise(resolve => {
      assert.equal(api.runtime.onMessage.listener(message, { id: api.runtime.id }, resolve), true);
    }),
    set cleanupError(value) { cleanupError = value; }, set cleanupRejection(value) { cleanupRejection = value; }, set diskVersion(value) { diskVersion = value; } };
}

test('extension replies preserve only supported structured error evidence', async t => {
  const f = await fixture(t);
  const evidence = { input_dispatched: true, post_action: { delivery: 'unknown', navigation_observed: true }, diagnostics: { reason: 'obstructed' },
    open_tab: { opened: true, claimed: false, tab_id: 10, phase: 'claim' } };
  f.controller.execute = async () => { throw Object.assign(new Error('Receipt lost'), evidence, { private_state: 'not transported' }); };
  const result = await f.command('click');
  assert.deepEqual(result, { id: result.id, error: 'Receipt lost', ...evidence });
});

test('popup release reports partial cleanup failures and rejected cleanup, then permits an explicit retry', async t => {
  const f = await fixture(t);
  f.cleanupError = 'detach failed';
  assert.deepEqual(await f.message({ type: 'release_all' }), { ok: false, error: 'Extension cleanup failed: detach failed' });
  f.cleanupError = undefined;
  f.cleanupRejection = 'cleanup rejected';
  assert.deepEqual(await f.message({ type: 'release_all' }), { ok: false, error: 'cleanup rejected' });
  f.cleanupRejection = undefined;
  assert.deepEqual(await f.message({ type: 'release_all' }), { ok: true });
});

test('maintenance blocks page commands until resume and failed cleanup never reloads', async t => {
  const f = await fixture(t);
  f.cleanupError = 'detach failed';
  assert.match((await f.command('prepare_upgrade')).error, /detach failed/);
  assert.match((await f.command('click')).error, /preparing an upgrade/);
  assert.match((await f.command('reload_extension', { version: VERSION })).error, /detach failed/);
  assert.equal(f.reloads, 0);
  assert.equal(f.executions, 0);
  f.cleanupError = undefined;
  assert.equal((await f.command('resume')).result.resumed, true);
  assert.equal((await f.command('click')).result.ok, true);
  assert.equal(f.executions, 1);
});

test('reload verifies local files and persists an attempt to prevent a reload loop', async t => {
  const f = await fixture(t);
  f.diskVersion = '0.16.9';
  assert.match((await f.command('reload_extension', { version: VERSION })).error, /files do not match/);
  assert.equal(f.reloads, 0);
  f.diskVersion = VERSION;
  assert.equal((await f.command('reload_extension', { version: VERSION })).result.reloading, true);
  assert.equal(f.reloads, 1);
  assert.deepEqual(f.local.reloadAttempt, { from: '0.16.9', target: VERSION });
  assert.match((await f.command('reload_extension', { version: VERSION })).error, /reload manually/);
  assert.equal(f.reloads, 1);
  assert.match((await f.command('reload_extension', { version: '0.16.8' })).error, /must be newer/);
});

test('reconnect waits for successful cleanup instead of handing off after failed detach', async t => {
  const f = await fixture(t);
  f.cleanupError = 'detach failed';
  f.ws.close();
  await f.flush(); t.mock.timers.tick(2000); await f.flush();
  assert.equal(f.sockets.length, 1);
  f.cleanupError = undefined;
  t.mock.timers.tick(2000); await f.flush();
  assert.equal(f.sockets.length, 2);
});
