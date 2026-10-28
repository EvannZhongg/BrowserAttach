import { deadline, waitForTarget } from './actionability.js';
import { offsetOption } from './motion.js';
import { describeTarget } from './target-description.js';

export function createPointer(cdp, value, viewport, position, sessions, getTab, getWindow) {
  async function assertReady(tabId, budget, action, args = {}) {
    const inactiveClick = action === 'click' && (args.button ?? 'left') === 'left' &&
      (args.click_count ?? 1) === 1 && (args.modifiers ?? []).length === 0;
    const timeout = Math.min(500, budget.remaining());
    const guidance = 'Call browser_tab_control action=activate with this tab_handle, then browser_snapshot and retry the requested pointer action. If focus is still unavailable, restore/focus the browser window. No input was dispatched.';
    let timer;
    try {
      if (timeout <= 0) throw new Error('input deadline expired before the readiness check');
      return await Promise.race([
        (async () => {
          const tab = await getTab(tabId);
          if ((!tab.active && !inactiveClick) || tab.discarded || tab.frozen) throw new Error(`tab not active or renderer suspended (active=${tab.active}, discarded=${!!tab.discarded}, frozen=${!!tab.frozen})`);
          const window = await getWindow(tab.windowId);
          if (window.state === 'minimized') throw new Error('browser window is minimized');
          const state = value(await cdp(tabId, 'Runtime.evaluate', {
            expression: '({visibility_state: document.visibilityState, has_focus: document.hasFocus()})', returnByValue: true,
          }));
          if (typeof state?.visibility_state !== 'string' || typeof state.has_focus !== 'boolean') throw new Error('page readiness unavailable');
          // A hidden renderer can still receive a complete click, while an
          // isolated move or drag may stall. Delivery still needs a trusted receipt.
          return { ...state, tab_active: tab.active, window_focused: window.focused };
        })(),
        new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(`readiness check did not respond within ${timeout} ms`)), timeout); }),
      ]);
    } catch (error) {
      throw Object.assign(new Error(`TAB_NOT_READY: Native pointer input not dispatched: ${error.message}. ${guidance}`), { input_dispatched: false });
    } finally { clearTimeout(timer); }
  }
  async function prepare(tabId, node, args) {
    const budget = args.budget || deadline(args.timeout_ms);
    try { return await prepareOnce(tabId, node, { ...args, budget }); }
    catch (error) {
      if (!node || args.scroll === false || budget.has_dispatched() || error.input_dispatched !== false ||
          !['obstructed', 'frame_obstructed'].includes(error.diagnostics?.reason)) throw error;
      // Chromium may leave a visible target behind a sticky overlay. Recenter
      // once before input, then repeat every hit/frame check on the same node.
      budget.describe?.('one bounded centering scroll', { reason: 'preparation_timeout', frame_id: node.frameId });
      value(await budget.run(() => cdp(node.target, 'Runtime.callFunctionOn', { objectId: node.objectId, returnByValue: true,
        functionDeclaration: `function() {
          if (!this.isConnected) throw new Error('Element detached before centering; no input was dispatched.');
          this.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
        }` })));
      return prepareOnce(tabId, node, { ...args, budget, scroll: false });
    }
  }
  async function prepareOnce(tabId, node, args) {
    offsetOption(args);
    if (!!node === (args.x != null || args.y != null)) throw new Error('Provide either ref/selector or x/y');
    if (args.coordinate_space != null && !['viewport', 'document'].includes(args.coordinate_space)) throw new Error('coordinate_space must be viewport or document');
    if (node && args.coordinate_space != null) throw new Error('coordinate_space applies to coordinate clicks only');
    const budget = args.budget || deadline(args.timeout_ms);
    const obstruction = (detail, diagnostics) => Object.assign(new Error(`${detail}. ${budget.has_dispatched()
      ? 'Input has already been dispatched. Outcome is unknown; observe before continuing. Do not replay automatically.'
      : 'No input was dispatched.'}`), { outcome_unknown: budget.has_dispatched(), input_dispatched: budget.has_dispatched(), diagnostics });
    let target = node?.target || { tabId };
    const send = (method, params) => budget.run(() => cdp(target, method, params));
    let point, view;
    if (node) {
      await waitForTarget(cdp, value, target, node, budget);
      if (args.scroll !== false) await send('DOM.scrollIntoViewIfNeeded', { backendNodeId: node.backendNodeId });
      await waitForTarget(cdp, value, target, node, budget);
      const { quads } = await send('DOM.getContentQuads', { backendNodeId: node.backendNodeId });
      view = await budget.run(() => viewport(target));
      for (const quad of quads || []) {
        point = clippedPoint(quad, view, args.offset);
        if (point) break;
      }
      if (!point) throw obstruction('Element has no visible click point. Inspect a screenshot', {
        reason: 'no_visible_click_point', frame_id: node.frameId, viewport: view, quads: quads || [],
      });
    } else {
      view = await budget.run(() => viewport(target));
      if (args.coordinate_space === 'document') {
        if (!Number.isFinite(args.x) || !Number.isFinite(args.y) || args.x < 0 || args.y < 0) throw new Error('Document coordinates must be finite and nonnegative');
        const x = args.x - view.scroll_x, y = args.y - view.scroll_y;
        if (args.scroll !== false && (x < 0 || y < 0 || x >= view.width || y >= view.height)) {
          const left = x < 0 || x >= view.width ? Math.max(0, args.x - view.width / 2) : view.scroll_x;
          const top = y < 0 || y >= view.height ? Math.max(0, args.y - view.height / 2) : view.scroll_y;
          value(await send('Runtime.evaluate', { returnByValue: true,
            expression: `scrollTo({left:${left},top:${top},behavior:'instant'})` }));
          view = await budget.run(() => viewport(target));
        }
        point = position(view, args.x - view.scroll_x, args.y - view.scroll_y);
      } else point = position(view, args.x, args.y);
    }
    // DOM hit testing uses document CSS coordinates; Input uses viewport CSS coordinates.
    let hitNode = await send('DOM.getNodeForLocation', {
      x: Math.floor(point.x + view.scroll_x), y: Math.floor(point.y + view.scroll_y), includeUserAgentShadowDOM: true,
    });
    // Coordinate input starts in the root viewport; descend into a remote frame
    // before resolving backend ids or installing isolated-world verification.
    const visited = new Set();
    while (!node) {
      const description = await send('DOM.describeNode', { backendNodeId: hitNode.backendNodeId, depth: 0 });
      const childId = description.node.frameId, child = childId && sessions.target(tabId, childId);
      if (!child?.sessionId || child.sessionId === target.sessionId) break;
      if (visited.has(child.sessionId)) throw new Error('Frame hit-test cycle; no input was dispatched.');
      visited.add(child.sessionId);
      const { model } = await send('DOM.getBoxModel', { backendNodeId: hitNode.backendNodeId });
      const childView = await budget.run(() => viewport(child));
      point = framePoint(point, model.content, childView, true);
      target = child; view = childView;
      hitNode = await send('DOM.getNodeForLocation', { x: Math.floor(point.x + view.scroll_x), y: Math.floor(point.y + view.scroll_y), includeUserAgentShadowDOM: true });
    }
    let { backendNodeId } = hitNode;
    const { frameId } = hitNode;
    let hit = await send('DOM.resolveNode', { backendNodeId, objectGroup: 'browser-attach' });
    const pseudo = hit.object.className === 'CSSPseudoElement';
    if (pseudo || hit.object.className === 'ShadowRoot') {
      let localPoint = point;
      if (!pseudo && frameId && (await send('Page.getFrameTree')).frameTree.frame.id !== frameId) {
        // Same-process frame quads are session-relative, while ShadowRoot hit
        // testing expects the owning document's viewport coordinates.
        const owner = await send('DOM.getFrameOwner', { frameId });
        const { model } = await send('DOM.getBoxModel', { backendNodeId: owner.backendNodeId });
        const { executionContextId } = await send('Page.createIsolatedWorld', { frameId, worldName: 'browser-attach-locator' });
        const frameView = value(await send('Runtime.evaluate', { contextId: executionContextId,
          expression: '({width: innerWidth, height: innerHeight})', returnByValue: true }));
        localPoint = framePoint(point, model.content, frameView, true);
      }
      const normalized = await send('Runtime.callFunctionOn', { objectId: hit.object.objectId,
        functionDeclaration: normalizeHit.toString(), arguments: [{ value: localPoint.x }, { value: localPoint.y }], objectGroup: 'browser-attach' });
      value(normalized);
      if (!normalized.result?.objectId) throw new Error('Hit element could not be resolved; no input was dispatched.');
      hit = { object: normalized.result };
      const { node: origin } = await send('DOM.describeNode', { objectId: hit.object.objectId });
      backendNodeId = origin.backendNodeId;
    }
    const hitTarget = value(await send('Runtime.callFunctionOn', { objectId: hit.object.objectId,
      functionDeclaration: describeHit.toString(), returnByValue: true }));
    if (pseudo) hitTarget.pseudo_element = true;
    let relation = null;
    if (node) {
      // resolveNode without an explicit context can reuse wrappers from a prior
      // isolated read. Compare both backend identities in the same frame world.
      const { executionContextId } = await send('Page.createIsolatedWorld', { frameId: node.frameId, worldName: 'browser-attach-input' });
      if (!executionContextId) throw new Error('Could not create hit verification context; no input was dispatched.');
      const expected = await send('DOM.resolveNode', { backendNodeId: node.backendNodeId, executionContextId, objectGroup: 'browser-attach' });
      const actual = await send('DOM.resolveNode', { backendNodeId, executionContextId, objectGroup: 'browser-attach' });
      relation = value(await send('Runtime.callFunctionOn', {
        objectId: expected.object.objectId, functionDeclaration: hitRelation.toString(),
        arguments: [{ objectId: actual.object.objectId }], returnByValue: true,
      }));
      if (!relation) {
        const requested = await requestedTarget(node);
        throw obstruction(`Another element covers the requested target. requested_target=${JSON.stringify(requested)}; hit_target=${JSON.stringify(hitTarget)}; point=${JSON.stringify(point)}; frame_id=${JSON.stringify(node.frameId)}`,
          { reason: 'obstructed', requested_target: requested, blocked_by: hitTarget, hit_target: hitTarget, point, coordinate_space: 'session_viewport_css_pixels', frame_id: node.frameId, hit_relation: null });
      }
    }
    // Dispatch through the root widget so overlays in ancestor documents cannot
    // be bypassed by sending directly to an OOPIF widget. Guard every boundary.
    const boundaries = [];
    let rootPoint = point, current = target, currentView = view;
    while (current.sessionId) {
      const parent = sessions.parent(tabId, current.sessionId);
      const owner = await budget.run(() => cdp(parent.target, 'DOM.getFrameOwner', { frameId: parent.frameId }));
      const { model } = await budget.run(() => cdp(parent.target, 'DOM.getBoxModel', { backendNodeId: owner.backendNodeId }));
      rootPoint = framePoint(rootPoint, model.content, currentView);
      const parentView = await budget.run(() => viewport(parent.target));
      position(parentView, rootPoint.x, rootPoint.y);
      const parentHit = await budget.run(() => cdp(parent.target, 'DOM.getNodeForLocation', {
        x: Math.floor(rootPoint.x + parentView.scroll_x), y: Math.floor(rootPoint.y + parentView.scroll_y), includeUserAgentShadowDOM: true,
      }));
      if (parentHit.backendNodeId !== owner.backendNodeId) {
        let blocker;
        try {
          const diagnostic = budget.child(200);
          const resolved = await diagnostic.run(() => cdp(parent.target, 'DOM.resolveNode', { backendNodeId: parentHit.backendNodeId, objectGroup: 'browser-attach' }));
          blocker = value(await diagnostic.run(() => cdp(parent.target, 'Runtime.callFunctionOn', { objectId: resolved.object.objectId,
            functionDeclaration: describeHit.toString(), returnByValue: true })));
        } catch { /* Preserve the obstruction error even if its node disappears. */ }
        const requested = node ? await requestedTarget(node) : null;
        throw obstruction(`Another element covers this frame. requested_target=${JSON.stringify(requested)}; hit_target=${JSON.stringify(blocker ?? { backend_node_id: parentHit.backendNodeId })}; point=${JSON.stringify(rootPoint)}; blocked_frame_id=${JSON.stringify(parent.frameId)}`,
          { reason: 'frame_obstructed', requested_target: requested, blocked_by: blocker ?? { backend_node_id: parentHit.backendNodeId }, hit_target: blocker ?? null, point: rootPoint, coordinate_space: 'session_viewport_css_pixels', blocked_frame_id: parent.frameId });
      }
      const ownerFrameId = parent.ownerFrameId || (await budget.run(() => cdp(parent.target, 'Page.getFrameTree'))).frameTree.frame.id;
      boundaries.push({ target: parent.target, backendNodeId: owner.backendNodeId, frameId: ownerFrameId });
      current = parent.target; currentView = parentView;
    }
    return { target, point: rootPoint, hitTarget, relation, frameId: node?.frameId || frameId, backendNodeId: node?.backendNodeId || backendNodeId, boundaries };
    async function requestedTarget(node) {
      const identity = { backend_node_id: node.backendNodeId, frame_id: node.frameId };
      try {
        const detail = value(await budget.child(100).run(() => cdp(node.target, 'Runtime.callFunctionOn', {
          objectId: node.objectId, functionDeclaration: describeTarget.toString(), returnByValue: true,
        })));
        return { ...identity, ...detail };
      } catch { return identity; }
    }
  }
  return { assertReady, prepare };
}

export function describeHit() {
  const element = this.nodeType === 3 ? this.parentElement : this;
  if (element?.nodeType !== 1) throw new Error('Hit target is not an Element; no input was dispatched.');
  let clickable, disabled = false, nativeSelect = false;
  for (let parent = element; parent; parent = parent.assignedSlot || parent.parentElement || parent.getRootNode().host) {
    if (parent.tagName === 'SELECT' || parent.tagName === 'LABEL' && parent.control?.tagName === 'SELECT') nativeSelect = true;
    if (!clickable && parent.matches('button,a[href],input,select,textarea,summary,[role="button"],[role="link"],[onclick]')) clickable = parent;
    if (parent.matches(':disabled,[inert],[aria-disabled="true"]')) disabled = true;
  }
  const rect = element.getBoundingClientRect(), style = element.ownerDocument.defaultView.getComputedStyle(element);
  const identity = node => ({ tag: node.tagName.toLowerCase(), id: node.id || null,
    classes: Array.from(node.classList).slice(0, 8).map(name => name.slice(0, 100)) });
  return { ...identity(element), text: (element.innerText || element.textContent || '').slice(0, 300),
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, coordinate_space: 'frame_viewport_css_pixels',
    position: style.position, z_index: style.zIndex, visibility: style.visibility,
    role: element.getAttribute('role'), disabled, clickable_hint: !!clickable,
    native_select: nativeSelect,
    clickable_target: clickable ? { ...identity(clickable), role: clickable.getAttribute('role'),
      text: (clickable.innerText || clickable.textContent || '').slice(0, 300) } : null };
}

export function normalizeHit(x, y) {
  let element = this.element || (this.nodeType === 3 ? this.parentElement : this);
  if (element?.nodeType === 11 && element.host) element = element.elementFromPoint(x, y);
  if (element?.nodeType !== 1) throw new Error('Hit test did not resolve an Element; no input was dispatched.');
  return element;
}

export function hitRelation(hit) {
  if (hit === this) return 'same_node';
  for (let node = hit; node; node = node.assignedSlot || node.parentNode || node.host) {
    if (node === this) return 'composed_descendant';
  }
  return null;
}

export function clippedPoint(quad, view, offset) {
  if (offset) {
    const { x_ratio: x, y_ratio: y } = offset;
    const point = { x: (1 - y) * ((1 - x) * quad[0] + x * quad[2]) + y * ((1 - x) * quad[6] + x * quad[4]),
      y: (1 - y) * ((1 - x) * quad[1] + x * quad[3]) + y * ((1 - x) * quad[7] + x * quad[5]) };
    return point.x >= 0 && point.y >= 0 && point.x < view.width && point.y < view.height ? point : null;
  }
  let polygon = Array.from({ length: 4 }, (_, i) => ({ x: quad[i * 2], y: quad[i * 2 + 1] }));
  for (const [axis, bound, lower] of [['x', 0, true], ['x', view.width - 0.01, false], ['y', 0, true], ['y', view.height - 0.01, false]]) {
    const input = polygon; polygon = [];
    for (let i = 0; i < input.length; i++) {
      const a = input[i], b = input[(i + 1) % input.length];
      const insideA = lower ? a[axis] >= bound : a[axis] <= bound;
      const insideB = lower ? b[axis] >= bound : b[axis] <= bound;
      if (insideA) polygon.push(a);
      if (insideA !== insideB) {
        const t = (bound - a[axis]) / (b[axis] - a[axis]);
        polygon.push({ x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) });
      }
    }
  }
  const twiceArea = polygon.reduce((sum, a, i) => {
    const b = polygon[(i + 1) % polygon.length]; return sum + a.x * b.y - b.x * a.y;
  }, 0);
  if (Math.abs(twiceArea) < 2) return null;
  const point = { x: 0, y: 0 };
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length], cross = a.x * b.y - b.x * a.y;
    point.x += (a.x + b.x) * cross; point.y += (a.y + b.y) * cross;
  }
  return { x: point.x / (3 * twiceArea), y: point.y / (3 * twiceArea) };
}

// Affine transforms cover translation, scale, rotation and skew. Reject
// perspective rather than silently clicking a wrongly transformed position.
export function framePoint(point, quad, view, inverse = false) {
  const [x, y, x1, y1, x2, y2, x3, y3] = quad;
  const ax = x1 - x, ay = y1 - y, bx = x3 - x, by = y3 - y;
  if (Math.abs(x2 - x1 - x3 + x) > 0.5 || Math.abs(y2 - y1 - y3 + y) > 0.5) throw new Error('Perspective iframe transforms are unsupported; no input was dispatched.');
  const determinant = ax * by - ay * bx;
  if (Math.abs(determinant) < 0.001) throw new Error('Frame has no visible content area; no input was dispatched.');
  if (inverse) {
    const dx = point.x - x, dy = point.y - y;
    return { x: (dx * by - dy * bx) / determinant * view.width, y: (dy * ax - dx * ay) / determinant * view.height };
  }
  return { x: x + point.x / view.width * ax + point.y / view.height * bx,
    y: y + point.x / view.width * ay + point.y / view.height * by };
}
