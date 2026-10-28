// Render semantic AX nodes once; page through the same observation without losing refs.
export function snapshotOptions({ profile = 'full', text = true, text_limit, query, include_hidden } = {}) {
  if (!['full', 'interactive', 'fields'].includes(profile)) throw new Error('profile must be full, interactive or fields');
  if (typeof text !== 'boolean') throw new Error('text must be a boolean');
  if (text_limit != null && (!Number.isInteger(text_limit) || text_limit < 0 || text_limit > 10000)) throw new Error('text_limit must be 0..10000');
  if (query != null && (typeof query !== 'string' || !query.trim() || query.length > 2000)) throw new Error('query must contain 1..2000 characters and not be blank');
  if (include_hidden != null && (profile !== 'fields' || typeof include_hidden !== 'boolean')) throw new Error('include_hidden is a boolean for profile=fields only');
  return { profile, text, text_limit: text_limit ?? (profile === 'interactive' ? 80 : null), ...(query != null ? { query } : {}),
    ...(profile === 'fields' ? { include_hidden: include_hidden ?? false } : {}) };
}

export const FIELD_ROLES = new Set(['checkbox', 'combobox', 'listbox', 'radio', 'searchbox', 'slider', 'spinbutton', 'switch', 'textbox']);
const CONTROLS = new Set(['button', 'checkbox', 'combobox', 'DisclosureTriangle', 'link', 'listbox', 'menuitem',
  'menuitemcheckbox', 'menuitemradio', 'option', 'radio', 'scrollbar', 'searchbox', 'slider', 'spinbutton', 'switch', 'tab', 'textbox', 'treeitem']);

export function axContext(nodes) {
  const byId = new Map(nodes.map(node => [node.nodeId, node]));
  const parents = new Map();
  for (const node of nodes) for (const child of node.childIds || []) parents.set(child, node.nodeId);
  function contextText(node) {
    const pending = [node], parts = [];
    let visited = 0, length = 0;
    while (pending.length && ++visited <= 32) {
      const current = pending.pop();
      if (!current) return null;
      const role = current.role?.value;
      if (current.ignored && !['none', 'generic'].includes(role)) continue;
      if (role === 'StaticText') {
        const text = String(current.name?.value || '');
        const separator = parts.length ? 1 : 0;
        if (length + text.length + separator > 160) return null;
        parts.push(text); length += text.length + separator;
      }
      else {
        if (!['none', 'generic', 'LabelText', 'paragraph'].includes(role)) return null;
        if (visited + pending.length + (current.childIds?.length || 0) > 32) return null;
        for (let i = (current.childIds?.length || 0) - 1; i >= 0; i--) pending.push(byId.get(current.childIds[i]));
      }
    }
    const text = parts.join(' ').replace(/\s+/g, ' ').trim();
    return !pending.length && text && text.length <= 160 ? text : null;
  }
  // Nearby text is observation context, never a replacement for AX identity or
  // an inferred label locator. Bound both the ancestor search and subtree work.
  function fieldContext(node) {
    let child = node;
    for (let depth = 0; depth < 4; depth++) {
      const parent = byId.get(parents.get(child.nodeId));
      if (!parent || !['none', 'generic', 'group'].includes(parent.role?.value)) return null;
      const pending = [parent];
      let count = 0, visited = 0;
      while (pending.length && ++visited <= 64 && count < 2) {
        const current = pending.pop();
        if (!current) return null;
        if (!current.ignored && CONTROLS.has(current.role?.value)) count++;
        if (visited + pending.length + (current.childIds?.length || 0) > 64) return null;
        for (const id of current.childIds || []) pending.push(byId.get(id));
      }
      if (pending.length || count !== 1) return null;
      const index = parent.childIds.indexOf(child.nodeId);
      if (index > 0) {
        const text = contextText(byId.get(parent.childIds[index - 1]));
        if (text) return text;
      }
      child = parent;
    }
    return null;
  }
  return { byId, parents, fieldContext };
}

export function registerAXRef(node, token, refs, frameId, sessionId) {
  if (!node.backendDOMNodeId || node.ignored) return null;
  const ref = `${token}:${refs.size + 1}`;
  refs.set(ref, { backendNodeId: node.backendDOMNodeId, frameId, sessionId, role: node.role?.value, name: String(node.name?.value || '') });
  return ref;
}

export function popupProperties(node) {
  const result = {};
  for (const { name, value } of node.properties || []) {
    if (name === 'hasPopup' && value?.value != null) result.hasPopup = value.value;
    if (name === 'controls' || name === 'owns' || name === 'activedescendant') {
      // Keep browser-resolved DOM idrefs, not AX/backend ids or inferred owners.
      const ids = [...new Set((value?.relatedNodes || []).map(node => node.idref).filter(id => typeof id === 'string' && id))];
      if (ids.length) result[name] = ids;
    }
  }
  return result;
}

export function renderAX(nodes, token, refs, frameId, sessionId, options = snapshotOptions()) {
  const { byId, parents, fieldContext } = axContext(nodes);
  const visited = new Set(), entries = [];
  const query = options.query?.toLowerCase();
  const textRoles = new Set(['StaticText', 'InlineTextBox', 'ListMarker']);
  let kept;
  if (options.profile === 'interactive') {
    kept = new Set();
    function keepText(node) {
      const pending = [node];
      while (pending.length) {
        const current = pending.pop();
        if (!current || kept.has(current.nodeId)) continue;
        const role = current.role?.value;
        if (!textRoles.has(role) && !current.ignored && !['none', 'generic'].includes(role)) continue;
        kept.add(current.nodeId);
        for (const child of current.childIds || []) pending.push(byId.get(child));
      }
    }
    for (const node of nodes) {
      if (node.ignored || !node.backendDOMNodeId || !(CONTROLS.has(node.role?.value) ||
        node.properties?.some(prop => prop.name === 'focusable' && prop.value?.value === true ||
          prop.name === 'editable' && prop.value?.value && prop.value.value !== 'false'))) continue;
      for (const child of node.childIds || []) keepText(byId.get(child));
      let id = node.nodeId;
      while (id != null && !kept.has(id)) { kept.add(id); id = parents.get(id); }
    }
  }
  function plainText(node) {
    const pending = [node], parts = [];
    while (pending.length) {
      const current = pending.pop();
      if (current === ' ') { parts.push(' '); continue; }
      if (!current) return null;
      const role = current.role?.value;
      if (textRoles.has(role)) { parts.push(String(current.name?.value || '')); continue; }
      if (!current.ignored && !['none', 'generic'].includes(role)) return null;
      const children = current.childIds || [];
      for (let index = children.length - 1; index >= 0; index--) {
        pending.push(byId.get(children[index]));
        if (index > 0) pending.push(' ');
      }
    }
    return parts.join('');
  }
  // Preserve preorder and ref numbering without using the JavaScript call stack.
  const children = new Set();
  for (const node of nodes) for (const child of node.childIds || []) children.add(child);
  const pending = nodes.filter(node => !children.has(node.nodeId)).reverse().map(node => ({ node, depth: 0, parentName: '' }));
  while (pending.length) {
    const { node, depth, parentName } = pending.pop();
    if (!node || visited.has(node.nodeId)) continue;
    visited.add(node.nodeId);
    if (kept && !kept.has(node.nodeId)) continue;
    const role = node.role?.value || 'node';
    if (role === 'InlineTextBox') continue;
    let name = String(node.name?.value || '');
    let merged = false;
    if (['listitem', 'paragraph'].includes(role) && !name) {
      const parts = (node.childIds || []).map(id => plainText(byId.get(id)));
      if (parts.length && !parts.includes(null)) { name = parts.filter(Boolean).join(' '); merged = true; }
    }
    const states = (node.properties || []).filter(prop =>
      ['disabled', 'focused', 'expanded', 'checked', 'selected', 'required', 'invalid', 'level'].includes(prop.name)
    ).map(prop => `${prop.name}=${JSON.stringify(prop.value?.value)}`);
    for (const [name, value] of Object.entries(popupProperties(node))) states.push(`${name}=${JSON.stringify(value)}`);
    if (node.value?.value != null) states.push(`value=${JSON.stringify(node.value.value)}`);
    const context = FIELD_ROLES.has(role) && !node.ignored ? fieldContext(node) : null;
    if (context && context !== name) states.push(`context=${JSON.stringify(context)}`);
    const attributes = states.join(' ');
    const skip = node.ignored || (!options.text && textRoles.has(role)) || (['none', 'generic'].includes(role) && !name && !attributes) ||
      (role === 'StaticText' && name === parentName);
    const identityName = name;
    if (textRoles.has(role) || merged) {
      if (!options.text) name = '';
      else if (options.text_limit != null && name.length > options.text_limit) name = name.slice(0, options.text_limit) + '…';
    }
    let nextDepth = depth;
    if (!skip) {
      if (query == null || identityName.toLowerCase().includes(query) || String(node.value?.value ?? '').toLowerCase().includes(query) || context?.toLowerCase().includes(query)) {
        const ref = registerAXRef(node, token, refs, frameId, sessionId);
        entries.push({ node: true, frameId, line: `${'  '.repeat(Math.min(depth, 24))}${ref ? `[${ref}] ` : ''}${role} ${JSON.stringify(name)}${attributes ? ' ' + attributes : ''}` });
      }
      nextDepth++;
    }
    if (!merged) {
      const childIds = node.childIds || [];
      for (let index = childIds.length - 1; index >= 0; index--) {
        pending.push({ node: byId.get(childIds[index]), depth: nextDepth, parentName: skip ? parentName : identityName });
      }
    }
  }
  return entries;
}

export function snapshotPage(state, { max_nodes = 600, max_chars = 24000, cursor, verbose = false, ...view } = {}) {
  if (!Number.isInteger(max_nodes) || max_nodes < 1 || max_nodes > 3000) throw new Error('max_nodes must be 1..3000');
  if (!Number.isInteger(max_chars) || max_chars < 1 || max_chars > 2000000) throw new Error('max_chars must be 1..2000000');
  if (typeof verbose !== 'boolean') throw new Error('verbose must be a boolean');
  let offset = 0;
  if (cursor != null) {
    if (cursor !== state.nextCursor) throw new Error('Snapshot cursor is stale or unknown. Take a new browser_snapshot.');
    for (const key of ['profile', 'text', 'text_limit', 'query', 'include_hidden']) if (view[key] != null && view[key] !== state.options[key]) {
      throw new Error('Snapshot cursor uses the original profile/text/text_limit/query/include_hidden; take a new snapshot to change the view.');
    }
    offset = state.nextOffset;
  }
  const lines = [], fields = [];
  const structured = state.options.profile === 'fields';
  let count = 0, chars = 0, index = offset, reason = null;
  for (; index < state.entries.length; index++) {
    const entry = state.entries[index];
    if (state.invalidFrames.has(entry.frameId)) continue;
    const size = JSON.stringify(structured ? entry.field : entry.line).length + 2;
    if (entry.node && count >= max_nodes) { reason = 'node_limit'; break; }
    if (chars + size > max_chars) {
      if (!lines.length && !fields.length) throw new Error(`A snapshot ${structured ? 'field' : 'line'} requires max_chars >= ${size}. Increase max_chars to continue without losing text.`);
      reason = 'text_budget'; break;
    }
    if (structured) fields.push(entry.field); else lines.push(entry.line);
    chars += size; count += entry.node ? 1 : 0;
  }
  const truncated = index < state.entries.length;
  state.nextOffset = index;
  state.nextCursor = truncated ? `${state.id}@${index}` : null;
  const { viewport, ...metadata } = state.metadata;
  return { ...metadata, ...state.options, ...(verbose ? { viewport, snapshot_id: state.id } : {}), ...(structured ? { fields } : { snapshot: lines.join('\n') }), node_count: count,
    total_node_count: state.totalNodes, truncated, truncation_reason: reason, next_cursor: state.nextCursor };
}
