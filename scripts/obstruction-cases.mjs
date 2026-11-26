import assert from 'node:assert/strict';

export async function checkObstructions({ call, page, results, focus, base }) {
  await call('activate_tab', { focus_window: false });
  const initialFocus = await focus();
  await page(`(() => {
    window.overlayClicks={close:0,underlying:0};
    const button=document.createElement('button');button.id='underlying';button.textContent='Underlying action';
    button.style='position:fixed;left:200px;top:200px;width:150px;height:50px';
    button.onclick=()=>overlayClicks.underlying++;document.body.append(button);
    const overlay=document.createElement('div');overlay.id='guide-overlay';overlay.setAttribute('aria-hidden','true');
    overlay.style='position:fixed;inset:0;z-index:11001;background:#0003';document.body.append(overlay);
    const portal=document.createElement('div');portal.id='guide-portal';portal.style='position:fixed;left:30px;top:30px;z-index:11002';
    portal.innerHTML='<button aria-label="关闭引导" id="guide-close">×</button>';document.body.append(portal);
    portal.querySelector('button').onclick=()=>{overlayClicks.close++;overlay.remove();portal.remove()};
    return true;
  })()`);
  let obstruction;
  await assert.rejects(call('click', { selector: '#underlying' }), error => {
    obstruction=error;return error.input_dispatched===false&&error.diagnostics.reason==='obstructed'&&!!error.diagnostics.blocked_by.ref;
  });
  const blocker = obstruction.diagnostics.blocked_by;
  const html = await page('document.body.innerHTML');
  const context = await call('read_control', { view: 'context', ref: blocker.ref });
  assert.equal(context.target.dom.id, 'guide-overlay'); assert.equal(context.target.dom.aria_hidden, 'true');
  assert.equal(context.target.dom.text, ''); assert.ok(context.target.ref);
  assert.ok(context.ancestors.some(item=>item.dom.tag==='body'&&item.ref));
  const portal = context.siblings.find(item=>item.dom.id==='guide-portal'); assert.ok(portal?.ref);
  assert.equal(await page('document.body.innerHTML'), html);
  assert.deepEqual(await page('overlayClicks'), { close: 0, underlying: 0 });
  const controls = await call('read_control', { view:'context', ref:portal.ref });
  const close = controls.children.find(item=>item.dom.aria_label==='关闭引导'); assert.ok(close?.ref);
  assert.equal((await call('click', { ref:close.ref })).target_verified, true);
  assert.equal((await call('click', { selector:'#underlying' })).delivery_verified, true);
  assert.deepEqual(await page('overlayClicks'), {close:1,underlying:1});
  results.cases.push({scenario:'ignored_ax_overlay_context_sibling_portal_explicit_close',blocker,context});

  // An outer overlay blocking an OOPIF must publish an outer-frame ref.
  await page(`(() => {
    const frame=document.createElement('iframe');frame.id='covered-frame';
    const url=new URL('/inner',location.href);url.hostname='localhost';frame.src=url.href;
    frame.style='position:fixed;left:20px;top:300px;width:400px;height:130px';document.body.append(frame);
    const overlay=document.createElement('div');overlay.id='frame-overlay';overlay.style='position:fixed;inset:0;z-index:11001';document.body.append(overlay);return true;
  })()`);
  const frame = {path:['#covered-frame']};
  assert.equal((await call('wait',{selector:'button',frame,condition:'visible'})).status,'pass');
  let covered;
  await assert.rejects(call('click',{selector:'button',frame}),error=>{covered=error;return error.input_dispatched===false&&error.diagnostics.reason==='frame_obstructed'&&!!error.diagnostics.blocked_by.ref});
  const parentContext=await call('read_control',{view:'context',ref:covered.diagnostics.blocked_by.ref});
  assert.equal(parentContext.target.dom.id,'frame-overlay');
  assert.notEqual(parentContext.frame_id,covered.diagnostics.blocked_frame_id);
  results.cases.push({scenario:'ancestor_frame_blocker_identity',frame_id:parentContext.frame_id});
  const oldRef=parentContext.target.ref;
  await call('navigate',{url:base+'/probe#context-source',include_snapshot:false});
  await assert.rejects(call('read_control',{view:'context',ref:oldRef}),error=>error.input_dispatched===false&&error.diagnostics.reason==='stale_ref');
  assert.deepEqual((await focus()).map(({focused,...w})=>w),initialFocus.map(({focused,...w})=>w));
  results.cases.push({scenario:'stale_context_ref_and_no_implicit_focus',passed:true});
}
