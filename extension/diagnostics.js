import { clip, redactHeaders, boundedBody } from './log-data.js';

const MAX_ENTRIES = 500, MAX_CHARS = 1024 * 1024;

function buffer() {
  const entries = [];
  let sequence = 0, chars = 0, droppedThrough = 0;
  return {
    add(entry) {
      const record = { seq: ++sequence, ...entry };
      const size = JSON.stringify(record).length;
      entries.push({ record, size }); chars += size;
      while (entries.length > MAX_ENTRIES || chars > MAX_CHARS) {
        const removed = entries.shift(); chars -= removed.size; droppedThrough = removed.record.seq;
      }
    },
    read(args, matches) {
      const after = args.after_seq ?? 0, limit = args.limit ?? 100, maxChars = args.max_chars ?? 24000;
      if (!Number.isSafeInteger(after) || after < 0 || after > sequence) throw new Error('after_seq must be a sequence from this claim (0 starts reading)');
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('limit must be 1..200');
      if (!Number.isInteger(maxChars) || maxChars < 1000 || maxChars > 100000) throw new Error('max_chars must be 1000..100000');
      const result = [];
      let next = Math.max(after, droppedThrough), used = 2;
      for (const { record, size } of entries) {
        if (record.seq <= after) continue;
        if (!matches(record)) { next = record.seq; continue; }
        if (result.length >= limit || (used + size + 1 > maxChars && result.length)) break;
        const output = size + used + 1 <= maxChars ? record : {
          seq: record.seq, truncated: true, serialized_preview: JSON.stringify(record).slice(0, Math.floor((maxChars - 150) / 6)),
        };
        result.push(output); used += JSON.stringify(output).length + 1; next = record.seq;
      }
      return { entries: result, next_seq: next, latest_seq: sequence, has_more: next < sequence,
        data_loss: after < droppedThrough, dropped_through_seq: droppedThrough };
    },
  };
}

function remoteText(arg) {
  if ('value' in arg) return clip(typeof arg.value === 'string' ? arg.value : JSON.stringify(arg.value));
  if (arg.unserializableValue) return clip(arg.unserializableValue);
  if (arg.preview?.properties?.length) return clip(`${arg.description || arg.type} {${arg.preview.properties.slice(0, 10)
    .map(property => `${clip(property.name, 100)}: ${clip(property.value ?? property.type, 100)}`).join(', ')}}`);
  return clip(arg.description || arg.type);
}

function location(frame = {}) {
  return { url: clip(frame.url), line: frame.lineNumber, column: frame.columnNumber };
}

function stackData(trace) {
  if (!trace) return {};
  const stack = [];
  let depth = 0, truncated = false;
  while (trace) {
    const frames = trace.callFrames || [], available = 8 - stack.length;
    for (const frame of frames.slice(0, available)) stack.push({
      function: clip(frame.functionName, 200), ...location(frame),
      script_id: clip(frame.scriptId, 100), async_depth: depth,
    });
    if (frames.length > available || trace.parentId) truncated = true;
    if (!trace.parent) break;
    if (stack.length >= 8 || depth >= 2) { truncated = true; break; }
    trace = trace.parent; depth++;
  }
  return { stack, stack_truncated: truncated };
}

function initiatorData(initiator) {
  if (!initiator) return {};
  return { initiator: { type: clip(initiator.type, 100),
    ...(initiator.url != null ? location(initiator) : {}),
    ...(initiator.requestId != null ? { request_id: clip(initiator.requestId, 200) } : {}),
    ...stackData(initiator.stack) } };
}

function validateQuery(args) {
  if (!['console', 'network', 'navigation'].includes(args.kind)) throw new Error('kind must be console, network or navigation');
  if (args.kind !== 'network' && args.capture != null) throw new Error('capture is only valid for network logs');
  if (args.kind !== 'network' && args.url_contains != null) throw new Error('url_contains is only valid for kind=network');
  if (args.kind !== 'console' && args.level != null) throw new Error('level is only valid for kind=console');
  if (args.level != null && !['log', 'debug', 'info', 'warning', 'error'].includes(args.level)) throw new Error('Invalid console level');
  if (args.url_contains != null && (typeof args.url_contains !== 'string' || args.url_contains.length > 2000)) throw new Error('url_contains must be at most 2000 characters');
}

export function createDiagnostics(cdp) {
  const tabs = new Map();
  function start(tabId) { tabs.set(tabId, { started: Date.now(), console: buffer(), network: buffer(), navigation: buffer(), contexts: new Map(), capture: { enabled: false, max_body_bytes: 65536 }, captureVersion: 0, detailed: new Set(), pending: new Set() }); }
  function event(source, method, params, tracked) {
    const state = tabs.get(source.tabId);
    if (!state) return;
    const origin = { session_id: source.sessionId ?? null };
    const contextKey = JSON.stringify([source.sessionId, params.executionContextId ?? params.context?.id ?? params.exceptionDetails?.executionContextId]);
    if (method === 'Runtime.executionContextCreated') state.contexts.set(contextKey, params.context.auxData?.frameId);
    if (method === 'Runtime.executionContextDestroyed') state.contexts.delete(contextKey);
    if (method === 'Runtime.executionContextsCleared') for (const key of state.contexts.keys()) if (JSON.parse(key)[0] === (source.sessionId ?? null)) state.contexts.delete(key);
    const timestamp = params.timestamp ?? params.entry?.timestamp;
    if ((method.startsWith('Runtime.') || method.startsWith('Log.')) && timestamp != null && timestamp < state.started) return;
    if (method === 'Runtime.consoleAPICalled') {
      if (params.executionContextId === 0) return;
      const type = params.type;
      const level = ['warning', 'warn'].includes(type) ? 'warning' : ['error', 'assert'].includes(type) ? 'error'
        : ['debug', 'trace'].includes(type) ? 'debug' : type === 'info' ? 'info' : 'log';
      state.console.add({ ...origin, frame_id: state.contexts.get(contextKey), timestamp, source: 'console', type, level,
        text: clip((params.args || []).slice(0, 20).map(remoteText).join(' '), 8000),
        location: location(params.stackTrace?.callFrames?.[0]), execution_context_id: params.executionContextId, ...stackData(params.stackTrace) });
    } else if (method === 'Runtime.exceptionThrown') {
      const details = params.exceptionDetails || {};
      state.console.add({ ...origin, frame_id: state.contexts.get(contextKey), timestamp, source: 'exception', type: 'exception', level: 'error',
        text: clip(details.exception?.description || details.text, 8000), location: location(details),
        stack: [], ...stackData(details.stackTrace) });
    } else if (method === 'Log.entryAdded') {
      const entry = params.entry;
      state.console.add({ ...origin, frame_id: state.contexts.get(contextKey), timestamp, source: clip(entry.source, 100), type: 'browser', level: clip(entry.level, 100),
        text: clip(entry.text, 8000), location: location(entry), ...stackData(entry.stackTrace),
        ...(entry.networkRequestId != null ? { request_id: clip(entry.networkRequestId, 200) } : {}) });
    } else if (method === 'Page.frameRequestedNavigation') {
      state.navigation.add({ ...origin, event: 'requested', observed_at: Date.now(), frame_id: params.frameId,
        url: clip(params.url), reason: clip(params.reason, 100), disposition: clip(params.disposition, 100) });
    } else if (method === 'Page.frameNavigated') {
      const frame = params.frame;
      state.navigation.add({ ...origin, event: 'committed', observed_at: Date.now(), frame_id: frame.id,
        parent_frame_id: frame.parentId ?? null, loader_id: frame.loaderId, url: clip(frame.url),
        ...(frame.unreachableUrl ? { unreachable_url: clip(frame.unreachableUrl) } : {}), navigation_type: params.type });
    } else if (method === 'Page.navigatedWithinDocument') {
      state.navigation.add({ ...origin, event: 'same_document', observed_at: Date.now(), frame_id: params.frameId,
        url: clip(params.url), navigation_type: params.navigationType });
    } else if (method.startsWith('Network.')) {
      if (!tracked) return;
      const id = params.requestId, { key } = tracked;
      let request = method === 'Network.requestWillBeSent' ? tracked.previous : tracked.request;
      const add = (event, extra = {}) => state.network.add({ ...origin, event, request_id: id, timestamp, ...request, ...extra });
      if (method === 'Network.requestWillBeSent') {
        if (params.redirectResponse) add('redirect', { ...(state.capture.enabled ? { headers: redactHeaders(params.redirectResponse.headers) } : {}), status: params.redirectResponse.status,
          url: clip(params.redirectResponse.url), redirect_to: clip(params.request.url) });
        request = tracked.request;
        if (tracked.evicted) state.detailed.delete(tracked.evicted);
        state.detailed.delete(key);
        if (state.capture.enabled && ['XHR', 'Fetch'].includes(params.type)) state.detailed.add(key);
        add('request', { wall_time: params.wallTime, ...initiatorData(params.initiator), ...(state.detailed.has(key) ? {
          headers: redactHeaders(params.request.headers), ...(params.request.postData != null ? { request_body: boundedBody(params.request.postData, state.capture.max_body_bytes) } : params.request.hasPostData ? { request_body_unavailable: 'not present in bounded request event' } : {}),
        } : {}) });
      } else if (method === 'Network.responseReceived') {
        const response = params.response;
        add('response', { ...(state.detailed.has(key) ? { headers: redactHeaders(response.headers) } : {}), url: clip(response.url), status: response.status, status_text: clip(response.statusText, 200),
          mime_type: clip(response.mimeType, 200), protocol: clip(response.protocol, 50),
          from_cache: !!(response.fromDiskCache || response.fromPrefetchCache), from_service_worker: !!response.fromServiceWorker });
      } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
        const failed = method === 'Network.loadingFailed';
        add(failed ? 'failed' : 'finished', failed ? { error: clip(params.errorText), canceled: !!params.canceled,
          blocked_reason: clip(params.blockedReason) } : { encoded_data_length: params.encodedDataLength });
        if (!failed && state.detailed.has(key) && state.capture.enabled && cdp) {
          const version = state.captureVersion, requestInfo = request, maxBytes = state.capture.max_body_bytes;
          if (requestInfo?.decodedBytes > maxBytes) add('body', { response_body_unavailable: 'decoded response exceeds capture byte limit', decoded_bytes: requestInfo.decodedBytes });
          else if (state.pending.size >= 8) add('body', { response_body_unavailable: 'capture concurrency limit (8)' });
          else {
            let timer;
            const task = Promise.race([cdp(source, 'Network.getResponseBody', { requestId: id }), new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('body read exceeded 1500 ms')), 1500); })])
              .then(result => {
                if (tabs.get(source.tabId) !== state || state.captureVersion !== version) return;
                state.network.add({ ...origin, event: 'body', request_id: id, timestamp, ...requestInfo,
                  ...(result.base64Encoded ? { response_body_unavailable: 'binary response omitted' } : { response_body: boundedBody(result.body, maxBytes) }) });
              }).catch(error => {
                if (tabs.get(source.tabId) === state && state.captureVersion === version) state.network.add({ ...origin, event: 'body', request_id: id, timestamp, ...requestInfo, response_body_unavailable: clip(error.message, 500) });
              }).finally(() => { clearTimeout(timer); state.pending.delete(task); });
            state.pending.add(task);
          }
        }
        state.detailed.delete(key);
      } else if (method === 'Network.requestServedFromCache') add('cache');
    }
  }
  function read(tabId, args) {
    const state = tabs.get(tabId);
    if (!state) throw new Error('Diagnostics are unavailable; claim the tab again');
    validateQuery(args);
    const { kind } = args;
    return { ...state[kind].read(args, record => kind === 'console' ? !args.level || record.level === args.level
      : !args.url_contains || record.url?.includes(args.url_contains)),
      kind, ...(kind === 'network' ? { capture: state.capture, pending_bodies: state.pending.size } : {}), capture_started_at: state.started, scope: 'tab_and_iframes', retained_across_navigation: true };
  }
  function networkOptions(tabId, config = tabs.get(tabId)?.capture) {
    return config?.enabled ? { maxTotalBufferSize: 2097152, maxResourceBufferSize: config.max_body_bytes, maxPostDataSize: config.max_body_bytes } : { maxTotalBufferSize: 0, maxResourceBufferSize: 0, maxPostDataSize: 0 };
  }
  async function configure(tabId, config, targets) {
    const state = tabs.get(tabId);
    if (!state || typeof config?.enabled !== 'boolean') throw new Error('capture requires enabled boolean');
    const max = config.max_body_bytes ?? 65536;
    if (!Number.isInteger(max) || max < 1024 || max > 262144) throw new Error('max_body_bytes must be 1024..262144');
    const next = { enabled: config.enabled, max_body_bytes: max };
    try { for (const target of targets) await cdp(target, 'Network.enable', networkOptions(tabId, next)); }
    catch (error) { await Promise.allSettled(targets.map(target => cdp(target, 'Network.enable', networkOptions(tabId)))); throw error; }
    state.capture = next; state.captureVersion++; state.detailed.clear();
  }
  async function readDetails(tabId, args, targets) {
    validateQuery(args);
    if (args.capture != null) {
      await configure(tabId, args.capture, targets);
    }
    const state = tabs.get(tabId);
    if (args.kind === 'network' && state) await Promise.allSettled([...state.pending]);
    return read(tabId, args);
  }
  return { start, event, read, readDetails, networkOptions, detach(tabId, sessionId) {
    const state = tabs.get(tabId);
    if (!state) return;
    for (const key of state.detailed) if (JSON.parse(key)[0] === sessionId) state.detailed.delete(key);
    for (const key of state.contexts.keys()) if (JSON.parse(key)[0] === sessionId) state.contexts.delete(key);
  }, forget: tabId => tabs.delete(tabId) };
}
