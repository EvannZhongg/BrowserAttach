import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startHub } from '../src/hub.mjs';
import { AttachClient } from '../src/client.mjs';
import { ROOT, VERSION, writeJson } from '../src/config.mjs';
import { setup } from '../src/setup.mjs';
import { validateFiles } from '../src/upload.mjs';
import { fixture as controllerFixture } from './helpers/controller-fixture.mjs';
import { errorData } from '../extension/errors.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB1kAAAAASUVORK5CYII=';
async function fixture(t, options) {
  const config = { port: 47831, token: 'test-secret-'.repeat(5), extension_id: 'a'.repeat(32) };
  const hub = await startHub(config, { port: 0, ...options }); config.port = hub.port;
  const sockets = [], clients = [], requests = [], released = new Set();
  let tabs = [{ tab_id: 9, title: 'Demo', url: 'http://localhost:8000/' }, { tab_id: 10, title: 'Other', url: 'https://example.com/' }];
  t.after(async () => {
    await Promise.all(clients.map(client => client.close()));
    for (const socket of sockets) socket.close();
    await hub.close();
  });
  async function extension({ family = 'chrome', instance = family, run = 'one', token = config.token } = {}) {
    const ws = new WebSocket(`ws://127.0.0.1:${config.port}/extension`, { origin: `chrome-extension://${config.extension_id}` });
    sockets.push(ws); await once(ws, 'open');
    const response = once(ws, 'message');
    ws.send(JSON.stringify({ type: 'hello', token, browser: { family, instance_id: instance, run_id: run, profile_name: family, extension_version: VERSION } }));
    const connected = JSON.parse((await response)[0].toString());
    ws.on('message', async raw => {
      const data = JSON.parse(raw.toString()); requests.push(data);
      if (!data.id || data.command === 'stall') return;
      if (data.command === 'read_text' && options?.stall) return;
      if (options?.failCommands?.has(data.command)) {
        ws.send(JSON.stringify({ id: data.id, error: `${data.command} failed`, ...options.failure }));
        return;
      }
      if (options?.execute) {
        try { ws.send(JSON.stringify({ id: data.id, result: await options.execute(data.owner, data.command, data.arguments) })); }
        catch (error) { ws.send(JSON.stringify({ id: data.id, ...errorData(error) })); }
        return;
      }
      let result = { ok: true };
      if (data.command === 'list_tabs') result = { tabs: structuredClone(tabs) };
      if (data.command === 'open_tab') result = { opened: true, tab_id: 11, active: data.arguments.active ?? false };
      if (data.command === 'release_owner') released.add(data.owner);
      if (data.command === 'snapshot') result = { snapshot: '[s1:1] button "Test"' };
      if (data.command === 'batch') result = { completed: false, results: [{ value_verified: true }], failed_step: 1, error: 'Outcome is unknown' };
      if (data.command === 'wait') result = { status: 'fail', timed_out: true, retry_safe: true, failed: [0], unavailable: [], results: [{ index: 0, status: 'fail', expected: 1, actual: { count: 0 } }] };
      if (data.command === 'screenshot') result = { data: PNG, capture: { css_width: 1, css_height: 1,
        image_origin_css: { x: 0, y: 0 }, viewport: { scroll_x: 0, scroll_y: 0 } } };
      ws.send(JSON.stringify({ id: data.id, result }));
    });
    return { id: connected.browser_id, ws };
  }
  function client() { const client = new AttachClient(config); clients.push(client); return client; }
  async function claim(client, browser, tabId = 9) {
    const result = await client.call('list_tabs', { browser_id: browser.id });
    const tab = result.tabs.find(tab => tab.tab_id === tabId);
    return client.call('claim_tab', { browser_id: browser.id, tab_id: tabId, expected_url: tab.url, expected_title: tab.title });
  }
  return { hub, config, extension, client, claim, requests, released, tabs };
}

test('loopback endpoints reject missing auth, website origins and unpaired extensions', async t => {
  const f = await fixture(t), url = `http://127.0.0.1:${f.config.port}`;
  assert.equal((await fetch(`${url}/health`)).status, 403);
  const headers = { Authorization: `Bearer ${f.config.token}`, Origin: 'https://evil.test' };
  assert.equal((await fetch(`${url}/health`, { headers })).status, 403);
  assert.equal((await fetch(`${url}/shutdown`, { method: 'POST', headers })).status, 403);
  for (const [path, settings] of [['extension', { origin: 'https://evil.test' }], ['client', { headers }], ['client', {}],
    ['client', { headers: { Authorization: `Bearer ${f.config.token}`, 'X-Browser-Attach-Version': '0.16.9' } }]]) {
    const ws = new WebSocket(`${url.replace('http:', 'ws:')}/${path}`, settings);
    await assert.rejects(once(ws, 'open'), /403/);
  }
  const ws = new WebSocket(`${url.replace('http:', 'ws:')}/extension`, { origin: `chrome-extension://${f.config.extension_id}` });
  await once(ws, 'open'); const closed = once(ws, 'close');
  ws.send(JSON.stringify({ type: 'hello', token: 'wrong' }));
  assert.equal((await closed)[0], 1008);
});

test('profiles are separate and upload capability is advertised', async t => {
  const f = await fixture(t); const chrome = await f.extension(), edge = await f.extension({ family: 'edge' });
  const result = await f.client().call('list_browsers');
  assert.deepEqual(new Set(result.browsers.map(item => item.browser_id)), new Set([chrome.id, edge.id]));
  assert.ok(result.browsers.every(item => item.capabilities.includes('upload_file')));
  assert.ok(result.browsers.every(item => item.capabilities.includes('logs') && !item.capabilities.includes('console_logs') && !item.capabilities.includes('network_logs')));
});

test('claims require exact latest observation; ownership and release are connection-scoped', async t => {
  const f = await fixture(t), browser = await f.extension(), a = f.client(), b = f.client();
  const args = { browser_id: browser.id, tab_id: 9, expected_url: f.tabs[0].url, expected_title: 'Demo' };
  await assert.rejects(a.call('claim_tab', args), /latest/);
  await a.call('list_tabs', { browser_id: browser.id });
  await assert.rejects(a.call('claim_tab', { ...args, expected_title: 'Changed' }), /exact/);
  const claim = await a.call('claim_tab', args);
  await assert.rejects(f.claim(b, browser), /another MCP/);
  await assert.rejects(b.call('upload_file', { tab_handle: claim.tab_handle, files: [] }), /belongs to another/);
  await f.claim(b, browser, 10);
  await a.call('release_tab', { tab_handle: claim.tab_handle }); await f.claim(b, browser);
});

test('disconnect releases owner; browser restart invalidates old handles', async t => {
  const f = await fixture(t), browser = await f.extension(), a = f.client();
  await f.claim(a, browser); await a.close();
  for (let i = 0; !f.released.size && i < 40; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(f.released.size);
  const b = f.client(), claim = await f.claim(b, browser);
  browser.ws.close(); await once(browser.ws, 'close');
  await f.extension({ run: 'two' });
  await assert.rejects(b.call('snapshot', { tab_handle: claim.tab_handle }), /expired/);
});

test('claim by listed tab_id permits omitted guards and preserves current extension identity', async t => {
  const f = await fixture(t), browser = await f.extension(), client = f.client();
  await assert.rejects(client.call('claim_tab', { browser_id: browser.id, tab_id: 9 }), /latest/);
  await client.call('list_tabs', { browser_id: browser.id });
  const result = await client.call('claim_tab', { browser_id: browser.id, tab_id: 9 });
  assert.ok(result.tab_handle);
  assert.equal(f.requests.find(item => item.command === 'claim_tab').arguments.expected_title, undefined);
});

test('tab lifecycle routes to the selected browser and close expires only the owning handle', async t => {
  const f = await fixture(t), browser = await f.extension(), a = f.client(), b = f.client();
  await assert.rejects(a.call('open_tab', { browser_id: 'absent', url: 'https://example.com/' }), /not connected/);
  const opened = await a.call('open_tab', { browser_id: browser.id, url: 'https://example.com/' });
  assert.equal(opened.opened, true); assert.equal(opened.active, false);
  const claim = await f.claim(a, browser), args = { tab_handle: claim.tab_handle };
  await assert.rejects(b.call('activate_tab', args), /belongs to another/);
  await assert.rejects(b.call('close_tab', args), /belongs to another/);
  await a.call('activate_tab', { ...args, focus_window: true });
  assert.equal(f.requests.find(item => item.command === 'activate_tab').arguments.tab_id, 9);
  await a.call('close_tab', args);
  await assert.rejects(a.call('snapshot', args), /expired/);
  await f.claim(b, browser);
});

test('open with claim uses the created identity without discovery and enforces both ownership layers', async t => {
  const controller = controllerFixture();
  const f = await fixture(t, { execute: (...args) => controller.controller.execute(...args) });
  const browser = await f.extension(), a = f.client(), b = f.client();
  const opened = await a.call('open_tab', { browser_id: browser.id, url: 'https://created.test/', claim: true });
  assert.equal(opened.opened, true); assert.equal(opened.claimed, true);
  assert.ok(opened.tab_handle); assert.equal(opened.activation_requested, false);
  assert.deepEqual(f.requests.map(r => r.command), ['open_tab', 'claim_tab']);
  assert.equal(f.requests[1].arguments.tab_id, opened.tab_id);
  assert.ok(!controller.calls.some(c => ['tabs.update', 'windows.update', 'Page.bringToFront'].includes(c.method)));
  await assert.rejects(b.call('snapshot', { tab_handle: opened.tab_handle }), /belongs to another/);
  await b.call('list_tabs', { browser_id: browser.id });
  await assert.rejects(b.call('claim_tab', { browser_id: browser.id, tab_id: opened.tab_id }), /another MCP/);
  await a.call('release_tab', { tab_handle: opened.tab_handle });
  assert.equal(controller.controller.claimedCount(), 0);
  await assert.rejects(a.call('snapshot', { tab_handle: opened.tab_handle }), /expired/);
  await b.call('claim_tab', { browser_id: browser.id, tab_id: opened.tab_id });
});

test('open claim failure reports a persistent tab and does not pollute discovery or replay creation', async t => {
  const controller = controllerFixture();
  controller.api.debugger.attach = async () => { throw new Error('debugger busy'); };
  const f = await fixture(t, { execute: (...args) => controller.controller.execute(...args) });
  const browser = await f.extension(), client = f.client();
  await client.call('list_tabs', { browser_id: browser.id });
  await assert.rejects(client.call('open_tab', { browser_id: browser.id, url: 'https://created.test/', claim: true }), error => {
    assert.match(error.message, /debugger busy/);
    assert.equal(error.open_tab.opened, true); assert.equal(error.open_tab.claimed, false);
    assert.equal(error.open_tab.phase, 'claim'); assert.equal(error.open_tab.tab_id, 10);
    assert.equal(error.open_tab.browser_id, browser.id); return true;
  });
  assert.ok(controller.tabs.has(10)); assert.equal(f.hub.claims.size, 0);
  assert.equal(f.requests.filter(r => r.command === 'open_tab').length, 1);
  await assert.rejects(client.call('claim_tab', { browser_id: browser.id, tab_id: 10 }), /latest/);
  controller.api.debugger.attach = async () => {};
  const old = await client.call('claim_tab', { browser_id: browser.id, tab_id: 9 });
  assert.ok(old.tab_handle);
});

test('open validates claim before creation and defaults to leaving the tab unclaimed', async t => {
  const f = await fixture(t), browser = await f.extension(), client = f.client();
  await assert.rejects(client.call('open_tab', { browser_id: browser.id, url: 'https://created.test/', claim: 'true' }), /boolean/);
  assert.equal(f.requests.length, 0);
  const opened = await client.call('open_tab', { browser_id: browser.id, url: 'https://created.test/' });
  assert.equal(opened.claimed, false); assert.equal(opened.tab_handle, undefined);
  assert.deepEqual(f.requests.map(r => r.command), ['open_tab']);
});

test('failed claim detach retains ownership and returns a recovery handle through open errors', async t => {
  const controller = controllerFixture(), send = controller.api.debugger.sendCommand, detach = controller.api.debugger.detach;
  controller.api.debugger.sendCommand = async (target, method, args) => {
    if (method === 'Page.getFrameTree') throw new Error('initialization failed');
    return send(target, method, args);
  };
  controller.api.debugger.detach = async () => { throw new Error('detach failed'); };
  const f = await fixture(t, { execute: (...args) => controller.controller.execute(...args) });
  const browser = await f.extension(), client = f.client(), other = f.client();
  let recovery;
  await assert.rejects(client.call('open_tab', { browser_id: browser.id, url: 'https://created.test/', claim: true }), error => {
    recovery = error.open_tab.tab_handle;
    assert.ok(recovery); assert.equal(error.open_tab.control_retained, true);
    assert.match(error.message, /initialization failed.*detach failed/); return true;
  });
  assert.equal(f.hub.claims.size, 1); assert.equal(controller.controller.claimedCount(), 1);
  await other.call('list_tabs', { browser_id: browser.id });
  await assert.rejects(other.call('claim_tab', { browser_id: browser.id, tab_id: 10 }), /another MCP/);
  controller.api.debugger.detach = detach;
  await client.call('release_tab', { tab_handle: recovery });
  assert.equal(f.hub.claims.size, 0); assert.equal(controller.controller.claimedCount(), 0);
});

test('another owner winning between creation and claim causes an explicit conflict without taking over', async t => {
  const controller = controllerFixture();
  let browser, other, winner;
  const f = await fixture(t, { execute: async (...args) => {
    const result = await controller.controller.execute(...args);
    if (args[1] === 'open_tab') {
      await other.call('list_tabs', { browser_id: browser.id });
      winner = await other.call('claim_tab', { browser_id: browser.id, tab_id: result.tab_id });
    }
    return result;
  } });
  browser = await f.extension(); other = f.client();
  await assert.rejects(f.client().call('open_tab', { browser_id: browser.id, url: 'https://created.test/', claim: true }), error => {
    assert.match(error.message, /another MCP/); assert.equal(error.open_tab.tab_id, 10); return true;
  });
  assert.ok(winner.tab_handle); assert.equal(f.hub.claims.size, 1);
  assert.equal(controller.calls.filter(c => c.method === 'attach').length, 1);
  await other.call('release_tab', { tab_handle: winner.tab_handle });
});

test('open claim timeout releases a pending attachment once it settles, without creating twice', async t => {
  const controller = controllerFixture();
  let finish, entered;
  const attaching = new Promise(resolve => { entered = resolve; });
  controller.api.debugger.attach = async () => { entered(); await new Promise(resolve => { finish = resolve; }); };
  const f = await fixture(t, { operationTimeout: 100, execute: (...args) => controller.controller.execute(...args) });
  const browser = await f.extension(), client = f.client();
  const failure = assert.rejects(client.call('open_tab', { browser_id: browser.id, url: 'https://created.test/', claim: true }), error => {
    assert.match(error.message, /outcome may be unknown/);
    assert.equal(error.open_tab.opened, true); assert.equal(error.open_tab.claimed, null);
    assert.equal(error.open_tab.outcome_unknown, true); return true;
  });
  await attaching; await failure;
  finish();
  for (let i = 0; (f.hub.claims.size || controller.controller.claimedCount()) && i < 50; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.hub.claims.size, 0); assert.equal(controller.controller.claimedCount(), 0);
  assert.ok(controller.tabs.has(10));
  assert.equal(controller.calls.filter(c => c.method === 'tabs.create').length, 1);
});

test('a detach notification before the claim reply cannot publish a stale new-tab handle', async t => {
  let browser;
  const f = await fixture(t, { execute: async (owner, method) => {
    if (method === 'open_tab') return { opened: true, tab_id: 11, active: false };
    if (method === 'claim_tab') browser.ws.send(JSON.stringify({ type: 'detached', tab_id: 11 }));
    return { claimed: true };
  } });
  browser = await f.extension();
  await assert.rejects(f.client().call('open_tab', { browser_id: browser.id, url: 'https://created.test/', claim: true }), error => {
    assert.match(error.message, /detached.*during claim/);
    assert.equal(error.open_tab.tab_id, 11); return true;
  });
  assert.equal(f.hub.claims.size, 0);
});

test('unknown outcome disconnects the client and releases its claims without replaying', async t => {
  const f = await fixture(t, { operationTimeout: 80, stall: true });
  const browser = await f.extension(), client = f.client(), claim = await f.claim(client, browser);
  await assert.rejects(client.call('read_text', { tab_handle: claim.tab_handle }), /outcome may be unknown/);
  for (let i = 0; f.hub.claims.size && i < 40; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.hub.claims.size, 0);
  assert.equal(f.requests.filter(item => item.command === 'read_text').length, 1);
});

test('real stdio MCP exposes 24 tools including bounded control reads, ordered batch, unified logs and validated upload', async t => {
  const failCommands = new Set();
  const failure = {};
  const f = await fixture(t, { failCommands, failure }), browser = await f.extension();
  const temp = await mkdtemp(join(tmpdir(), 'attach-mcp-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const path = join(temp, 'config.json'), file = join(temp, '中文 empty.txt');
  await writeJson(path, { ...f.config, extension_dir: join(temp, 'extension') }); await writeFile(file, '');
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(ROOT, 'bin/browser-attach.mjs'), 'mcp', '--config', path], cwd: temp });
  const mcp = new Client({ name: 'test', version: '1' });
  await mcp.connect(transport); t.after(() => mcp.close());
  assert.match(mcp.getInstructions(), /popup options.*selected\/active items use read_control.*page-wide field values\/state use snapshot\(profile=fields\)/);
  const tools = (await mcp.listTools()).tools;
  assert.equal(tools.length, 24);
  const readControlSchema = tools.find(tool => tool.name === 'browser_read_control').inputSchema.properties;
  assert.equal(readControlSchema.timeout_ms.maximum, 5000); assert.equal(readControlSchema.max_options.maximum, 100);
  const batchSchema = tools.find(tool => tool.name === 'browser_batch').inputSchema.properties;
  assert.equal(batchSchema.steps.maxItems, 30); assert.equal(batchSchema.start_at.maximum, 29);
  const waitSchema = tools.find(tool => tool.name === 'browser_wait').inputSchema;
  assert.ok(!waitSchema.required.includes('checks'));
  assert.ok(waitSchema.properties.condition); assert.ok(waitSchema.properties.selector);
  assert.equal(waitSchema.properties.dialog_policy.const, 'ask');
  assert.equal(waitSchema.properties.checks.maxItems, 30);
  assert.ok(waitSchema.properties.checks.items.properties.condition.enum.includes('count'));
  assert.ok(waitSchema.properties.checks.items.properties.condition.enum.includes('value_present'));
  assert.equal(waitSchema.properties.checks.items.properties.not.type, 'boolean');
  assert.ok(tools.find(tool => tool.name === 'browser_press_key').inputSchema.properties.ref);
  assert.ok(!tools.some(tool => ['browser_console_logs', 'browser_network_logs'].includes(tool.name)));
  const logSchema = tools.find(tool => tool.name === 'browser_logs').inputSchema;
  assert.deepEqual(logSchema.properties.kind.enum, ['console', 'network', 'navigation']);
  assert.ok(logSchema.required.includes('kind'));
  assert.equal(logSchema.properties.after_seq.default, 0);
  for (const name of ['click', 'fill']) {
    const mode = tools.find(tool => tool.name === `browser_${name}`).inputSchema.properties.mode;
    assert.deepEqual(mode.enum, ['native', 'dom']); assert.equal(mode.default, 'native');
  }
  const scrollSchema = tools.find(tool => tool.name === 'browser_scroll').inputSchema.properties;
  assert.deepEqual(scrollSchema.mode.enum, ['dom', 'wheel']); assert.equal(scrollSchema.mode.default, 'dom');
  const snapshotSchema = tools.find(tool => tool.name === 'browser_snapshot').inputSchema.properties;
  assert.deepEqual(snapshotSchema.profile.enum, ['full', 'interactive', 'fields']);
  assert.equal(snapshotSchema.include_hidden.type, 'boolean');
  assert.equal(snapshotSchema.text.type, 'boolean'); assert.equal(snapshotSchema.text_limit.maximum, 10000);
  assert.equal(snapshotSchema.query.maxLength, 2000); assert.equal(snapshotSchema.verbose.default, false);
  assert.equal(snapshotSchema.diff_since.type, 'string'); assert.equal(snapshotSchema.diff_since.maxLength, 128);
  for (const name of ['upload_file', 'open_tab', 'discover', 'tab_control', 'evaluate', 'logs']) assert.ok(tools.some(tool => tool.name === `browser_${name}`));
  const discoverSchema = tools.find(tool => tool.name === 'browser_discover').inputSchema;
  const openSchema = tools.find(tool => tool.name === 'browser_open_tab').inputSchema;
  assert.equal(openSchema.properties.claim.type, 'boolean');
  assert.equal(openSchema.properties.claim.default, false);
  assert.deepEqual(discoverSchema.properties.kind.enum, ['browsers', 'tabs']);
  assert.ok(discoverSchema.required.includes('kind'));
  const controlSchema = tools.find(tool => tool.name === 'browser_tab_control').inputSchema;
  assert.deepEqual(controlSchema.properties.action.enum, ['release', 'activate', 'close']);
  assert.ok(controlSchema.required.includes('action') && controlSchema.required.includes('tab_handle'));
  const call = (name, args = {}) => mcp.callTool({ name: `browser_${name}`, arguments: args });
  const fetchSchema = tools.find(tool => tool.name === 'browser_fetch').inputSchema;
  assert.ok(fetchSchema.required.includes('browser_id'));
  assert.ok(!fetchSchema.required.includes('url'));
  assert.deepEqual(fetchSchema.properties.format.enum, ['text', 'html', 'json']);
  assert.deepEqual(fetchSchema.properties.wait_until.enum, ['commit', 'domcontentloaded', 'load', 'network_idle']);
  const beforeFetch = f.requests.length;
  for (const args of [{}, { url: 'file:///a' }, { url: 'https://example.com', max_chars: 0 }, { cursor: 'x', url: 'https://example.com' }, { cursor: 'x', format: 'json' }]) {
    assert.equal((await call('fetch', { browser_id: browser.id, ...args })).isError, true);
  }
  assert.equal(f.requests.length, beforeFetch);
  assert.ok(!(await call('fetch', { browser_id: browser.id, url: 'https://example.com', wait_until: 'network_idle', format: 'json' })).isError);
  assert.equal(f.requests.at(-1).command, 'fetch');
  assert.equal(f.requests.at(-1).arguments.tab_id, undefined);
  assert.ok(!(await call('fetch', { browser_id: browser.id, cursor: 'cached' })).isError);
  assert.equal(f.requests.at(-1).arguments.url, undefined);
  const beforeDiscovery = f.requests.length;
  for (const args of [{}, { kind: 'all' }, { kind: 'tabs' }, { kind: 'tabs', browser_id: '' }, { kind: 'browsers', browser_id: browser.id }]) {
    assert.equal((await call('discover', args)).isError, true);
  }
  assert.equal(f.requests.length, beforeDiscovery);
  const browsers = await call('discover', { kind: 'browsers' });
  assert.equal(browsers.structuredContent, undefined); assert.equal(browsers.content.length, 1);
  assert.equal(JSON.parse(browsers.content[0].text).browsers[0].browser_id, browser.id);
  const claimArgs = { browser_id: browser.id, tab_id: 9 };
  assert.equal((await call('claim_tab', claimArgs)).isError, true);
  const discoveredTabs = await call('discover', { kind: 'tabs', browser_id: browser.id });
  assert.equal(JSON.parse(discoveredTabs.content[0].text).tabs[0].control, 'available');
  assert.deepEqual(f.requests.find(item => item.command === 'list_tabs').arguments, {});
  const result = await call('claim_tab', { browser_id: browser.id, tab_id: 9, expected_title: 'Demo', expected_url: f.tabs[0].url });
  const handle = JSON.parse(result.content[0].text).tab_handle;
  const checks = [{ selector: '.row', condition: 'count', expected: 1 }];
  const beforeWait = f.requests.length;
  for (const args of [{}, { checks: [] }, { checks, selector: '.row' }, { checks, condition: 'attached' },
    { checks, dialog_policy: 'dismiss' }, { checks: [{ ...checks[0], nth: 0 }] },
    { checks: [{ selector: '#field', condition: 'value_present', expected: 'true' }] }]) {
    assert.equal((await call('wait', { tab_handle: handle, ...args, checks: [{  }] })).isError, true);
  }
  assert.equal(f.requests.length, beforeWait);
  const verification = await call('wait', { tab_handle: handle, checks });
  assert.ok(!verification.isError); assert.equal(JSON.parse(verification.content[0].text).status, 'fail');
  assert.deepEqual(f.requests.at(-1).arguments.checks, checks);
  assert.equal(f.requests.at(-1).arguments.idle_ms, undefined);
  const singleVerification = await call('wait', { tab_handle: handle, ...checks[0] });
  assert.ok(!singleVerification.isError); assert.deepEqual(singleVerification, verification);
  assert.equal(f.requests.at(-1).arguments.condition, 'count');
  assert.equal((await call('batch', { tab_handle: handle, steps: [{ action: 'wait', checks }] })).isError, true);
  assert.deepEqual(f.requests.at(-1).arguments.steps[0].checks, checks);
  const beforeSemantic = f.requests.length;
  for (const args of [{ text: 'x' }, { focused: true, ref: 'r', text: 'x' }, { focused: true, frame_id: 'child', text: 'x' }, { selector: 'input', name: 'Name', text: 'x' }]) {
    assert.equal((await call('type', { tab_handle: handle, ...args })).isError, true);
  }
  assert.equal(f.requests.length, beforeSemantic);
  assert.ok(!(await call('type', { tab_handle: handle, focused: true, text: 'x' })).isError);
  assert.equal(f.requests.at(-1).arguments.focused, true);
  for (const [selector_type, selector, name] of [['label', '工作职责'], ['placeholder', 'Name'], ['role', 'textbox', 'Name']]) {
    assert.ok(!(await call('fill', { tab_handle: handle, selector_type, selector, ...(name ? { name } : {}), text: 'value' })).isError);
    assert.equal(f.requests.at(-1).arguments.selector_type, selector_type);
    assert.equal(f.requests.at(-1).arguments.name, name);
  }
  assert.equal((await call('batch', { tab_handle: handle, steps: [{ action: 'type', focused: true, text: 'x' }] })).isError, true);
  assert.equal(f.requests.at(-1).arguments.steps[0].focused, true);
  for (const args of [{ profile: 'bad' }, { text: 'false' }, { text_limit: -1 }, { query: '' }, { verbose: 'true' },
    { diff_since: '' }, { diff_since: ' ' }, { diff_since: 'baseline', cursor: 'page' }, { diff_since: 'baseline', profile: 'fields' }]) {
    assert.equal((await call('snapshot', { tab_handle: handle, ...args })).isError, true);
  }
  await call('snapshot', { tab_handle: handle, profile: 'interactive', text: false, text_limit: 40, query: 'Save', verbose: true });
  const viewRequest = f.requests.findLast(item => item.command === 'snapshot');
  assert.equal(viewRequest.arguments.profile, 'interactive'); assert.equal(viewRequest.arguments.text, false);
  assert.equal(viewRequest.arguments.text_limit, 40);
  assert.equal(viewRequest.arguments.query, 'Save'); assert.equal(viewRequest.arguments.verbose, true);
  await call('snapshot', { tab_handle: handle, diff_since: 'baseline' });
  assert.equal(f.requests.at(-1).arguments.diff_since, 'baseline');
  await call('snapshot', { tab_handle: handle, diff_since: 'latest' });
  assert.equal(f.requests.at(-1).arguments.diff_since, 'latest');
  await call('snapshot', { tab_handle: handle, profile: 'fields', include_hidden: true, query: 'TEXTS28' });
  const fieldRequest = f.requests.findLast(item => item.command === 'snapshot');
  assert.equal(fieldRequest.arguments.profile, 'fields'); assert.equal(fieldRequest.arguments.include_hidden, true);
  assert.equal(fieldRequest.arguments.query, 'TEXTS28');
  await call('read_control', { tab_handle: handle, selector: '#education', popup_selector: '#portal', max_options: 2 });
  assert.equal(f.requests.at(-1).command, 'read_control'); assert.equal(f.requests.at(-1).arguments.popup_selector, '#portal');
  await call('press_key', { tab_handle: handle, selector: '#education', key: 'Enter', observe: { selector: '#education' } });
  assert.equal(f.requests.at(-1).arguments.observe.selector, '#education');
  const beforeObservation = f.requests.length;
  for (const observe of [{}, { selector: '#education', max_options: 0 }, { selector: '#education', timeout_ms: 5001 },
    'auto', { diff_since: '' }, { diff_since: ' ' }, { diff_since: 'latest', selector: '#mixed' },
    { diff_since: 'latest', profile: 'fields' }, { diff_since: 'latest', cursor: 'x' }, { diff_since: 'latest', max_nodes: 0 }]) {
    assert.equal((await call('click', { tab_handle: handle, selector: '#button', observe })).isError, true);
  }
  assert.equal(f.requests.length, beforeObservation);
  await call('click', { tab_handle: handle, selector: '#button', mode: 'dom', observe: { diff_since: 'latest', max_nodes: 100, max_chars: 8000 } });
  assert.equal(f.requests.at(-1).command, 'click');
  assert.equal(f.requests.at(-1).arguments.observe.diff_since, 'latest');
  assert.equal(f.requests.at(-1).arguments.observe.timeout_ms, 5000);
  await call('batch', { tab_handle: handle, steps: [{ action: 'click', selector: '#button' }], observe: { diff_since: 'baseline' } });
  assert.equal(f.requests.at(-1).arguments.observe.diff_since, 'baseline');
  const beforeStepDiff = f.requests.length;
  assert.equal((await call('batch', { tab_handle: handle, steps: [{ action: 'click', selector: '#button', observe: { diff_since: 'latest' } }] })).isError, true);
  assert.equal(f.requests.length, beforeStepDiff);
  const beforeControl = f.requests.length;
  for (const args of [{ tab_handle: handle }, { action: 'all', tab_handle: handle }, { action: 'release' },
    { action: 'release', tab_handle: handle, focus_window: false }, { action: 'close', tab_handle: handle, focus_window: true },
    { action: 'activate', tab_handle: handle, focus_window: 'true' }]) {
    assert.equal((await call('tab_control', args)).isError, true);
  }
  assert.equal(f.requests.length, beforeControl);
  const other = f.client(), foreign = await f.claim(other, browser, 10);
  const beforeForeign = f.requests.length;
  for (const action of ['release', 'activate', 'close']) {
    const rejected = await call('tab_control', { action, tab_handle: foreign.tab_handle });
    assert.equal(rejected.isError, true);
    assert.match(rejected.content[0].text, /belongs to another/);
  }
  assert.equal(f.requests.length, beforeForeign);
  for (const nth of [-1, 0.5]) assert.equal((await call('fill', { tab_handle: handle, selector: 'input', nth, text: 'x' })).isError, true);
  assert.equal((await call('fill', { tab_handle: handle, ref: 'a', nth: 1, text: 'x' })).isError, true);
  const batch = await call('batch', { tab_handle: handle, steps: [{ action: 'fill', selector: 'input', nth: 1, text: 'x' }, { action: 'press_key', key: 'Tab' }] });
  assert.equal(batch.isError, true); assert.equal(JSON.parse(batch.content[0].text).failed_step, 1);
  const batchCount = f.requests.filter(r => r.command === 'batch').length;
  for (const steps of [[], [{ action: 'fill', ref: 'old', text: 'x' }], [{ action: 'evaluate', expression: '1' }], Array(31).fill({ action: 'press_key', key: 'Tab' })]) {
    assert.equal((await call('batch', { tab_handle: handle, steps })).isError, true);
  }
  assert.equal(f.requests.filter(r => r.command === 'batch').length, batchCount);
  for (const [name, query] of [['evaluate', { expression: 'document.title' }], ['logs', { kind: 'console' }], ['logs', { kind: 'network' }], ['logs', { kind: 'navigation' }]]) {
    const args = { tab_handle: handle, ...query };
    assert.ok(!(await call(name, args)).isError);
    assert.ok(f.requests.some(item => item.command === name));
    assert.equal((await call(name, { ...args, tab_handle: 'expired' })).isError, true);
  }
  const logCount = f.requests.filter(item => item.command === 'logs').length;
  for (const query of [{}, { kind: 'all' }, { kind: 'console', url_contains: '/api' }, { kind: 'network', level: 'error' },
    { kind: 'navigation', level: 'error' }, { kind: 'navigation', url_contains: '/api' }, { kind: 'navigation', capture: { enabled: false } }]) {
    const invalid = await call('logs', { tab_handle: handle, ...query });
    assert.equal(invalid.isError, true);
  }
  assert.equal(f.requests.filter(item => item.command === 'logs').length, logCount);
  for (const name of ['console_logs', 'network_logs']) await assert.rejects(f.client().call(name, { tab_handle: handle }), /Unknown browser operation/);
  const evaluationCount = f.requests.filter(item => item.command === 'evaluate').length;
  assert.equal((await call('evaluate', { tab_handle: handle, expression: '42', timeout_ms: 60000 })).isError, true);
  for (const max_chars of [0, 100001]) {
    const invalid = await call('evaluate', { tab_handle: handle, expression: '42', max_chars });
    assert.equal(invalid.isError, true); assert.match(invalid.content[0].text, /1\.\.100000/);
  }
  assert.equal(f.requests.filter(item => item.command === 'evaluate').length, evaluationCount);
  assert.ok(!(await call('click', { tab_handle: handle, ref: 'current-ref', mode: 'dom' })).isError);
  assert.equal(f.requests.find(item => item.command === 'click').arguments.mode, 'dom');
  for (const [name, input] of [['hover', {selector:'#menu'}], ['drag', {source:{selector:'#source'},destination:{x:10,y:10}}], ['wait', {checks:[{condition:'visible',selector:'#late'}]}], ['select_option', {selector:'select',label:'Beta'}]]) {
    assert.ok(!(await call(name, {tab_handle:handle,...input})).isError);
    assert.ok(f.requests.some(item => item.command === name));
  }
  for (const [name, input] of [['hover', {}], ['drag', {source:{selector:'#source'},destination:{}}], ['wait', {checks:[{condition:'text',selector:'#late'}]}], ['select_option', {selector:'select',label:'Beta',value:'b'}]]) {
    const before=f.requests.length;
    assert.equal((await call(name, {tab_handle:handle,...input})).isError,true);
    assert.equal(f.requests.length,before);
  }
  for (const input of [
    { selector: '#field', condition: 'value', expected: '' },
    { selector: '#field', condition: 'checked', expected: false },
    { selector: '#field', condition: 'checked', expected: 'mixed' },
    { selector: '#field', condition: 'selected', expected: true },
    { selector: '#field', condition: 'expanded', expected: false },
    { selector: '#field', condition: 'absent' },
  ]) {
    assert.ok(!(await call('wait', { tab_handle: handle, checks: [{ ...input }] })).isError);
    assert.equal(f.requests.at(-1).arguments.checks[0].expected, input.expected);
    await call('batch', { tab_handle: handle, steps: [{ action: 'wait', checks: [{ ...input }] }] });
    assert.equal(f.requests.at(-1).arguments.steps[0].checks[0].condition, input.condition);
    assert.equal(f.requests.at(-1).arguments.steps[0].checks[0].expected, input.expected);
  }
  for (const input of [{ condition: 'checked', expected: 'false' }, { condition: 'value', expected: false }, { condition: 'expanded', expected: 'mixed' }]) {
    const before = f.requests.length;
    assert.equal((await call('wait', { tab_handle: handle, checks: [{ selector: '#field', ...input }] })).isError, true);
    assert.equal((await call('batch', { tab_handle: handle, steps: [{ action: 'wait', checks: [{ selector: '#field', ...input }] }] })).isError, true);
    assert.equal(f.requests.length, before);
  }
  for (const [name, input] of [['type',{selector:'#input',text:'typed',delay_ms:20}],['navigate',{direction:'back'}],['fill',{selector:'input',frame:{path:['iframe[title="Inner"]']},text:'scoped'}],['logs',{kind:'network',capture:{enabled:true,max_body_bytes:4096}}]]) {
    assert.ok(!(await call(name,{tab_handle:handle,...input})).isError);
    assert.ok(f.requests.some(r=>r.command===name));
  }
  for (const expected_value of ['6', '']) {
    await call('fill', { tab_handle: handle, selector: '#month', text: '06', expected_value });
    assert.equal(f.requests.at(-1).arguments.expected_value, expected_value);
    await call('batch', { tab_handle: handle, steps: [{ action: 'fill', selector: '#month', text: '06', expected_value }] });
    assert.equal(f.requests.at(-1).arguments.steps[0].expected_value, expected_value);
  }
  for(const input of [{text:'bad\nline',selector:'input'},{text:'x',selector:'input',delay_ms:-1}])assert.equal((await call('type',{tab_handle:handle,...input})).isError,true);
  for (const [name, input] of [
    ['click', { selector: '#go', offset: { x_ratio: .25, y_ratio: .75 }, settle_ms: [80, 250] }],
    ['hover', { selector: '#menu', offset: { x_ratio: .75, y_ratio: .5 } }],
    ['type', { selector: '#edit', text: 'abc', delay_ms: [40, 180] }],
    ['drag', { source: { selector: '#a', offset: { x_ratio: .25, y_ratio: .5 } }, destination: { x: 200, y: 200 }, trajectory: { curve_px: 12, duration_ms: 600 }, steps: 30, settle_ms: 120 }],
    ['batch', { steps: [{ action: 'click', selector: '#go', offset: { x_ratio: .25, y_ratio: .5 }, settle_ms: [80, 250] }, { action: 'type', selector: '#edit', text: 'abc', delay_ms: [40, 180] }] }],
  ]) {
    const before = f.requests.length;
    const result = await call(name, { tab_handle: handle, ...input });
    if (name !== 'batch') assert.ok(!result.isError);
    assert.equal(f.requests.length, before + 1);
    const forwarded = f.requests.at(-1).arguments;
    if (name === 'batch') {
      assert.deepEqual(forwarded.steps[0].offset, input.steps[0].offset);
      assert.deepEqual(forwarded.steps[0].settle_ms, input.steps[0].settle_ms);
      assert.deepEqual(forwarded.steps[1].delay_ms, input.steps[1].delay_ms);
    } else {
      for (const [key, value] of Object.entries(input)) {
        if (key === 'source') assert.deepEqual(forwarded.source.offset, value.offset);
        else assert.deepEqual(forwarded[key], value);
      }
    }
  }
  for (const [name, input] of [
    ['click', { x: 10, y: 10, offset: { x_ratio: .5, y_ratio: .5 } }],
    ['click', { selector: '#go', mode: 'dom', settle_ms: 10 }],
    ['hover', { selector: '#menu', offset: { x_ratio: -1, y_ratio: .5 } }],
    ['type', { selector: '#edit', text: 'x', delay_ms: [180, 40] }],
    ['drag', { source: { selector: '#a' }, destination: { x: 20, y: 20 }, trajectory: { curve_px: 5, duration_ms: 99 } }],
    ['batch', { steps: [{ action: 'type', selector: '#edit', text: 'x', delay_ms: [180, 40] }] }],
  ]) {
    const before = f.requests.length;
    assert.equal((await call(name, { tab_handle: handle, ...input })).isError, true);
    assert.equal(f.requests.length, before);
  }
  const clickCount = f.requests.filter(item => item.command === 'click').length;
  assert.equal((await call('click', { tab_handle: handle, x: 1, y: 1, mode: 'dom' })).isError, true);
  assert.equal(f.requests.filter(item => item.command === 'click').length, clickCount);
  await call('scroll',{tab_handle:handle,delta_y:120});
  await call('scroll',{tab_handle:handle,mode:'wheel',delta_y:120,timeout_ms:700});
  const scrolls = f.requests.filter(item => item.command === 'scroll');
  assert.equal(scrolls[0].arguments.mode,'dom'); assert.equal(scrolls[1].arguments.mode,'wheel');
  assert.equal(scrolls[1].arguments.timeout_ms,700);
  assert.equal((await call('scroll',{tab_handle:handle,mode:'invalid',delta_y:1})).isError,true);
  const image = await call('screenshot', { tab_handle: handle });
  assert.equal(image.content[1].mimeType, 'image/png');
  assert.equal(JSON.parse(image.content[0].text).capture.image_to_viewport_css.scale_x, 1);
  assert.ok(!image.content[0].text.includes(PNG));
  assert.ok(!(await call('upload_file', { tab_handle: handle, files: [file] })).isError);
  const count = f.requests.filter(item => item.command === 'upload_file').length;
  assert.equal((await call('upload_file', { tab_handle: handle, files: [join(temp, 'missing')] })).isError, true);
  assert.equal(f.requests.filter(item => item.command === 'upload_file').length, count);
  const error = await call('read_text', { tab_handle: 'expired' });
  assert.equal(error.isError, true);
  assert.match(JSON.parse(error.content[0].text).error, /^Tab handle/);
  Object.assign(failure, { input_dispatched: true, post_action: { delivery: 'unknown', navigation_observed: true, current_url: 'https://example.com/after' }, diagnostics: { reason: 'obstructed' } });
  failCommands.add('click');
  const uncertain = await call('click', { tab_handle: handle, selector: '#submit' });
  assert.equal(uncertain.isError, true);
  assert.deepEqual(JSON.parse(uncertain.content[0].text), { error: 'click failed', ...failure });
  failCommands.delete('click');
  assert.ok(!(await call('open_tab', { browser_id: browser.id, url: 'https://example.com/' })).isError);
  assert.equal(f.requests.find(item => item.command === 'open_tab').arguments.active, false);
  const openedClaim = await call('open_tab', { browser_id: browser.id, url: 'https://example.com/', claim: true });
  assert.ok(!openedClaim.isError);
  const openedHandle = JSON.parse(openedClaim.content[0].text).tab_handle;
  assert.ok(openedHandle);
  await call('tab_control', { action: 'release', tab_handle: openedHandle });
  failCommands.add('claim_tab');
  const openFailure = await call('open_tab', { browser_id: browser.id, url: 'https://example.com/', claim: true });
  assert.equal(openFailure.isError, true);
  assert.equal(JSON.parse(openFailure.content[0].text).open_tab.tab_id, 11);
  failCommands.delete('claim_tab');
  assert.ok(!(await call('tab_control', { action: 'activate', tab_handle: handle })).isError);
  assert.deepEqual(f.requests.find(item => item.command === 'activate_tab').arguments, { tab_handle: handle, focus_window: true, tab_id: 9 });
  assert.ok(!(await call('tab_control', { action: 'activate', tab_handle: handle, focus_window: false })).isError);
  assert.equal(f.requests.filter(item => item.command === 'activate_tab').at(-1).arguments.focus_window, false);
  failCommands.add('release_tab');
  assert.equal((await call('tab_control', { action: 'release', tab_handle: handle })).isError, true);
  assert.ok(!(await call('snapshot', { tab_handle: handle })).isError);
  await assert.rejects(other.call('claim_tab', claimArgs), /another MCP/);
  failCommands.delete('release_tab');
  assert.ok(!(await call('tab_control', { action: 'release', tab_handle: handle })).isError);
  assert.deepEqual(f.requests.filter(item => item.command === 'release_tab').at(-1).arguments, { tab_handle: handle, tab_id: 9 });
  assert.equal((await call('snapshot', { tab_handle: handle })).isError, true);
  const reclaimed = await call('claim_tab', claimArgs);
  assert.ok(!reclaimed.isError);
  const nextHandle = JSON.parse(reclaimed.content[0].text).tab_handle;
  assert.notEqual(nextHandle, handle);
  failCommands.add('close_tab');
  assert.equal((await call('tab_control', { action: 'close', tab_handle: nextHandle })).isError, true);
  assert.ok(!(await call('snapshot', { tab_handle: nextHandle })).isError);
  failCommands.delete('close_tab');
  assert.ok(!(await call('tab_control', { action: 'close', tab_handle: nextHandle })).isError);
  assert.deepEqual(f.requests.filter(item => item.command === 'close_tab').at(-1).arguments, { tab_handle: nextHandle, tab_id: 9 });
  assert.equal((await call('snapshot', { tab_handle: nextHandle })).isError, true);
  await mcp.close();
});

test('upload rejects directories, relative and missing files; handles empty files and Unicode paths', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'attach-files-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const file = join(temp, '中文 empty.txt'); await writeFile(file, '');
  assert.deepEqual(await validateFiles([file]), [file]); assert.deepEqual(await validateFiles([]), []);
  await assert.rejects(validateFiles(['relative.txt']), /absolute/);
  await assert.rejects(validateFiles([temp]), /regular file/);
  await assert.rejects(validateFiles([join(temp, 'missing')]), /ENOENT/);
});

test('setup preserves pairing and the Hub installs the stable extension while holding its port', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'attach-setup-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const configPath = join(temp, 'config.json');
  const a = await setup({ configPath }), b = await setup({ configPath });
  assert.equal(a.config.token, b.config.token);
  assert.equal(a.config.extension_id.length, 32);
  assert.equal(a.extensionDir, join(temp, 'extension'));
  const hub = await startHub(a.config, { port: 0 });
  t.after(() => hub.close());
  assert.ok((await readFile(join(a.extensionDir, 'config.generated.js'), 'utf8')).includes(a.config.token));
  assert.equal(JSON.parse(await readFile(join(a.extensionDir, 'manifest.json'), 'utf8')).version, VERSION);
});
