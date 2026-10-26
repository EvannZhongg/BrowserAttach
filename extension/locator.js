import { checkedValue } from './errors.js';

// Selectors are reusable queries, never identities inferred from old AX text.
export function targetOptions(args, { coordinates = false, focused = false } = {}) {
  const hasRef = args.ref != null, hasSelector = args.selector != null;
  const hasPoint = args.x != null || args.y != null;
  if (args.focused != null && (args.focused !== true || !focused)) throw new Error('focused=true is only supported by type');
  if (Number(hasRef) + Number(hasSelector) + Number(hasPoint) + Number(args.focused === true) !== 1 ||
      (hasPoint && (!coordinates || !Number.isFinite(args.x) || !Number.isFinite(args.y)))) {
    throw new Error(focused ? 'Provide exactly one of ref, selector or focused=true' : coordinates ? 'Provide exactly one of ref, selector, or both finite x and y' : 'Provide exactly one of ref or selector');
  }
  if (hasRef && (typeof args.ref !== 'string' || !args.ref)) throw new Error('ref must be nonempty');
  if (hasSelector && (typeof args.selector !== 'string' || !args.selector.trim() || args.selector.length > 10000)) throw new Error('selector must contain 1..10000 characters');
  if (args.selector_type != null && !['css', 'xpath', 'label', 'placeholder', 'role'].includes(args.selector_type)) throw new Error('selector_type must be css, xpath, label, placeholder or role');
  if (args.name != null && (args.selector_type !== 'role' || typeof args.name !== 'string' || args.name.length > 10000)) throw new Error('name requires selector_type=role and must be a string of at most 10000 characters');
  frameOptions(args);
  if (!hasSelector && (args.frame_id != null || args.frame != null || args.selector_type != null)) throw new Error('frame/frame_id and selector_type require selector');
  if (args.nth != null && (!hasSelector || !Number.isSafeInteger(args.nth) || args.nth < 0)) throw new Error('nth requires selector and must be a nonnegative safe integer (zero-based)');
  if (args.coordinate_space != null && (!hasPoint || !['viewport', 'document'].includes(args.coordinate_space))) throw new Error('coordinate_space must be viewport or document and applies to coordinate clicks only');
}

export function queryElement(selector, type = 'css', nth, waitForMatch = false) {
  if (nth != null && (!Number.isSafeInteger(nth) || nth < 0)) throw new Error('nth must be a nonnegative safe integer (zero-based)');
  const failure = (message, reason, detail = {}) => Object.assign(new Error(message), {
    diagnostics: { reason, selector_type: type, ...detail },
  });
  let element, count, at;
  try {
    if (type === 'xpath') {
      const result = document.evaluate(selector, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      count = result.snapshotLength; at = index => result.snapshotItem(index);
    } else {
      const normalize = text => text.replace(/\s+/g, ' ').trim();
      const elements = type === 'label'
        ? Array.from(document.querySelectorAll('input,textarea,select,button,meter,output,progress')).filter(element =>
          Array.from(element.labels || []).some(label => normalize(label.textContent || '') === normalize(selector)))
        : type === 'placeholder'
          ? Array.from(document.querySelectorAll('[placeholder]')).filter(element => element.getAttribute('placeholder') === selector)
          : document.querySelectorAll(selector);
      count = elements.length; at = index => elements[index];
    }
  } catch (error) {
    const hint = type === 'css' ? 'Use browser-native CSS, not Playwright selectors such as :has-text(). For accessible names use selector_type="role", selector="<actual AX role>", name="<exact accessible name>"; label matches associated HTML labels and placeholder matches the exact placeholder attribute. Inspect browser_snapshot query to find the actual role/name.' : null;
    throw failure(`${error.message}${hint ? ` ${hint}` : ''}`, 'selector_invalid', hint ? { hint } : {});
  }
  if (waitForMatch && (count === 0 || (nth != null && nth >= count))) return null;
  if (nth == null && count !== 1) {
    const candidates = Array.from({ length: Math.min(count, 10) }, (_, nth) => {
      const node = at(nth), text = (node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120);
      if (node.nodeType !== 1) return { nth, node_type: node.nodeType, text };
      const rect = node.getBoundingClientRect(), style = node.ownerDocument.defaultView.getComputedStyle(node);
      return { nth, tag: node.tagName.toLowerCase(), text,
        disabled: node.matches(':disabled') || !!node.closest('[inert], [aria-disabled="true"]'),
        visible: rect.width > 0 && rect.height > 0 && style.visibility === 'visible' };
    });
    throw failure(`Selector must match exactly one element; matched ${count}. Scope the selector or provide an explicit zero-based nth. Candidates: ${JSON.stringify(candidates)}${count > candidates.length ? ` (${count - candidates.length} more omitted)` : ''}`,
      count ? 'selector_ambiguous' : 'selector_not_found', { matched: count, candidates, omitted_candidates: Math.max(0, count - candidates.length) });
  }
  if (nth != null && nth >= count) throw failure(`Selector nth=${nth} is out of range; matched ${count}`, 'selector_not_found', { matched: count, nth });
  element = at(nth ?? 0);
  if (element.nodeType !== 1) throw failure('Selector must resolve to an element', 'selector_not_element');
  return element;
}

export async function resolveSelector(cdp, value, sessions, tabId, args, budget, { wait = true } = {}) {
  targetOptions(args);
  const frameId = await resolveFrame(cdp, value, sessions, tabId, args, budget);
  const target = sessions.target(tabId, frameId);
  const send = (method, params) => budget.run(() => cdp(target, method, params));
  const role = args.selector_type === 'role';
  const context = role ? null : await send('Page.createIsolatedWorld', { frameId, worldName: 'browser-attach-locator' });
  let backendNodeId, roleNodes;
  try {
    while (true) {
      if (role) {
        const { nodes } = await send('Accessibility.getFullAXTree', { frameId });
        roleNodes = nodes;
        backendNodeId = matchRole(nodes, args)?.backendDOMNodeId;
      } else {
        const result = await send('Runtime.evaluate', { contextId: context.executionContextId, objectGroup: 'browser-attach',
          expression: `(${queryElement.toString()})(${JSON.stringify(args.selector)},${JSON.stringify(args.selector_type ?? 'css')},${args.nth ?? 'undefined'},true)` });
        await checkedValue(result, send, value);
        if (result.result?.subtype !== 'null') {
          if (!result.result?.objectId) throw Object.assign(new Error('Selector did not resolve to an element'), {
            diagnostics: { reason: 'selector_not_element', frame_id: frameId },
          });
          const { node } = await send('DOM.describeNode', { objectId: result.result.objectId });
          backendNodeId = node.backendNodeId;
        }
      }
      if (backendNodeId != null) break;
      if (!wait) return null;
      budget.describe?.(`selector ${JSON.stringify(args.selector)}${args.name == null ? '' : ` name=${JSON.stringify(args.name)}`}${args.nth == null ? '' : ` nth=${args.nth}`} to appear; current=no matching element`,
        { reason: 'selector_not_found', selector_type: args.selector_type ?? 'css', frame_id: frameId, ...(args.nth == null ? {} : { nth: args.nth }) });
      await budget.run(() => new Promise(resolve => setTimeout(resolve, 20)));
    }
  } catch (error) {
    if (role && error.diagnostics?.reason === 'selector_not_found' && !budget.has_dispatched()) {
      const hint = 'For selector_type="role", selector is the actual AX role (e.g. "link"), and name is the exact accessible name (e.g. "Claim"). Suggestions are diagnostic only; inspect browser_snapshot query before choosing a target.';
      const suggestions = roleSuggestions(roleNodes || [], args);
      error.diagnostics = { ...error.diagnostics, ...suggestions, hint };
      error.message += ` ${hint} Name suggestions: ${JSON.stringify(suggestions.suggestions)}${suggestions.omitted_suggestions ? ` (${suggestions.omitted_suggestions} more omitted)` : ''}`;
    }
    throw error;
  }
  // Hit-test refs resolve in the default world too. CDP forbids passing object
  // arguments between worlds, even when both wrappers refer to the same node.
  const resolved = await send('DOM.resolveNode', { backendNodeId, objectGroup: 'browser-attach' });
  if (!resolved.object?.objectId) throw Object.assign(new Error('Selector target detached before resolution; no input was dispatched'), {
    diagnostics: { reason: 'element_detached', frame_id: frameId },
  });
  return { target, frameId, objectId: resolved.object.objectId, backendNodeId };
}

function roleSuggestions(nodes, args) {
  const query = (args.name ?? args.selector).trim().toLowerCase();
  const matches = new Map();
  if (query) for (const node of nodes) {
    const name = String(node.name?.value || '');
    if (node.ignored || !node.backendDOMNodeId || !node.role?.value || !name.toLowerCase().includes(query) || matches.has(node.backendDOMNodeId)) continue;
    matches.set(node.backendDOMNodeId, { role: node.role.value, name, exact: name.toLowerCase() === query });
  }
  const candidates = [...matches.values()].sort((a, b) => Number(b.exact) - Number(a.exact));
  return { suggestions: candidates.slice(0, 10).map(({ role, name }) => ({ role, name: name.slice(0, 120), ...(name.length > 120 ? { name_truncated: true } : {}) })),
    omitted_suggestions: Math.max(0, candidates.length - 10) };
}

export function matchRole(nodes, args) {
  const byId = new Map(nodes.map(node => [node.nodeId, node]));
  const children = new Set(nodes.flatMap(node => node.childIds || []));
  const pending = nodes.filter(node => !children.has(node.nodeId)).reverse(), seen = new Set(), matches = new Map();
  while (pending.length) {
    const node = pending.pop();
    if (!node || seen.has(node.nodeId)) continue;
    seen.add(node.nodeId);
    if (!node.ignored && node.backendDOMNodeId && node.role?.value === args.selector &&
        (args.name == null || String(node.name?.value || '') === args.name)) matches.set(node.backendDOMNodeId, node);
    for (let i = (node.childIds?.length || 0) - 1; i >= 0; i--) pending.push(byId.get(node.childIds[i]));
  }
  const candidates = [...matches.values()];
  if (args.nth == null && candidates.length > 1) {
    const preview = candidates.slice(0, 10).map((node, nth) => ({ nth, role: node.role?.value, name: String(node.name?.value || '').slice(0, 120) }));
    throw Object.assign(new Error(`Role selector must match exactly one element; matched ${candidates.length}. Provide name or an explicit zero-based nth. Candidates: ${JSON.stringify(preview)}`), {
      diagnostics: { reason: 'selector_ambiguous', selector_type: 'role', matched: candidates.length,
        candidates: preview, omitted_candidates: Math.max(0, candidates.length - preview.length) },
    });
  }
  return candidates[args.nth ?? 0] || null;
}

export function frameOptions(args) {
  if (args.frame_id != null && args.frame != null) throw new Error('Provide frame_id or frame, never both');
  const frame = args.frame;
  if (frame == null) return;
  if (typeof frame !== 'object' || Array.isArray(frame) || !Object.keys(frame).length || Object.keys(frame).some(key => !['url', 'title', 'path'].includes(key))) throw new Error('frame requires url, title or a CSS iframe path');
  for (const key of ['url', 'title']) if (frame[key] != null && (typeof frame[key] !== 'string' || !frame[key])) throw new Error(`frame.${key} must be nonempty`);
  if (frame.path != null && (!Array.isArray(frame.path) || frame.path.length < 1 || frame.path.length > 16 || frame.path.some(s => typeof s !== 'string' || !s.trim() || s.length > 10000))) throw new Error('frame.path must contain 1..16 CSS iframe selectors');
}

async function resolveFrameOnce(cdp, value, sessions, tabId, args, budget) {
  frameOptions(args);
  const frames = await budget.run(() => sessions.frames(tabId));
  const failure = (error, scope = {}) => {
    const candidates = frames.slice(0, 10).map(frame => ({ frame_id: frame.id, parent_frame_id: frame.parentId ?? null, url: frame.url }));
    error.diagnostics = { reason: 'frame_locator', ...(error.diagnostics ? { cause: error.diagnostics.reason, selector_diagnostics: error.diagnostics } : {}), ...scope, candidates, omitted_candidates: Math.max(0, frames.length - candidates.length) };
    error.message += `; frame scope=${JSON.stringify(scope)}; current frames=${JSON.stringify(candidates)}${frames.length > candidates.length ? ` (${frames.length - candidates.length} more omitted)` : ''}`;
    return error;
  };
  if (args.frame_id != null) {
    if (!frames.some(f => f.id === args.frame_id)) throw failure(new Error('frame_id is unknown; take a new snapshot'), { frame_id: args.frame_id });
    return args.frame_id;
  }
  if (!args.frame) return frames[0].id;
  const scope = args.frame;
  let frameId = frames[0].id;
  for (const [pathIndex, selector] of (scope.path || []).entries()) {
    const parentFrameId = frameId;
    try {
      const target = sessions.target(tabId, frameId);
      const send = (method, params) => budget.run(() => cdp(target, method, params));
      const { executionContextId } = await send('Page.createIsolatedWorld', { frameId, worldName: 'browser-attach-locator' });
      const result = await send('Runtime.evaluate', { contextId: executionContextId, expression: `(${queryElement.toString()})(${JSON.stringify(selector)},"css")`, objectGroup: 'browser-attach-frame' });
      await checkedValue(result, send, value);
      try {
        const { node } = await send('DOM.describeNode', { objectId: result.result.objectId });
        if (!['IFRAME', 'FRAME'].includes(node.nodeName)) throw new Error('frame.path must resolve to iframe/frame elements');
        frameId = node.frameId || node.contentDocument?.frameId;
        if (!frameId) throw new Error('Frame document is not available yet');
      } finally { await send('Runtime.releaseObjectGroup', { objectGroup: 'browser-attach-frame' }); }
    } catch (error) {
      error.message += '; frame.path entries are CSS selectors, e.g. "#content_iframe"';
      throw failure(error, { parent_frame_id: parentFrameId, path_index: pathIndex, selector });
    }
  }
  const candidates = scope.path ? frames.filter(f => f.id === frameId) : frames.filter(f => f.id !== frames[0].id);
  const matches = [];
  for (const frame of candidates) {
    if (scope.url != null && frame.url !== scope.url) continue;
    if (scope.title != null) {
      const target = sessions.target(tabId, frame.id);
      const { executionContextId } = await budget.run(() => cdp(target, 'Page.createIsolatedWorld', { frameId: frame.id, worldName: 'browser-attach-locator' }));
      const title = value(await budget.run(() => cdp(target, 'Runtime.evaluate', { contextId: executionContextId, expression: 'document.title', returnByValue: true })));
      if (title !== scope.title) continue;
    }
    matches.push(frame.id);
  }
  if (matches.length !== 1) throw failure(new Error(`Frame locator must match exactly once; matched ${matches.length}`), { locator: scope, matched_frame_ids: matches.slice(0, 10) });
  return matches[0];
}

export async function resolveFrame(cdp, value, sessions, tabId, args, budget, { wait = true } = {}) {
  while (true) {
    try { return await resolveFrameOnce(cdp, value, sessions, tabId, args, budget); }
    catch (error) {
      if (!wait) throw error;
      if (!/Frame locator.*matched 0|Frame document.*not available|Selector.*matched 0|context.*destroyed|cannot find context/i.test(error.message)) throw error;
      budget.describe?.(`frame ${JSON.stringify(args.frame)}; current=${error.message}`, error.diagnostics);
      await budget.run(() => new Promise(resolve => setTimeout(resolve, 20)));
    }
  }
}
