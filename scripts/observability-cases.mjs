import assert from 'node:assert/strict';

export async function checkObservability({ call, page, base, focus, results }) {
  await call('activate_tab');
  const before = await focus();
  await page(`(() => {
    document.body.innerHTML='<section style="margin:60px"><span id="disabled-wrapper" style="display:inline-block"><button id="disabled" disabled aria-describedby="reason" aria-description="Raw ARIA description" title="Raw title" style="width:180px;height:50px">Delete app</button><span id="tooltip" role="tooltip" hidden>Hover-only detail</span></span><span id="reason" hidden>Stop the app first</span><button class="choice" id="safe" style="width:150px;height:50px">Safe action</button><button class="choice">Other action</button><div role="button" id="custom" aria-disabled="true" aria-readonly="false" aria-required="true" aria-invalid="grammar">Custom control</div></section>';
    window.writes=0;document.querySelector('#safe').onclick=()=>writes++;
    document.querySelector('#disabled-wrapper').onpointerenter=()=>document.querySelector('#tooltip').hidden=false;
  })()`);
  const control = await call('read_control', { selector: '#disabled' });
  assert.equal(control.control.dom.disabled, true); assert.equal(control.control.ax.disabled, true);
  assert.equal(control.control.dom.title, 'Raw title'); assert.equal(control.control.dom.aria_description, 'Raw ARIA description');
  assert.equal(control.control.dom.descriptions[0].source, 'aria-describedby');
  assert.equal(control.control.dom.descriptions[0].text, 'Stop the app first');
  assert.equal(control.control.ax.description, 'Stop the app first');
  const custom = await call('read_control', { selector: '#custom' });
  assert.equal(custom.control.dom.aria_disabled, 'true'); assert.equal(custom.control.dom.aria_invalid, 'grammar');
  assert.equal(custom.control.dom.aria_readonly, 'false'); assert.equal(custom.control.dom.aria_required, 'true');
  const snapshot = await call('snapshot', { query: 'Stop the app first' });
  assert.match(snapshot.snapshot, /button "Delete app".*description="Stop the app first"/);
  const ref = snapshot.snapshot.match(/\[([^\]]+)\] button/)[1];
  const hover = await call('hover', { ref });
  assert.equal(hover.delivery_verified, true); assert.equal(hover.events_trusted, true); assert.equal(hover.hit_target.disabled, true);
  const tooltip = await call('snapshot', { query: 'Hover-only detail' });
  assert.match(tooltip.snapshot, /Hover-only detail/);
  await assert.rejects(call('click', { selector: '#disabled', timeout_ms: 200 }), error => {
    assert.equal(error.input_dispatched, false); assert.equal(error.diagnostics.reason, 'disabled'); return true;
  });
  results.cases.push({ scenario: 'disabled_hover_and_explicit_descriptions', control, custom, hover, tooltip });

  const point = await page(`(() => {const r=document.querySelector('#safe').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  const click = await call('click', point);
  assert.equal(click.target_verified, null); assert.equal(click.delivery_verified, true); assert.equal(click.hit_target.id, 'safe');
  assert.equal(click.hit_target.text, 'Safe action'); assert.equal(click.hit_target.rect, undefined); assert.equal(await page('writes'), 1);
  results.cases.push({ scenario: 'coordinate_hit_summary', click });

  for (const [selector, nth, matched, reason] of [['.missing', 0, 0, 'selector_not_found'], ['.choice', 3, 2, 'selector_nth_out_of_range']]) {
    await assert.rejects(call('click', { selector, nth, timeout_ms: 250 }), error => {
      assert.equal(error.input_dispatched, false); assert.equal(error.diagnostics.reason, reason);
      assert.equal(error.diagnostics.selector, selector); assert.equal(error.diagnostics.nth, nth);
      assert.equal(error.diagnostics.matched, matched); assert.ok(error.diagnostics.frame_id);
      results.cases.push({ scenario: reason, diagnostics: error.diagnostics }); return true;
    });
  }
  await page(`(() => {
    const host=document.createElement('div');host.id='shadow-host';host.style.margin='40px';
    const root=host.attachShadow({mode:'closed'});root.innerHTML='<button disabled aria-label="Shadow disabled" aria-describedby="shadow-reason" style="width:180px;height:40px">Shadow disabled</button><span id="shadow-reason" hidden>Shadow explanation</span>';
    document.body.append(host);
    const frame=document.createElement('iframe');frame.id='hover-frame';frame.style.margin='20px';frame.srcdoc='<fieldset disabled><button aria-label="Frame disabled" style="width:180px;height:40px">Frame disabled</button></fieldset>';
    document.body.append(frame);
  })()`);
  const shadow = await call('read_control', { selector_type: 'role', selector: 'button', name: 'Shadow disabled' });
  assert.equal(shadow.control.dom.descriptions[0].text, 'Shadow explanation');
  assert.equal((await call('hover', { ref: shadow.control.ref })).delivery_verified, true);
  const frame = await call('read_control', { selector: 'button', frame: { path: ['#hover-frame'] }, timeout_ms: 3000 });
  assert.equal(frame.control.dom.disabled, false); assert.equal(frame.control.ax.disabled, true);
  assert.equal((await call('hover', { ref: frame.control.ref })).delivery_verified, true);
  results.cases.push({ scenario: 'disabled_hover_shadow_and_inherited_frame', shadow_description: shadow.control.ax.description, frame_disabled: frame.control.ax.disabled });

  await call('logs', { kind: 'network', capture: { enabled: true } });
  await call('evaluate', { expression: `fetch('/echo?observability=1',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':'synthetic-header','X-API-Key':'synthetic-api-key'},body:JSON.stringify({csrf_token:'synthetic-csrf',lark_oapi_csrf_token:'synthetic-lark',accessToken:'synthetic-access',field:'kept'})}).then(r=>r.json())` });
  const logs = await call('logs', { kind: 'network', view: 'events', url_origin: base, url_contains: 'observability=1' });
  assert.ok(logs.entries.some(row => row.request_body)); assert.ok(logs.entries.some(row => row.response_body));
  assert.doesNotMatch(JSON.stringify(logs), /synthetic-/);
  assert.ok(logs.entries.some(row => row.headers?.['X-CSRF-Token'] === '[REDACTED]' || row.headers?.['x-csrf-token'] === '[REDACTED]'));
  results.cases.push({ scenario: 'compound_credential_redaction', captured: logs.entries.length });
  assert.deepEqual(await focus(), before);
}
