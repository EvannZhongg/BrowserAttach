const fields = ['input_dispatched', 'outcome_unknown', 'post_action', 'diagnostics', 'observation', 'wait_result', 'recovery', 'open_tab'];

const recovery = {
  stale_ref: 'Observe the affected page/frame and use a fresh ref or selector. A stale ref alone does not require a new claim.',
  obstructed: 'Inspect blocked_by and the visible control or associated HTML label. If input_dispatched=false, choose an observed target explicitly; otherwise observe effects first. Never switch to DOM input automatically.',
  frame_obstructed: 'Inspect the ancestor-frame blocker before choosing another target. Do not bypass it with DOM input automatically.',
  selector_not_found: 'Inspect snapshot(profile="interactive", query=...) or read_control for an open popup; wait for a concrete condition if loading. Absence from rendered options does not prove absence from a virtual list.',
  selector_nth_out_of_range: 'Inspect matched/nth and the current ordering in the reported frame. Choose an observed target; do not guess another index.',
  selector_ambiguous: 'Scope the observed target by container/frame; use nth only when the observed ordering identifies it.',
  value_not_retained: 'Read the current control with read_control or the form with snapshot(profile="fields"). Retained values and application acceptance are separate; do not refill automatically.',
  delivery_unverified: 'Use browser_wait for the expected result or observe current state. Activate explicitly if rendering/focus is unavailable; activation does not prove earlier non-delivery.',
  input_timeout: 'Observe current state or repeat only the read-only browser_wait; do not repeat the input or switch modes automatically.',
  evaluation_source_changed: 'Observe the current page and resolve a new target. The expression may have had effects; do not rerun it to recover an element ref.',
  evaluation_control_changed: 'Discover and claim only if control ended. A new claim does not make replaying the old expression safe.',
};

export function errorData(error) {
  const data = { error: error.message || String(error) };
  for (const key of fields) if (error[key] !== undefined) data[key] = error[key];
  if (!data.recovery && recovery[error.diagnostics?.reason]) data.recovery = recovery[error.diagnostics.reason];
  return data;
}

export function errorFromData(data) {
  const error = new Error(String(data.error));
  for (const key of fields) if (data[key] !== undefined) error[key] = data[key];
  return error;
}

// CDP exception descriptions omit custom properties on errors thrown by our
// isolated-world helpers. Read their diagnostics only on the failure path.
export async function checkedValue(result, send, value, context) {
  if (!result.exceptionDetails) return value(result);
  let diagnostics;
  const objectId = result.exceptionDetails.exception?.objectId;
  if (objectId) {
    try {
      const details = await send('Runtime.callFunctionOn', { objectId, returnByValue: true,
        functionDeclaration: 'function() { return Object.getOwnPropertyDescriptor(this, "diagnostics")?.value; }' });
      if (!details.exceptionDetails) diagnostics = details.result?.value;
    } catch {}
    finally { await send('Runtime.releaseObject', { objectId }).catch(() => {}); }
  }
  try { return value(result); }
  catch (error) { if (typeof diagnostics?.reason === 'string') error.diagnostics = context ? { ...context, ...diagnostics } : diagnostics; throw error; }
}
