export function createUploads(cdp, value) {
  const fileChoosers = new Map();
  async function upload(tabId, node, args) {
    const send = (target, method, params) => args.budget.run(() => cdp(target, method, params));
    if (!Array.isArray(args.files) || args.files.length > 100 || args.files.some(file => typeof file !== 'string' || !file || file.includes('\0'))) {
      throw new Error('files must contain at most 100 valid absolute file paths; [] clears selection');
    }
    const chooser = fileChoosers.get(tabId);
    let target = node;
    if (!target) {
      if (!chooser) throw new Error('No pending file chooser. Supply a fresh file-input/label ref, or click the upload button first.');
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
  return { upload,
    opened(tabId, params, sessionId) {
      if (params.backendNodeId) fileChoosers.set(tabId, { sessionId, backendNodeId: params.backendNodeId, mode: params.mode, frame_id: params.frameId });
    },
    pending: tabId => fileChoosers.get(tabId),
    forget: tabId => fileChoosers.delete(tabId),
    forgetFrames(tabId, affected) { if (affected.has(fileChoosers.get(tabId)?.frame_id)) fileChoosers.delete(tabId); },
  };
}
