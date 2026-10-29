import assert from 'node:assert/strict';

export async function checkSnapshotDiff({ call, page, base, focus, results }) {
  const stripRefs = text => text.replace(/\[[a-f\d]{8}:[^\]\n]+\]/g, '[ref]');
  const getRef = (text, role, name) => text.split('\n').find(line => line.includes(`${role} ${JSON.stringify(name)}`)).match(/\[([^\]]+)\]/)[1];
  const collect = async args => {
    const pages = [await call('snapshot', args)];
    while (pages.at(-1).next_cursor) pages.push(await call('snapshot', { cursor: pages.at(-1).next_cursor, max_nodes: args.max_nodes, max_chars: args.max_chars }));
    return pages;
  };
  const apply = (before, pages) => {
    const edits = new Map();
    for (const p of pages) for (const change of p.changes) {
      let edit = edits.get(change.start_line);
      if (!edit) edits.set(change.start_line, edit = { ...change, lines: [] });
      assert.equal(change.line_offset, edit.lines.length);
      if (change.snapshot) edit.lines.push(...change.snapshot.split('\n'));
      edit.complete = change.complete;
    }
    const lines = before ? before.split('\n') : [];
    for (const [start, edit] of [...edits].sort((a, b) => b[0] - a[0])) {
      assert.equal(edit.complete, true); lines.splice(start, edit.delete_count, ...edit.lines);
    }
    assert.equal(lines.length, pages.at(-1).line_count);
    return lines.join('\n');
  };
  const quiet = async () => { await page('document.body.offsetHeight'); await new Promise(resolve => setTimeout(resolve, 100)); };
  const initialFocus = await focus();
  await page(`(() => {
    document.body.replaceChildren();window.diffClicks=0;
    const main=document.createElement('main');main.id='diff-fixture';
    main.innerHTML='<button id="diff-keep" onclick="diffClicks++">Keep ref</button><label>Name<input id="diff-value"></label><div role="group" aria-label="Results" id="diff-results"></div><div id="diff-shadow"></div>';
    for(let i=0;i<120;i++){const p=document.createElement('p');p.textContent='Unchanged prose '+i;main.append(p)}
    const root=main.querySelector('#diff-shadow').attachShadow({mode:'closed'});const button=document.createElement('button');button.textContent='Shadow keep';button.onclick=()=>diffClicks++;root.append(button);
    document.body.append(main);return true;
  })()`);
  await quiet();
  let baseline = await call('snapshot', { max_nodes: 3000 });
  const keep = getRef(baseline.snapshot, 'button', 'Keep ref'), shadow = getRef(baseline.snapshot, 'button', 'Shadow keep');
  const unchanged = await call('snapshot', { diff_since: baseline.snapshot_id });
  assert.deepEqual(unchanged.changes, []);
  baseline = { ...unchanged, snapshot: baseline.snapshot };
  await call('fill', { selector: '#diff-value', text: 'Updated value', mode: 'dom' });
  const changed = await call('snapshot', { diff_since: baseline.snapshot_id });
  assert.ok(changed.node_count < 8); assert.ok(JSON.stringify(changed).length < JSON.stringify(baseline).length / 4);
  let reconstructed = apply(baseline.snapshot, [changed]);
  assert.match(reconstructed, /textbox "Name".*value="Updated value"/);
  assert.ok(reconstructed.includes(`[${keep}]`));
  await call('click', { ref: keep, mode: 'dom' }); await call('click', { ref: shadow, mode: 'dom' });
  assert.equal(await page('diffClicks'), 2);
  results.cases.push({ scenario: 'full_diff_local_value_closed_shadow_stable_refs', full_chars: baseline.snapshot.length, diff_chars: JSON.stringify(changed.changes).length, changed_nodes: changed.node_count });

  await page(`(() => { const group=document.querySelector('#diff-results');for(const id of ['a','b','c','d']){const button=document.createElement('button');button.id='diff-'+id;button.textContent='Item '+id;group.append(button)}return true })()`);
  await quiet();
  const pages = await collect({ diff_since: changed.snapshot_id, max_nodes: 1 });
  assert.ok(pages.length >= 4); assert.ok(pages.some(p => p.changes.some(c => !c.complete)));
  reconstructed = apply(reconstructed, pages);
  const itemA = getRef(reconstructed, 'button', 'Item a');
  await page(`(() => {const group=document.querySelector('#diff-results');group.prepend(document.querySelector('#diff-d'));document.querySelector('#diff-b').remove();document.querySelector('#diff-c').textContent='Renamed c';return true})()`);
  await quiet();
  const moved = await call('snapshot', { diff_since: pages.at(-1).snapshot_id });
  reconstructed = apply(reconstructed, [moved]);
  assert.match(reconstructed, /Item d[\s\S]*Item a[\s\S]*Renamed c/); assert.doesNotMatch(reconstructed, /Item b/);
  assert.ok(reconstructed.includes(`[${itemA}]`));
  await call('click', { ref: itemA, mode: 'dom' });
  await page(`document.querySelector('#diff-a').replaceWith(document.querySelector('#diff-a').cloneNode(true));true`); await quiet();
  const replaced = await call('snapshot', { diff_since: moved.snapshot_id });
  reconstructed = apply(reconstructed, [replaced]);
  assert.notEqual(getRef(reconstructed, 'button', 'Item a'), itemA);
  await assert.rejects(call('click', { ref: itemA, mode: 'dom' }), /stale|no longer|detached/i);
  const full = await call('snapshot', { max_nodes: 3000 });
  assert.equal(stripRefs(reconstructed), stripRefs(full.snapshot));
  results.cases.push({ scenario: 'paged_add_delete_reorder_rename_same_name_replacement_exact_reconstruction', pages: pages.length });

  const interactive = await call('snapshot', { profile: 'interactive' });
  await page(`document.querySelector('#diff-value').value='Interactive value';true`);
  const interactiveDiff = await call('snapshot', { diff_since: interactive.snapshot_id });
  assert.equal(interactiveDiff.profile, 'interactive'); assert.match(JSON.stringify(interactiveDiff.changes), /Interactive value/);
  await assert.rejects(call('snapshot', { diff_since: interactiveDiff.snapshot_id, profile: 'fields' }), /full\/interactive/);
  const unread = await call('snapshot', { max_nodes: 1 });
  await assert.rejects(call('snapshot', { diff_since: unread.snapshot_id }), /unread pages/);
  results.cases.push({ scenario: 'interactive_view_inheritance_and_unread_baseline_rejection' });

  for (const remote of [false, true]) {
    await page(`(() => {const iframe=document.createElement('iframe');iframe.id='diff-frame-${remote}';iframe.src=${JSON.stringify((remote ? base.replace('127.0.0.1', 'localhost') : base) + '/probe')};document.body.append(iframe);return new Promise(resolve=>iframe.onload=()=>resolve(true))})()`);
  }
  await quiet();
  const frames = await call('snapshot', { max_nodes: 3000, max_chars: 2000000 });
  assert.deepEqual(frames.omitted_frames, []);
  const frameDiff = await call('snapshot', { diff_since: frames.snapshot_id });
  assert.deepEqual(frameDiff.changes, []);
  const mainKeep = getRef(frames.snapshot, 'button', 'Keep ref');
  await page(`document.querySelector('#diff-frame-true').src += '?navigated';new Promise(resolve=>document.querySelector('#diff-frame-true').onload=()=>resolve(true))`);
  await assert.rejects(call('snapshot', { diff_since: frameDiff.snapshot_id }), /invalidated frame coverage/);
  await call('click', { ref: mainKeep, mode: 'dom' });
  const current = await call('snapshot', { max_nodes: 3000, max_chars: 2000000 });
  await call('navigate', { url: base + '/probe?new-document', include_snapshot: false });
  await assert.rejects(call('snapshot', { diff_since: current.snapshot_id }), /baseline.*stale/);
  assert.deepEqual((await focus()).map(({ focused, ...w }) => w), initialFocus.map(({ focused, ...w }) => w));
  results.cases.push({ scenario: 'same_process_and_oopif_no_change_then_frame_and_document_invalidation_focus_preserved' });
}
