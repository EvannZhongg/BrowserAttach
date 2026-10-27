export function domCapture(documents) {
  const strings = [], indexes = new Map();
  const intern = value => {
    if (!indexes.has(value)) { indexes.set(value, strings.length); strings.push(value); }
    return indexes.get(value);
  };
  return { strings, documents: documents.map(({ frameId, nodes: input }) => {
    const nodes = { parentIndex: [], nodeType: [], nodeName: [], nodeValue: [], backendNodeId: [], attributes: [],
      inputValue: { index: [], value: [] }, textValue: { index: [], value: [] }, inputChecked: { index: [] }, optionSelected: { index: [] } };
    input.forEach((node, index) => {
      nodes.parentIndex.push(node.parent ?? -1); nodes.nodeType.push(node.tag === '#text' ? 3 : 1);
      nodes.nodeName.push(intern(node.tag.toUpperCase())); nodes.nodeValue.push(intern(node.text ?? ''));
      nodes.backendNodeId.push(node.backend ?? 1000 + index);
      nodes.attributes.push(Object.entries(node.attrs || {}).flatMap(([name, value]) => [intern(name), intern(value)]));
      if (node.value != null) {
        const data = node.tag.toLowerCase() === 'textarea' ? nodes.textValue : nodes.inputValue;
        data.index.push(index); data.value.push(node.value === '' ? -1 : intern(node.value));
      }
      if (node.checked) nodes.inputChecked.index.push(index);
      if (node.selected) nodes.optionSelected.index.push(index);
    });
    return { frameId: intern(frameId), nodes };
  }) };
}

export const axField = (backend, name, role = 'textbox', extra = {}) => ({
  nodeId: String(backend), backendDOMNodeId: backend, role: { value: role }, name: { value: name }, ...extra,
});
