import { deadline } from './actionability.js';
import { targetOptions, resolveSelector } from './locator.js';
import { popupProperties } from './snapshot.js';
import { boundedRead } from './outcomes.js';

const OPTION_ROLES = new Set(['option', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'treeitem']);
const STATES = new Set(['disabled', 'readonly', 'required', 'invalid', 'checked', 'selected', 'expanded', 'focused', 'multiselectable']);

export function controlOptions(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('observe requires a control locator object');
  targetOptions(args);
  if (args.popup_selector != null && (typeof args.popup_selector !== 'string' || !args.popup_selector.trim() || args.popup_selector.length > 10000)) throw new Error('popup_selector must contain 1..10000 CSS characters');
  for (const [key, fallback, min, max] of [['timeout_ms', 1000, 100, 5000], ['max_options', 30, 1, 100], ['max_chars', 16000, 1000, 64000]]) {
    if (!Number.isInteger(args[key] ?? fallback) || (args[key] ?? fallback) < min || (args[key] ?? fallback) > max) throw new Error(`${key} must be ${min}..${max}`);
  }
}

function axFacts(node, protectedValue = false) {
  if (!node || node.ignored) return null;
  const name = String(node.name?.value || '');
  const facts = { role: node.role?.value, name: name.slice(0, 1000), ...(name.length > 1000 ? { name_truncated: true } : {}) };
  if (!protectedValue && node.value?.value != null) {
    facts.value = typeof node.value.value === 'string' ? node.value.value.slice(0, 1000) : node.value.value;
    if (typeof node.value.value === 'string' && node.value.value.length > 1000) facts.value_truncated = true;
  }
  for (const property of node.properties || []) if (STATES.has(property.name)) facts[property.name] = property.value?.value;
  Object.assign(facts, popupProperties(node));
  return facts;
}

export function createControlReader(cdp, value, sessions, observations, resolveNode, currentClaim) {
  return async (tabId, args, budget = deadline(args.timeout_ms ?? 1000, 'snapshot')) => {
    controlOptions(args);
    const claim = currentClaim(tabId), version = observations.version(tabId), group = 'browser-attach-control';
    let target;
    try {
      const node = await resolveNode(tabId, args, budget);
      target = node.target;
      const frameVersion = observations.frameVersion(tabId, node.frameId);
      const assertCurrent = () => {
        if (!claim || currentClaim(tabId) !== claim || version !== observations.version(tabId) ||
            frameVersion !== observations.frameVersion(tabId, node.frameId) || sessions.target(tabId, node.frameId).sessionId !== target.sessionId) {
          throw new Error('Control observation document/frame/claim changed; no refs were published');
        }
      };
      const send = (method, params) => budget.run(() => cdp(target, method, params));
      assertCurrent();
      const { executionContextId } = await send('Page.createIsolatedWorld', { frameId: node.frameId, worldName: group });
      const { object } = await send('DOM.resolveNode', { backendNodeId: node.backendNodeId, executionContextId, objectGroup: group });
      if (!object?.objectId) throw new Error('Control detached during observation');
      const dom = value(await send('Runtime.callFunctionOn', { objectId: object.objectId,
        functionDeclaration: readControlDOM.toString(), arguments: [{ value: args.max_options ?? 30 }], returnByValue: true }));
      if (!dom || dom.detached) throw new Error('Control detached during observation');
      const { nodes } = await send('Accessibility.getFullAXTree', { frameId: node.frameId });
      const byBackend = new Map(), byId = new Map(nodes.map(ax => [ax.nodeId, ax]));
      for (const ax of nodes) if (ax.backendDOMNodeId && (!ax.ignored || !byBackend.has(ax.backendDOMNodeId))) byBackend.set(ax.backendDOMNodeId, ax);
      const control = byBackend.get(node.backendNodeId), related = [], activeNodes = [];
      for (const property of control?.properties || []) {
        if (!['controls', 'owns', 'activedescendant'].includes(property.name)) continue;
        for (const link of property.value?.relatedNodes || []) {
          const ax = byBackend.get(link.backendDOMNodeId);
          if (!ax) continue;
          if (property.name === 'activedescendant') {
            if (!ax.ignored && !activeNodes.includes(ax)) activeNodes.push(ax);
          } else if (!related.some(item => item.node === ax)) related.push({ node: ax, relation: property.name, ...(link.idref ? { id: link.idref.slice(0, 200) } : {}) });
        }
      }
      if (args.popup_selector != null) {
        const popup = await resolveSelector(cdp, value, sessions, tabId, { selector: args.popup_selector, frame_id: node.frameId }, budget, { wait: false });
        if (!popup) throw new Error('Explicit popup_selector did not match an element');
        const ax = byBackend.get(popup.backendNodeId);
        if (!ax) throw new Error('Explicit popup is unavailable in the current AX tree');
        if (!related.some(item => item.node === ax)) related.push({ node: ax, relation: 'explicit_selector' });
      }
      const popups = related.slice(0, 8), optionNodes = [], seen = new Set();
      const popupDOM = [];
      for (const popup of popups) {
        try {
          const resolved = await send('DOM.resolveNode', { backendNodeId: popup.node.backendDOMNodeId, executionContextId, objectGroup: group });
          const dom = value(await send('Runtime.callFunctionOn', { objectId: resolved.object.objectId,
            functionDeclaration: readControlDOM.toString(), arguments: [{ value: args.max_options ?? 30 }], returnByValue: true }));
          popupDOM.push(dom?.detached ? { available: false, error: 'Popup detached during observation' } : dom);
        } catch (error) {
          if (error.deadline_exceeded) throw error;
          popupDOM.push({ available: false, error: String(error.message).slice(0, 300) });
        }
      }
      function visit(root) {
        const pending = [root], visited = new Set();
        while (pending.length) {
          const ax = pending.pop();
          if (!ax || visited.has(ax.nodeId)) continue;
          visited.add(ax.nodeId);
          if (!ax.ignored && OPTION_ROLES.has(ax.role?.value) && ax.backendDOMNodeId && !seen.has(ax.backendDOMNodeId)) {
            seen.add(ax.backendDOMNodeId); optionNodes.push(ax);
          }
          for (let i = (ax.childIds?.length || 0) - 1; i >= 0; i--) pending.push(byId.get(ax.childIds[i]));
        }
      }
      if (control) visit(control);
      for (const popup of popups) visit(popup.node);
      // An active descendant outside the declared subtree is reported separately,
      // never used to claim ownership of other options in its surrounding popup.
      const active = activeNodes.length === 1 ? activeNodes[0] : null;
      const activeFacts = active ? { ref: null, ax: axFacts(active) } : null;
      const activeOption = active && OPTION_ROLES.has(active.role?.value) ? activeFacts : null;
      const selected = optionNodes.filter(ax => ax.properties?.some(p => p.name === 'selected' && p.value?.value === true));
      const result = { frame_id: node.frameId, control: { ref: null, dom, ax: axFacts(control, dom.value_redacted) },
        popups: popups.map((item, index) => ({ ref: null, relation: item.relation, ...(item.id ? { id: item.id } : {}), dom: popupDOM[index], ax: axFacts(item.node) })),
        active_descendant: activeFacts, active_option: activeOption,
        active_option_status: activeOption ? 'observed' : active ? 'non_option' : activeNodes.length ? 'ambiguous' : 'unavailable', options: [], observed_options: optionNodes.length,
        omitted_popups: Math.max(0, related.length - popups.length), option_order: 'ax_tree',
        application_result: 'not_checked' };
      const included = optionNodes.slice(0, args.max_options ?? 30);
      for (const ax of included) result.options.push({ ref: null, ax: axFacts(ax) });
      // Prioritize the committed selection and keyboard active item even when
      // ordinary options are truncated. No component-specific CSS is inferred.
      result.selected_options = selected.slice(0, args.max_options ?? 30).map(ax => ({ ref: null, ax: axFacts(ax) }));
      result.omitted_selected_options = Math.max(0, selected.length - result.selected_options.length);
      const maxChars = args.max_chars ?? 16000;
      const size = () => JSON.stringify(result).length + 160 * (result.options.length + result.selected_options.length + popups.length + 2);
      while (result.options.length && size() > maxChars - 100) result.options.pop();
      while (result.selected_options.length && size() > maxChars - 100) { result.selected_options.pop(); result.omitted_selected_options++; }
      result.omitted_options = Math.max(0, optionNodes.length - result.options.length);
      if (size() > maxChars - 100) throw new Error('Control facts exceed max_chars; increase max_chars or reduce max_options');
      const connected = value(await send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: 'function() { return this.isConnected; }', returnByValue: true }));
      if (!connected) throw new Error('Control detached during observation');
      return await budget.run(() => {
        assertCurrent();
        const published = [control, ...popups.map(item => item.node), active,
          ...included.slice(0, result.options.length), ...selected.slice(0, result.selected_options.length)].filter(ax => ax && !ax.ignored);
        const refs = observations.rememberAXNodes(tabId, target, node.frameId, published);
        result.control.ref = refs.get(node.backendNodeId) ?? null;
        result.popups.forEach((item, i) => { item.ref = refs.get(popups[i].node.backendDOMNodeId) ?? null; });
        if (active) result.active_descendant.ref = refs.get(active.backendDOMNodeId) ?? null;
        result.options.forEach((item, i) => { item.ref = refs.get(included[i].backendDOMNodeId) ?? null; });
        result.selected_options.forEach((item, i) => { item.ref = refs.get(selected[i].backendDOMNodeId) ?? null; });
        return result;
      });
    } finally {
      const cleanup = sessions.targets(tabId).map(target => cdp(target, 'Runtime.releaseObjectGroup', { objectGroup: 'browser-attach' }));
      if (target) cleanup.push(cdp(target, 'Runtime.releaseObjectGroup', { objectGroup: group }));
      await boundedRead(() => Promise.allSettled(cleanup), 100).catch(() => {});
    }
  };
}

export function readControlDOM(maxOptions) {
  if (!this.isConnected || this.nodeType !== 1) return { detached: true };
  const clip = text => String(text).slice(0, 1000), tag = this.tagName.toLowerCase();
  const result = { tag, id: clip(this.id || '') || null };
  if (tag === 'input') result.type = this.type;
  if (tag === 'input' && this.type === 'password') result.value_redacted = true;
  else if (['input', 'textarea', 'select'].includes(tag)) {
    result.value = clip(this.value); result.value_source = tag === 'input' ? 'input_value' : tag === 'textarea' ? 'textarea_value' : 'selected_option';
    if (String(this.value).length > 1000) result.value_truncated = true;
  }
  if (['input', 'textarea'].includes(tag)) result.readonly = this.readOnly;
  if (['input', 'textarea', 'select', 'button', 'option'].includes(tag)) result.disabled = this.disabled;
  if (tag === 'input' && ['checkbox', 'radio'].includes(this.type)) {
    result.checked = this.checked;
    if (this.type === 'checkbox') result.indeterminate = this.indeterminate;
  }
  if (tag === 'select') {
    result.selected_options = [];
    for (let index=0; index<Math.min(this.selectedOptions.length, maxOptions); index++) {
      const option=this.selectedOptions[index];
      result.selected_options.push({ value: clip(option.value), label: clip(option.label), index: option.index,
        ...(option.value.length > 1000 ? { value_truncated: true } : {}), ...(option.label.length > 1000 ? { label_truncated: true } : {}) });
    }
    result.omitted_selected_options = Math.max(0, this.selectedOptions.length - result.selected_options.length);
  }
  const text = this.innerText ?? '';
  result.text = clip(text); result.text_source = 'inner_text';
  if (text.length > 1000) result.text_truncated = true;
  const rect = this.getBoundingClientRect(), win = this.ownerDocument.defaultView;
  result.rect = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  result.visible = rect.width > 0 && rect.height > 0 && win.getComputedStyle(this).visibility === 'visible';
  const active = this.getRootNode().activeElement;
  result.focused = active === this;
  result.contains_focus = active === this || this.contains(active);
  for (const name of ['expanded', 'checked', 'selected', 'activedescendant', 'controls', 'owns', 'valuetext', 'valuenow']) {
    const attribute = this.getAttribute(`aria-${name}`);
    if (attribute != null && !(result.value_redacted && ['valuetext', 'valuenow'].includes(name))) {
      result[`aria_${name}`] = clip(attribute);
      if (attribute.length > 1000) (result.truncated_attributes ||= []).push(`aria-${name}`);
    }
  }
  return result;
}
