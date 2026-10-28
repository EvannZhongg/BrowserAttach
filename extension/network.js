import { clip } from './log-data.js';

const MAX_ENTRIES = 500;

// Passive request/document facts are independent of diagnostic log retention.
export function createNetworkTracker() {
  const tabs = new Map();
  function start(tabId) {
    tabs.set(tabId, { requests: new Map(), documentResponses: new Map(), pendingDocumentExtraInfo: new Map(), networkActivity: Date.now(), requestsOverflow: false });
  }
  function event(source, method, params) {
    const state = tabs.get(source.tabId), id = params.requestId;
    if (!state || !method.startsWith('Network.') || !id) return;
    state.networkActivity = Date.now();
    const key = JSON.stringify([source.sessionId, id]);
    let request = state.requests.get(key), evicted;
    const previous = request;
    if (method === 'Network.requestWillBeSent') {
      if (params.type === 'Document') state.documentResponses.delete(JSON.stringify([source.sessionId ?? null, params.frameId]));
      request = { url: clip(params.request.url), method: clip(params.request.method, 50), resource_type: clip(params.type, 50),
        frame_id: params.frameId, loader_id: params.loaderId, hop: request ? request.hop + 1 : 0 };
      Object.defineProperty(request, 'decodedBytes', { value: 0, writable: true });
      state.requests.delete(key); state.requests.set(key, request);
      if (state.requests.size > MAX_ENTRIES) { state.requestsOverflow = true; const removed = state.requests.keys().next().value; state.requests.delete(removed); evicted = removed; }
    } else if (method === 'Network.dataReceived') {
      if (request && Number.isFinite(params.dataLength) && params.dataLength > 0) request.decodedBytes += params.dataLength;
    } else if (method === 'Network.responseReceived') {
      const response = params.response;
      if (params.type === 'Document') {
        const documentKey = JSON.stringify([source.sessionId ?? null, params.frameId]);
        state.documentResponses.delete(documentKey);
        const header = name => Object.entries(response.headers || {}).find(([key]) => key.toLowerCase() === name)?.[1];
        const pendingKey = JSON.stringify([source.sessionId ?? null, id, response.status]);
        const extra = state.pendingDocumentExtraInfo.get(pendingKey);
        const length = extra?.length ?? header('content-length');
        state.pendingDocumentExtraInfo.delete(pendingKey);
        state.documentResponses.set(documentKey, { requestId: id, loaderId: params.loaderId, status: response.status, url: response.url,
          contentType: response.mimeType || String(header('content-type') || '').split(';')[0] || null, empty_body: String(length ?? '').trim() === '0' });
        if (state.documentResponses.size > MAX_ENTRIES) state.documentResponses.delete(state.documentResponses.keys().next().value);
      }
    } else if (method === 'Network.responseReceivedExtraInfo') {
      // ExtraInfo can arrive on either side of responseReceived. Enrich only
      // its matching status, never a redirect hop or a wire-level cache 304.
      const length = Object.entries(params.headers || {}).find(([key]) => key.toLowerCase() === 'content-length')?.[1];
      if (length != null) {
        let matched = false;
        for (const [documentKey, response] of state.documentResponses) if (JSON.parse(documentKey)[0] === (source.sessionId ?? null) && response.requestId === id && response.status === params.statusCode) {
          response.empty_body = String(length).trim() === '0'; matched = true;
        }
        if (!matched && state.requests.get(key)?.resource_type === 'Document') {
          state.pendingDocumentExtraInfo.set(JSON.stringify([source.sessionId ?? null, id, params.statusCode]), { length });
          if (state.pendingDocumentExtraInfo.size > MAX_ENTRIES) state.pendingDocumentExtraInfo.delete(state.pendingDocumentExtraInfo.keys().next().value);
        }
      }
    } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
      const failed = method === 'Network.loadingFailed';
      if (failed) for (const [documentKey, response] of state.documentResponses) {
        if (JSON.parse(documentKey)[0] === (source.sessionId ?? null) && response.requestId === id && (!response.error || params.errorText === 'net::ERR_HTTP_RESPONSE_CODE_FAILURE')) response.error = params.errorText;
      }
      state.requests.delete(key);
    }
    return { key, request, previous, evicted };
  }
  return { start, event, documentStatus(tabId, frame) {
    const response = tabs.get(tabId)?.documentResponses.get(JSON.stringify([null, frame.id]));
    return frame.loaderId && response?.loaderId === frame.loaderId && Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? response.status : null;
  }, failedDocument(tabId, frameId) {
    const response = tabs.get(tabId)?.documentResponses.get(JSON.stringify([null, frameId]));
    return response?.error === 'net::ERR_HTTP_RESPONSE_CODE_FAILURE' && Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? { ...response } : null;
  }, networkStatus(tabId) {
    const state = tabs.get(tabId);
    if (!state) throw new Error('Tab control ended while waiting for network idle');
    return { inflight: state.requests.size, idle_ms: Date.now() - state.networkActivity, tracking_overflow: state.requestsOverflow };
  }, detach(tabId, sessionId) {
    const state = tabs.get(tabId);
    if (!state) return;
    for (const map of [state.requests, state.documentResponses, state.pendingDocumentExtraInfo]) for (const key of map.keys()) if (JSON.parse(key)[0] === sessionId) map.delete(key);
  }, forget: tabId => tabs.delete(tabId) };
}
