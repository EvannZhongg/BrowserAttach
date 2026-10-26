import { axContext, FIELD_ROLES, registerAXRef, popupProperties } from './snapshot.js';

const INPUT_BUTTONS = new Set(['button', 'submit', 'reset', 'image']);
const AX_STATES = new Set(['disabled', 'readonly', 'required', 'invalid', 'checked', 'selected', 'expanded', 'multiselectable']);

// One native DOM capture per debugger session, joined by frame and backend id.
// No DOM query, component getter or per-field resolve is needed for ordinary fields.
export function createFieldReader(send, value) {
  const captures = new Map();
  return async (target, frameId, nodes, token, refs, options) => {
    const key = target.sessionId ?? '';
    if (!captures.has(key)) captures.set(key, await send(target, 'DOMSnapshot.captureSnapshot', { computedStyles: [] }));
    const capture = captures.get(key);
    const document = capture.documents.find(doc => capture.strings[doc.frameId] === frameId);
    if (!document) throw new Error('Frame document is unavailable in the DOM field capture');
    const entries = renderFields(nodes, document.nodes, capture.strings, token, refs, frameId, target.sessionId, options);
    const files = entries.filter(entry => entry.field.dom?.tag === 'input' && entry.field.dom.type === 'file');
    if (files.length) {
      const group = 'browser-attach-fields';
      try {
        const { executionContextId } = await send(target, 'Page.createIsolatedWorld', { frameId, worldName: group });
        for (const entry of files) {
          try {
            const { object } = await send(target, 'DOM.resolveNode', { backendNodeId: entry.backendNodeId, executionContextId, objectGroup: group });
            if (!object?.objectId) throw new Error('File input detached');
            entry.field.dom.files = value(await send(target, 'Runtime.callFunctionOn', { objectId: object.objectId,
              functionDeclaration: readFileSelection.toString(), returnByValue: true }));
          } catch (error) { entry.field.dom.files = { available: false, error: error.message }; }
        }
      } finally { await send(target, 'Runtime.releaseObjectGroup', { objectGroup: group }).catch(() => {}); }
    }
    return entries;
  };
}

function readFileSelection() {
  if (!this.isConnected || this.tagName !== 'INPUT' || this.type !== 'file') return { available: false, error: 'File input changed during observation' };
  return { available: true, count: this.files.length, names: Array.from(this.files, file => file.name) };
}

export function renderFields(axNodes, domNodes, strings, token, refs, frameId, sessionId, options) {
  const { fieldContext } = axContext(axNodes);
  const axByBackend = new Map();
  for (const node of axNodes) if (node.backendDOMNodeId && (!node.ignored || !axByBackend.has(node.backendDOMNodeId))) axByBackend.set(node.backendDOMNodeId, node);
  const rare = data => new Map((data?.index || []).map((index, n) => [index, data.value?.[n]]));
  const inputValues = rare(domNodes.inputValue), textValues = rare(domNodes.textValue);
  const checked = new Set(domNodes.inputChecked?.index || []), selected = new Set(domNodes.optionSelected?.index || []);
  const children = new Map();
  for (let i = 0; i < domNodes.parentIndex.length; i++) {
    const parent = domNodes.parentIndex[i];
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(i);
  }
  const attributes = index => {
    const list = domNodes.attributes[index] || [], result = new Map();
    for (let i = 0; i < list.length; i += 2) result.set(strings[list[i]], strings[list[i + 1]]);
    return result;
  };
  function descendants(index, visit) {
    const pending = [index];
    while (pending.length) {
      const current = pending.pop(); visit(current);
      const list = children.get(current) || [];
      for (let i = list.length - 1; i >= 0; i--) pending.push(list[i]);
    }
  }
  function textContent(index) {
    const parts = [];
    descendants(index, current => { if (domNodes.nodeType[current] === 3) parts.push(strings[domNodes.nodeValue[current]] || ''); });
    return parts.join('');
  }
  const entries = [], seen = new Set(), query = options.query?.toLowerCase();
  function add(node, dom, backendNodeId) {
    const protectedValue = dom?.tag === 'input' && dom.type === 'password';
    const ax = node && !node.ignored ? { role: node.role?.value, name: String(node.name?.value || '') } : null;
    if (ax) {
      if (dom && node.value?.value != null && !protectedValue) ax.value = node.value.value;
      for (const property of node.properties || []) if (AX_STATES.has(property.name)) ax[property.name] = property.value?.value;
      Object.assign(ax, popupProperties(node));
    }
    const labels = [];
    for (const source of node?.name?.sources || []) {
      if (!['label', 'labelfor', 'labelwrapped'].includes(source.nativeSource) || source.invalid) continue;
      const related = source.nativeSourceValue?.relatedNodes ?? source.value?.relatedNodes ?? [];
      const texts = related.map(item => item.text).filter(text => typeof text === 'string');
      if (!texts.length && typeof source.value?.value === 'string') texts.push(source.value.value);
      for (const text of texts) { const label = text.replace(/\s+/g, ' ').trim(); if (label && !labels.includes(label)) labels.push(label); }
    }
    const context = ax ? fieldContext(node) : null;
    const field = { ref: null, frame_id: frameId, labels, context, ax, dom };
    const terms = [ax?.name, ax?.value, context, ...labels, dom?.id, dom?.name, dom?.placeholder, dom?.value,
      ...(dom?.selected_options || []).flatMap(option => [option.value, option.label])];
    if (query != null && !terms.some(term => term != null && String(term).toLowerCase().includes(query))) return;
    if (ax) field.ref = registerAXRef(node, token, refs, frameId, sessionId);
    entries.push({ node: true, frameId, backendNodeId, field });
  }
  for (let index = 0; index < domNodes.backendNodeId.length; index++) {
    if (domNodes.nodeType[index] !== 1) continue;
    const backendNodeId = domNodes.backendNodeId[index], node = axByBackend.get(backendNodeId);
    const attrs = attributes(index), tag = strings[domNodes.nodeName[index]].toLowerCase();
    const type = tag === 'input' ? (attrs.get('type') || 'text').toLowerCase() : null;
    const editable = attrs.has('contenteditable') && ['', 'true', 'plaintext-only'].includes(attrs.get('contenteditable').toLowerCase());
    const native = tag === 'input' && !INPUT_BUTTONS.has(type) || ['textarea', 'select', 'output'].includes(tag) || editable;
    if (!native && (!node || node.ignored || !FIELD_ROLES.has(node.role?.value))) continue;
    if ((!node || node.ignored) && !options.include_hidden) continue;
    seen.add(backendNodeId);
    const dom = { tag, id: attrs.get('id') ?? null, name: attrs.get('name') ?? null };
    if (type != null) dom.type = type;
    if (attrs.has('placeholder')) dom.placeholder = attrs.get('placeholder');
    if (type === 'password') dom.value_redacted = true;
    else if (tag === 'input' && inputValues.has(index)) { dom.value = strings[inputValues.get(index)]; dom.value_source = 'input_value'; }
    else if (tag === 'textarea' && textValues.has(index)) { dom.value = strings[textValues.get(index)]; dom.value_source = 'textarea_value'; }
    else if (tag === 'select') {
      dom.multiple = attrs.has('multiple'); dom.selected_options = [];
      descendants(index, current => {
        if (strings[domNodes.nodeName[current]] !== 'OPTION' || !selected.has(current)) return;
        const optionAttrs = attributes(current), text = textContent(current).replace(/[\t\n\f\r ]+/g, ' ').replace(/^ | $/g, '');
        dom.selected_options.push({ value: optionAttrs.get('value') ?? text, label: optionAttrs.get('label') ?? text });
      });
      dom.value = dom.selected_options[0]?.value ?? ''; dom.value_source = 'selected_option';
    } else if (editable || tag === 'output') { dom.value = textContent(index); dom.value_source = 'text_content'; }
    if (['checkbox', 'radio'].includes(type)) dom.checked = checked.has(index);
    add(node, dom, backendNodeId);
  }
  // A DOM replacement between the AX and DOM captures must not be joined to
  // a new element just because its name/id looks the same.
  for (const node of axNodes) if (!node.ignored && node.backendDOMNodeId && !seen.has(node.backendDOMNodeId) && FIELD_ROLES.has(node.role?.value)) {
    add(node, null, node.backendDOMNodeId);
  }
  return entries;
}
