import { HUB_OPERATION_TIMEOUT_MS } from '../extension/limits.js';
import { errorData, errorFromData } from '../extension/errors.js';
import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { VERSION } from './config.mjs';
import { syncExtension } from './setup.mjs';
import { compareVersions } from '../extension/version.js';

const MAX_MESSAGE = 24 * 1024 * 1024;
const OPERATIONS = new Set(['release_tab', 'activate_tab', 'close_tab', 'snapshot', 'read_text', 'type', 'hover', 'drag', 'wait', 'select_option', 'click', 'fill', 'press_key', 'batch', 'scroll', 'navigate', 'screenshot', 'handle_dialog', 'upload_file', 'evaluate', 'logs']);
export const CAPABILITIES = ['tabs', 'fetch', 'open_tab', 'activate_tab', 'close_tab', 'claim', 'ax_snapshot', 'text', 'type', 'hover', 'drag', 'wait', 'select_option', 'click', 'fill', 'keyboard', 'batch', 'scroll', 'navigate', 'screenshot', 'handle_dialog', 'upload_file', 'visual_indicator', 'evaluate', 'logs'];
export class OperationTimeout extends Error {}
const send = (ws, data) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data)); };

export async function startHub(config, { port = config.port, operationTimeout = HUB_OPERATION_TIMEOUT_MS } = {}) {
  const browsers = new Map(), clients = new Set(), claims = new Map(), tabClaims = new Map(), queues = new Map();
  const cleanups = new Set();
  let state = 'starting', upgradeError;
  const authorized = token => typeof token === 'string' && Buffer.byteLength(token) === Buffer.byteLength(config.token)
    && timingSafeEqual(Buffer.from(token), Buffer.from(config.token));
  const bearer = request => authorized(request.headers.authorization?.replace(/^Bearer /, ''));
  const keyFor = (browser, tab) => JSON.stringify([browser, tab]);
  function forget(handle) {
    const claim = claims.get(handle);
    if (claim) tabClaims.delete(keyFor(claim.browser_id, claim.tab_id));
    claims.delete(handle);
  }
  function queued(key, action) {
    const result = (queues.get(key) || Promise.resolve()).catch(() => {}).then(action);
    queues.set(key, result);
    const done = () => { if (queues.get(key) === result) queues.delete(key); };
    result.then(done, done);
    return result;
  }
  function requestBrowser(browser, owner, command, args, timeout = operationTimeout) {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        browser.pending.delete(id);
        reject(new OperationTimeout('Browser operation timed out; outcome may be unknown. Connection will release its tabs. List and claim again.'));
      }, timeout);
      browser.pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      if (browser.ws.readyState !== WebSocket.OPEN) {
        clearTimeout(timer); browser.pending.delete(id); reject(new Error('Browser disconnected')); return;
      }
      send(browser.ws, { id, owner, command, arguments: args });
    });
  }
  function claimTab(browser, owner, tab, args) {
    const key = keyFor(browser.id, tab.tab_id);
    return queued(key, async () => {
      const existing = tabClaims.get(key);
      if (existing) {
        if (claims.get(existing).owner !== owner) throw new Error('Tab is controlled by another MCP session');
        return { claimed: true, activation_requested: false, tab_handle: existing, browser_id: browser.id, tab_id: tab.tab_id, title: tab.title, url: tab.url };
      }
      const handle = randomUUID(), claim = { owner, browser_id: browser.id, tab_id: tab.tab_id };
      // Reserve before dispatch so detach notifications cannot be overwritten by a late reply.
      claims.set(handle, claim);
      tabClaims.set(key, handle);
      try {
        const result = await requestBrowser(browser, owner, 'claim_tab', { ...args, tab_id: tab.tab_id, tab_handle: handle });
        if (browsers.get(browser.id) !== browser || claims.get(handle) !== claim) throw new Error('Tab detached or browser disconnected during claim');
        return { ...result, tab_handle: handle, browser_id: browser.id, tab_id: tab.tab_id, title: result.title ?? tab.title, url: result.url ?? tab.url };
      } catch (error) {
        if (!(error instanceof OperationTimeout) && !error.diagnostics?.control_retained) forget(handle);
        if (error.diagnostics?.control_retained) error.diagnostics = { ...error.diagnostics, tab_handle: handle };
        throw error;
      }
    });
  }
  async function execute(owner, observed, method, args) {
    if (method === 'list_browsers') return {
      browsers: [...browsers.values()].filter(browser => browser.ready).map(browser => ({ browser_id: browser.id, ...browser.info, capabilities: CAPABILITIES })),
      upgrades: [...browsers.values()].filter(browser => !browser.ready).map(browser => ({ instance_id: browser.info.instance_id, version: browser.info.extension_version, error: browser.upgradeError })),
      hint: 'Load the paired extension in each Chrome/Edge profile if empty.',
    };
    if (method === 'list_tabs' || method === 'claim_tab' || method === 'open_tab' || method === 'fetch') {
      const browser = browsers.get(args.browser_id);
      if (!browser?.ready) throw new Error('Browser is not connected; call browser_discover kind=browsers again');
      if (method === 'fetch') return await requestBrowser(browser, owner, method, args);
      if (method === 'open_tab') {
        if (args.claim != null && typeof args.claim !== 'boolean') throw new Error('claim must be a boolean');
        const opened = await requestBrowser(browser, owner, method, { url: args.url, active: args.active });
        if (!args.claim) return { ...opened, claimed: false };
        try {
          const claimed = await claimTab(browser, owner, opened, { wait_for_page: true });
          return { ...opened, ...claimed };
        } catch (error) {
          const unknown = error instanceof OperationTimeout || browsers.get(browser.id) !== browser;
          error.open_tab = { ...opened, browser_id: browser.id, claimed: unknown ? null : false, phase: 'claim',
            ...(unknown ? { outcome_unknown: true } : {}),
            ...(error.diagnostics?.control_retained ? { control_retained: true, tab_handle: error.diagnostics.tab_handle } : {}) };
          throw error;
        }
      }
      if (method === 'list_tabs') {
        const result = await requestBrowser(browser, owner, method, {});
        for (const [key, tab] of observed) if (tab.browser_id === browser.id) observed.delete(key);
        for (const tab of result.tabs) {
          const key = keyFor(browser.id, tab.tab_id);
          observed.set(key, { ...tab, browser_id: browser.id });
          const claim = claims.get(tabClaims.get(key));
          tab.control = !claim ? 'available' : claim.owner === owner ? 'yours' : 'another_session';
        }
        return result;
      }
      const key = keyFor(browser.id, args.tab_id), tab = observed.get(key);
      if (!tab || (args.expected_url != null && tab.url !== args.expected_url) || (args.expected_title != null && tab.title !== args.expected_title))
        throw new Error("Claim requires a tab_id from this session's latest browser_discover kind=tabs result; optional expected_url/title must match exactly");
      return claimTab(browser, owner, tab, { expected_url: args.expected_url, expected_title: args.expected_title });
    }
    if (!OPERATIONS.has(method)) throw new Error(`Unknown browser operation: ${method}`);
    const handle = args.tab_handle, claim = claims.get(handle);
    if (!claim || claim.owner !== owner) throw new Error('Tab handle is absent, expired or belongs to another MCP session; list and claim again');
    return queued(keyFor(claim.browser_id, claim.tab_id), async () => {
      if (claims.get(handle) !== claim) throw new Error('Tab was released while this operation was waiting');
      const browser = browsers.get(claim.browser_id);
      if (!browser) throw new Error('Browser disconnected');
      const result = await requestBrowser(browser, owner, method, { ...args, tab_id: claim.tab_id });
      if (method === 'release_tab' || method === 'close_tab') forget(handle);
      return { ...result, tab_handle: handle, tab_id: claim.tab_id };
    });
  }

  let closing;
  const server = http.createServer(async (request, response) => {
    if (request.headers.origin || !bearer(request)) { response.writeHead(403).end(); return; }
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/health' && request.method === 'GET') response.end(JSON.stringify({ service: 'browser-attach', version: VERSION, state,
      browsers: [...browsers.values()].filter(browser => browser.ready).length, clients: clients.size, upgrade_error: upgradeError,
      extensions: [...browsers.values()].map(browser => ({ instance_id: browser.info.instance_id, version: browser.info.extension_version, ready: browser.ready, error: browser.upgradeError })) }));
    else if (request.url === '/upgrade' && request.method === 'POST') {
      try {
        const target = request.headers['x-browser-attach-version'];
        if (compareVersions(target, VERSION) <= 0) { response.writeHead(409).end(JSON.stringify({ error: 'Upgrade target must be newer than this Hub' })); return; }
        if (state !== 'ready' || clients.size || cleanups.size || [...browsers.values()].some(browser => browser.pending.size)) {
          response.writeHead(409).end(JSON.stringify({ error: 'Hub is in use; close other MCP connections and retry the upgrade' })); return;
        }
        state = 'upgrading';
        upgradeError = undefined;
        const connected = [...browsers.values()];
        const outcomes = await Promise.allSettled(connected.map(async browser => {
          const result = await requestBrowser(browser, null, 'prepare_upgrade', {}, 8000);
          if (result.errors?.length || result.prepared !== true) throw new Error(result.errors?.join('; ') || 'Extension did not confirm cleanup');
        }));
        const failed = outcomes.find(item => item.status === 'rejected');
        if (failed) {
          await Promise.allSettled(connected.map(browser => requestBrowser(browser, null, 'resume', {}, 1000)));
          upgradeError = `Extension cleanup failed: ${failed.reason.message}`;
          state = 'ready'; throw new Error(upgradeError);
        }
        response.end(JSON.stringify({ stopping: true, extensions: connected.map(browser => browser.info.instance_id) }));
        setImmediate(() => close());
      } catch (error) { response.writeHead(409).end(JSON.stringify({ error: error.message })); }
    }
    else if (request.url === '/shutdown' && request.method === 'POST') {
      response.end('{"stopping":true}'); setImmediate(() => close());
    } else response.writeHead(404).end();
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE });
  server.on('upgrade', (request, socket, head) => {
    const extension = request.url === '/extension';
    const valid = extension ? request.headers.origin === `chrome-extension://${config.extension_id}`
      : request.url === '/client' && !request.headers.origin && bearer(request) && request.headers['x-browser-attach-version'] === VERSION;
    if (!valid) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    if (state !== 'ready') { socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); return; }
    wss.handleUpgrade(request, socket, head, ws => {
      ws.on('pong', () => { ws.isAlive = true; });
      if (extension) connectExtension(ws); else connectClient(ws);
    });
  });
  function connectExtension(ws) {
    let browser;
    const helloTimer = setTimeout(() => ws.close(1008, 'Pairing timeout'), 5000);
    ws.on('error', () => {});
    ws.on('message', raw => {
      try {
        const data = JSON.parse(raw.toString());
        if (!browser) {
          if (state !== 'ready') { ws.close(1013, 'Hub is preparing an upgrade'); return; }
          const info = data.browser;
          if (data.type !== 'hello' || !authorized(data.token) || !info || !['chrome', 'edge'].includes(info.family) ||
              !['instance_id', 'run_id', 'profile_name'].every(key => typeof info[key] === 'string' && info[key].length >= 1 && info[key].length <= 128))
            throw new Error('Invalid pairing or browser identity');
          const id = `${info.instance_id}:${info.run_id}`;
          if (browsers.has(id)) throw new Error('Browser instance is already connected');
          const comparison = compareVersions(info.extension_version, VERSION);
          if (comparison > 0) throw new Error('Extension is newer than this Hub');
          browser = { id, ws, info, ready: comparison === 0, pending: new Map() };
          browsers.set(id, browser); clearTimeout(helloTimer);
          if (browser.ready) send(ws, { type: 'connected', browser_id: id });
          else requestBrowser(browser, null, 'reload_extension', { version: VERSION }).catch(error => { browser.upgradeError = error.message; });
          return;
        }
        if (data.type === 'ping') send(ws, { type: 'pong' });
        else if (browser.ready && data.type === 'detached') forget(tabClaims.get(keyFor(browser.id, data.tab_id)));
        else if (browser.pending.has(data.id)) {
          const pending = browser.pending.get(data.id); browser.pending.delete(data.id);
          if ('error' in data) pending.reject(errorFromData(data)); else pending.resolve(data.result || {});
        }
      } catch { ws.close(1008, 'Invalid extension message'); }
    });
    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (!browser || browsers.get(browser.id) !== browser) return;
      browsers.delete(browser.id);
      for (const pending of browser.pending.values()) pending.reject(new Error('Browser disconnected; observe again after reconnecting'));
      browser.pending.clear();
      for (const [handle, claim] of claims) if (claim.browser_id === browser.id) forget(handle);
    });
  }
  function connectClient(ws) {
    clients.add(ws);
    const owner = randomUUID(), observed = new Map();
    let chain = Promise.resolve(), disconnected = false;
    ws.on('error', () => {});
    ws.on('message', raw => {
      chain = chain.then(async () => {
        if (disconnected) return;
        let data;
        try {
          data = JSON.parse(raw.toString());
          const result = await execute(owner, observed, data.method, data.arguments || {});
          send(ws, { id: data.id, result });
        } catch (error) {
          send(ws, { id: data?.id, ...errorData(error) });
          if (error instanceof OperationTimeout) { disconnected = true; ws.close(1011, 'Operation timeout'); }
        }
      });
    });
    ws.on('close', () => {
      disconnected = true; clients.delete(ws);
      const cleanup = chain.then(async () => {
        await Promise.allSettled([...browsers.values()].filter(browser => browser.ready).map(async browser => {
          const result = await requestBrowser(browser, owner, 'release_owner', {});
          if (!result.errors?.length) for (const [handle, claim] of claims) if (claim.owner === owner && claim.browser_id === browser.id) forget(handle);
        }));
      }).finally(() => cleanups.delete(cleanup));
      cleanups.add(cleanup);
    });
  }
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false; ws.ping();
    }
  }, 25000);
  async function close() {
    if (closing) return closing;
    closing = (async () => {
      state = 'stopping';
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.close(1001, 'Hub stopped');
      const timer = setTimeout(() => { for (const ws of wss.clients) ws.terminate(); }, 1000);
      await new Promise(resolve => wss.close(resolve)); clearTimeout(timer);
      await new Promise(resolve => server.close(resolve));
    })();
    return closing;
  }
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    config.port = server.address().port;
    if (config.extension_dir) await syncExtension(config);
    state = 'ready';
  } catch (error) { await close(); throw error; }
  return { server, close, port: server.address().port, claims, browsers };
}
