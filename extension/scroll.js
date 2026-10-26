import { resolveSelector } from './locator.js';

export function scrollOptions(args) {
  if (!['dom', 'wheel'].includes(args.mode ?? 'dom')) throw new Error('Scroll mode must be dom or wheel');
  if (!Number.isFinite(args.delta_x ?? 0) || args.delta_y != null && !Number.isFinite(args.delta_y)) throw new Error('Scroll deltas must be finite');
  if (!args.until && !Number.isFinite(args.delta_y)) throw new Error('delta_y is required without until');
  if (args.until) {
    if (args.mode === 'wheel') throw new Error('until search requires explicit DOM scroll mode');
    const { text, selector } = args.until;
    if (typeof text !== 'string' || !text || text.length > 2000 || selector != null && (typeof selector !== 'string' || !selector)) throw new Error('until requires nonempty text and optional CSS selector');
    if (!Number.isInteger(args.max_steps ?? 100) || (args.max_steps ?? 100) < 1 || (args.max_steps ?? 100) > 500) throw new Error('max_steps must be 1..500');
  }
}

export function scrollElement(dx, dy) {
  if (!this.isConnected) throw new Error('Scroll container is detached');
  const before = { x: this.scrollLeft, y: this.scrollTop };
  this.scrollBy({ left: dx, top: dy ?? Math.max(1, this.clientHeight * 0.8), behavior: 'instant' });
  const after = { x: this.scrollLeft, y: this.scrollTop, width: this.scrollWidth, height: this.scrollHeight,
    client_width: this.clientWidth, client_height: this.clientHeight };
  return { scrolled: before.x !== after.x || before.y !== after.y, before, after, method: 'dom_scroll', scope: 'element' };
}

export function scrollState() {
  if (!this.isConnected) throw new Error('Scroll container is detached');
  return { x: this.scrollLeft, y: this.scrollTop, width: this.scrollWidth, height: this.scrollHeight,
    client_width: this.clientWidth, client_height: this.clientHeight };
}

export function findScrollText(text, selector) {
  if (!this.isConnected) throw new Error('Scroll container detached');
  const elements = this.querySelectorAll(selector || '*');
  if (elements.length > 10000) throw new Error('Scroll search exceeds 10000 candidates; scope until.selector');
  const matches = [];
  for (const element of elements) {
    if (!(element.textContent || '').includes(text)) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0 && element.ownerDocument.defaultView.getComputedStyle(element).visibility === 'visible') matches.push(element);
  }
  // Document order keeps each subtree contiguous, even after filtering.
  const leaves = matches.filter((element, index) => index === matches.length - 1 || !element.contains(matches[index + 1]));
  if (leaves.length > 1) throw new Error(`Scroll text must match one element; matched ${leaves.length}. Scope until.selector`);
  return leaves[0] || null;
}

export function createScrolling(cdp, value, sessions, pointer, viewport, position, observations, currentClaim) {
  async function search(tabId, node, args) {
    const { text, selector } = args.until;
    const maxSteps = args.max_steps ?? 100;
    const root = node || await resolveSelector(cdp, value, sessions, tabId, { selector: 'html' }, args.budget);
    const claim = currentClaim(tabId), version = observations.version(tabId), frameVersion = observations.frameVersion(tabId, root.frameId);
    let last, steps = 0, scrollPending = false, boundaryObserved = false, stopReason;
    const changed = () => currentClaim(tabId) !== claim ? 'control_changed' : observations.version(tabId) !== version ? 'document_changed'
      : observations.frameVersion(tabId, root.frameId) !== frameVersion ? 'frame_changed' : null;
    try {
      while (true) {
        stopReason = changed();
        if (stopReason) throw new Error('Document/frame/control changed during scroll search; observe before continuing');
        const found = await args.budget.run(() => cdp(root.target, 'Runtime.callFunctionOn', { objectId: root.objectId,
          functionDeclaration: findScrollText.toString(), arguments: [{ value: text }, { value: selector }], objectGroup: 'browser-attach-search' }));
        value(found);
        if (found.result?.objectId) {
          const result = await observations.rememberElement(tabId, root.target, found.result.objectId, root.frameId, args.budget);
          await args.budget.run(() => cdp(root.target, 'Runtime.releaseObjectGroup', { objectGroup: 'browser-attach-search' }));
          return { found: true, ...result, scroll_steps: steps, application_result: 'not_checked', observe_again: true };
        }
        if (steps === maxSteps) { stopReason = 'max_steps'; throw new Error(`Scroll search did not find ${JSON.stringify(text)} within ${maxSteps} steps`); }
        if (last?.scrolled === false) {
          // A boundary may precede lazy loading. Observe without repeating a
          // no-op scroll until content grows, a match appears, or time runs out.
          const current = value(await args.budget.run(() => cdp(root.target, 'Runtime.callFunctionOn', { objectId: root.objectId,
            functionDeclaration: scrollState.toString(), returnByValue: true })));
          if (JSON.stringify(current) === JSON.stringify(last.after)) { await args.budget.run(() => new Promise(resolve => setTimeout(resolve, 50))); continue; }
        }
        args.budget.dispatch();
        scrollPending = true;
        last = value(await args.budget.run(() => cdp(root.target, 'Runtime.callFunctionOn', { objectId: root.objectId,
          functionDeclaration: scrollElement.toString(), arguments: [{ value: args.delta_x ?? 0 }, { value: args.delta_y ?? null }], returnByValue: true })));
        scrollPending = false;
        steps++;
        boundaryObserved ||= last.scrolled === false;
        await args.budget.run(() => new Promise(resolve => setTimeout(resolve, 50)));
      }
    } catch (error) {
      const timedOut = error.deadline_exceeded === true;
      stopReason ||= changed() || (timedOut ? 'timeout' : 'error');
      const cause = error.diagnostics;
      error.diagnostics = { reason: 'scroll_search_stopped', stop_reason: stopReason, frame_id: root.frameId,
        scroll_steps: steps, scroll_pending: scrollPending, boundary_observed: boundaryObserved, last_scroll: last ?? null,
        ...(cause && !timedOut ? { cause } : {}) };
      if (timedOut) error.message = `Scroll search did not finish before its deadline while looking for ${JSON.stringify(text)}`;
      error.message += '. Content may still load later; a boundary does not prove all data was loaded. Observe before continuing; do not replay automatically.';
      error.input_dispatched = args.budget.has_dispatched();
      error.outcome_unknown = error.input_dispatched;
      throw error;
    }
  }

  async function scroll(tabId, node, args) {
    if (args.until != null) return search(tabId, node, args);
    const mode = args.mode ?? 'dom';
    const budget = args.budget;
    const view = await budget.run(() => viewport(tabId));
    if (node && mode === 'dom') {
      budget.dispatch();
      return { ...value(await budget.run(() => cdp(node.target, 'Runtime.callFunctionOn', { objectId: node.objectId,
        functionDeclaration: scrollElement.toString(), arguments: [{ value: args.delta_x ?? 0 }, { value: args.delta_y }], returnByValue: true }))), observe_again: true };
    }
    const point = node ? (await pointer.prepare(tabId, node, { budget })).point : position(view, args.x ?? view.width / 2, args.y ?? view.height / 2);
    budget.dispatch();
    if (mode === 'wheel') {
      // Root-widget routing respects ancestor overlays and OOPIF boundaries.
      // A protocol acknowledgement does not prove a page handler ran or scrolled.
      await budget.run(() => cdp(tabId, 'Input.dispatchMouseEvent', {
        type: 'mouseWheel', ...point, deltaX: args.delta_x ?? 0, deltaY: args.delta_y,
        button: 'none', buttons: 0, modifiers: 0,
      }));
      return { dispatched: true, method: 'native_wheel', at: point, coordinate_space: 'viewport_css_pixels',
        application_result: 'not_checked', observe_again: true };
    }
    const result = value(await budget.run(() => cdp(tabId, 'Runtime.evaluate', { returnByValue: true,
      expression: `(${scrollAtPoint.toString()})(${point.x},${point.y},${args.delta_x ?? 0},${args.delta_y})` })));
    return { ...result, observe_again: true };
  }
  return { scroll };
}

function scrollAtPoint(x, y, dx, dy) {
  let doc = document;
  let element = doc.elementFromPoint(x, y);
  const enteredShadowHosts = new Set();
  while (element) {
    if (element.tagName === 'IFRAME') {
      const frame = element;
      const rect = frame.getBoundingClientRect();
      try { doc = frame.contentDocument; } catch { doc = null; }
      if (!doc) throw new Error('Cross-origin iframe scrolling is unavailable; scroll the outer page or use the website controls.');
      x -= rect.left + frame.clientLeft; y -= rect.top + frame.clientTop;
      element = doc.elementFromPoint(x, y);
      continue;
    }
    if (element.shadowRoot && !enteredShadowHosts.has(element)) {
      enteredShadowHosts.add(element);
      const inner = element.shadowRoot.elementFromPoint(x, y);
      if (inner && inner !== element) { element = inner; continue; }
    }
    const style = doc.defaultView.getComputedStyle(element);
    const canX = /auto|scroll|overlay/.test(style.overflowX) && element.scrollWidth > element.clientWidth &&
      ((dx > 0 && element.scrollLeft < element.scrollWidth - element.clientWidth) || (dx < 0 && element.scrollLeft > 0));
    const canY = /auto|scroll|overlay/.test(style.overflowY) && element.scrollHeight > element.clientHeight &&
      ((dy > 0 && element.scrollTop < element.scrollHeight - element.clientHeight) || (dy < 0 && element.scrollTop > 0));
    if (canX || canY) break;
    const parent = element.parentElement || element.getRootNode().host;
    if (!parent) { element = doc.scrollingElement; break; }
    element = parent;
  }
  if (!element) element = doc.scrollingElement;
  const before = { x: element.scrollLeft, y: element.scrollTop };
  element.scrollBy({ left: dx, top: dy, behavior: 'instant' });
  const after = { x: element.scrollLeft, y: element.scrollTop };
  return { scrolled: before.x !== after.x || before.y !== after.y, before, after,
    method: 'dom_scroll', scope: element === doc.scrollingElement ? 'document' : 'element' };
}
