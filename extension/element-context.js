import { boundedRead } from './outcomes.js';

// A bounded DOM neighborhood, not inferred ownership or dismissal controls.
export function collectElementContext(maxNodes) {
  if (this.nodeType !== 1 || !this.isConnected) throw new Error('Context target is detached');
  const nodes = [this], entries = [{ relation: 'target' }];
  const add = (element, relation, detail = {}) => { nodes.push(element); entries.push({ relation, ...detail }); };
  const parentOf = element => element.parentElement || element.getRootNode().host || null;
  let current = this, parent = parentOf(current);
  for (let depth = 0; parent && depth < 3 && nodes.length < maxNodes; depth++) {
    add(parent, 'ancestor', { via: current.parentElement ? 'parent' : 'shadow_host' });
    current = parent; parent = parentOf(current);
  }
  const omitted = { ancestors_more: !!parent, children: this.childElementCount, siblings: Math.max(0, (this.parentNode?.childElementCount ?? 1) - 1) };
  const remaining = maxNodes - nodes.length;
  let childCount = Math.min(omitted.children, Math.ceil(remaining / 2));
  const siblingCount = Math.min(omitted.siblings, remaining - childCount);
  childCount = Math.min(omitted.children, remaining - siblingCount);
  for (let index = 0; index < childCount; index++) add(this.children[index], 'child');
  const previous = [], next = [];
  for (let element = this.previousElementSibling; element && previous.length < siblingCount; element = element.previousElementSibling) previous.push(element);
  for (let element = this.nextElementSibling; element && next.length < siblingCount; element = element.nextElementSibling) next.push(element);
  let before = Math.min(previous.length, Math.ceil(siblingCount / 2)), after = Math.min(next.length, siblingCount - before);
  before = Math.min(previous.length, siblingCount - after);
  previous.slice(0, before).reverse().forEach(element => add(element, 'sibling'));
  next.slice(0, after).forEach(element => add(element, 'sibling'));
  omitted.children -= childCount; omitted.siblings -= before + after;
  const clip = text => String(text).slice(0, 300);
  entries.forEach((entry, index) => {
    const element = nodes[index], rect = element.getBoundingClientRect(), win = element.ownerDocument.defaultView, style = win.getComputedStyle(element);
    const text = ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) ? '' : element.innerText || '';
    const truncated = [], attribute = name => {
      const text = element.getAttribute(name);
      if (text == null) return null;
      if (text.length > 300) truncated.push(name);
      return clip(text);
    };
    entry.dom = { tag: element.tagName.toLowerCase(), id: clip(element.id || '') || null,
      classes: Array.from(element.classList).slice(0, 8).map(name => name.slice(0, 100)), text: clip(text), ...(text.length > 300 ? { text_truncated: true } : {}),
      role: attribute('role'), aria_label: attribute('aria-label'), title: attribute('title'), aria_hidden: attribute('aria-hidden'), aria_modal: attribute('aria-modal'),
      disabled: element.matches(':disabled'), aria_disabled: attribute('aria-disabled'),
      ...(truncated.length ? { truncated_attributes: truncated } : {}),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      coordinate_space: 'frame_viewport_css_pixels', visible: rect.width > 0 && rect.height > 0 && style.visibility === 'visible',
      position: style.position, z_index: style.zIndex, pointer_events: style.pointerEvents };
  });
  nodes.facts = { entries, omitted };
  return nodes;
}

export function createContextReader(cdp, value, sessions, observations, resolveNode, currentClaim) {
  return async (tabId, args, budget) => {
    const claim = currentClaim(tabId), version = observations.version(tabId), group = 'browser-attach-context';
    let target;
    try {
      const node = await resolveNode(tabId, args, budget);
      target = node.target;
      const frameVersion = observations.frameVersion(tabId, node.frameId);
      const assertCurrent = () => {
        if (!claim || currentClaim(tabId) !== claim || observations.version(tabId) !== version ||
            observations.frameVersion(tabId, node.frameId) !== frameVersion || sessions.target(tabId, node.frameId).sessionId !== target.sessionId) {
          throw new Error('Context document/frame/control changed; observe again');
        }
      };
      const send = (method, params) => budget.run(() => cdp(target, method, params));
      assertCurrent();
      const { executionContextId } = await send('Page.createIsolatedWorld', { frameId: node.frameId, worldName: group });
      const { object } = await send('DOM.resolveNode', { backendNodeId: node.backendNodeId, executionContextId, objectGroup: group });
      if (!object?.objectId) throw new Error('Context target detached');
      const collected = await send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: collectElementContext.toString(),
        arguments: [{ value: args.max_nodes ?? 20 }], objectGroup: group });
      value(collected);
      if (!collected.result?.objectId) throw new Error('Context DOM observation is unavailable');
      const facts = value(await send('Runtime.callFunctionOn', { objectId: collected.result.objectId, functionDeclaration: 'function() { return this.facts; }', returnByValue: true }));
      const result = { view: 'context', frame_id: node.frameId, target: null, ancestors: [], children: [], siblings: [], omitted: facts.omitted,
        application_result: 'not_checked' };
      const lists = { ancestor: 'ancestors', child: 'children', sibling: 'siblings' };
      const size = () => JSON.stringify({ ...result, entries: facts.entries }).length + facts.entries.length * 300;
      while (facts.entries.length > 1 && size() > (args.max_chars ?? 16000)) {
        const removed = facts.entries.pop();
        if (removed.relation === 'ancestor') result.omitted.ancestors_more = true;
        else result.omitted[lists[removed.relation]]++;
      }
      if (size() > (args.max_chars ?? 16000)) throw new Error('Context target exceeds max_chars; increase the budget');
      const { result: properties } = await send('Runtime.getProperties', { objectId: collected.result.objectId, ownProperties: true });
      const elements = new Map(properties.filter(item => /^\d+$/.test(item.name) && item.value?.objectId).map(item => [Number(item.name), item.value.objectId]));
      for (const [index, entry] of facts.entries.entries()) {
        assertCurrent();
        const item = { ref: null, ...(entry.via ? { via: entry.via } : {}), dom: entry.dom };
        try {
          if (!elements.has(index)) throw new Error('Element identity is unavailable');
          item.ref = (await observations.rememberElement(tabId, target, elements.get(index), node.frameId, budget)).ref;
        } catch (error) {
          if (error.deadline_exceeded) throw error;
          item.ref_unavailable = String(error.message).slice(0, 100);
        }
        if (entry.relation === 'target') result.target = item;
        else result[lists[entry.relation]].push(item);
      }
      const connected = value(await send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: 'function() { return this.isConnected; }', returnByValue: true }));
      if (!connected) throw new Error('Context target detached during observation');
      if (JSON.stringify(result).length > (args.max_chars ?? 16000)) throw new Error('Context facts exceed max_chars; increase the budget');
      return await budget.run(() => { assertCurrent(); return result; });
    } finally {
      if (target) await boundedRead(() => Promise.allSettled([cdp(target, 'Runtime.releaseObjectGroup', { objectGroup: group }),
        cdp(target, 'Runtime.releaseObjectGroup', { objectGroup: 'browser-attach' })]), 100).catch(() => {});
    }
  };
}
