import { axRefKey, indexAXRefs, renderAX, snapshotOptions, snapshotPage, validateSnapshotRequest } from './snapshot.js';
import { snapshotDiff } from './snapshot-diff.js';
import { createFieldReader } from './fields.js';
import { deadline } from './actionability.js';

export async function retryObservation(read, budget, recover = () => false) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { return await read(); }
    catch (error) {
      const transient = error.diagnostics?.reason === 'document_changed' || /context.*(destroyed|not found)|cannot find (?:default execution )?context|document (changed|updated)|inspected target navigated|no frame with given id/i.test(error.message);
      if (attempt || error.deadline_exceeded || budget.remaining() <= 100 || !(recover(error) || transient)) throw error;
      await budget.run(() => new Promise(resolve => setTimeout(resolve, 50)));
    }
  }
}

// Observation identity is separate from debugger session ownership.
export function createObservations(cdp, value, sessions, viewport, currentClaim, changed) {
  const snapshots = new Map(), retiredRefs = new Map(), documents = new Map();
  const pageContexts = new Map(), frameStates = new Map();
  function retireRef(tabId, ref, cause, frameId) {
    let history = retiredRefs.get(tabId);
    if (!history) retiredRefs.set(tabId, history = new Map());
    history.set(ref, { cause, frame_id: frameId });
    if (history.size > 1000) history.delete(history.keys().next().value);
  }

  function invalidateSnapshot(tabId, cause) {
    const state = snapshots.get(tabId);
    if (state) for (const [ref, node] of state.refs) retireRef(tabId, ref, cause, node.frameId);
    snapshots.delete(tabId);
  }

  async function getObject(tabId, ref, budget) {
    const refError = (cause, frameId, message) => {
      const dispatched = budget.has_dispatched();
      return Object.assign(new Error(`${message}. Take a new browser_snapshot. ${dispatched ? 'Input was already dispatched; outcome is unknown. Do not replay automatically.' : 'No input was dispatched.'}`), { outcome_unknown: true,
        input_dispatched: dispatched, diagnostics: { reason: 'stale_ref', cause, ref, ...(frameId ? { frame_id: frameId } : {}) },
      });
    };
    const node = snapshots.get(tabId)?.refs.get(ref);
    if (!node) {
      const failure = retiredRefs.get(tabId)?.get(ref);
      throw refError(failure?.cause || 'unknown_ref', failure?.frame_id, 'Element ref is stale or unknown');
    }
    const target = sessions.target(tabId, node.frameId);
    if (target.sessionId !== node.sessionId) throw refError('frame_session_changed', node.frameId, 'Frame session changed');
    let resolved, nodes;
    try {
      resolved = await budget.run(() => cdp(target, 'DOM.resolveNode', { backendNodeId: node.backendNodeId, objectGroup: 'browser-attach' }));
      if (!resolved.object?.objectId) throw refError('element_detached', node.frameId, 'Element no longer exists');
      ({ nodes } = await budget.run(() => cdp(target, 'Accessibility.getPartialAXTree', { backendNodeId: node.backendNodeId, fetchRelatives: false })));
    }
    catch (error) {
      const retired = retiredRefs.get(tabId)?.get(ref);
      if (retired) throw refError(retired.cause, retired.frame_id, 'Element ref became stale during resolution');
      if (/no node|could not find node|node.*(detached|not found)/i.test(error.message)) throw refError('element_detached', node.frameId, 'Element is detached or no longer exists');
      throw error;
    }
    if (snapshots.get(tabId)?.refs.get(ref) !== node) {
      const retired = retiredRefs.get(tabId)?.get(ref);
      throw refError(retired?.cause || 'unknown_ref', node.frameId, 'Element ref became stale during resolution');
    }
    const current = nodes?.find(item => item.backendDOMNodeId === node.backendNodeId);
    if (!current || !!current.ignored !== !!node.ignored || current.role?.value !== node.role || String(current.name?.value || '') !== node.name) {
      throw refError('identity_changed', node.frameId, 'Element ref identity changed (role/name or accessibility)');
    }
    return { ...node, target, objectId: resolved.object.objectId };
  }

  async function rememberElement(tabId, target, objectId, frameId, budget) {
    const version = documents.get(tabId), claim = currentClaim(tabId), frameVersion = frameStates.get(tabId)?.versions.get(frameId);
    const send = (method, params) => budget.run(() => cdp(target, method, params));
    const { node } = await send('DOM.describeNode', { objectId, depth: 0 });
    if (node.nodeType !== 1) throw new Error('Result must be a DOM element');
    const { nodes } = await send('Accessibility.getPartialAXTree', { backendNodeId: node.backendNodeId, fetchRelatives: false });
    const ax = nodes?.find(item => item.backendDOMNodeId === node.backendNodeId);
    if (!ax) throw new Error('Element accessibility identity is unavailable; observe again');
    const connected = value(await send('Runtime.callFunctionOn', { objectId, functionDeclaration: 'function() { return this.isConnected; }', returnByValue: true }));
    if (!connected) throw new Error('Element is detached; no ref was created');
    if (documents.get(tabId) !== version || currentClaim(tabId) !== claim || frameStates.get(tabId)?.versions.get(frameId) !== frameVersion) throw new Error('Element document/frame/control changed; no ref was created');
    const refs = rememberAXNodes(tabId, target, frameId, [ax]);
    return { ref: refs.get(node.backendNodeId), frame_id: frameId, role: ax.role?.value, name: String(ax.name?.value || '') };
  }

  // Targeted reads add bounded refs to the current observation, without replacing
  // its identities or pagination. The caller checks document/frame/claim first.
  function rememberAXNodes(tabId, target, frameId, nodes) {
    let state = snapshots.get(tabId);
    if (!state) {
      state = { id: crypto.randomUUID().slice(0, 8), refs: new Map(), entries: [], invalidFrames: new Set(), totalNodes: 0, nextCursor: null, metadata: { omitted_frames: [] } };
    }
    const refs = new Map(), additions = [], existingRefs = indexAXRefs(state.refs);
    for (const ax of nodes) {
      if (!ax.backendDOMNodeId || refs.has(ax.backendDOMNodeId)) continue;
      const identity = { backendNodeId: ax.backendDOMNodeId, frameId, sessionId: target.sessionId,
        role: ax.role?.value, name: String(ax.name?.value || ''), ignored: !!ax.ignored };
      const existing = existingRefs.get(axRefKey(identity));
      const ref = existing?.[0] || `${state.id}:element:${(state.extraRefs || 0) + additions.length + 1}`;
      refs.set(identity.backendNodeId, ref);
      if (!existing) additions.push([ref, identity]);
    }
    if ((state.extraRefs || 0) + additions.length > 500) throw new Error('Element ref budget exhausted; take a new snapshot');
    state.extraRefs = (state.extraRefs || 0) + additions.length;
    for (const [ref, identity] of additions) state.refs.set(ref, identity);
    snapshots.set(tabId, state);
    return refs;
  }

  function invalidateFrame(tabId, frameId) {
    const frames = frameStates.get(tabId);
    if (!frames || !frameId) return;
    const affected = new Set([frameId]);
    // Descendant documents disappear with their parent, even without individual events.
    let size;
    do {
      size = affected.size;
      for (const [id, parent] of frames.parents) if (affected.has(parent)) affected.add(id);
    } while (size !== affected.size);
    const state = snapshots.get(tabId);
    for (const id of affected) {
      frames.versions.set(id, (frames.versions.get(id) || 0) + 1);
      if (state) omitFrame(tabId, state, id, 'Frame navigated or detached after observation');
    }
    changed(tabId, affected);
  }

  function omitFrame(tabId, state, frameId, reason) {
    if (state.invalidFrames.has(frameId)) return;
    state.invalidFrames.add(frameId);
    for (const [ref, node] of state.refs) if (node.frameId === frameId) {
      retireRef(tabId, ref, 'frame_changed', frameId);
      state.refs.delete(ref);
    }
    state.totalNodes -= state.entries.filter(entry => entry.frameId === frameId && entry.node).length;
    state.metadata.omitted_frames.push({ frame_id: frameId, reason });
  }

  function expireCursor(tabId) {
    const state = snapshots.get(tabId);
    if (state) state.nextCursor = null;
  }

  function prepareSnapshot(tabId, args = {}) {
    validateSnapshotRequest(args);
    const state = snapshots.get(tabId), latest = args.diff_since === 'latest';
    let previous = args.diff_since != null ? state : null, resetReason;
    if (latest) {
      if (state?.options && !state.delivered) unreadBaseline(state);
      if (!state?.options) resetReason = 'no_baseline';
      else if (state.options.profile === 'fields') resetReason = 'unsupported_view';
      else if (state.invalidFrames.size || state.metadata.omitted_frames.length) resetReason = 'incomplete_frame_coverage';
      if (resetReason) previous = null;
    } else if (args.diff_since != null) assertDiffBaseline(tabId, previous, args.diff_since);
    const inherited = state?.options && state.options.profile !== 'fields' && args.diff_since != null ? state.options : {};
    const options = snapshotOptions({ ...inherited, ...args });
    if (previous && Object.keys(options).some(key => options[key] !== previous.options[key])) {
      if (!latest) throw new Error('diff_since uses the original profile/text/text_limit/query; take a new snapshot to change the view.');
      previous = null; resetReason = 'view_changed';
    }
    return { previous, options, latest, resetReason, claim: currentClaim(tabId), documentVersion: documents.get(tabId) };
  }

  async function snapshot(tabId, args = {}, budget = deadline(30000, 'snapshot'), prepared) {
    validateSnapshotRequest(args);
    if (args.cursor != null) {
      const state = snapshots.get(tabId);
      if (!state) throw new Error('Snapshot cursor is stale or unknown. Take a new browser_snapshot.');
      return snapshotPage(state, args);
    }
    const plan = prepared || prepareSnapshot(tabId, args);
    let { previous, resetReason } = plan;
    if (!previous && !plan.latest) invalidateSnapshot(tabId, 'snapshot_replaced');
    return await retryObservation(() => {
      if (plan.latest) {
        if (plan.documentVersion !== documents.get(tabId)) { previous = null; resetReason = 'document_changed'; }
        else if (previous && (snapshots.get(tabId) !== previous || previous.invalidFrames.size || previous.metadata.omitted_frames.length)) {
          previous = null; resetReason = 'baseline_invalidated';
        }
      }
      if (previous) assertDiffBaseline(tabId, previous, previous.id);
      return captureSnapshot(tabId, args, plan.options, budget, plan.claim, previous, resetReason);
    }, budget, error => {
      if (!plan.latest || !['diff_baseline_invalid', 'diff_incomplete'].includes(error.diagnostics?.reason)) return false;
      previous = null;
      resetReason = error.diagnostics.reason === 'diff_incomplete' ? 'incomplete_frame_coverage' : 'baseline_invalidated';
      return true;
    });
  }

  function unreadBaseline(state) {
    throw Object.assign(new Error('Snapshot diff baseline has unread pages; finish its cursor or take a new browser_snapshot without diff_since.'), {
      diagnostics: { reason: 'diff_baseline_invalid', cause: 'unread_pages', snapshot_id: state.id,
        next_cursor: state.deltaEntries && state.invalidFrames.size ? null : state.nextCursor ?? null },
    });
  }

  function assertDiffBaseline(tabId, state, id) {
    const fail = message => { throw Object.assign(new Error(`${message}. Take a new browser_snapshot without diff_since.`), { diagnostics: { reason: 'diff_baseline_invalid' } }); };
    if (!state || snapshots.get(tabId) !== state || state.id !== id || !state.options) fail('Snapshot diff baseline is stale or unknown');
    if (state.options.profile === 'fields') fail('diff_since supports full/interactive only');
    if (!state.delivered) unreadBaseline(state);
    if (state.invalidFrames.size || state.metadata.omitted_frames.length) fail('Snapshot diff baseline has incomplete or invalidated frame coverage');
  }

  async function captureSnapshot(tabId, args, options, budget, claim, previous, resetReason) {
    const assertClaim = () => {
      if (!claim || currentClaim(tabId) !== claim) throw Object.assign(new Error('Tab control ended while reading the snapshot; no refs were published.'), { diagnostics: { reason: 'control_changed' } });
    };
    assertClaim();
    const send = (...params) => budget.run(() => cdp(...params));
    const documentVersion = documents.get(tabId);
    const versions = new Map(frameStates.get(tabId)?.versions);
    await budget.run(() => sessions.settle(tabId));
    for (const target of sessions.targets(tabId)) await send(target, 'Runtime.releaseObjectGroup', { objectGroup: 'browser-attach' });
    const frames = await budget.run(() => sessions.frames(tabId, send));
    const mainId = frameStates.get(tabId).mainId;
    for (const frame of frames) if (frame.parentId) frameStates.get(tabId).parents.set(frame.id, frame.parentId);
    const knownFrames = new Set(frames.map(frame => frame.id));
    const token = crypto.randomUUID().slice(0, 8);
    const refs = new Map(), entries = [], omittedFrames = [];
    const previousRefs = previous && indexAXRefs(previous.refs), previousByFrame = new Map(), captured = new Map();
    for (const entry of previous?.refs || []) {
      const frameId = entry[1].frameId;
      if (!previousByFrame.has(frameId)) previousByFrame.set(frameId, []);
      previousByFrame.get(frameId).push(entry);
    }
    const readFields = options.profile === 'fields' ? createFieldReader(send, value) : null;
    for (const frame of frames) {
      let nodes;
      let target;
      try {
        target = sessions.target(tabId, frame.id);
        frameStates.get(tabId).sessions.set(frame.id, target.sessionId);
        ({ nodes } = await send(target, 'Accessibility.getFullAXTree', { frameId: frame.id }));
      }
      catch (error) {
        if (frame.id === mainId) throw error;
        omittedFrames.push({ frame_id: frame.id, url: frame.url, reason: error.message });
        continue;
      }
      if (previous?.frameScopes.has(frame.id) && previous.frameScopes.get(frame.id).sessionId !== target.sessionId) {
        throw Object.assign(new Error('Snapshot diff frame session changed; take a new browser_snapshot without diff_since.'), { diagnostics: { reason: 'diff_baseline_invalid' } });
      }
      const byBackend = previous ? new Map() : null;
      if (byBackend) for (const node of nodes) if (node.backendDOMNodeId && (!node.ignored || !byBackend.has(node.backendDOMNodeId))) byBackend.set(node.backendDOMNodeId, node);
      captured.set(frame.id, { sessionId: target.sessionId, byBackend });
      for (const [ref, identity] of previousByFrame.get(frame.id) || []) {
        const node = byBackend.get(identity.backendNodeId);
        if (node && identity.sessionId === target.sessionId && !!node.ignored === !!identity.ignored &&
            node.role?.value === identity.role && String(node.name?.value || '') === identity.name) refs.set(ref, identity);
      }
      // Report cross-process frames that are missing from Page.getFrameTree.
      for (const node of nodes) {
        if (!/^iframe$/i.test(node.role?.value || '') || !node.backendDOMNodeId) continue;
        const { node: owner } = await send(target, 'DOM.describeNode', { backendNodeId: node.backendDOMNodeId, depth: 0 });
        const childId = owner.frameId || owner.contentDocument?.frameId;
        if (!childId) continue;
        frameStates.get(tabId)?.parents.set(childId, frame.id);
        sessions.rememberParent(tabId, childId, frame.id);
        if (knownFrames.has(childId)) continue;
        const attributes = owner.attributes || [], srcIndex = attributes.indexOf('src');
        const url = srcIndex >= 0 ? new URL(attributes[srcIndex + 1], frame.url).href : 'about:blank';
        knownFrames.add(childId); frames.push({ id: childId, url });
      }
      let rendered;
      if (readFields) {
        try { rendered = await readFields(target, frame.id, nodes, token, refs, options); }
        catch (error) {
          if (frame.id === mainId) throw error;
          for (const [ref, node] of refs) if (node.frameId === frame.id) refs.delete(ref);
          omittedFrames.push({ frame_id: frame.id, url: frame.url, reason: error.message });
          continue;
        }
      } else {
        rendered = renderAX(nodes, token, refs, frame.id, target.sessionId, options, previousRefs);
        if (rendered.length || options.query == null) entries.push({ node: false, frameId: frame.id, key: JSON.stringify(['frame', frame.id, target.sessionId]), line: `Frame ${frame.id} ${frame.url}` });
      }
      for (const entry of rendered) entries.push(entry);
    }
    const metadata = value(await send(tabId, 'Runtime.evaluate', {
      expression: '({title: document.title, url: location.href})', returnByValue: true,
    }));
    const state = { id: token, options, refs, entries, resetReason, invalidFrames: new Set(), totalNodes: entries.filter(entry => entry.node).length,
      extraRefs: [...refs.keys()].filter(ref => ref.includes(':element:')).length,
      frameScopes: new Map([...captured].map(([id, frame]) => [id, { sessionId: frame.sessionId }])),
      metadata: { title: metadata.title, url: metadata.url, viewport: await budget.run(() => viewport(tabId)), omitted_frames: omittedFrames,
        ...(readFields ? { frames: frames.map(frame => ({ frame_id: frame.id, url: frame.url })) } : {}) } };
    assertClaim();
    if (documentVersion !== documents.get(tabId)) throw Object.assign(new Error('Document changed while reading the snapshot. Take a new browser_snapshot.'), { diagnostics: { reason: 'document_changed' } });
    for (const frame of frames) if (versions.get(frame.id) !== frameStates.get(tabId)?.versions.get(frame.id) ||
        captured.has(frame.id) && captured.get(frame.id).sessionId !== sessions.target(tabId, frame.id).sessionId) {
      omitFrame(tabId, state, frame.id, 'Frame changed while reading the snapshot; take a new snapshot to observe it');
    }
    if (previous) {
      assertDiffBaseline(tabId, previous, previous.id);
      if (state.invalidFrames.size || omittedFrames.length) throw Object.assign(new Error('Snapshot diff capture has incomplete frame coverage; baseline was not advanced. Take a new browser_snapshot without diff_since.'), { diagnostics: { reason: 'diff_incomplete' } });
      state.baseId = previous.id;
      state.deltaEntries = snapshotDiff(previous.entries, entries);
    }
    const page = snapshotPage(state, args);
    // Recheck the deadline after synchronous diffing/serialization, before any
    // new baseline or retired identities can become visible.
    return await budget.run(() => {
      assertClaim();
      if (previous) assertDiffBaseline(tabId, previous, previous.id);
      else invalidateSnapshot(tabId, 'snapshot_replaced');
      for (const [ref, node] of previous?.refs || []) if (!refs.has(ref)) {
        const frame = captured.get(node.frameId);
        retireRef(tabId, ref, !frame || frame.sessionId !== node.sessionId ? 'frame_changed' :
          frame.byBackend.has(node.backendNodeId) ? 'identity_changed' : 'element_detached', node.frameId);
      }
      snapshots.set(tabId, state);
      return page;
    });
  }


  function documentChanged(tabId, cause) {
    documents.set(tabId, (documents.get(tabId) || 0) + 1);
    invalidateSnapshot(tabId, cause);
    changed(tabId);
  }
  function contextEvent(source, method, params) {
    const contextKey = JSON.stringify([source.tabId, source.sessionId]);
    if (method === 'Runtime.executionContextCreated' && params.context.auxData?.isDefault) pageContexts.set(JSON.stringify([source.tabId, source.sessionId, params.context.auxData.frameId]), params.context.id);
    if (method === 'Runtime.executionContextDestroyed' || method === 'Runtime.executionContextsCleared') {
      for (const [key, id] of pageContexts) if (key.startsWith(contextKey.slice(0, -1) + ',') && (method.endsWith('Cleared') || id === params.executionContextId)) pageContexts.delete(key);
    }
  }
  function event(source, method, params) {
    const frames = frameStates.get(source.tabId);
    if (method === 'Page.frameAttached') frames?.parents.set(params.frameId, params.parentFrameId);
    const mainNavigation = !source.sessionId && method === 'Page.frameNavigated' && params.frame && !params.frame.parentId;
    if (mainNavigation && frames) {
      frames.mainId = params.frame.id;
      frames.parents.clear(); frames.versions.clear(); frames.sessions.clear();
    }
    if (method === 'Page.frameNavigated' && params.frame?.parentId) frames?.parents.set(params.frame.id, params.frame.parentId);
    const sameDocumentMain = method === 'Page.navigatedWithinDocument' && params.frameId === frames?.mainId;
    if ((!source.sessionId && method === 'DOM.documentUpdated') || mainNavigation || sameDocumentMain) {
      documentChanged(source.tabId, sameDocumentMain ? 'same_document_navigation' : mainNavigation ? 'document_navigation' : 'document_updated');
    } else if (source.sessionId && method === 'DOM.documentUpdated') {
      for (const [frame, session] of frameStates.get(source.tabId)?.sessions || []) if (session === source.sessionId) invalidateFrame(source.tabId, frame);
    } else if (method === 'Page.frameNavigated' || method === 'Page.navigatedWithinDocument' || method === 'Page.frameDetached') {
      invalidateFrame(source.tabId, params.frame?.id || params.frameId);
    }
  }
  function initialize(tabId, frameTree) {
    const state = { mainId: frameTree.frame.id, parents: new Map(), versions: new Map(), sessions: new Map() };
    const remember = tree => {
      if (tree.frame.parentId) state.parents.set(tree.frame.id, tree.frame.parentId);
      (tree.childFrames || []).forEach(remember);
    };
    remember(frameTree); frameStates.set(tabId, state);
  }
  function forget(tabId) {
    snapshots.delete(tabId); retiredRefs.delete(tabId); documents.delete(tabId);
    for (const key of pageContexts.keys()) if (JSON.parse(key)[0] === tabId) pageContexts.delete(key);
    frameStates.delete(tabId);
  }
  return { snapshot, prepareSnapshot, resolve: getObject, rememberElement, rememberAXNodes, invalidate: invalidateSnapshot, expireCursor,
    initialize, invalidateFrame, documentChanged, event, contextEvent, forget,
    version: tabId => documents.get(tabId),
    mainFrame: tabId => frameStates.get(tabId)?.mainId,
    frameVersion: (tabId, frameId) => frameStates.get(tabId)?.versions.get(frameId),
    refFrame: (tabId, ref) => snapshots.get(tabId)?.refs.get(ref)?.frameId,
    context: (tabId, sessionId, frameId) => pageContexts.get(JSON.stringify([tabId, sessionId, frameId])),
    detachSession(tabId, sessionId) {
      for (const key of pageContexts.keys()) { const [tab, session] = JSON.parse(key); if (tab === tabId && session === sessionId) pageContexts.delete(key); }
    },
  };
}
