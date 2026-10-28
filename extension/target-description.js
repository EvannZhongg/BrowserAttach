// Identity clues only: never echo input values or manufacture a locator.
export function describeTarget() {
  const node = this?.nodeType === 3 ? this.parentElement : this;
  if (node?.nodeType !== 1) return null;
  return { tag: node.tagName.toLowerCase(), id: (node.id || '').slice(0, 200) || null,
    classes: Array.from(node.classList).slice(0, 8).map(name => name.slice(0, 100)),
    role: node.getAttribute('role')?.slice(0, 200) ?? null, type: node.tagName === 'INPUT' ? node.type : null,
    text: (node.innerText || node.textContent || '').slice(0, 300) };
}
