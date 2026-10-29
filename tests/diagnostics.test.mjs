import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiagnostics } from '../extension/diagnostics.js';
import { boundedBody } from '../extension/log-data.js';
import { createNetworkTracker } from '../extension/network.js';

test('API discovery filters exact origins/types/methods/status and correlates bounded request summaries', () => {
  const f = fixture();
  const request = (id, url, type = 'Fetch', source = { tabId: 9 }) => f.emit('Network.requestWillBeSent', { requestId: id, type, frameId: 'main', request: { url, method: 'POST' } }, source);
  request('api', 'https://jobs.test/api/search');
  f.emit('Network.responseReceived', { requestId: 'api', type: 'Fetch', response: { status: 200, url: 'https://jobs.test/api/search', mimeType: 'application/json' } });
  f.emit('Network.loadingFinished', { requestId: 'api', encodedDataLength: 100 });
  request('analytics', 'https://analytics.test/api');
  request('image', 'https://jobs.test/api/image', 'Image');
  request('api', 'https://jobs.test/api/remote', 'XHR', { tabId: 9, sessionId: 'remote' });
  const query = { view: 'requests', resource_types: ['XHR', 'Fetch'], url_origin: 'https://jobs.test', method: 'post' };
  const summary = f.read('network', { ...query, status: 200 });
  assert.equal(summary.entries.length, 1);
  const api = summary.entries[0];
  assert.equal(api.request_id, 'api'); assert.equal(api.last_event, 'finished'); assert.equal(api.status, 200);
  assert.deepEqual(api.events, ['request', 'response', 'finished']); assert.equal(api.first_seq, 1);
  assert.equal(api.session_id, null); assert.equal(api.hop, 0); assert.equal(api.response_body, undefined);
  const details = f.read('network', { view: 'events', request_id: api.request_id, session_id: api.session_id, hop: api.hop });
  assert.deepEqual(details.entries.map(item => item.event), ['request', 'response', 'finished']);
  assert.equal(f.read('network', { ...query, session_id: 'remote' }).entries.length, 1);
  const all = f.read('network', query);
  assert.equal(all.entries.length, 2);
  const none = f.read('network', { ...query, after_seq: all.next_seq });
  assert.equal(none.entries.length, 0);
  f.emit('Network.responseReceived', { requestId: 'api', type: 'XHR', response: { status: 201, url: 'https://jobs.test/api/remote' } }, { tabId: 9, sessionId: 'remote' });
  const update = f.read('network', { ...query, after_seq: none.next_seq });
  assert.equal(update.entries.length, 1); assert.equal(update.entries[0].status, 201);
  for (const args of [{ kind: 'console', view: 'requests' }, { kind: 'network', view: 'requests', event: 'body' },
    { kind: 'network', url_origin: 'https://jobs.test/path' }, { kind: 'network', url_origin: 'https://user@jobs.test' },
    { kind: 'network', resource_types: [] }, { kind: 'network', status: 999 }, { kind: 'network', method: 'POST\nGET' }]) assert.throws(() => f.logs.read(9, args));
});

test('summary pagination orders by last evidence, preserves redirect hops and reports eviction without another network state', () => {
  const f = fixture();
  const emit = (id, url) => f.emit('Network.requestWillBeSent', { requestId: id, type: 'Fetch', request: { url, method: 'GET' } });
  emit('redirect', 'https://a.test/');
  f.emit('Network.requestWillBeSent', { requestId: 'redirect', type: 'Fetch', request: { url: 'https://b.test/', method: 'GET' }, redirectResponse: { url: 'https://a.test/', status: 302 } });
  let first = f.read('network', { view: 'requests', limit: 1 });
  assert.equal(first.entries[0].hop, 0); assert.equal(first.entries[0].status, 302); assert.equal(first.has_more, true);
  const second = f.read('network', { view: 'requests', limit: 1, after_seq: first.next_seq });
  assert.equal(second.entries[0].hop, 1); assert.equal(second.has_more, false);
  for (let i = 0; i < 510; i++) emit(String(i), 'https://noise.test/');
  first = f.read('network', { view: 'requests', url_origin: 'https://a.test' });
  assert.equal(first.entries.length, 0); assert.equal(first.data_loss, true); assert.ok(first.recovery.includes('cannot recover'));
});

function fixture() {
  const network = createNetworkTracker(); network.start(9);
  const logs = createDiagnostics(); logs.start(9);
  return { logs, network, emit: (method, params, source = { tabId: 9 }) => logs.event(source, method, params, network.event(source, method, params)),
    read: (kind, args = {}) => logs.read(9, { kind, ...args }) };
}

test('HTTP error metadata correlates failure, response headers and late ExtraInfo without crossing sessions or redirect statuses', () => {
  const f = fixture();
  f.emit('Network.responseReceived', { requestId: 'r', type: 'Document', frameId: 'main', loaderId: 'original',
    response: { status: 503, url: 'https://fixture.test/error', mimeType: 'text/html' } });
  f.emit('Network.loadingFailed', { requestId: 'r', errorText: 'net::ERR_HTTP_RESPONSE_CODE_FAILURE' });
  assert.equal(f.network.failedDocument(9, 'main').empty_body, false);
  f.emit('Network.responseReceivedExtraInfo', { requestId: 'r', statusCode: 302, headers: { 'Content-Length': '0' } });
  f.emit('Network.responseReceivedExtraInfo', { requestId: 'r', statusCode: 503, headers: { 'Content-Length': '0' } }, { tabId: 9, sessionId: 'other' });
  assert.equal(f.network.failedDocument(9, 'main').empty_body, false);
  f.emit('Network.responseReceivedExtraInfo', { requestId: 'r', statusCode: 503, headers: { 'content-length': '0' } });
  const failed = f.network.failedDocument(9, 'main');
  assert.equal(failed.status, 503); assert.equal(failed.empty_body, true); assert.equal(failed.contentType, 'text/html');
  assert.equal(f.network.documentStatus(9, { id: 'main', loaderId: 'error-page' }), null);
  f.emit('Network.loadingFailed', { requestId: 'r', errorText: 'net::ERR_ABORTED' });
  assert.equal(f.network.failedDocument(9, 'main').error, 'net::ERR_HTTP_RESPONSE_CODE_FAILURE');
  f.emit('Network.requestWillBeSent', { requestId: 'next', type: 'Document', frameId: 'main', request: { url: 'https://fixture.test/next', method: 'GET' } });
  assert.equal(f.network.failedDocument(9, 'main'), null);
  f.emit('Network.requestWillBeSent', { requestId: 'early', type: 'Document', frameId: 'main', request: { url: 'https://fixture.test/early', method: 'GET' } });
  f.emit('Network.responseReceivedExtraInfo', { requestId: 'early', statusCode: 503, headers: { 'content-length': '0' } });
  f.emit('Network.responseReceived', { requestId: 'early', type: 'Document', frameId: 'main', loaderId: 'early', response: { status: 503, url: 'https://fixture.test/early', mimeType: 'text/html' } });
  f.emit('Network.loadingFailed', { requestId: 'early', errorText: 'net::ERR_HTTP_RESPONSE_CODE_FAILURE' });
  assert.equal(f.network.failedDocument(9, 'main').empty_body, true);
});

test('document status matches the frame and loader, survives log eviction and expires with the document or claim', () => {
  const f = fixture(), main = { id: 'main', loaderId: 'document' };
  const response = (frameId, loaderId, status, source) => f.emit('Network.responseReceived', { requestId: frameId, type: 'Document', frameId, loaderId, response: { status, url: 'https://fixture.test/' } }, source);
  assert.equal(f.network.documentStatus(9, main), null);
  response('main', 'document', 404);
  response('child', 'document', 500);
  response('main', 'document', 403, { tabId: 9, sessionId: 'remote' });
  assert.equal(f.network.documentStatus(9, main), 404);
  assert.equal(f.network.documentStatus(9, { id: 'main', loaderId: 'other' }), null);
  assert.equal(f.network.documentStatus(9, { id: 'main' }), null);
  for (let i = 0; i < 700; i++) f.emit('Network.responseReceived', { requestId: String(i), type: 'Fetch', response: { status: 200, url: 'https://fixture.test/api' } });
  assert.equal(f.network.documentStatus(9, main), 404);
  f.emit('Network.requestWillBeSent', { requestId: 'next', type: 'Document', frameId: 'main', request: { url: 'https://fixture.test/next', method: 'GET' } });
  assert.equal(f.network.documentStatus(9, main), null);
  response('main', 'document', 200);
  f.logs.forget(9); f.network.forget(9);
  assert.equal(f.network.documentStatus(9, main), null);
});

test('unified log query requires a kind and refuses irrelevant filters', () => {
  const f = fixture();
  for (const kind of [undefined, '', 'all', '__proto__']) assert.throws(() => f.read(kind), /kind must be console, network or navigation/);
  assert.throws(() => f.read('console', { url_contains: '' }), /only valid for kind=network/);
  assert.throws(() => f.read('network', { level: 'error' }), /only valid for kind=console/);
  assert.throws(() => f.read('console', { level: 'unknown' }), /console level/);
  assert.throws(() => f.read('network', { url_contains: 5 }), /url_contains/);
  assert.equal(f.read('console').kind, 'console');
  assert.equal(f.read('network').kind, 'network');
  assert.equal(f.read('navigation').kind, 'navigation');
  assert.throws(() => f.read('navigation', { level: 'error' }), /only valid for kind=console/);
  assert.throws(() => f.read('navigation', { url_contains: '' }), /only valid for kind=network/);
  assert.throws(() => f.read('navigation', { capture: { enabled: true } }), /only valid for network/);
});

test('navigation preserves requests separately from commits, same-document changes and child-session identity', () => {
  const f = fixture();
  f.emit('Page.frameRequestedNavigation', { frameId: 'main', url: 'https://fixture.test/cancelled', reason: 'anchorClick', disposition: 'newTab' });
  f.emit('Page.frameRequestedNavigation', { frameId: 'main', url: 'about:blank', reason: 'scriptInitiated', disposition: 'currentTab' });
  f.emit('Page.frameNavigated', { frame: { id: 'main', loaderId: 'blank-document', url: 'about:blank' }, type: 'Navigation' });
  f.emit('Page.navigatedWithinDocument', { frameId: 'main', url: 'about:blank#fragment', navigationType: 'fragment' });
  f.emit('Page.frameNavigated', { frame: { id: 'child', parentId: 'main', loaderId: 'child-document', url: 'chrome-error://chromewebdata/', unreachableUrl: 'https://fixture.test/failed' }, type: 'Navigation' }, { tabId: 9, sessionId: 'oopif' });
  const page = f.read('navigation', { limit: 2 });
  assert.deepEqual(page.entries.map(row => row.event), ['requested', 'requested']);
  assert.deepEqual(page.entries.map(row => row.reason), ['anchorClick', 'scriptInitiated']);
  assert.equal(page.entries[0].disposition, 'newTab');
  assert.equal(page.has_more, true);
  const next = f.read('navigation', { after_seq: page.next_seq });
  assert.deepEqual(next.entries.map(row => row.event), ['committed', 'same_document', 'committed']);
  assert.equal(next.entries[0].loader_id, 'blank-document');
  assert.equal(next.entries[0].parent_frame_id, null);
  assert.equal(next.entries[1].navigation_type, 'fragment');
  assert.equal(next.entries[2].session_id, 'oopif');
  assert.equal(next.entries[2].parent_frame_id, 'main');
  assert.equal(next.entries[2].unreachable_url, 'https://fixture.test/failed');
  assert.ok(next.entries.every(row => Number.isFinite(row.observed_at) && !('timestamp' in row) && !('reason' in row)));
  assert.equal(f.read('console').entries.length, 0);
  assert.equal(f.read('network').entries.length, 0);
});

test('navigation eviction and lifecycle stay independent of network and console buffers', () => {
  const f = fixture();
  f.emit('Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'retained' }] });
  f.emit('Network.requestWillBeSent', { requestId: 'r', request: { url: 'https://fixture.test/', method: 'GET' } });
  for (let i = 0; i < 700; i++) f.emit('Page.navigatedWithinDocument', { frameId: 'main', url: `https://fixture.test/#${i}` });
  const page = f.read('navigation', { limit: 1 });
  assert.equal(page.entries[0].seq, 201); assert.equal(page.data_loss, true);
  assert.equal(page.dropped_through_seq, 200);
  assert.equal(f.read('console').entries[0].text, 'retained');
  assert.equal(f.read('network').entries[0].request_id, 'r');
  f.logs.detach(9, 'oopif');
  assert.equal(f.read('navigation').latest_seq, 700);
  f.logs.forget(9);
  assert.throws(() => f.read('navigation'), /unavailable/);
  f.logs.start(9);
  assert.equal(f.read('navigation').latest_seq, 0);
});

test('bounded stacks preserve asynchronous boundaries and network initiators without retaining remote ids or request secrets', () => {
  const f = fixture();
  const frame = { functionName: 'report', scriptId: 'script-1', url: 'https://fixture.test/security.js', lineNumber: 7, columnNumber: 2, objectId: 'private-handle' };
  const trace = { callFrames: [frame], parent: { callFrames: [frame], parentId: { id: 'private-stack-id' } } };
  f.emit('Runtime.consoleAPICalled', { type: 'trace', args: [], stackTrace: trace });
  f.emit('Runtime.exceptionThrown', { exceptionDetails: { text: 'failure', stackTrace: trace } });
  f.emit('Log.entryAdded', { entry: { level: 'error', source: 'javascript', text: 'failure', stackTrace: trace, networkRequestId: 'r' } });
  f.emit('Network.requestWillBeSent', { requestId: 'r', frameId: 'main', loaderId: 'document-1', type: 'Fetch',
    request: { url: 'https://fixture.test/report', method: 'POST', headers: { Cookie: 'secret-cookie' }, postData: 'secret-body' },
    initiator: { type: 'script', url: frame.url, lineNumber: 7, columnNumber: 2, requestId: 'parent-request', stack: trace } });
  const consoleRows = f.read('console').entries, request = f.read('network').entries[0];
  for (const row of [...consoleRows, request.initiator]) {
    assert.deepEqual(row.stack.map(item => item.async_depth), [0, 1]);
    assert.equal(row.stack[0].script_id, 'script-1');
    assert.equal(row.stack[0].line, 7); assert.equal(row.stack_truncated, true);
  }
  assert.equal(consoleRows[2].request_id, 'r');
  assert.equal(request.initiator.type, 'script'); assert.equal(request.initiator.request_id, 'parent-request');
  assert.equal(request.loader_id, 'document-1');
  assert.doesNotMatch(JSON.stringify({ consoleRows, request }), /private-handle|private-stack-id|secret-cookie|secret-body/);
  f.emit('Network.loadingFinished', { requestId: 'r' });
  const finished = f.read('network').entries[1];
  assert.equal(finished.loader_id, 'document-1');
  assert.equal(finished.initiator, undefined);
});

test('stack frame count, parent traversal and strings are bounded with explicit truncation', () => {
  const f = fixture();
  const frame = { functionName: 'f'.repeat(10000), url: 'u'.repeat(10000), scriptId: 's'.repeat(10000) };
  const emit = stackTrace => f.emit('Runtime.consoleAPICalled', { type: 'trace', args: [], stackTrace });
  emit({ callFrames: Array(9).fill(frame) });
  emit({ callFrames: [], parent: { callFrames: [], parent: { callFrames: [], parent: { callFrames: [frame] } } } });
  emit({ callFrames: [frame], parent: { callFrames: [frame] } });
  emit({ callFrames: Array(8).fill(frame) });
  const rows = f.read('console', { max_chars: 100000 }).entries;
  assert.equal(rows[0].stack.length, 8); assert.equal(rows[0].stack_truncated, true);
  assert.equal(rows[1].stack.length, 0); assert.equal(rows[1].stack_truncated, true);
  assert.equal(rows[2].stack.length, 2); assert.equal(rows[2].stack_truncated, false);
  assert.equal(rows[3].stack.length, 8); assert.equal(rows[3].stack_truncated, false);
  assert.ok(rows[0].stack.every(item => item.function.length <= 200 && item.url.length <= 2000 && item.script_id.length <= 100));
});

test('network traffic cannot evict console messages; kind-specific cursors and loss stay independent', () => {
  const f = fixture();
  f.emit('Runtime.consoleAPICalled', { type: 'error', args: [{ value: 'retained console error' }] });
  const consolePage = f.read('console');
  for (let i = 0; i < 700; i++) f.emit('Network.requestWillBeSent', { requestId: String(i), request: { url: 'https://fixture.test/api', method: 'GET' } });
  const networkPage = f.read('network', { limit: 1 });
  assert.equal(networkPage.kind, 'network'); assert.equal(networkPage.entries[0].seq, 201);
  assert.equal(networkPage.data_loss, true); assert.equal(networkPage.dropped_through_seq, 200);
  assert.equal(f.read('console').entries[0].text, 'retained console error');
  f.emit('Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'later console' }] });
  const nextConsole = f.read('console', { after_seq: consolePage.next_seq });
  assert.equal(nextConsole.kind, 'console'); assert.equal(nextConsole.data_loss, false);
  assert.deepEqual(nextConsole.entries.map(entry => entry.text), ['later console']);
  assert.equal(nextConsole.next_seq, 2); assert.equal(nextConsole.dropped_through_seq, 0);
  const nextNetwork = f.read('network', { after_seq: networkPage.next_seq, limit: 1 });
  assert.equal(nextNetwork.entries[0].seq, 202); assert.equal(nextNetwork.data_loss, false);
});

test('network lifecycle is append-only and correlates redirects without retaining headers or bodies', () => {
  const f = fixture();
  f.emit('Network.requestWillBeSent', { requestId: 'r1', timestamp: 1, request: { url: 'https://fixture.test/start', method: 'POST', headers: { Cookie: 'secret' }, postData: 'secret-body' }, type: 'Fetch', frameId: 'main' });
  const first = f.read('network');
  assert.equal(first.entries[0].event, 'request');
  f.emit('Network.requestWillBeSent', { requestId: 'r1', timestamp: 2, redirectResponse: { url: 'https://fixture.test/start', status: 302 }, request: { url: 'https://fixture.test/end', method: 'GET' } });
  f.emit('Network.responseReceived', { requestId: 'r1', timestamp: 3, response: { url: 'https://fixture.test/end', status: 404, mimeType: 'text/html', headers: { 'Set-Cookie': 'secret' }, fromServiceWorker: true } });
  f.emit('Network.loadingFinished', { requestId: 'r1', timestamp: 4, encodedDataLength: 123 });
  const next = f.read('network', { after_seq: first.next_seq });
  assert.deepEqual(next.entries.map(row => row.event), ['redirect', 'request', 'response', 'finished']);
  assert.deepEqual(next.entries.map(row => row.hop), [0, 1, 1, 1]);
  assert.equal(next.entries[2].status, 404); assert.equal(next.entries[2].from_service_worker, true);
  assert.ok(!JSON.stringify(next).includes('secret'));
  assert.equal(next.has_more, false);
  f.emit('Network.loadingFailed', { requestId: 'unknown', errorText: 'net::ERR_FAILED', canceled: true });
  const failed = f.read('network', { after_seq: next.next_seq });
  assert.equal(failed.entries[0].error, 'net::ERR_FAILED');
  assert.equal(failed.entries[0].canceled, true);
});

test('console collects previews, errors/rejections and browser messages; excludes old and unclaimed events and records child sessions', () => {
  const f = fixture();
  f.emit('Runtime.consoleAPICalled', { type: 'warn', timestamp: 1, args: [{ value: 'historical' }] });
  f.emit('Runtime.consoleAPICalled', { type: 'warn', executionContextId: 0, args: [{ value: 'removed context' }] });
  f.emit('Runtime.consoleAPICalled', { type: 'warn', args: [{ value: 'child' }] }, { tabId: 9, sessionId: 'child' });
  f.emit('Runtime.consoleAPICalled', { type: 'warn', args: [{ value: 'other tab' }] }, { tabId: 10 });
  const args = [{ value: 'warning' }, { type: 'object', objectId: 'private-handle', description: 'Object', preview: { properties: [{ name: 'x', value: '42' }] } }];
  f.emit('Runtime.consoleAPICalled', { type: 'warning', args, stackTrace: { callFrames: [{ url: 'https://fixture.test/', lineNumber: 10, columnNumber: 2 }] } });
  f.emit('Runtime.exceptionThrown', { exceptionDetails: { text: 'Uncaught (in promise)', exception: { description: 'Error: rejected' } } });
  f.emit('Log.entryAdded', { entry: { level: 'error', source: 'network', text: 'browser failure' } });
  const child = f.read('console').entries[0];
  assert.equal(child.session_id, 'child');
  const result = f.read('console', { after_seq: 1 });
  assert.equal(result.entries.length, 3); assert.equal(result.entries[0].level, 'warning');
  assert.match(result.entries[0].text, /x: 42/); assert.equal(result.entries[0].location.line, 10);
  assert.ok(!JSON.stringify(result).includes('private-handle'));
  assert.equal(f.read('console', { level: 'error' }).entries.length, 2);
});

test('log pagination never skips retained records; overflow is explicit and responses obey character budget', () => {
  const f = fixture();
  for (let i = 0; i < 700; i++) f.emit('Runtime.consoleAPICalled', { type: 'log', args: [{ value: `entry ${i}` }] });
  let page = f.read('console', { limit: 37 }), count = page.entries.length;
  assert.equal(page.data_loss, true); assert.equal(page.dropped_through_seq, 200);
  while (page.has_more) {
    page = f.read('console', { after_seq: page.next_seq, limit: 37 });
    assert.equal(page.data_loss, false); count += page.entries.length;
  }
  assert.equal(count, 500); assert.equal(page.next_seq, 700);
  f.emit('Runtime.consoleAPICalled', { type: 'error', args: [{ value: '"\\'.repeat(10000) }] });
  const huge = f.read('console', { after_seq: 700, max_chars: 1000 });
  assert.equal(huge.entries[0].truncated, true); assert.ok(JSON.stringify(huge.entries).length <= 1000);
  assert.equal(huge.next_seq, 701);
  assert.throws(() => f.read('console', { after_seq: 10000 }), /after_seq/);
  assert.throws(() => f.read('console', { max_chars: 2 }), /max_chars/);
  f.logs.forget(9); f.network.forget(9); assert.throws(() => f.read('console'), /unavailable/);
});

test('filters advance cursor through unmatched events and character budget evicts large messages', () => {
  const f = fixture();
  for (let i = 0; i < 300; i++) f.emit('Runtime.consoleAPICalled', { type: 'log', args: Array.from({ length: 4 }, () => ({ value: 'x'.repeat(2000) })) });
  const filtered = f.read('console', { level: 'error' });
  assert.equal(filtered.entries.length, 0); assert.equal(filtered.next_seq, 300);
  assert.equal(filtered.has_more, false); assert.ok(filtered.dropped_through_seq > 0);
  f.emit('Network.requestWillBeSent', { requestId: 'a', request: { url: 'https://fixture.test/api', method: 'GET' } });
  f.emit('Network.requestWillBeSent', { requestId: 'b', request: { url: 'https://fixture.test/image', method: 'GET' } });
  const network = f.read('network', { url_contains: '/api' });
  assert.equal(network.entries.length, 1); assert.equal(network.next_seq, 2);
});

test('identical child/root request and context ids retain independent ownership', () => {
  const f = fixture();
  for (const [sessionId, frameId] of [[undefined, 'main'], ['child', 'remote']]) {
    const source = { tabId: 9, ...(sessionId ? {sessionId} : {}) };
    f.emit('Runtime.executionContextCreated', { context: {id:42,auxData:{frameId}} }, source);
    f.emit('Runtime.consoleAPICalled', { executionContextId:42, type:'log', args:[{value:frameId}] }, source);
    f.emit('Network.requestWillBeSent', {requestId:'same',frameId,request:{url:`https://${frameId}.test/`,method:'GET'}}, source);
  }
  f.emit('Network.loadingFinished', {requestId:'same'}, {tabId:9});
  f.emit('Network.loadingFailed', {requestId:'same',errorText:'child failed'}, {tabId:9,sessionId:'child'});
  const consoleRows = f.read('console').entries;
  assert.deepEqual(consoleRows.map(row => row.frame_id), ['main','remote']);
  const finished = f.read('network').entries.slice(2);
  assert.deepEqual(finished.map(row => row.url), ['https://main.test/','https://remote.test/']);
  assert.deepEqual(finished.map(row => row.session_id), [null,'child']);
  f.logs.detach(9,'child'); f.network.detach(9,'child');
  f.emit('Runtime.consoleAPICalled', {executionContextId:42,type:'log',args:[]}, {tabId:9,sessionId:'child'});
  assert.equal(f.read('console').entries.at(-1).frame_id, undefined);
});


test('network details are opt-in, redact credentials, retain method/status and bound request/response bodies', async () => {
  const calls=[];const logs=createDiagnostics(async(target,method,args)=>{calls.push({method,args});return method==='Network.getResponseBody'?{body:'{"field":"kept","Authorization":"hidden-response"}',base64Encoded:false}:{};});
  const network = createNetworkTracker();
  const emit = (source, method, params) => logs.event(source, method, params, network.event(source, method, params));
  logs.start(9); network.start(9);const source={tabId:9};
  emit(source,'Network.requestWillBeSent',{requestId:'old',type:'Fetch',request:{url:'https://test/api',method:'POST',headers:{Authorization:'secret'},postData:'old-secret'}});
  assert.equal(logs.read(9,{kind:'network'}).entries[0].headers,undefined);
  await logs.readDetails(9,{kind:'network',capture:{enabled:true,max_body_bytes:1024}},[source]);
  emit(source,'Network.requestWillBeSent',{requestId:'new',type:'Fetch',request:{url:'https://test/api',method:'POST',headers:{Authorization:'Bearer hidden',Cookie:'session=hidden','X-Safe':'kept'},postData:'{"password":"hidden-password","field":"kept"}'}});
  emit(source,'Network.responseReceived',{requestId:'new',response:{url:'https://test/api',status:201,headers:{'Set-Cookie':'hidden-cookie'},mimeType:'application/json'}});
  emit(source,'Network.dataReceived',{requestId:'new',dataLength:60});
  emit(source,'Network.loadingFinished',{requestId:'new'});
  const result=await logs.readDetails(9,{kind:'network',max_chars:100000},[source]);
  assert.ok(result.entries.some(e=>e.method==='POST'&&e.request_body?.text.includes('kept')));
  assert.ok(result.entries.some(e=>e.status===201));assert.ok(result.entries.some(e=>e.response_body?.text.includes('kept')));
  assert.doesNotMatch(JSON.stringify(result),/Bearer hidden|hidden-password|hidden-cookie|hidden-response/);
  assert.equal(calls.filter(c=>c.method==='Network.getResponseBody').length,1);
  assert.equal(calls.find(c=>c.method==='Network.enable').args.maxResourceBufferSize,1024);
  await logs.readDetails(9,{kind:'network',capture:{enabled:false}},[source]);
  assert.equal(logs.networkOptions(9).maxTotalBufferSize,0);
});

test('oversized decoded responses are reported without fetching an unbounded decompressed body', async () => {
  let bodyReads=0;const logs=createDiagnostics(async(target,method)=>{if(method==='Network.getResponseBody')bodyReads++;return {};});
  const network = createNetworkTracker();
  const emit = (source, method, params) => logs.event(source, method, params, network.event(source, method, params));
  logs.start(9); network.start(9);const source={tabId:9};await logs.readDetails(9,{kind:'network',capture:{enabled:true,max_body_bytes:1024}},[source]);
  emit(source,'Network.requestWillBeSent',{requestId:'r',type:'XHR',request:{url:'https://test/',method:'GET'}});
  emit(source,'Network.dataReceived',{requestId:'r',dataLength:10000000});emit(source,'Network.loadingFinished',{requestId:'r',encodedDataLength:20});
  const result=await logs.readDetails(9,{kind:'network'},[source]);
  assert.equal(bodyReads,0);assert.ok(result.entries.some(e=>/exceeds capture/.test(e.response_body_unavailable)));
  assert.ok(boundedBody('x'.repeat(2000),1024).truncated);
  assert.doesNotMatch(boundedBody('password=hidden&field=kept',1024).text,/hidden/);
});

test('late response body reads cannot recreate data after release or capture reconfiguration', async () => {
  let finish;const logs=createDiagnostics(async(target,method)=>method==='Network.getResponseBody'?new Promise(resolve=>{finish=resolve}):{});
  const network = createNetworkTracker();
  const emit = (source, method, params) => logs.event(source, method, params, network.event(source, method, params));
  const source={tabId:9};logs.start(9); network.start(9);await logs.readDetails(9,{kind:'network',capture:{enabled:true}},[source]);
  emit(source,'Network.requestWillBeSent',{requestId:'r',type:'Fetch',request:{url:'https://test/',method:'GET'}});
  emit(source,'Network.loadingFinished',{requestId:'r'});logs.forget(9);finish({body:'late',base64Encoded:false});
  await new Promise(resolve=>setImmediate(resolve));logs.start(9); network.start(9);
  assert.equal(logs.read(9,{kind:'network'}).entries.length,0);assert.equal(logs.networkOptions(9).maxTotalBufferSize,0);
});
