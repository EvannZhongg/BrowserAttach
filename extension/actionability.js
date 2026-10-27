// One deadline covers preparation, waiting, dispatch and verification. Only
// preparation is retried; once input is sent its outcome must be observed.
const INPUT_RECOVERY = 'Browser UI may be capturing input; if a native menu is open, press Escape to dismiss it. Observe browser_snapshot before deciding what to do. If page focus is unavailable, explicitly call browser_tab_control({tab_handle, action:"activate", focus_window:true}), then browser_snapshot and re-resolve the target. Activation does not prove non-delivery; retry only if observation confirms the action is still needed. Never automatically replay or fall back.';

export function deadline(timeout_ms = 5000, phase = 'input', parentEnd = Infinity) {
  if (!Number.isInteger(timeout_ms) || timeout_ms < 100 || timeout_ms > 30000) throw new Error('timeout_ms must be 100..30000');
  const end = Math.min(Date.now() + timeout_ms, parentEnd);
  let dispatched = false, waiting, diagnostics;
  function error() {
    const result = timeoutError();
    result.deadline_exceeded = true;
    if (diagnostics && !dispatched) result.diagnostics = diagnostics;
    return result;
  }
  function timeoutError() {
    if (phase === 'evaluation') return Object.assign(new Error(dispatched ? 'JavaScript evaluation timed out. Page effects may already have occurred. Observe before continuing. Do not replay automatically.' : 'Evaluation preparation timed out; no expression was executed.'), { input_dispatched: dispatched, outcome_unknown: dispatched });
    if (phase === 'fetch') return new Error(`Fetch did not finish within ${timeout_ms} ms; the temporary tab will be closed. Do not automatically replay the request.`);
    if (phase === 'claim') return new Error(`Initial tab URL did not become available within ${timeout_ms} ms. The tab may still be loading; discover it before continuing. Do not repeat open_tab automatically.`);
    if (phase === 'wait') return Object.assign(new Error(`Condition was not satisfied within ${timeout_ms} ms`), { input_dispatched: false });
    if (phase === 'observation') return Object.assign(new Error(`Navigation observation timed out within ${timeout_ms} ms; navigation already succeeded. Take a new snapshot.`), { outcome_unknown: true });
    if (phase === 'snapshot') return Object.assign(new Error(`Snapshot observation timed out within ${timeout_ms} ms. Take a new browser_snapshot.`), { input_dispatched: false, diagnostics: { reason: 'snapshot_timeout' } });
    const result = new Error(dispatched
      ? `Input did not finish with verified delivery within ${timeout_ms} ms. Outcome is unknown. ${INPUT_RECOVERY}`
      : `Target did not become actionable within ${timeout_ms} ms${waiting ? `; waiting for ${waiting}` : ''}; no input was dispatched.`);
    result.input_dispatched = dispatched;
    result.outcome_unknown = dispatched;
    result.diagnostics = { reason: dispatched ? 'input_timeout' : 'preparation_timeout' };
    return result;
  }
  async function run(operation) {
    const remaining = end - Date.now();
    if (remaining <= 0) throw error();
    let timer;
    try { return await Promise.race([Promise.resolve().then(operation), new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(error()), remaining);
    })]); } finally { clearTimeout(timer); }
  }
  return { run, has_dispatched: () => dispatched, child(ms, childPhase = phase) { return deadline(ms, childPhase, end); }, describe(detail, state) { waiting = detail; diagnostics = state; }, dispatch() { if (Date.now() >= end) throw error(); dispatched = true; }, remaining: () => Math.max(0, end - Date.now()) };
}

export async function waitForTarget(cdp, value, target, node, budget, { editable = false } = {}) {
  let previous;
  while (true) {
    const bounds = value(await budget.run(() => cdp(target, 'Runtime.callFunctionOn', {
      objectId: node.objectId, functionDeclaration: inspectTarget.toString(), arguments: [{ value: editable }], returnByValue: true,
    })));
    if (bounds?.detached || bounds?.unsupported) throw Object.assign(new Error(`${bounds.detached
      ? 'Element is detached; take a new snapshot.'
      : 'Target is not a supported editable field.'} ${budget.has_dispatched() ? 'Input was already dispatched; outcome is unknown. Do not replay automatically.' : 'No input was dispatched.'}`), { outcome_unknown: true,
      input_dispatched: budget.has_dispatched(), diagnostics: { reason: bounds.detached ? 'element_detached' : 'unsupported_editable', frame_id: node.frameId },
    });
    if (bounds?.ready && previous && JSON.stringify(bounds) === JSON.stringify(previous)) return;
    budget.describe?.(`visible, enabled, stable target; current=${JSON.stringify(bounds)}`, { reason: bounds?.ready ? 'unstable_geometry' : bounds?.reason || 'not_actionable', frame_id: node.frameId, target: bounds });
    previous = bounds?.ready ? bounds : null;
    await budget.run(() => new Promise(resolve => setTimeout(resolve, 20)));
  }
}

export function inspectTarget(editable) {
  let element = this?.nodeType === 3 ? this.parentElement : this;
  if (!element?.isConnected) return { detached: true };
  const tag = element.tagName?.toLowerCase();
  if (editable && ((!['input', 'textarea'].includes(tag) && !element.isContentEditable) ||
      (tag === 'input' && !['text', 'search', 'email', 'password', 'tel', 'url', ''].includes(element.type)))) return { unsupported: true };
  const next = node => node.assignedSlot || node.parentElement || node.getRootNode().host;
  const rect = element.getBoundingClientRect(), win = element.ownerDocument.defaultView, style = win.getComputedStyle(element);
  function failure(reason, blocker) {
    const ancestors = [];
    let parent = element;
    for (; parent && ancestors.length < 8; parent = next(parent)) {
      const css = win.getComputedStyle(parent);
      ancestors.push({ tag: parent.tagName?.toLowerCase(), id: parent.id || null,
        display: css.display, visibility: css.visibility, opacity: css.opacity, pointer_events: css.pointerEvents,
        overflow_x: css.overflowX, overflow_y: css.overflowY,
        transition_property: css.transitionProperty, transition_duration: css.transitionDuration,
        scrollable_x: /auto|scroll|overlay/.test(css.overflowX) && parent.scrollWidth > parent.clientWidth,
        scrollable_y: /auto|scroll|overlay/.test(css.overflowY) && parent.scrollHeight > parent.clientHeight });
    }
    if (reason === 'zero_size' && ancestors.some(node => node.display === 'none')) reason = 'display_none';
    return { ready: false, reason, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      ...(blocker ? { blocker: { tag: blocker.tagName?.toLowerCase(), id: blocker.id || null } } : {}),
      ancestors, ancestors_truncated: !!parent };
  }
  // Inert and disabled state can be inherited through a slot or shadow host.
  for (let parent = element; parent; parent = next(parent)) {
    if (parent.matches(':disabled') || parent.hasAttribute('inert')) return failure(parent.matches(':disabled') ? 'disabled' : 'inert', parent);
  }
  if (style.display === 'none') return failure('display_none');
  if (style.visibility !== 'visible') return failure('visibility_hidden');
  if (rect.width <= 0 || rect.height <= 0) return failure('zero_size');
  if (editable && element.readOnly) return failure('read_only');
  return { ready: true,
    x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

// A lost native receipt must free the queue promptly even with a long preparation budget.
export async function delivery(operation, ms = 1250) {
  let timer;
  try { return await Promise.race([operation, new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`Native input has no verified receipt. Outcome is unknown. ${INPUT_RECOVERY}`), {
      outcome_unknown: true, diagnostics: { reason: 'delivery_unverified' },
    })), ms);
  })]); } finally { clearTimeout(timer); }
}
