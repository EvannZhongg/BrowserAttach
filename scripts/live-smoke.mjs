// Real extension -> Hub -> stdio MCP integration on disposable local pages only.
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { setup } from '../src/setup.mjs';
import { ROOT, DEFAULT_CONFIG, VERSION, loadConfig } from '../src/config.mjs';
import { startHub } from '../src/hub.mjs';
import { AttachClient } from '../src/client.mjs';

const { values } = parseArgs({ options: { executable: { type: 'string' }, family: { type: 'string', default: 'chromium' }, connected: { type: 'boolean', default: false }, files: { type: 'boolean', default: false } } });
if (!values.executable) throw new Error('Pass --executable PATH to a Chromium/Edge browser that permits --load-extension');
if (values.files && values.connected) throw new Error('--files requires a disposable browser profile');
const temp = await mkdtemp(join(tmpdir(), 'attach-live-'));
const checks = [], calls = [];
let browser, hub, cdp, mcp, command;
const html = `<!doctype html><meta charset="utf-8"><title>Attach upload fixture</title>
<label>Single<input id="single" type="file"></label>
<label>Multiple<input id="multiple" type="file" multiple></label>
<input id="hidden" type="file" multiple hidden>
<button onclick="document.querySelector('#hidden').click()">Choose file</button>
<label>Disabled<input type="file" disabled></label>
<label>Directory<input type="file" webkitdirectory></label>
<input id="shadow-upload" type="file" hidden>
<button onclick="document.querySelector('#shadow-upload').showPicker()">Show picker</button>
<label>Name<input id="name"></label><button onclick="window.count++; sync()">Increment</button>
<button onclick="confirm('Fixture dialog');sync()">Confirm</button>
<pre id="state"></pre><script>
console.log('attach-before-claim');
window.count=0;const data={files:{},events:[],errors:[]};
function sync(){document.querySelector('#state').textContent='STATE:'+JSON.stringify({...data,count:window.count,name:document.querySelector('#name').value});}
window.onerror=message=>{data.errors.push(String(message));sync()};
window.onunhandledrejection=event=>{data.errors.push(String(event.reason));sync()};
for(const input of document.querySelectorAll('input[type=file]')){
 input.addEventListener('input',()=>{data.events.push(input.id+':input');sync()});
 input.addEventListener('change',async()=>{data.events.push(input.id+':change');
 data.files[input.id]=await Promise.all([...input.files].map(async file=>({name:file.name,size:file.size,text:await file.text()})));sync()});
}
document.querySelector('#name').oninput=sync;sync();</script>`;
let fetchVisits = 0, crawled = 0;
const fixture = http.createServer((request, response) => {
  const port = fixture.address().port;
  if (request.url === '/editor-tt') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "require-trusted-types-for 'script'" });
    response.end('<!doctype html><title>Trusted Types editor</title><div id="editor" role="textbox" aria-label="Editor" contenteditable="true" style="white-space:normal;min-height:30px">Old<div><span>paragraph</span></div></div><input id="other">'); return;
  }
  if (request.url === '/fetch/hang') return;
  if (request.url === '/fetch/events') { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write('data: connected\n\n'); return; }
  if (request.url === '/fetch/stall') { response.setHeader('Content-Type', 'text/html'); response.end('<title>Incomplete load</title><h1>Readable before load</h1><img src="/fetch/hang">'); return; }
  if (request.url === '/fetch/replace') { response.setHeader('Content-Type', 'text/html'); response.end('<title>Redirecting</title><h1>First document</h1><img src="/fetch/hang"><script>setTimeout(()=>location.replace("/fetch/final"),100)</script>'); return; }
  if (request.url === '/fetch/final') { response.setHeader('Content-Type', 'text/html'); response.end('<title>Final SPA document</title><h1>Final SPA content</h1>'); return; }
  if (request.url === '/fetch/sse') { response.setHeader('Content-Type', 'text/html'); response.end('<title>Streaming app</title><h1>Readable with a stream</h1><script>new EventSource("/fetch/events")</script>'); return; }
  if (request.url.startsWith('/fetch/empty/')) { response.writeHead(Number(request.url.split('/').at(-1)), { 'Content-Type': 'text/html', 'Content-Length': '0' }); response.end(); return; }
  if (request.url === '/fetch/error/404' || request.url === '/fetch/error/500') {
    const status = Number(request.url.split('/').at(-1));
    response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<title>HTTP error fixture</title><h1>Error ' + status + '</h1><p>' + 'error message '.repeat(80) + '</p>'); return;
  }
  if (request.url === '/fetch/softwall') { response.setHeader('Content-Type', 'text/html'); response.end('<title>Sign in</title><h1>Login required to view this document</h1>'); return; }
  if (request.url === '/fetch/status-frame') { response.setHeader('Content-Type', 'text/html'); response.end('<title>Main document</title><h1>Main frame</h1><iframe src="/fetch/error/404"></iframe>'); return; }
  if (request.url === '/fetch/large-json' || request.url === '/fetch/oversized-json') {
    response.setHeader('Content-Type', 'application/json; charset=utf-8'); response.end(JSON.stringify({ text: 'a'.repeat(request.url === '/fetch/large-json' ? 900000 : 1000020) })); return;
  }
  if (request.url === '/fetch/redirect') { response.writeHead(302, { Location: '/fetch/page', 'Set-Cookie': 'fetch_session=local; HttpOnly; Path=/' }); response.end(); return; }
  if (request.url === '/fetch/page') {
    fetchVisits++; response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<title>Fetch fixture</title><h1>Read once</h1><span hidden>SECRET_HIDDEN</span><a href="/fetch/link">Link</a><p>${request.headers.cookie?.includes('fetch_session=local') ? 'SIGNED_IN' : 'SIGNED_OUT'}</p><script>const injected=document.createElement('script');injected.dataset.fixtureInjected='true';injected.textContent='/* rendered insertion */';document.head.append(injected);fetch('/fetch/data').then(r=>r.text()).then(text=>{const p=document.createElement('p');p.textContent=text;document.body.append(p)})</script>`); return;
  }
  if (request.url === '/fetch/data') { setTimeout(() => response.end('LATE_CONTENT'), 150); return; }
  if (request.url === '/fetch/link') { crawled++; response.end('not requested'); return; }
  if (request.url === '/fetch/json') { response.setHeader('Content-Type', 'application/json'); response.end('{"ok":true,"text":"你好😀"}'); return; }
  if (request.url === '/fetch/invalid') { response.setHeader('Content-Type', 'application/json'); response.end('{invalid'); return; }
  if (request.url === '/fetch/large') { response.setHeader('Content-Type', 'text/html'); response.end('<pre>' + 'a'.repeat(1000020) + '</pre>'); return; }
  if (request.url === '/fetch/slow') return;
  if (request.url === '/frames') {
    response.setHeader('Content-Type', 'text/html');
    response.end(`<title>Frame fixture</title><button>Main frame button</button><iframe style="margin:60px;width:650px;height:500px" src="http://localhost:${port}/frame"></iframe><script>window.frameState={};addEventListener('message',event=>{window.frameState[event.data.id]=event.data})</script>`); return;
  }
  if (request.url?.startsWith('/frame') || request.url === '/nested') {
    const nested = request.url === '/nested';
    response.setHeader('Content-Type', 'text/html');
    response.end(`<title>Child fixture</title><button id="go">${nested ? 'Nested' : 'Child'} button</button><input aria-label="Child name" id="name"><input id="file" type="file" hidden><button onclick="file.click()">Child upload</button><pre id="state"></pre>
      ${nested ? '' : `<iframe style="margin:20px;width:400px;height:180px" src="http://127.0.0.1:${port}/nested"></iframe>`}
      <script>const data={id:${JSON.stringify(nested ? 'nested' : 'child')},clicks:0,doubles:0,middle:0,right:0,control:0,keys:0,wheels:0,wheelTrusted:false,text:'',files:[]};
      function publish(){state.textContent=JSON.stringify(data);top.postMessage(data,'*')}
      go.onclick=e=>{data.clicks++;if(e.ctrlKey)data.control++;console.log(data.id+' click');fetch('/api/ok');publish()};
      go.ondblclick=e=>{data.doubles++;publish()};go.onmousedown=e=>{if(e.button===1)e.preventDefault()};go.onauxclick=e=>{if(e.button===1){data.middle++;publish()}};
      go.oncontextmenu=e=>{e.preventDefault();data.right++;publish()};
      document.querySelector('#name').oninput=()=>{data.text=document.querySelector('#name').value;publish()};
      addEventListener('keydown',()=>{data.keys++;publish()});
      addEventListener('wheel',e=>{e.preventDefault();data.wheels++;data.wheelTrusted=e.isTrusted;publish()},{passive:false});
      file.onchange=()=>{data.files=[...file.files].map(f=>f.name);publish()};publish();</script>`); return;
  }
  if (request.url === '/api/redirect') { response.writeHead(302, { Location: '/api/ok' }); response.end(); return; }
  if (request.url === '/api/failed') { request.socket.destroy(); return; }
  if (request.url === '/api/ok') { response.setHeader('Content-Type', 'application/json'); response.end('{"ok":true}'); return; }
  if (request.url === '/api/missing') { response.writeHead(404); response.end('missing'); return; }
  response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(html);
});
const fixtureSockets = new Set();
fixture.on('connection', socket => { fixtureSockets.add(socket); socket.on('close', () => fixtureSockets.delete(socket)); });
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${fixture.address().port}/`;
async function until(fn, description, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`Timed out waiting for ${description}`);
}
try {
  let configPath = DEFAULT_CONFIG;
  if (values.connected) {
    // Open only our local fixture in an already-paired user's browser profile.
    const launcher = spawn(values.executable, [url], { windowsHide: true, stdio: 'ignore' });
    launcher.on('error', error => console.error(error.message));
    launcher.unref();
  } else {
  // Allocate an isolated Hub port; the user's configured Hub is untouched.
  const reserve = http.createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  configPath = join(temp, 'config.json');
  const pairing = await setup({ configPath, port }); hub = await startHub(pairing.config);
  const profile = join(temp, 'profile'); await mkdir(profile);
  browser = spawn(values.executable, [
    `--user-data-dir=${profile}`, `--disable-extensions-except=${pairing.extensionDir}`, `--load-extension=${pairing.extensionDir}`,
    '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', '--headless=new',
    '--enable-unsafe-extension-debugging', '--site-per-process', 'about:blank',
  ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  browser.on('error', error => { console.error(error.message); });
  let stderr = ''; browser.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-6000); });
  const active = await until(async () => {
    try { return (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/); } catch { return null; }
  }, 'test browser debugging endpoint');
  cdp = new WebSocket(`ws://127.0.0.1:${active[0]}${active[1]}`); await once(cdp, 'open');
  let id = 0; const pending = new Map();
  cdp.on('message', raw => { const data = JSON.parse(raw.toString()); const item = pending.get(data.id); if (item) { pending.delete(data.id); data.error ? item.reject(new Error(data.error.message)) : item.resolve(data.result); } });
  command = (method, params, sessionId) => new Promise((resolve, reject) => { const requestId = ++id; pending.set(requestId, { resolve, reject }); cdp.send(JSON.stringify({ id: requestId, method, params, sessionId })); });
  await command('Target.createTarget', { url });
  }
  mcp = new Client({ name: 'live-test', version: '1' });
  await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [join(ROOT, 'bin/browser-attach.mjs'), 'mcp', '--config', configPath], cwd: temp }));
  const tools = (await mcp.listTools()).tools;
  assert.equal(tools.length, 23);
  assert.ok(tools.some(tool => tool.name === 'browser_logs'));
  assert.ok(!tools.some(tool => ['browser_console_logs', 'browser_network_logs'].includes(tool.name)));
  const rawCall = async (method, args = {}) => {
    if (process.env.ATTACH_TEST_VERBOSE) console.error(method, args.ref || '');
    const result = await mcp.callTool({ name: `browser_${method}`, arguments: args });
    calls.push({ method, isError: !!result.isError }); return result;
  };
  const call = async (method, args) => { const result = await rawCall(method, args); if (result.isError) throw new Error(result.content[0].text); return JSON.parse(result.content[0].text); };
  const browsers = await until(async () => {
    const list = (await call('discover', { kind: 'browsers' })).browsers.filter(browser => !values.connected || browser.family === values.family);
    return list.length && list;
  }, 'extension connection');
  assert.ok(browsers[0].capabilities.includes('upload_file'));
  const browserId = browsers[0].browser_id;
  if (values.files) {
    await checkFiles({ browserId, call, rawCall, configPath });
  } else {
  const fetchArgs = { browser_id: browserId };
  const activeBefore = (await call('discover', { kind: 'tabs', browser_id: browserId })).tabs.filter(t => t.active).map(t => t.tab_id);
  let fetched = await call('fetch', { ...fetchArgs, url: url + 'fetch/redirect', wait_until: 'network_idle', max_chars: 5 });
  assert.equal(fetched.url, url + 'fetch/page'); assert.equal(fetched.title, 'Fetch fixture'); assert.equal(fetched.contentType, 'text/html');
  assert.equal(fetched.status, 200); assert.equal(fetched.ok, true);
  let fetchedText = fetched.body;
  while (fetched.next_cursor) { fetched = await call('fetch', { ...fetchArgs, cursor: fetched.next_cursor, max_chars: 9 }); fetchedText += fetched.body; }
  assert.match(fetchedText, /Read once/); assert.match(fetchedText, /SIGNED_IN/); assert.match(fetchedText, /LATE_CONTENT/);
  assert.doesNotMatch(fetchedText, /SECRET_HIDDEN/); assert.equal(fetchVisits, 1); assert.equal(crawled, 0);
  const fetchedHtml = await call('fetch', { ...fetchArgs, url: url + 'fetch/page', format: 'html' });
  assert.match(fetchedHtml.body, /<h1>Read once<\/h1>/); assert.match(fetchedHtml.body, /SECRET_HIDDEN/);
  assert.equal(fetchedHtml.dom, 'rendered'); assert.match(fetchedHtml.body, /data-fixture-injected="true"/);
  const jsonPage = await call('fetch', { ...fetchArgs, url: url + 'fetch/json', format: 'json', max_chars: 4 });
  assert.equal(jsonPage.contentType, 'application/json'); assert.equal(jsonPage.status, 200); assert.equal(jsonPage.ok, true);
  assert.deepEqual(JSON.parse(jsonPage.body), { ok: true, text: '你好😀' });
  assert.equal(jsonPage.next_cursor, null); assert.equal(jsonPage.truncated, false); assert.equal(Object.hasOwn(jsonPage, 'title'), false);
  const wholeJson = await call('fetch', { ...fetchArgs, url: url + 'fetch/large-json', format: 'json', max_chars: 400 });
  assert.equal(JSON.parse(wholeJson.body).text.length, 900000); assert.equal(wholeJson.next_cursor, null);
  assert.equal((await rawCall('fetch', { ...fetchArgs, url: url + 'fetch/oversized-json', format: 'json' })).isError, true);
  for (const status of [404, 500]) {
    const errorPage = await call('fetch', { ...fetchArgs, url: url + 'fetch/error/' + status });
    assert.equal(errorPage.status, status); assert.equal(errorPage.ok, false); assert.match(errorPage.body, new RegExp('Error ' + status));
  }
  const wall = await call('fetch', { ...fetchArgs, url: url + 'fetch/softwall' });
  assert.equal(wall.status, 200); assert.equal(wall.ok, true); assert.match(wall.body, /Login required/);
  const mainWithErrorFrame = await call('fetch', { ...fetchArgs, url: url + 'fetch/status-frame' });
  assert.equal(mainWithErrorFrame.status, 200); assert.equal(mainWithErrorFrame.ok, true);
  for (const wait_until of ['commit', 'domcontentloaded', 'load']) {
    const started = Date.now();
    const readable = await call('fetch', { ...fetchArgs, url: url + 'fetch/stall', wait_until, timeout_ms: 1200 });
    assert.equal(readable.status, 200); assert.match(readable.body, /Readable before load/);
    assert.equal(readable.wait_until, wait_until); assert.equal(readable.wait_satisfied, wait_until !== 'load');
    assert.equal(readable.degraded, wait_until === 'load'); assert.equal(readable.document_changed, false);
    assert.ok(['loading', 'interactive', 'complete'].includes(readable.ready_state)); assert.ok(Date.now() - started < 1500);
  }
  const redirectedClient = await call('fetch', { ...fetchArgs, url: url + 'fetch/replace', timeout_ms: 4000 });
  assert.equal(redirectedClient.url, url + 'fetch/final'); assert.equal(redirectedClient.status, 200);
  assert.match(redirectedClient.body, /Final SPA content/); assert.equal(redirectedClient.document_changed, true);
  assert.equal(redirectedClient.wait_satisfied, true); assert.equal(redirectedClient.degraded, false);
  const streaming = await call('fetch', { ...fetchArgs, url: url + 'fetch/sse', wait_until: 'network_idle', timeout_ms: 1200 });
  assert.equal(streaming.status, 200); assert.match(streaming.body, /Readable with a stream/);
  assert.equal(streaming.degraded, true); assert.equal(streaming.degraded_reason, 'wait_timeout');
  for (const status of [418, 500, 503]) {
    const empty = await call('fetch', { ...fetchArgs, url: url + 'fetch/empty/' + status, timeout_ms: 1200 });
    assert.equal(empty.status, status); assert.equal(empty.ok, false); assert.equal(empty.body, '');
    assert.equal(empty.body_source, 'http_response'); assert.equal(empty.ready_state, null);
    assert.equal(empty.degraded_reason, 'http_error_response'); assert.equal(empty.body_unavailable, undefined);
  }
  const retained = [];
  for (const path of ['page', 'status-frame', 'softwall', 'error/404']) retained.push(await call('fetch', { ...fetchArgs, url: url + 'fetch/' + path, max_chars: 5 }));
  retained[0] = await call('fetch', { ...fetchArgs, cursor: retained[0].next_cursor, max_chars: 5 });
  retained.push(await call('fetch', { ...fetchArgs, url: url + 'fetch/error/500', max_chars: 5 }));
  const evicted = await rawCall('fetch', { ...fetchArgs, cursor: retained[1].next_cursor });
  assert.equal(evicted.isError, true); assert.match(evicted.content[0].text, /evicted/);
  for (const index of [0, 2, 3, 4]) assert.equal((await call('fetch', { ...fetchArgs, cursor: retained[index].next_cursor })).next_cursor, null);
  const invalidJson = await rawCall('fetch', { ...fetchArgs, url: url + 'fetch/invalid', format: 'json' });
  assert.equal(invalidJson.isError, true);
  const slow = await rawCall('fetch', { ...fetchArgs, url: url + 'fetch/slow', timeout_ms: 250 }); assert.equal(slow.isError, true);
  let large = await call('fetch', { ...fetchArgs, url: url + 'fetch/large', max_chars: 100000 });
  assert.equal(large.capture_truncated, true); let capturedChars = large.body.length;
  while (large.next_cursor) { large = await call('fetch', { ...fetchArgs, cursor: large.next_cursor, max_chars: 100000 }); capturedChars += large.body.length; }
  assert.equal(capturedChars, 1000000); assert.equal(large.truncated, true);
  const afterFetch = (await call('discover', { kind: 'tabs', browser_id: browserId })).tabs;
  assert.deepEqual(afterFetch.filter(t => t.active).map(t => t.tab_id), activeBefore);
  assert.ok(!afterFetch.some(t => t.url.startsWith(url + 'fetch/')));
  checks.push('fetch commit/DOMContentLoaded, stalled-load and persistent-stream degraded captures within deadline, client-side document replacement, empty 418/500/503 HTTP responses');
  checks.push('fetch background cleanup/no activation, redirect/login cookie, network idle, no crawling, rendered DOM marker/insertion, whole JSON/budget override/capture cap, 404/500/main-frame status, HTTP 200 soft wall, four interleaved captures/LRU eviction, omitted empty title, malformed JSON and timeout');
  const tab = await until(async () => (await call('discover', { kind: 'tabs', browser_id: browserId })).tabs.find(tab => tab.url === url && tab.title === 'Attach upload fixture'), 'fixture tab');
  const claim = await call('claim_tab', { browser_id: browserId, tab_id: tab.tab_id, expected_url: tab.url, expected_title: tab.title });
  const handle = { tab_handle: claim.tab_handle };
  const evaluate = (expression, args = {}) => call('evaluate', { ...handle, expression, ...args });
  for (const comparison of [{ expected: 'RENDERED_READY' }, { previous: 'Waiting' }]) {
    await evaluate(`(() => {
      document.querySelector('#wait-probe')?.remove();
      const probe = document.createElement('div'); probe.id = 'wait-probe';
      probe.innerHTML = 'Waiting<script>window.literal = "RENDERED_READY"</script><style>/* RENDERED_READY */</style><span hidden>RENDERED_READY</span>';
      document.body.append(probe); window.waitProbeReady = false;
      setTimeout(() => { probe.firstChild.textContent = 'RENDERED_READY'; window.waitProbeReady = true; }, 1000);
    })()`);
    const waited = await call('wait', { ...handle, selector: '#wait-probe', condition: 'text', ...comparison, timeout_ms: 3000 });
    assert.equal(waited.current.text, 'RENDERED_READY');
    assert.equal((await evaluate('window.waitProbeReady')).value, true);
  }
  await evaluate(`document.querySelector('#wait-probe').remove()`);
  checks.push('text wait ignores script/style/hidden descendant literals and waits for rendered substring or full previous-text change');
  const whole = await call('snapshot', handle);
  assert.equal(whole.profile, 'full'); assert.equal(whole.viewport, undefined); assert.equal(whole.snapshot_id, undefined); assert.equal(whole.note, undefined);
  const queried = await call('snapshot', { ...handle, query: 'increment' });
  assert.equal(queried.node_count, 1); assert.equal(queried.next_cursor, null); assert.ok(queried.snapshot.length < whole.snapshot.length);
  assert.doesNotMatch(queried.snapshot, /textbox/);
  await call('hover', { ...handle, ref: queried.snapshot.match(/\[([^\]]+)\] button/)[1] });
  const queriedPage = await call('snapshot', { ...handle, query: 'i', max_nodes: 1 });
  assert.equal(queriedPage.truncated, true);
  const queriedNext = await call('snapshot', { ...handle, cursor: queriedPage.next_cursor, verbose: true });
  assert.equal(queriedNext.query, 'i'); assert.ok(queriedNext.viewport.width); assert.ok(queriedNext.snapshot_id);
  const unmatched = await call('snapshot', { ...handle, query: 'no-such-fixture-control' });
  assert.equal(unmatched.snapshot, ''); assert.equal(unmatched.node_count, 0); assert.equal(unmatched.next_cursor, null);
  checks.push('compact default/full reading, fresh AX name query with actionable ref, query pagination/verbose metadata and zero matches');
  await evaluate(`(() => {
    const section=document.createElement('section');section.id='field-observation-fixture';
    section.innerHTML='<label for="observed-fee">签证费</label><input id="observed-fee" name="TEXTS28" value="1,234.00" readonly>'+
      '<label>签证费<input id="observed-other" name="TEXTS29" value="0"></label>'+
      '<input name="rawFee" type="hidden" value="1234">'+
      '<label>多选<select id="observed-select" multiple><option value="cn" selected>中国</option><option value="us" selected>美国</option></select></label>'+
      '<label>同意<input id="observed-check" type="checkbox"></label>'+
      '<label>密码<input id="observed-password" type="password" value="field-observation-secret"></label>'+
      '<div id="observed-custom" role="combobox" aria-label="自定义选项" aria-expanded="false" tabindex="0">显示项</div>'+
      '<div id="observed-shadow"></div>';
    document.body.append(section);document.querySelector('#observed-check').indeterminate=true;
    const root=document.querySelector('#observed-shadow').attachShadow({mode:'closed'});
    root.innerHTML='<label>影子字段<input id="shadow-field" name="shadowName" value="shadow value"></label>';
    window.fieldObservationEvents=0;section.addEventListener('input',()=>window.fieldObservationEvents++);
    const frame=document.createElement('iframe');
    frame.srcdoc='<label>同源字段<input name="sameOriginField" value="same-origin value"></label>';
    const loaded=new Promise(resolve=>frame.onload=resolve);section.append(frame);return loaded;
  })()`);
  const fieldView = await call('snapshot', { ...handle, profile: 'fields', max_nodes: 3000, max_chars: 100000 });
  assert.equal(fieldView.snapshot, undefined); assert.deepEqual(fieldView.omitted_frames, []);
  const fee = fieldView.fields.find(field => field.dom?.name === 'TEXTS28');
  assert.ok(fee?.ref); assert.equal(fee.dom.value, '1,234.00'); assert.equal(fee.ax.readonly, true);
  assert.ok(fee.labels.includes('签证费'), JSON.stringify(fee));
  assert.equal(fieldView.fields.filter(field => field.labels.includes('签证费')).length, 2);
  assert.ok(!fieldView.fields.some(field => field.dom?.name === 'rawFee'));
  assert.ok(!JSON.stringify(fieldView).includes('field-observation-secret'));
  assert.deepEqual(fieldView.fields.find(field => field.dom?.id === 'observed-select').dom.selected_options,
    [{ value: 'cn', label: '中国' }, { value: 'us', label: '美国' }]);
  assert.equal(fieldView.fields.find(field => field.dom?.id === 'observed-check').ax.checked, 'mixed');
  assert.equal(fieldView.fields.find(field => field.dom?.id === 'observed-custom').ax.role, 'combobox');
  assert.equal(fieldView.fields.find(field => field.dom?.name === 'shadowName').dom.value, 'shadow value');
  const sameOriginField = fieldView.fields.find(field => field.dom?.name === 'sameOriginField');
  assert.equal(sameOriginField.dom.value, 'same-origin value'); assert.notEqual(sameOriginField.frame_id, fee.frame_id);
  const selectedFiles = fieldView.fields.find(field => field.dom?.type === 'file');
  assert.equal(selectedFiles.dom.files.available, true); assert.equal(selectedFiles.dom.files.count, 0);
  assert.equal((await evaluate('window.fieldObservationEvents')).value, 0);
  const hiddenFields = await call('snapshot', { ...handle, profile: 'fields', include_hidden: true, query: 'rawFee' });
  assert.equal(hiddenFields.fields.length, 1); assert.equal(hiddenFields.fields[0].ref, null);
  assert.equal(hiddenFields.fields[0].dom.value, '1234');
  const fieldQuery = await call('snapshot', { ...handle, profile: 'fields', query: 'TEXTS28' });
  assert.equal(fieldQuery.fields.length, 1);
  let fieldPage = await call('snapshot', { ...handle, profile: 'fields', query: '签证费', max_nodes: 1 });
  const firstFieldRef = fieldPage.fields[0].ref;
  assert.equal(fieldPage.truncated, true);
  fieldPage = await call('snapshot', { ...handle, cursor: fieldPage.next_cursor });
  assert.equal(fieldPage.fields.length, 1); assert.equal(fieldPage.next_cursor, null);
  await call('fill', { ...handle, ref: fieldPage.fields[0].ref, text: '2', mode: 'dom' });
  assert.equal((await evaluate('document.querySelector("#observed-other").value')).value, '2');
  const readOnlyField = await rawCall('fill', { ...handle, ref: firstFieldRef, text: '3', timeout_ms: 1000 });
  assert.equal(readOnlyField.isError, true); assert.equal(JSON.parse(readOnlyField.content[0].text).diagnostics.reason, 'read_only');
  await evaluate('document.querySelector("#field-observation-fixture").remove()');
  checks.push('structured DOM/AX field arrays: duplicate HTML labels, id/name queries, hidden opt-in, password omission, multi-select/mixed state, closed Shadow DOM, native file selection, immutable pagination and actionable refs without observation input');
  assert.ok(!(await call('logs', { ...handle, kind: 'console' })).entries.some(entry => entry.text === 'attach-before-claim'));
  assert.deepEqual((await evaluate('Promise.resolve({title: document.title, answer: 6 * 7})')).value,
    { title: 'Attach upload fixture', answer: 42 });
  const special = await evaluate('(()=>{const result={big:12n};result.self=result;return result})()');
  assert.equal(special.value.big.value, '12'); assert.equal(special.value.self.$type, 'circular_or_repeated');
  assert.equal((await evaluate('"x".repeat(100000)', { max_chars: 1000 })).truncated, true);
  assert.equal((await rawCall('evaluate', { ...handle, expression: '(()=>{throw new Error("evaluation fixture")})()' })).isError, true);
  assert.equal((await rawCall('evaluate', { ...handle, expression: 'new Promise(()=>{})', timeout_ms: 100 })).isError, true);
  assert.equal((await rawCall('evaluate', { ...handle, expression: '(()=>{while(true){}})()', timeout_ms: 200 })).isError, true);
  assert.equal((await evaluate('42')).value, 42); checks.push('evaluate promise/special values/truncation/errors/async and synchronous timeouts');
  let page = await evaluate('(window.pageRuns=(window.pageRuns||0)+1, Array.from({length:40},(_,i)=>({i,text:"escaped\\\\text"})))', { max_chars: 120 });
  const all = [...page.value];
  while (page.next_cursor) {
    page = await call('evaluate', { ...handle, cursor: page.next_cursor, max_chars: 120 });
    all.push(...page.value);
  }
  assert.equal(all.length, 40); assert.deepEqual(all.map(item => item.i), Array.from({ length: 40 }, (_, i) => i));
  assert.equal((await evaluate('window.pageRuns')).value, 1);
  await evaluate(`(()=>{
    const button=document.createElement('button');button.id='offscreen';button.innerHTML='<span style="display:block;width:100%;height:100%">Offscreen target</span>';
    button.style='position:absolute;left:20px;top:2200px;width:160px;height:40px';
    button.onclick=()=>window.extraClicks=(window.extraClicks||0)+1;document.body.append(button);
    const text=document.createElement('textarea');text.id='full-text';text.value='all\\nlines\\nhere';document.body.append(text);
  })()`);
  const located = await call('click', { ...handle, selector: '#offscreen' });
  assert.equal(located.hit_target.tag, 'span'); assert.equal(located.hit_target.text, 'Offscreen target');
  assert.equal(located.hit_target.clickable_hint, true);
  assert.equal(located.hit_target.clickable_target.tag, 'button');
  await call('click', { ...handle, selector: '//*[@id="offscreen"]', selector_type: 'xpath' });
  await call('click', { ...handle, x: 100, y: 2220, coordinate_space: 'document' });
  assert.equal((await evaluate('window.extraClicks')).value, 3);
  const readyTree = await call('snapshot', handle);
  const readyRef = readyTree.snapshot.split('\n').find(line => line.includes('button "Offscreen target"')).match(/\[([^\]]+)\]/)[1];
  const backgroundCover = await call('open_tab', { browser_id: browserId, url: `${url}?click-cover`, active: true });
  const backgroundPoint = (await evaluate('(()=>{const r=document.querySelector("#offscreen").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()')).value;
  for (const target of [{ selector: '#offscreen' }, { ref: readyRef }, backgroundPoint]) {
    const clicked = await call('click', { ...handle, ...target });
    assert.equal(clicked.delivery_verified, true);assert.equal(clicked.events_trusted, true);assert.equal(clicked.page_state.tab_active, false);
  }
  assert.equal((await evaluate('window.extraClicks')).value, 6);
  await call('click', { ...handle, selector: '#offscreen', mode: 'dom' });
  assert.equal((await evaluate('window.extraClicks')).value, 7);
  await call('tab_control', { ...handle, action: 'activate' });
  await call('snapshot', handle);
  assert.equal((await call('click', { ...handle, selector: '#offscreen' })).target_verified, true);
  assert.equal((await evaluate('window.extraClicks')).value, 8);
  const listedCover = await until(async () => (await call('discover', { kind: 'tabs', browser_id: browserId })).tabs.find(tab => tab.tab_id === backgroundCover.tab_id && tab.title === 'Attach upload fixture'), 'background click cover');
  const coverClaim = await call('claim_tab', { browser_id: browserId, tab_id: listedCover.tab_id });
  await call('tab_control', { action: 'close', tab_handle: coverClaim.tab_handle });
  checks.push('background native ref/selector/coordinate click verifies trusted delivery without activation; explicit DOM and foreground click; span/button hit hints');
  for (const [method, args, reason] of [
    ['click', { selector: 'button' }, 'selector_ambiguous'],
    ['click', { selector: 'button', selector_type: 'role' }, 'selector_ambiguous'],
    ['click', { selector: '[' }, 'selector_invalid'],
    ['click', { selector: '//*[', selector_type: 'xpath' }, 'selector_invalid'],
    ['click', { selector: '#missing-selector', timeout_ms: 150 }, 'selector_not_found'],
    ['read_text', { selector: 'input' }, 'selector_ambiguous'],
    ['read_text', { selector: '#missing-selector' }, 'selector_not_found'],
    ['wait', { selector: 'button', condition: 'attached' }, 'selector_ambiguous'],
  ]) {
    const result = await rawCall(method, { ...handle, ...args });
    assert.equal(result.isError, true);
    const error = JSON.parse(result.content[0].text);
    assert.equal(error.diagnostics?.reason, reason, result.content[0].text);
    if (method !== 'read_text') assert.equal(error.input_dispatched, false);
  }
  const failedBatch = await rawCall('batch', { ...handle, steps: [{ action: 'click', selector: 'button' }] });
  assert.equal(failedBatch.isError, true);
  assert.equal(JSON.parse(failedBatch.content[0].text).diagnostics.reason, 'selector_ambiguous');
  checks.push('selector failure reasons cross real CDP, extension, Hub and stdio MCP for CSS/XPath/role, text, wait and batch');
  await evaluate(`(()=>{const input=document.createElement('input');input.id='format-probe';input.oninput=()=>{input.dataset.inputs=String(Number(input.dataset.inputs||0)+1);input.value='1,234'};document.body.append(input)})()`);
  const formatted = await rawCall('fill', { ...handle, selector: '#format-probe', text: '1234' });
  assert.equal(formatted.isError, true);
  const formatError = JSON.parse(formatted.content[0].text);
  assert.equal(formatError.diagnostics.reason, 'value_not_retained');
  assert.equal(formatError.input_dispatched, true); assert.equal(formatError.post_action.delivery, 'unknown');
  assert.equal((await evaluate(`document.querySelector('#format-probe').dataset.inputs`)).value, '1');
  await evaluate(`document.querySelector('#format-probe').remove()`);
  checks.push('native fill formatting mismatch reports value_not_retained with unknown-outcome evidence and one input event');
  await evaluate(`(()=>{const e=document.createElement('div');e.id='rich-fill-probe';e.contentEditable='true';e.setAttribute('role','textbox');e.style='white-space:normal;min-height:30px';e.oninput=event=>{e.dataset.inputs=String(Number(e.dataset.inputs||0)+1);e.dataset.trusted=String(event.isTrusted)};document.body.append(e)})()`);
  for (const text of [' leading and trailing ', 'first\r\nsecond', 'first\rsecond', '中文🙂\n第二行', 'Line one\n\nLine two', 'a\n\n\nb', 'a\n', '\na', '\n\n', '', 'replacement']) {
    await evaluate(`document.querySelector('#rich-fill-probe').dataset.inputs='0'`);
    assert.equal((await call('fill', { ...handle, selector: '#rich-fill-probe', text })).value_verified, true);
    if (text) {
      assert.ok(Number((await evaluate(`document.querySelector('#rich-fill-probe').dataset.inputs`)).value) > 0);
      assert.equal((await evaluate(`document.querySelector('#rich-fill-probe').dataset.trusted`)).value, 'true');
    }
    assert.equal((await evaluate(`getSelection().isCollapsed`)).value, true);
    if (text === 'Line one\n\nLine two') assert.equal((await evaluate(`document.querySelector('#rich-fill-probe').innerText`)).value, 'Line one\n\n\nLine two');
  }
  assert.equal((await evaluate(`document.querySelector('#rich-fill-probe').textContent`)).value, 'replacement');
  assert.equal((await call('fill', { ...handle, selector: '#rich-fill-probe', text: 'a\n\nb', mode: 'dom' })).value_verified, true);
  assert.equal((await evaluate(`document.querySelector('#rich-fill-probe').innerText`)).value, 'a\n\nb');
  assert.equal((await evaluate(`document.querySelector('#rich-fill-probe').dataset.trusted`)).value, 'false');
  for (const text of [' a ', 'a  b', 'a\u00a0 b']) {
    await evaluate(`(()=>{const e=document.querySelector('#rich-fill-probe');e.dataset.inputs='0';e.oninput=()=>{e.dataset.inputs=String(Number(e.dataset.inputs)+1);e.textContent=e.textContent.replaceAll(' ','\u00a0')}})()`);
    assert.equal((await call('fill', { ...handle, selector: '#rich-fill-probe', text, mode: 'dom' })).value_verified, true);
    assert.equal((await evaluate(`document.querySelector('#rich-fill-probe').innerText`)).value, text.replaceAll(' ', '\u00a0'));
    assert.equal((await evaluate(`document.querySelector('#rich-fill-probe').dataset.inputs`)).value, '1');
  }
  for (const text of [' a ', 'a  b', 'a\u00a0b']) {
    await evaluate(`(()=>{const e=document.querySelector('#rich-fill-probe');e.dataset.inputs='0';e.oninput=()=>{e.dataset.inputs=String(Number(e.dataset.inputs)+1);e.textContent=e.textContent.replaceAll('\u00a0',' ')}})()`);
    const result = await rawCall('fill', { ...handle, selector: '#rich-fill-probe', text, mode: 'dom' });
    assert.equal(result.isError, true);
    const error = JSON.parse(result.content[0].text);
    assert.equal(error.diagnostics.reason, 'value_not_retained');
    assert.equal(error.input_dispatched, true); assert.equal(error.post_action.delivery, 'unknown');
    assert.equal((await evaluate(`document.querySelector('#rich-fill-probe').dataset.inputs`)).value, '1');
  }
  checks.push('DOM fill accepts same-position space-to-NBSP formatting, still rejects collapsed whitespace and loss of explicit NBSP without replay');
  for (const [mode, text, html] of [['native', 'ab', '<div>a</div><div>b</div>'], ['dom', 'a\n\nb', 'a<br>b']]) {
    await evaluate(`(()=>{const e=document.querySelector('#rich-fill-probe');e.dataset.inputs='0';e.oninput=()=>{e.dataset.inputs=String(Number(e.dataset.inputs)+1);e.innerHTML=${JSON.stringify(html)}}})()`);
    const result = await rawCall('fill', { ...handle, selector: '#rich-fill-probe', text, mode });
    assert.equal(result.isError, true);
    const error = JSON.parse(result.content[0].text);
    assert.equal(error.diagnostics.reason, 'value_not_retained');
    assert.equal(error.input_dispatched, true); assert.equal(error.post_action.delivery, 'unknown');
    assert.equal((await evaluate(`document.querySelector('#rich-fill-probe').dataset.inputs`)).value, '1');
  }
  await evaluate(`document.querySelector('#rich-fill-probe').remove()`);
  checks.push('contenteditable fill: native selected text preserves blank/trailing lines and replaces existing paragraphs; DOM emits visible breaks; actual line-count changes never replay');
  await call('fill', { ...handle, selector: '#name', mode: 'dom', text: 'selector input' });
  assert.equal((await call('read_text', { ...handle, selector: '#name', mode: 'value' })).text, 'selector input');
  const textPage = await call('read_text', { ...handle, selector: '#full-text', mode: 'value', max_chars: 4 });
  const textRest = await call('read_text', { ...handle, selector: '#full-text', mode: 'value', offset: textPage.next_offset });
  assert.equal(textPage.text + textRest.text, 'all\nlines\nhere'); assert.equal(textRest.complete_source, true);
  assert.equal((await rawCall('read_text', { ...handle, selector: '#name', mode: 'editor' })).isError, true);
  await evaluate(`(()=>{document.querySelector('#offscreen').remove();document.querySelector('#full-text').remove();scrollTo(0,0)})()`);
  checks.push('CSS/XPath strict selectors, offscreen auto-scroll, document coordinates, hit metadata, value text pagination, cached evaluate pagination without replay');
  await evaluate(`(async()=>{
    console.warn('attach diagnostic warning', {answer:42});
    setTimeout(()=>{throw new Error('attach uncaught fixture')},0);
    Promise.reject(new Error('attach rejection fixture'));
    await (await fetch('/api/redirect')).text(); await (await fetch('/api/missing')).text();
    try { await fetch('/api/failed') } catch {}
    return true;
  })()`);
  const consoleLogs = await until(async () => {
    const result = await call('logs', { ...handle, kind: 'console' });
    return result.entries.some(entry => entry.text.includes('attach rejection fixture')) && result;
  }, 'console and rejection events');
  assert.equal(consoleLogs.kind, 'console');
  assert.ok(consoleLogs.entries.some(entry => entry.level === 'warning' && entry.text.includes('attach diagnostic warning')));
  assert.ok(consoleLogs.entries.some(entry => entry.source === 'exception' && entry.text.includes('attach uncaught fixture')));
  const networkLogs = await until(async () => {
    const result = await call('logs', { ...handle, kind: 'network', url_contains: '/api/' });
    return result.entries.some(entry => entry.event === 'failed') &&
      result.entries.some(entry => entry.event === 'finished' && entry.url?.endsWith('/api/ok')) && result;
  }, 'network failure');
  assert.equal(networkLogs.kind, 'network');
  assert.ok(networkLogs.entries.some(entry => entry.event === 'redirect' && entry.status === 302));
  assert.ok(networkLogs.entries.some(entry => entry.event === 'response' && entry.status === 404));
  assert.ok(networkLogs.entries.some(entry => entry.event === 'finished' && entry.url.endsWith('/api/ok')));
  const firstLog = await call('logs', { ...handle, kind: 'network', limit: 1 });
  assert.equal(firstLog.entries.length, 1);
  assert.ok((await call('logs', { ...handle, kind: 'network', after_seq: firstLog.next_seq })).entries.every(entry => entry.seq > firstLog.next_seq));
  checks.push('console previews/uncaught error/rejection and network redirect/HTTP error/failure/pagination');
  assert.equal((await rawCall('evaluate', { ...handle, expression: 'alert("evaluation modal")' })).isError, true);
  assert.ok((await call('logs', { ...handle, kind: 'console' })).entries.length);
  await call('handle_dialog', { ...handle, accept: true });
  await call('navigate', { ...handle, url: `${url}?diagnostics-reset` });
  assert.ok((await call('logs', { ...handle, kind: 'console' })).entries.some(entry => entry.text.includes('attach diagnostic warning')));
  assert.ok((await call('logs', { ...handle, kind: 'network' })).entries.some(entry => entry.event === 'redirect'));
  checks.push('evaluation dialog and diagnostic retention across navigation');
  const snapshot = () => call('snapshot', handle);
  const ref = async label => {
    const tree = (await snapshot()).snapshot;
    const line = tree.split('\n').find(line => line.includes(`"${label}"`) && /\[[^\]]+\] (button|textbox) /.test(line));
    assert.ok(line, `Missing ${label} in ${tree}`); return line.match(/\[([^\]]+)\]/)[1];
  };
  const state = async () => {
    const text = (await call('read_text', handle)).text;
    return JSON.parse(text.slice(text.indexOf('STATE:') + 6));
  };
  const file = join(temp, '中文 space.txt'), empty = join(temp, 'empty.txt');
  await writeFile(file, 'Attach 上传内容\n'); await writeFile(empty, '');
  await call('fill', { ...handle, ref: await ref('Name'), text: 'attach works' });
  assert.equal((await state()).name, 'attach works'); checks.push('existing fill');
  await call('click', { ...handle, ref: await ref('Increment') });
  assert.equal((await state()).count, 1); checks.push('existing click');
  const single = await ref('Single');
  await call('upload_file', { ...handle, ref: single, files: [file] });
  await until(async () => (await state()).files.single?.length, 'single file content');
  assert.equal((await state()).files.single[0].text, 'Attach 上传内容\n'); checks.push('single file content + Unicode path');
  assert.ok((await state()).events.includes('single:input'));
  assert.ok((await state()).events.includes('single:change'));
  const uploadedField = await call('snapshot', { ...handle, profile: 'fields', query: 'single' });
  assert.equal(uploadedField.fields[0].dom.files.count, 1);
  assert.deepEqual(uploadedField.fields[0].dom.files.names, ['中文 space.txt']);
  assert.equal((await rawCall('upload_file', { ...handle, ref: single, files: [file] })).isError, true); checks.push('new snapshot expires the old ref');
  await call('upload_file', { ...handle, ref: await ref('Multiple'), files: [file, empty] });
  await until(async () => (await state()).files.multiple?.length === 2, 'multiple file content');
  assert.equal((await state()).files.multiple[1].size, 0); checks.push('multiple + empty file');
  const click = await call('click', { ...handle, ref: await ref('Choose file') });
  await until(async () => (await snapshot()).file_chooser, 'intercepted chooser');
  await call('upload_file', { ...handle, files: [file, empty] });
  await until(async () => (await state()).files.hidden?.length === 2, 'hidden chooser input');
  checks.push('Choose file -> hidden input upload without native dialog');
  await call('click', { ...handle, ref: await ref('Show picker') });
  await until(async () => (await snapshot()).file_chooser, 'showPicker interception');
  await call('upload_file', { ...handle, files: [file] });
  await until(async () => (await state()).files['shadow-upload']?.length === 1, 'showPicker input');
  checks.push('HTMLInputElement.showPicker');
  await call('upload_file', { ...handle, ref: await ref('Multiple'), files: [] });
  await until(async () => (await state()).files.multiple?.length === 0, 'cleared selection'); checks.push('clear selection');
  for (const [label, files] of [['Single', [file, empty]], ['Disabled', [file]], ['Directory', [file]]]) {
    assert.equal((await rawCall('upload_file', { ...handle, ref: await ref(label), files })).isError, true); checks.push(`${label} validation`);
  }
  assert.equal((await rawCall('upload_file', { ...handle, ref: await ref('Single'), files: [join(temp, 'missing')] })).isError, true); checks.push('missing file rejected');
  assert.deepEqual((await state()).errors, [], 'Upload interactions must not generate page JavaScript errors');
  await call('click', { ...handle, ref: await ref('Choose file') });
  await until(async () => (await snapshot()).file_chooser, 'chooser before navigation');
  await call('navigate', { ...handle, url: `${url}?fresh` });
  await until(async () => !(await snapshot()).file_chooser, 'navigation cleanup');
  assert.equal((await rawCall('upload_file', { ...handle, files: [] })).isError, true); checks.push('navigation clears chooser');
  await call('click', { ...handle, ref: await ref('Confirm') }).catch(() => {});
  const dialog = await snapshot(); assert.equal(dialog.dialog.type, 'confirm');
  const handled = await call('handle_dialog', { ...handle, accept: false });
  assert.equal(handled.dialog.type, 'confirm'); assert.equal(handled.accepted, false); assert.equal(handled.dialog.default_button, null);
  checks.push('existing dialog handling and original type/acceptance metadata');
  const final = await state(); assert.deepEqual(final.errors, []); checks.push('no page JavaScript errors');

  await call('navigate', { ...handle, url: `${url}frames` });
  const childRef = async (role, label) => {
    const tree = (await snapshot()).snapshot;
    const line = tree.split('\n').find(line => line.includes(`${role} "${label}"`));
    assert.ok(line, `Missing ${label}: ${tree}`); return line.match(/\[([^\]]+)\]/)[1];
  };
  const frameState = async id => (await evaluate(`window.frameState[${JSON.stringify(id)}]`)).value;
  await until(async () => (await snapshot()).snapshot.includes('Nested button'), 'nested OOPIF snapshot');
  const frameFields = await call('snapshot', { ...handle, profile: 'fields', max_chars: 100000 });
  assert.deepEqual(frameFields.omitted_frames, []);
  const childField = frameFields.fields.find(field => field.ax?.name === 'Child name');
  assert.ok(childField?.ref); assert.equal(childField.dom.id, 'name');
  assert.ok(frameFields.frames.some(frame => frame.frame_id === childField.frame_id && frame.url.includes('/frame')));
  await call('fill', { ...handle, ref: childField.ref, text: 'field OOPIF', mode: 'dom' });
  assert.equal((await frameState('child')).text, 'field OOPIF');
  checks.push('structured fields join OOPIF DOM/AX by frame/session and produce usable child refs');
  const childClick = await call('click', { ...handle, ref: await childRef('button', 'Child button') });
  await until(async () => (await frameState('child'))?.clicks === 1, 'OOPIF native click');
  await call('click', { ...handle, ...childClick.clicked });
  await until(async () => (await frameState('child'))?.clicks === 2, 'root coordinate OOPIF click');
  await call('scroll', { ...handle, mode:'wheel', ...childClick.clicked, delta_y:80 });
  await until(async () => (await frameState('child'))?.wheels === 1, 'OOPIF native wheel handler');
  assert.equal((await frameState('child')).wheelTrusted,true);
  await call('fill', { ...handle, ref: await childRef('textbox', 'Child name'), text: 'OOPIF native' });
  await call('press_key', { ...handle, key: 'Z' });
  await until(async () => (await frameState('child'))?.text === 'OOPIF nativez', 'OOPIF fill and key');
  await call('fill', { ...handle, ref: await childRef('textbox', 'Child name'), text: 'DOM child', mode: 'dom' });
  assert.equal((await frameState('child')).text, 'DOM child');
  const childFrame = (await snapshot()).snapshot.split('\n').find(line => /^Frame /.test(line) && line.includes(`http://localhost:${fixture.address().port}/frame`)).split(' ')[1];
  await call('fill', { ...handle, selector: '#name', frame_id: childFrame, text: 'OOPIF selector', mode: 'dom' });
  assert.equal((await frameState('child')).text, 'OOPIF selector');
  await call('click', { ...handle, selector: '#go', frame_id: childFrame });
  await until(async () => (await frameState('child'))?.clicks === 3, 'OOPIF selector click');
  for (const options of [{button:'right'}, {button:'middle'}, {click_count:2}, {modifiers:['Control']}, {button:'right',click_count:2}, {button:'middle',click_count:2}]) {
    try { await call('click', { ...handle, ref: await childRef('button', 'Child button'), ...options }); }
    catch (error) { console.error('Mouse options', options, await frameState('child')); throw error; }
  }
  const mouseState = await frameState('child');
  assert.equal(mouseState.right, 3); assert.equal(mouseState.middle, 3); assert.equal(mouseState.doubles, 1); assert.equal(mouseState.control, 1);
  await call('click', { ...handle, ref: await childRef('button', 'Child upload') });
  await call('upload_file', { ...handle, files: [file] });
  await until(async () => (await frameState('child'))?.files.length === 1, 'OOPIF chooser upload');
  await call('click', { ...handle, ref: await childRef('button', 'Nested button') });
  await until(async () => (await frameState('nested'))?.clicks === 1, 'nested OOPIF click');
  assert.ok((await call('logs', { ...handle, kind: 'console' })).entries.some(e => e.session_id && e.text.includes('child click')));
  assert.ok((await call('logs', { ...handle, kind: 'network' })).entries.some(e => e.session_id && e.url?.includes('/api/ok')));
  // External subframe navigation must expire only its subtree, without consuming main refs.
  if (!values.connected) {
    await evaluate(`document.querySelector('iframe').src = 'http://localhost:${fixture.address().port}/frame?reload'`);
    // evaluate deliberately invalidates observations; take another before the timed reload.
    await evaluate(`setTimeout(()=>document.querySelector('iframe').src += '&again', 500)`);
    const stable = await childRef('button', 'Main frame button');
    await new Promise(resolve => setTimeout(resolve, 800));
    await call('tab_control', { ...handle, action: 'activate' });
    await call('click', { ...handle, ref: stable });
  }
  await evaluate(`(()=>{const cover=document.createElement('button');cover.id='cover';cover.textContent='Cover';cover.style='position:fixed;inset:0;width:100vw;height:100vh;z-index:2147483647';cover.onclick=()=>window.coverClicks=(window.coverClicks||0)+1;document.body.append(cover)})()`);
  const covered = await rawCall('click', { ...handle, ref: await childRef('button', 'Child button'), timeout_ms: 500 });
  assert.equal(covered.isError, true); assert.match(covered.content[0].text, /covers this frame.*hit_target=.*Cover.*No input was dispatched/);
  assert.equal((await evaluate('window.coverClicks||0')).value, 0);
  await call('navigate', { ...handle, url });
  checks.push('nested OOPIF snapshot/native and DOM fill/keyboard/right-middle-double-Control clicks/chooser upload/logs/subframe navigation cleanup');

  await call('fill', { ...handle, ref: await ref('Name'), text: '' });
  await evaluate(`(()=>{window.keyEvents=[];addEventListener('keydown',e=>{keyEvents.push({key:e.key,code:e.code,trusted:e.isTrusted});if(['F8','Insert','PageUp'].includes(e.key))e.preventDefault()})})()`);
  for (const key of ['F8','Insert','PageUp']) await call('press_key', { ...handle, key });
  const keys = (await evaluate('window.keyEvents')).value;
  assert.deepEqual(keys.map(e=>e.code), ['F8','Insert','PageUp']); assert.ok(keys.every(e=>e.trusted));
  for (const key of ['Shift+1',';',':','?','+','Backslash','Quote','Backquote']) await call('press_key', { ...handle, key });
  assert.equal((await state()).name, "!;:?+\\'`");
  await evaluate(`(()=>{const zone=document.createElement('div');zone.id='wheel-zone';zone.style='position:fixed;left:20px;top:240px;width:300px;height:180px;overflow:auto;z-index:10';zone.innerHTML='<div style="height:1000px">Custom wheel scroller</div>';window.wheelState={count:0,dx:0,dy:0,trusted:false};zone.addEventListener('wheel',e=>{e.preventDefault();wheelState={count:wheelState.count+1,dx:e.deltaX,dy:e.deltaY,trusted:e.isTrusted}}, {passive:false});document.body.append(zone)})()`);
  await call('scroll', { ...handle, x:100,y:300,delta_y:90 });
  assert.equal((await evaluate('window.wheelState.count')).value,0);
  const wheel = await call('scroll', { ...handle,mode:'wheel',x:100,y:300,delta_x:-15,delta_y:120 });
  assert.equal(wheel.method,'native_wheel'); assert.equal(wheel.scrolled,undefined);
  await until(async () => (await evaluate('window.wheelState.count')).value === 1, 'trusted custom wheel handler');
  const wheelState = (await evaluate('window.wheelState')).value;
  assert.deepEqual(wheelState,{count:1,dx:-15,dy:120,trusted:true});
  checks.push('F8/Insert/PageUp trusted keys, shifted punctuation text, DOM default and native wheel custom handler');

  await evaluate(`(() => {
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < 12000; i++) {
      const row = document.createElement('div'); row.setAttribute('role', 'group'); row.setAttribute('aria-label', 'Large row ' + i); fragment.append(row);
    }
    document.body.replaceChildren(fragment);
  })()`, { timeout_ms: 30000 });
  const largeSnapshotStarted = Date.now();
  const largeSnapshot = await call('snapshot', { ...handle, max_nodes: 1 });
  assert.ok(largeSnapshot.total_node_count >= 12000);
  assert.equal(largeSnapshot.node_count, 1); assert.equal(largeSnapshot.truncated, true);
  const largeNext = await call('snapshot', { ...handle, cursor: largeSnapshot.next_cursor, max_nodes: 2 });
  assert.match(largeNext.snapshot, /group "Large row 0"/);
  checks.push(`12000 semantic DOM nodes snapshot/pagination with max_nodes=1 (${Date.now() - largeSnapshotStarted} ms, ${largeSnapshot.total_node_count} rendered AX entries)`);
  await call('navigate', { ...handle, url: url + 'editor-tt', include_snapshot: false });
  assert.equal((await evaluate(`(()=>{try{document.querySelector('#editor').innerHTML='blocked';return false}catch(e){return e instanceof TypeError}})()`)).value, true);
  for (const mode of ['native', 'dom']) for (const text of ['Line one\n\nLine two', 'replacement']) {
    await call('fill', { ...handle, selector: '#editor', mode, text });
    if (text === 'replacement') assert.equal((await evaluate(`document.querySelector('#editor').textContent`)).value, 'replacement');
  }
  await evaluate(`document.querySelector('#other').focus()`);
  await call('fill', { ...handle, selector: '#editor', mode: 'dom', text: 'a\n\nb' });
  assert.equal((await evaluate(`document.activeElement.id`)).value, 'other');
  assert.equal((await evaluate(`document.querySelector('#editor').innerText`)).value, 'a\n\nb');
  const invalidType = await rawCall('type', { ...handle, selector: '#editor', text: 'a\nb' });
  assert.equal(invalidType.isError, true); assert.match(invalidType.content[0].text, /press_key.*Enter/);
  await evaluate(`(()=>{const e=document.querySelector('#editor');e.dataset.inputs='0';e.oninput=()=>e.dataset.inputs=String(Number(e.dataset.inputs)+1);e.onfocus=()=>queueMicrotask(()=>getSelection().collapseToEnd())})()`);
  const lostSelection = await rawCall('fill', { ...handle, selector: '#editor', text: 'must not append' });
  assert.equal(lostSelection.isError, true);
  assert.equal(JSON.parse(lostSelection.content[0].text).diagnostics.reason, 'fill_selection_lost');
  assert.equal((await evaluate(`document.querySelector('#editor').innerText`)).value, 'a\n\nb');
  assert.equal((await evaluate(`document.querySelector('#editor').dataset.inputs`)).value, '0');
  checks.push('Trusted Types blocks innerHTML; native/DOM multiline replacement succeeds without HTML sinks; DOM keeps focus; type newline error names Enter');
  checks.push('page collapses replacement selection after focus: fill_selection_lost before insertText, no append and zero input events');
  await call('tab_control', { ...handle, action: 'release' });
  }
  const report = { date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date()), family: values.family, user_agent: browsers[0].user_agent, extension_version: VERSION, checks, calls: calls.length, results: calls };
  const out = resolve(ROOT, 'test-results'); await mkdir(out, { recursive: true });
  await writeFile(join(out, `npm-live-${values.family}${values.files ? '-files' : ''}.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, results: undefined }, null, 2));
} finally {
  await mcp?.close().catch(() => {});
  // Edge can relaunch itself on Windows; killing its launcher alone leaves
  // the temporary profile locked by the actual browser process.
  if (browser && cdp?.readyState === WebSocket.OPEN) {
    let timer;
    try {
      const closed = once(cdp, 'close');
      cdp.send(JSON.stringify({ id: -1, method: 'Browser.close' }));
      await Promise.race([closed, new Promise(resolve => { timer = setTimeout(resolve, 3000); })]);
    } catch {} finally { clearTimeout(timer); }
  }
  cdp?.terminate();
  browser?.kill();
  await hub?.close();
  for (const socket of fixtureSockets) socket.destroy();
  await new Promise(resolve => fixture.close(resolve));
  // Browser teardown may hold profile files briefly on Windows.
  await rm(temp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }).catch(() => {});
}

async function checkFiles({ browserId, call, rawCall, configPath }) {
  const config = await loadConfig(configPath), other = new AttachClient(config);
  await mkdir(resolve(ROOT, 'test-results'), { recursive: true });
  const directory = join(temp, '中文 space'); await mkdir(directory);
  const file = join(directory, 'local #1.html'), next = join(directory, 'next.html');
  const fileUrl = pathToFileURL(file).href, nextUrl = pathToFileURL(next).href;
  await writeFile(file, `<!doctype html><meta charset="utf-8"><title>Local file fixture</title>
    <h1>本地页面 AX 正文</h1><label>Name<input id="name"></label><button id="go">Increment</button>
    <p id="state">0</p><iframe src="child.html"></iframe><script>
    window.count=0;window.trusted=[];go.onclick=e=>{state.textContent=++window.count;window.trusted.push(e.isTrusted)};
    document.querySelector('#name').oninput=e=>window.trusted.push(e.isTrusted);</script>`);
  await writeFile(join(directory, 'child.html'), '<title>Local child</title><button>Local frame button</button>');
  await writeFile(next, '<title>Next local file</title><h1>Next document</h1>');
  const { targetId: settingsTarget } = await command('Target.createTarget', { url: values.family === 'edge' ? 'edge://extensions/' : 'chrome://extensions/', background: true });
  const { sessionId } = await command('Target.attachToTarget', { targetId: settingsTarget, flatten: true });
  async function fileAccess(enabled) {
    const result = await command('Runtime.evaluate', { expression: `new Promise((resolve,reject)=>chrome.developerPrivate.updateExtensionConfiguration({extensionId:${JSON.stringify(config.extension_id)},fileAccess:${enabled}},()=>chrome.runtime.lastError?reject(Error(chrome.runtime.lastError.message)):resolve(true)))`, awaitPromise: true, returnByValue: true }, sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    // File access changes reload the extension and replace its connection identity.
    await until(async () => {
      const browser = (await call('discover', { kind: 'browsers' })).browsers[0];
      if (!browser) return false;
      browserId = browser.browser_id;
      return true;
    }, 'extension after file permission change');
  }
  const list = () => call('discover', { kind: 'tabs', browser_id: browserId });
  const claim = tab => call('claim_tab', { browser_id: browserId, tab_id: tab.tab_id, expected_url: tab.url });
  const rejected = async (method, args, pattern) => {
    const result = await rawCall(method, args); assert.equal(result.isError, true); assert.match(result.content[0].text, pattern);
  };
  let localTarget;
  try {
    // --load-extension permits initial loading without persisting developer mode.
    const developerMode = await command('Runtime.evaluate', { expression: 'chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode:true})', awaitPromise: true }, sessionId);
    if (developerMode.exceptionDetails) throw new Error(developerMode.exceptionDetails.exception?.description || developerMode.exceptionDetails.text);
    await fileAccess(false);
    localTarget = (await command('Target.createTarget', { url: fileUrl })).targetId;
    let tab = await until(async () => (await list()).tabs.find(t => t.url === fileUrl && t.title === 'Local file fixture'), 'local file fixture');
    assert.equal(tab.controllable, false);
    await rejected('claim_tab', { browser_id: browserId, tab_id: tab.tab_id }, /Local file access is disabled/);
    checks.push('file access off: discovery marks unavailable, claim fails before attach');
    await fileAccess(true);
    tab = (await list()).tabs.find(t => t.tab_id === tab.tab_id); assert.equal(tab.controllable, true);
    await assert.rejects(other.call('claim_tab', { browser_id: browserId, tab_id: tab.tab_id }), /latest/);
    const activeBefore = (await list()).tabs.filter(t => t.active).map(t => t.tab_id);
    const handle = { tab_handle: (await claim(tab)).tab_handle };
    assert.deepEqual((await list()).tabs.filter(t => t.active).map(t => t.tab_id), activeBefore);
    await other.call('list_tabs', { browser_id: browserId });
    await assert.rejects(other.call('claim_tab', { browser_id: browserId, tab_id: tab.tab_id }), /another MCP session/);
    const tree = await call('snapshot', handle);
    assert.match(tree.snapshot, /本地页面 AX 正文/); assert.match(tree.snapshot, /Local frame button/); assert.deepEqual(tree.omitted_frames, []);
    const button = tree.snapshot.match(/\[([^\]]+)\] button "Increment"/)[1];
    const field = tree.snapshot.match(/\[([^\]]+)\] textbox "Name"/)[1];
    await call('evaluate', { ...handle, expression: 'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))' });
    const image = await rawCall('screenshot', handle);
    assert.ok(!image.isError); const png = image.content.find(c => c.type === 'image'); assert.ok(png);
    assert.equal(Buffer.from(png.data, 'base64').subarray(1, 4).toString(), 'PNG');
    await writeFile(resolve(ROOT, 'test-results', `file-${values.family}.png`), Buffer.from(png.data, 'base64'));
    await call('fill', { ...handle, ref: field, text: 'local' });
    await call('type', { ...handle, ref: field, text: ' file' });
    assert.equal((await call('read_text', { ...handle, selector: '#name', mode: 'value' })).text, 'local file');
    await call('press_key', { ...handle, key: 'Tab' });
    await call('click', { ...handle, ref: button });
    const evaluate = async expression => (await call('evaluate', { ...handle, expression })).value;
    assert.equal(await evaluate('window.count'), 1);
    assert.ok((await evaluate('window.trusted')).every(Boolean));
    const batch = await call('batch', { ...handle, steps: [{ action: 'fill', selector: '#name', text: 'DOM file', mode: 'dom' }, { action: 'click', selector: '#go', mode: 'dom' }] });
    assert.equal(batch.completed, true); assert.equal(await evaluate('window.count'), 2);
    checks.push('Unicode/space/# file path: exclusive observed claim, no activation, main/iframe AX, PNG, native ref fill/type/key/click with trusted events, DOM batch');
    const paged = await call('snapshot', { ...handle, max_nodes: 1 });
    assert.ok(paged.next_cursor);
    const moved = await call('navigate', { ...handle, url: nextUrl }); assert.equal(moved.url, nextUrl); assert.match(moved.snapshot, /Next document/);
    await rejected('click', { ...handle, ref: button }, /stale/);
    await rejected('snapshot', { ...handle, cursor: paged.next_cursor }, /stale/);
    assert.equal((await call('navigate', { ...handle, direction: 'back' })).url, fileUrl);
    assert.equal((await call('navigate', { ...handle, direction: 'forward' })).url, nextUrl);
    assert.equal((await call('navigate', { ...handle, url })).url, url);
    assert.equal((await call('navigate', { ...handle, url: fileUrl })).url, fileUrl);
    checks.push('file URL/back/forward and HTTP↔file navigation; old refs and snapshot cursors expire');
    await call('tab_control', { ...handle, action: 'release' });
    await rejected('snapshot', handle, /absent|expired/);
    await other.call('claim_tab', { browser_id: browserId, tab_id: tab.tab_id });
    await other.close();
    await until(async () => (await list()).tabs.find(t => t.tab_id === tab.tab_id)?.control === 'available', 'file owner disconnect cleanup');
    const finalHandle = { tab_handle: (await claim(tab)).tab_handle };
    await call('tab_control', { ...finalHandle, action: 'close' });
    assert.ok(!(await list()).tabs.some(t => t.tab_id === tab.tab_id));
    await rejected('snapshot', finalHandle, /absent|expired/);
    checks.push('release invalidates handle; another connection can claim; disconnect releases; close clears ownership');
    await fileAccess(false);
    checks.push('file permission toggled off and on through real browser extension settings');
  } finally {
    await other.close();
    if (localTarget) await command('Target.closeTarget', { targetId: localTarget }).catch(() => {});
    await command('Target.closeTarget', { targetId: settingsTarget }).catch(() => {});
  }
}
