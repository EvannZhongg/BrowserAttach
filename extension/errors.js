const fields = ['input_dispatched', 'post_action', 'diagnostics', 'observation', 'open_tab'];

export function errorData(error) {
  const data = { error: error.message || String(error) };
  for (const key of fields) if (error[key] !== undefined) data[key] = error[key];
  return data;
}

export function errorFromData(data) {
  const error = new Error(String(data.error));
  for (const key of fields) if (data[key] !== undefined) error[key] = data[key];
  return error;
}

// CDP exception descriptions omit custom properties on errors thrown by our
// isolated-world helpers. Read their diagnostics only on the failure path.
export async function checkedValue(result, send, value) {
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
  catch (error) { if (typeof diagnostics?.reason === 'string') error.diagnostics = diagnostics; throw error; }
}
