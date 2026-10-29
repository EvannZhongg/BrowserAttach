// Deliberately a page expression API, not a raw CDP transport.
const CAPTURE_CHARS = 1000000, CAPTURE_NODES = 50000;
async function evaluatePage(cdp, tabId, args) {
  const timeout = args.timeout_ms ?? 10000, maxChars = args.max_chars ?? 20000;
  if (typeof args.expression !== 'string' || !args.expression.trim() || args.expression.length > 100000)
    throw new Error('expression must contain 1..100000 characters of JavaScript');
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > 30000) throw new Error('timeout_ms must be 100..30000');
  if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > 100000) throw new Error('max_chars must be 1..100000');
  let timer;
  try {
    const response = await Promise.race([
      cdp(tabId, 'Runtime.evaluate', {
        expression: `(async () => { let result = await (\n${args.expression}\n); if (typeof result === "function") result = await result(); return ${args.result_type === 'element' ? 'result' : `(${serializeEvaluation.toString()})(result, ${CAPTURE_CHARS}, ${CAPTURE_NODES})`}; })()`,
        ...(args.result_type === 'element' ? { objectGroup: 'browser-attach-evaluation' } : {}), ...(args.context_id != null ? { contextId: args.context_id } : {}), awaitPromise: true, returnByValue: args.result_type !== 'element', userGesture: false, timeout,
      }),
      new Promise((resolve, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(
        'JavaScript evaluation timed out. It may still run or have changed the page; observe before continuing. Do not replay automatically.'
      ), { outcome_unknown: true })), timeout); }),
    ]);
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    if (args.result_type === 'element') {
      if (response.result?.subtype !== 'node' || !response.result.objectId) throw new Error('Element result must be one connected DOM element, not JSON/array/null');
      return { element: response.result };
    }
    if (!response.result?.value || typeof response.result.value.truncated !== 'boolean') throw new Error('Invalid evaluation result');
    return { ...response.result.value, scope: args.frame || args.frame_id ? 'frame' : 'main_frame', ...(args.evaluation_frame ? { frame_id: args.evaluation_frame } : {}), observe_again: true };
  } catch (error) {
    throw Object.assign(new Error(`Evaluation failed; page effects may already have occurred. ${String(error.message).slice(0, 12000)}`), { outcome_unknown: true });
  } finally { clearTimeout(timer); }
}

// Runs in the page. Bound traversal before transferring the result across CDP.
// Preserve ordinary JSON; explicitly mark values that JSON cannot represent.
export function serializeEvaluation(value, maxChars, maxNodes = 1000) {
  const seen = new WeakSet();
  let nodes = 0, chars = 0, truncated = false;
  const mark = type => ({ $type: type });
  function visit(item, depth) {
    if (++nodes > maxNodes || depth > 8 || chars > maxChars) { truncated = true; return mark('truncated'); }
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'number') return Number.isFinite(item) && !Object.is(item, -0) ? item : { $type: 'number', value: String(Object.is(item, -0) ? '-0' : item) };
    if (typeof item === 'string') {
      const text = item.slice(0, Math.max(0, maxChars - chars));
      chars += text.length;
      if (text.length !== item.length) truncated = true;
      return text;
    }
    if (typeof item === 'bigint') return { $type: 'bigint', value: visit(String(item), depth + 1) };
    if (typeof item !== 'object') return mark(typeof item);
    if (seen.has(item)) return mark('circular_or_repeated');
    seen.add(item);
    if (item instanceof Date) return { $type: 'date', value: String(item) };
    if (item instanceof Error) return { $type: 'error', name: visit(item.name, depth + 1), message: visit(item.message, depth + 1) };
    if (Array.isArray(item)) {
      const output = [];
      // Do not copy a sparse index into an array with an unbounded length.
      for (let i = 0; i < item.length && nodes < maxNodes && chars < maxChars && depth < 8; i++) {
        const property = Object.getOwnPropertyDescriptor(item, String(i));
        output.push(!property ? visit(undefined, depth + 1) : 'value' in property ? visit(property.value, depth + 1) : (nodes++, mark('accessor')));
      }
      if (output.length < item.length) truncated = true;
      return output;
    }
    const output = Object.create(null);
    for (const key in item) {
      if (!Object.prototype.hasOwnProperty.call(item, key)) continue;
      if (nodes >= maxNodes || chars + key.length > maxChars || depth >= 8) { truncated = true; break; }
      chars += key.length;
      const property = Object.getOwnPropertyDescriptor(item, key);
      const result = property && 'value' in property ? visit(property.value, depth + 1) : (nodes++, mark('accessor'));
      Object.defineProperty(output, key, { value: result, enumerable: true, configurable: true, writable: true });
    }
    return output;
  }
  const result = visit(value, 0);
  const json = JSON.stringify(result);
  // Escaped strings and property names also count toward the transfer budget.
  // Never emit half a serialized JSON document. Keep the payload structured,
  // and state explicitly when the capture budget lost information.
  if (json.length > maxChars) return { value: { $type: 'truncated', reason: 'serialized_size', required_chars: json.length }, truncated: true };
  return { value: result, truncated };
}

// A document change expires continuations, but a completed JSON reply remains
// useful historical evidence. Control loss must discard even that late reply.
export function createEvaluations(cdp) {
  const results = new Map();
  function invalidate(tabId, reason = 'document_changed', frameId) {
    const state = results.get(tabId);
    if (!state || frameId != null && state.frameId !== frameId) return;
    if (state.pending) state.invalidated ??= reason;
    else results.delete(tabId);
  }
  async function read(tabId, args) {
    const max = args.max_chars ?? 20000;
    if (!Number.isInteger(max) || max < 1 || max > 100000) throw new Error('max_chars must be 1..100000');
    let state;
    if (args.cursor != null) {
      state = results.get(tabId);
      if (!state || state.cursor !== args.cursor) throw new Error('Evaluation cursor is stale or unknown; results expire on navigation, release or a new evaluation.');
      if (args.expression != null) throw new Error('Provide cursor or expression, never both');
    } else {
      const pending = { frameId: args.evaluation_frame, pending: true };
      results.set(tabId, pending);
      let result;
      try { result = await evaluatePage(cdp, args.target || tabId, args); }
      catch (error) { if (results.get(tabId) === pending) results.delete(tabId); throw error; }
      if (results.get(tabId) !== pending) throw Object.assign(new Error('Tab control ended during evaluation; the late result was discarded. Observe with a valid claim; do not replay automatically.'), { outcome_unknown: true, diagnostics: { reason: 'evaluation_control_changed' } });
      if (result.element) {
        results.delete(tabId);
        if (pending.invalidated) throw Object.assign(new Error('Evaluation completed but its source changed; no element ref was created. Observe the current page; do not replay automatically.'), { outcome_unknown: true, diagnostics: { reason: 'evaluation_source_changed', cause: pending.invalidated } });
        return result;
      }
      result = { ...result, execution_completed: true, source_current: !pending.invalidated,
        ...(pending.invalidated ? { source_changed: pending.invalidated } : {}) };
      const kind = Array.isArray(result.value) ? 'array' : typeof result.value === 'string' ? 'string' :
        result.value && typeof result.value === 'object' ? 'object' : 'scalar';
      state = Object.assign(pending, { pending: false, result, kind, offset: 0, token: crypto.randomUUID(), cursor: null,
        items: kind === 'object' ? Object.entries(result.value) : result.value });
      if (pending.invalidated) results.delete(tabId);
    }
    const { kind, items, offset, result } = state;
    const length = kind === 'scalar' ? 1 : items.length;
    const make = (end, start = offset) => kind === 'string' || kind === 'array' ? items.slice(start, end) :
      kind === 'object' ? Object.fromEntries(items.slice(start, end)) : items;
    let low = offset, high = length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (JSON.stringify(make(mid)).length <= max) low = mid; else high = mid - 1;
    }
    if ((length > offset && low === offset) || JSON.stringify(make(low)).length > max) {
      if (!state.invalidated) state.cursor ??= `${state.token}@${offset}`;
      return { execution_completed: true, source_current: result.source_current, ...(result.source_changed ? { source_changed: result.source_changed } : {}), scope: result.scope, ...(result.frame_id ? { frame_id: result.frame_id } : {}), result_kind: kind, capture_truncated: result.truncated, budget_too_small: true, next_cursor: state.cursor,
        required_chars: JSON.stringify(make(Math.min(length, offset + 1))).length,
        note: state.invalidated ? 'Source changed; no continuation was retained. Do not repeat a writing expression to retrieve its result. Observe current state first.' : 'Continue with this cursor and max_chars >= required_chars (maximum 100000); do not resend expression. For large collections return a top-level array of small records, not an object wrapping one large nested array.' };
    }
    state.offset = low;
    state.cursor = !state.invalidated && low < length ? `${state.token}@${low}` : null;
    const nextRequired = low < length ? JSON.stringify(make(low + 1, low)).length : null;
    return { ...result, value: make(low), result_kind: kind, has_more: low < length,
      ...(state.invalidated && low < length ? { continuation_unavailable: true, note: 'Source changed; only this bounded historical page is available, with no cursor. Observe current state before considering any new expression.' } : {}),
      ...(result.truncated ? { capture_hint: 'Capture loss cannot be recovered by pagination. For future reads return a top-level array of small plain records (e.g. rows.map(({id,title})=>({id,title}))); avoid deep or large nested values. Do not automatically rerun an expression with effects.' } : {}),
      ...(nextRequired > max ? { next_item: { ...(kind === 'object' ? { key: items[low][0] } : { index: low }), required_chars: nextRequired, exceeds_max_chars: nextRequired > 100000 } } : {}),
      next_cursor: state.cursor, capture_truncated: result.truncated, truncated: result.truncated || low < length };
  }
  return { read, invalidate, forget: tabId => results.delete(tabId) };
}
