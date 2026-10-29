// Align semantic node identities, not text lines: equal-looking replacement
// nodes and sibling moves must remain observable. Line ranges avoid exposing a
// second public node-id system alongside actionable refs.
export function snapshotDiff(before, after) {
  const positions = new Map(before.map((entry, index) => [entry.key, index]));
  const matches = [];
  for (let index = 0; index < after.length; index++) {
    const previous = positions.get(after[index].key);
    if (previous != null) matches.push({ previous, current: index });
  }
  // Longest increasing subsequence retains stable sibling order in O(n log n),
  // including large reordered lists, without a quadratic edit-distance table.
  const tails = [], links = new Int32Array(matches.length).fill(-1);
  for (let index = 0; index < matches.length; index++) {
    let low = 0, high = tails.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (matches[tails[mid]].previous < matches[index].previous) low = mid + 1;
      else high = mid;
    }
    if (low) links[index] = tails[low - 1];
    tails[low] = index;
  }
  const anchors = [];
  for (let index = tails.at(-1); index != null && index >= 0; index = links[index]) anchors.push(matches[index]);
  anchors.reverse();
  anchors.push({ previous: before.length, current: after.length });
  const result = [];
  let previous = 0, current = 0;
  for (const anchor of anchors) {
    const start = current, oldStart = previous;
    previous = anchor.previous; current = anchor.current;
    if (current > start || previous > oldStart) append(oldStart, previous - oldStart, start, current);
    if (previous < before.length && before[previous].line !== after[current].line) append(previous, 1, current, current + 1);
    previous++; current++;
  }
  // Adjacent changed nodes form one semantic fragment; unchanged descendants
  // never force a replacement of the entire ancestor subtree.
  function append(start, removed, from, to) {
    const last = result.at(-1);
    if (last && last.start_line + last.delete_count === start && last.to === from) {
      last.delete_count += removed; last.to = to;
    } else result.push({ start_line: start, delete_count: removed, from, to });
  }
  const entries = [];
  for (const { start_line, delete_count, from, to } of result) {
    const change = { start_line, delete_count };
    if (from === to) entries.push({ node: false, line: null, change, lineOffset: 0, changeEnd: true });
    for (let index = from; index < to; index++) entries.push({ ...after[index], change, lineOffset: index - from, changeEnd: index + 1 === to });
  }
  return entries;
}
