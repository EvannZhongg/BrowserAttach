import assert from 'node:assert/strict';

export async function checkTargeting({ call, page, results, focus }) {
  await call('activate_tab', { focus_window: false });
  await page(`(() => {
    window.targetingClicks=[];
    const panel=document.createElement('section');panel.id='targeting';
    panel.style='position:fixed;left:20px;top:60px;z-index:100;background:white;padding:20px;color:black';
    panel.innerHTML='<div id="plans" style="display:flex;gap:30px"><div id="plan40" style="padding:20px;border:1px solid"><span>¥40</span></div><div id="plan45" style="padding:20px;border:1px solid"><span id="price45">¥<span>45</span></span></div><div hidden>¥45</div></div><div id="other-price">¥45</div><div id="whitespace">选择   套餐</div>';
    document.body.prepend(panel);
    for(const id of ['plan40','plan45'])document.getElementById(id).onclick=e=>targetingClicks.push({id,trusted:e.isTrusted});
    return true;
  })()`);
  const initialFocus = await focus();
  const text = { selector: '¥45', selector_type: 'text', scope: '#plans' };
  assert.equal((await call('read_text', text)).text, '¥45');
  assert.equal((await call('wait', { ...text, condition: 'visible' })).status, 'pass');
  assert.equal((await call('wait', { selector: '¥45', selector_type: 'text', condition: 'count', expected: 2 })).status, 'pass');
  await assert.rejects(call('click', { selector: '¥45', selector_type: 'text' }), error => error.input_dispatched === false && error.diagnostics.reason === 'selector_ambiguous');
  assert.equal(await page('targetingClicks.length'), 0);
  assert.equal((await call('click', text)).target_verified, true);
  assert.deepEqual(await page('targetingClicks'), [{ id: 'plan45', trusted: true }]);
  const batch = await call('batch', { steps: [{ action: 'click', ...text }, { action: 'wait', ...text, condition: 'text', expected: '45' }] });
  assert.equal(batch.completed, true);
  assert.equal((await call('read_text', { selector: '选择 套餐', selector_type: 'text', scope: '#targeting' })).text, '选择 套餐');
  results.cases.push({ scenario: 'text_read_wait_count_ambiguity_click_batch', passed: true });

  const rect = await page(`(() => { const r=document.querySelector('#price45').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
  const shot = (await call('screenshot')).capture, map = shot.image_to_viewport_css;
  assert.equal(shot.viewport.device_pixel_ratio, 1.5);
  const image = { x: (rect.x-map.offset_x)/map.scale_x, y: (rect.y-map.offset_y)/map.scale_y, coordinate_space: 'image', screenshot_id: shot.screenshot_id };
  const before = await page('targetingClicks.length');
  await assert.rejects(call('click', { ...image, expected_target: { selector: '#plan40' } }), error => error.input_dispatched === false && error.diagnostics.reason === 'suspected_mistarget');
  assert.equal(await page('targetingClicks.length'), before);
  const clicked = await call('click', { ...image, expected_target: text });
  assert.equal(clicked.target_verified, true); assert.equal(clicked.delivery_verified, true);
  assert.equal(clicked.target_verification.basis, 'expected_target');
  assert.equal((await page('targetingClicks.at(-1)')).id, 'plan45');
  await assert.rejects(call('click', image), error => error.input_dispatched === false && error.diagnostics.reason === 'stale_screenshot');
  results.cases.push({ scenario: 'dpr_1_5_image_mapping_expected_target_and_consumption', capture: shot, clicked });

  const crop = (await call('screenshot', { selector: '#price45' })).capture;
  const cropClick = await call('click', { coordinate_space: 'image', screenshot_id: crop.screenshot_id,
    x: crop.image.width/2, y: crop.image.height/2, expected_target: text });
  assert.equal(cropClick.target_verified, true);
  const hoverShot = (await call('screenshot')).capture, hoverMap = hoverShot.image_to_viewport_css;
  const hovered = await call('hover', { coordinate_space: 'image', screenshot_id: hoverShot.screenshot_id,
    x: (rect.x-hoverMap.offset_x)/hoverMap.scale_x, y: (rect.y-hoverMap.offset_y)/hoverMap.scale_y, expected_target: { selector: '#plan45' } });
  assert.equal(hovered.delivery_verified, true); assert.equal(hovered.target_verified, true);
  results.cases.push({ scenario: 'element_capture_and_image_hover', passed: true });

  await page(`(() => {
    for(const [id,host,top] of [['same-target','127.0.0.1',320],['remote-target','localhost',460]]) {
      const frame=document.createElement('iframe');frame.id=id;
      const url=new URL('/inner',location.href);url.hostname=host;frame.src=url.href;
      frame.style='position:fixed;left:20px;top:'+top+'px;width:380px;height:110px;z-index:101';document.body.append(frame);
    }
    return true;
  })()`);
  for (const id of ['same-target', 'remote-target']) {
    const frame = { path: [`#${id}`] };
    assert.equal((await call('wait', { selector: 'button', frame, condition: 'visible' })).status, 'pass');
    assert.match((await call('read_text', { selector: 'Inner button', selector_type: 'text', frame })).text, /Inner button/);
    const child = (await call('evaluate', { frame, expression: `(() => {const r=document.querySelector('button').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()` })).value;
    const owner = await page(`(() => {const f=document.getElementById(${JSON.stringify(id)}),r=f.getBoundingClientRect();return {x:r.x+f.clientLeft,y:r.y+f.clientTop};})()`);
    const capture = (await call('screenshot')).capture, mapping = capture.image_to_viewport_css;
    const point = { coordinate_space: 'image', screenshot_id: capture.screenshot_id,
      x: (owner.x+child.x-mapping.offset_x)/mapping.scale_x, y: (owner.y+child.y-mapping.offset_y)/mapping.scale_y };
    await assert.rejects(call('click', { ...point, expected_target: { selector: '#plans' } }), error => error.input_dispatched === false && error.diagnostics.reason === 'suspected_mistarget');
    const result = await call('click', { ...point, expected_target: { selector: 'Inner button', selector_type: 'text', frame } });
    assert.equal(result.target_verified, true); assert.equal(result.delivery_verified, true);
    assert.equal((await call('evaluate', { frame, expression: 'window.count' })).value, 1);
    results.cases.push({ scenario: `${id}_text_image_expected_target`, passed: true });
  }

  const stale = (await call('screenshot')).capture;
  await page('scrollTo(0,100);true');
  await assert.rejects(call('click', { ...image, screenshot_id: stale.screenshot_id }), error => error.input_dispatched === false && error.diagnostics.reason === 'stale_screenshot');
  const full = (await call('screenshot', { full_page: true })).capture;
  await assert.rejects(call('click', { coordinate_space: 'image', screenshot_id: full.screenshot_id,
    x: full.image.width/2, y: full.image.height-1 }), error => error.input_dispatched === false && error.diagnostics.reason === 'image_point_out_of_viewport');
  assert.deepEqual((await focus()).map(({focused,...w})=>w), initialFocus.map(({focused,...w})=>w));
  results.cases.push({ scenario: 'viewport_staleness_offscreen_refusal_no_implicit_focus', passed: true });
}
