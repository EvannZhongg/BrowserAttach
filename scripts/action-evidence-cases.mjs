import assert from 'node:assert/strict';

export async function checkActionEvidence({ call, page, base, focus, results }) {
  const before = await focus();
  const historical = await call('evaluate', { expression: `(async()=>{history.pushState({},'', '/probe?route=1');await new Promise(r=>setTimeout(r,60));return {completed:true}})()` });
  assert.equal(historical.value.completed, true); assert.equal(historical.execution_completed, true);
  assert.equal(historical.source_current, false); assert.equal(historical.next_cursor, null);
  results.cases.push({ scenario: 'historical_json_after_route', historical });

  await page(`window.__count=0;document.querySelector('#go').onclick=()=>{window.__count++;setTimeout(()=>{history.pushState({},'', '/probe?submitted=1');document.querySelector('#state').textContent='Saved'},80)};true`);
  const spa = await call('click', { selector: '#go', timeout_ms: 5000, wait_for: { checks: [
    { condition: 'url', expected: 'submitted=1' }, { condition: 'text', selector: '#state', expected: 'Saved' },
  ] }, observe: { diff_since: 'latest' } });
  assert.equal(spa.delivery_verified, true); assert.equal(spa.wait_result.status, 'pass');
  assert.equal(spa.observation.available, true); assert.equal(spa.page_state, undefined);
  assert.equal(await page('window.__count'), 1);
  const unmet = await call('click', { selector: '#go', timeout_ms: 3000, wait_for: { checks: [{ condition: 'text', selector: '#state', expected: 'Never' }], timeout_ms: 250 } });
  assert.equal(unmet.delivery_verified, true); assert.notEqual(unmet.wait_result.status, 'pass');
  assert.equal(unmet.wait_result.timed_out, true);
  assert.equal(await page('window.__count'), 2);
  results.cases.push({ scenario: 'one_click_spa_wait_and_observe', spa, unmet });

  await page(`localStorage.setItem('evidenceClicks','0');document.querySelector('#go').onclick=()=>{localStorage.setItem('evidenceClicks',String(Number(localStorage.getItem('evidenceClicks'))+1));setTimeout(()=>location.href=${JSON.stringify(base + '/probe?landed=1')},60)};true`);
  const navigation = await call('click', { selector: '#go', timeout_ms: 5000, wait_for: { checks: [{ condition: 'url', expected: 'landed=1' }] } });
  assert.equal(navigation.wait_result.status, 'pass'); assert.equal(navigation.delivery_verified, true);
  assert.equal(await page(`localStorage.getItem('evidenceClicks')`), '1');
  results.cases.push({ scenario: 'one_click_cross_document_wait', navigation });

  await call('logs', { kind: 'network', capture: { enabled: true } });
  await call('evaluate', { expression: `fetch('/echo?evidence=1',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query:'jobs',token:'redact-me'})}).then(r=>r.json())` });
  const summary = await call('logs', { kind: 'network', view: 'requests', resource_types: ['XHR', 'Fetch'], url_origin: base, url_contains: 'evidence=1', status: 200 });
  assert.equal(summary.entries.length, 1); assert.equal(summary.entries[0].method, 'POST');
  const identity = summary.entries[0];
  const details = await call('logs', { kind: 'network', view: 'events', request_id: identity.request_id, session_id: identity.session_id, hop: identity.hop });
  assert.ok(details.entries.some(item => item.request_body)); assert.ok(details.entries.some(item => item.response_body));
  assert.ok(!JSON.stringify(details).includes('redact-me'));
  results.cases.push({ scenario: 'network_summary_and_captured_details', summary });
  assert.deepEqual(await focus(), before);
  results.cases.push({ scenario: 'explicit_focus_preserved' });
}
