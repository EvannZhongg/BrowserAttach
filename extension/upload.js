import { boundedRead } from './outcomes.js';

export function createUploads(cdp, value, sessions) {
  const fileChoosers = new Map();
  const captures = new Map();
  async function capture(tabId, args, click) {
    fileChoosers.delete(tabId);
    let resolve, reject, result, failure;
    const opened = new Promise((yes, no) => { resolve = yes; reject = no; });
    opened.catch(() => {});
    const request = { resolve, reject };
    captures.set(tabId, request);
    try {
      await sessions.interceptFileChoosers(tabId, true, operation => args.budget.run(operation));
      result = await click();
      let chooser;
      try { chooser = await (request.received ? opened : args.budget.run(() => opened)); }
      catch (error) { chooser = { pending: false, reason: captures.get(tabId) === request ? 'not_opened' : 'source_changed',
        observation_error: captures.get(tabId) === request ? 'No file chooser was captured within the remaining click timeout. The click is not repeated.' : error.message }; }
      if (chooser.pending && !fileChoosers.has(tabId)) chooser = { pending: false, reason: 'source_changed' };
      return { ...result, file_chooser: chooser };
    } catch (error) { failure = error; throw error; }
    finally {
      if (captures.get(tabId) === request) captures.delete(tabId);
      // Cleanup has its own bound even when input used the entire deadline.
      try { await sessions.interceptFileChoosers(tabId, false, operation => boundedRead(operation, 1000)); }
      catch (error) {
        const cleanup = { error: error.message, recovery: 'Release this tab before manual file selection; file chooser interception could not be disabled.' };
        if (failure) failure.file_chooser_cleanup = cleanup;
        else throw Object.assign(new Error('File chooser interception cleanup failed. Do not repeat the click.'), {
          input_dispatched: args.budget.has_dispatched(), file_chooser_cleanup: cleanup,
          ...(result ? { post_action: { action_result: result } } : {}),
        });
      }
    }
  }
  async function upload(tabId, node, args) {
    const send = (target, method, params) => args.budget.run(() => cdp(target, method, params));
    if (!Array.isArray(args.files) || args.files.length > 100 || args.files.some(file => typeof file !== 'string' || !file || file.includes('\0'))) {
      throw new Error('files must contain at most 100 valid absolute file paths; [] clears selection');
    }
    const chooser = fileChoosers.get(tabId);
    let target = node;
    if (!target) {
      if (!chooser) throw new Error('No pending file chooser. Supply a fresh file-input/label ref, or click the upload button with capture_file_chooser=true first.');
      const resolved = await send({ tabId, ...(chooser.sessionId ? { sessionId: chooser.sessionId } : {}) }, 'DOM.resolveNode', { backendNodeId: chooser.backendNodeId, objectGroup: 'browser-attach' });
      if (!resolved.object?.objectId) throw new Error('File chooser input no longer exists. Observe again.');
      target = { objectId: resolved.object.objectId, target: { tabId, ...(chooser.sessionId ? { sessionId: chooser.sessionId } : {}) } };
    }
    const resolved = await send(target.target, 'Runtime.callFunctionOn', {
      objectId: target.objectId, arguments: [{ value: args.files.length }],
      functionDeclaration: `function(count) {
        const input = this.tagName === 'LABEL' ? this.control : this;
        if (!input || input.tagName !== 'INPUT' || input.type !== 'file') throw new Error('Ref is not a file input or associated label');
        if (!input.isConnected) throw new Error('File input is detached');
        if (input.matches(':disabled')) throw new Error('File input is disabled');
        if (input.webkitdirectory) throw new Error('Directory upload is unsupported; use a regular file input');
        if (count > 1 && !input.multiple) throw new Error('Single-file input cannot accept multiple files');
        return input;
      }`, objectGroup: 'browser-attach',
    });
    if (resolved.exceptionDetails) value(resolved);
    if (!resolved.result?.objectId) throw new Error('Could not resolve the file input');
    args.budget.dispatch();
    try {
      if (args.files.length === 0) {
        // Chromium's native empty-path assignment does not emit input/change.
        // Like Playwright's empty payload path, explicitly clear and notify the app.
        value(await send(target.target, 'Runtime.callFunctionOn', { objectId: resolved.result.objectId, returnByValue: true,
          functionDeclaration: `function() {
            this.value = '';
            const Event = this.ownerDocument.defaultView.Event;
            this.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
            this.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          }` }));
      } else {
        // Native CDP assignment emits input/change and preserves actual file metadata.
        await send(target.target, 'DOM.setFileInputFiles', { objectId: resolved.result.objectId, files: args.files });
      }
      fileChoosers.delete(tabId);
      let count = null, observationError;
      try {
        const observed = value(await send(target.target, 'Runtime.callFunctionOn', { objectId: resolved.result.objectId, returnByValue: true,
          functionDeclaration: `function() { return this.isConnected ? this.files?.length : null; }` }));
        if (Number.isInteger(observed) && observed >= 0) count = observed;
        else observationError = { reason: 'file_selection_unavailable' };
      } catch (error) { observationError = { reason: 'file_selection_unavailable', error: error.message }; }
      // A component may consume/reset the FileList synchronously. Readback is
      // independent evidence and cannot undo the acknowledged assignment.
      return { assignment_acknowledged: true, requested_count: args.files.length, observed_count: count,
        count_verified: count == null ? null : count === args.files.length,
        ...(observationError ? { observation_error: observationError } : {}), method: args.files.length ? 'native' : 'dom',
        events_trusted: args.files.length ? null : false, application_result: 'not_checked', observe_again: true };
    } catch (error) { error.outcome_unknown = true; throw error; }
  }
  return { upload, capture,
    opened(tabId, params, sessionId) {
      const request = captures.get(tabId);
      if (!request || request.received) return;
      request.received = true;
      if (params.backendNodeId) fileChoosers.set(tabId, { sessionId, backendNodeId: params.backendNodeId, mode: params.mode, frame_id: params.frameId });
      request.resolve({ pending: !!params.backendNodeId, mode: params.mode, frame_id: params.frameId,
        ...(!params.backendNodeId ? { reason: 'unsupported_chooser' } : {}) });
    },
    pending: tabId => fileChoosers.get(tabId),
    forget(tabId) {
      fileChoosers.delete(tabId);
      captures.get(tabId)?.reject(new Error('File chooser capture ended because the document or tab control changed. Observe before continuing.'));
      captures.delete(tabId);
    },
    forgetSession(tabId, sessionId) { if (fileChoosers.get(tabId)?.sessionId === sessionId) fileChoosers.delete(tabId); },
    forgetFrames(tabId, affected) { if (affected.has(fileChoosers.get(tabId)?.frame_id)) fileChoosers.delete(tabId); },
  };
}
