// Flat debugger sessions are scoped to a claimed tab. Frame and object ids
// must always travel with their owning session, including nested OOPIFs.
export function createSessions(cdp, invalidate, detached = () => {}, networkOptions = () => ({ maxTotalBufferSize: 0, maxResourceBufferSize: 0, maxPostDataSize: 0 })) {
  const tabs = new Map();
  const autoAttach = { autoAttach: true, waitForDebuggerOnStart: false, flatten: true,
    filter: [{ type: 'iframe', exclude: false }, { exclude: true }] };
  async function enable(target, state) {
    const send = (method, params) => {
      if (tabs.get(target.tabId) !== state || (target.sessionId && !state.sessions.has(target.sessionId))) throw new Error('Frame session detached during setup');
      return cdp(target, method, params);
    };
    for (const method of ['Runtime.enable', 'Log.enable', 'Network.enable', 'Page.enable', 'DOM.enable', 'Accessibility.enable']) {
      await send(method, method === 'Network.enable' ? networkOptions(target.tabId) : {});
    }
    await send('Page.setLifecycleEventsEnabled', { enabled: true });
    if (state.interceptFileChoosers) await send('Page.setInterceptFileChooserDialog', { enabled: true });
    await send('Target.setAutoAttach', autoAttach);
  }
  async function start(tabId) {
    const state = { sessions: new Map(), frames: new Map(), parents: new Map() };
    tabs.set(tabId, state);
    await enable({ tabId }, state);
    await settle(tabId);
  }
  async function settle(tabId) {
    const state = tabs.get(tabId);
    if (!state) throw new Error('Tab sessions are unavailable');
    let count;
    do {
      count = state.sessions.size;
      await Promise.all([...state.sessions.values()].map(item => item.ready));
    } while (count !== state.sessions.size);
  }
  function event(source, method, params) {
    const state = tabs.get(source.tabId);
    if (!state) return;
    if (method === 'Target.attachedToTarget' && params.targetInfo.type === 'iframe') {
      const target = { tabId: source.tabId, sessionId: params.sessionId };
      const entry = { target, parent: source.sessionId, frameId: params.targetInfo.targetId, url: params.targetInfo.url };
      state.sessions.set(params.sessionId, entry);
      state.frames.set(entry.frameId, params.sessionId);
      entry.ready = enable(target, state).catch(error => { entry.error = error; });
    } else if (method === 'Target.detachedFromTarget') {
      const removed = new Set([params.sessionId]);
      let size;
      do {
        size = removed.size;
        for (const [id, entry] of state.sessions) if (removed.has(entry.parent)) removed.add(id);
      } while (size !== removed.size);
      for (const id of removed) {
        state.sessions.delete(id);
        detached(source.tabId, id);
        for (const [frame, session] of state.frames) if (session === id) { state.frames.delete(frame); invalidate(source.tabId, frame); }
      }
    } else if (method === 'Page.frameAttached') {
      state.parents.set(params.frameId, params.parentFrameId);
    } else if (method === 'Page.frameNavigated') {
      if (params.frame.parentId) state.parents.set(params.frame.id, params.frame.parentId);
      state.frames.set(params.frame.id, source.sessionId);
    } else if (method === 'Runtime.executionContextCreated' && params.context.auxData?.frameId) {
      state.frames.set(params.context.auxData.frameId, source.sessionId);
    }
  }
  function target(tabId, frameId) {
    const state = tabs.get(tabId), sessionId = state?.frames.get(frameId);
    const entry = sessionId && state.sessions.get(sessionId);
    if (entry?.error) throw new Error(`Frame session setup failed: ${entry.error.message}`);
    return { tabId, ...(sessionId ? { sessionId } : {}) };
  }
  async function frames(tabId, send = cdp) {
    await settle(tabId);
    const state = tabs.get(tabId), result = new Map();
    const collect = (tree, sessionId) => {
      if (tree.frame.parentId) state.parents.set(tree.frame.id, tree.frame.parentId);
      const existing = result.get(tree.frame.id);
      result.set(tree.frame.id, { ...existing, ...tree.frame, parentId: tree.frame.parentId || existing?.parentId });
      // A root tree can mention an OOPIF without owning its execution context.
      if (sessionId || !state.frames.has(tree.frame.id)) state.frames.set(tree.frame.id, sessionId);
      (tree.childFrames || []).forEach(child => collect(child, sessionId));
    };
    collect((await send(tabId, 'Page.getFrameTree')).frameTree);
    for (const entry of state.sessions.values()) {
      if (!result.has(entry.frameId)) result.set(entry.frameId, { id: entry.frameId, url: entry.url });
      if (entry.error) continue;
      try { collect((await send(entry.target, 'Page.getFrameTree')).frameTree, entry.target.sessionId); }
      catch (error) { entry.error = error; }
    }
    return [...result.values()];
  }
  async function interceptFileChoosers(tabId, enabled, run) {
    const state = tabs.get(tabId);
    if (!state) {
      if (enabled) throw new Error('Tab sessions are unavailable');
      return;
    }
    state.interceptFileChoosers = enabled;
    if (enabled) await run(() => settle(tabId));
    // Disable without waiting for frame setup: an in-flight setup observes the
    // flag before enabling interception, so it cannot re-enable after cleanup.
    const results = await Promise.allSettled([{ tabId }, ...[...state.sessions.values()].map(entry => entry.target)].map(target => run(async () => {
      if (tabs.get(tabId) !== state || !has(target)) return;
      try { await cdp(target, 'Page.setInterceptFileChooserDialog', { enabled }); }
      catch (error) { if (tabs.get(tabId) === state && has(target)) throw error; }
    })));
    const failure = results.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
  }
  const has = source => !source.sessionId || !!tabs.get(source.tabId)?.sessions.has(source.sessionId);
  return { start, settle, event, target, frames, interceptFileChoosers,
    rememberParent: (tabId, child, parent) => tabs.get(tabId)?.parents.set(child, parent),
    parent(tabId, sessionId) {
      const entry = tabs.get(tabId)?.sessions.get(sessionId);
      if (!entry) throw new Error('Frame session is detached; observe again.');
      return { frameId: entry.frameId, ownerFrameId: tabs.get(tabId).parents.get(entry.frameId), target: { tabId, ...(entry.parent ? { sessionId: entry.parent } : {}) } };
    },
    has,
    targets: tabId => [{ tabId }, ...[...(tabs.get(tabId)?.sessions.values() || [])].map(entry => entry.target)],
    forget: tabId => tabs.delete(tabId) };
}
