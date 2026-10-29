import assert from 'node:assert/strict';

export async function checkWaitVerification({ call, page, focus, base, results }) {
  const beforeFocus = await focus();
  await page(`(() => {
    const root = document.createElement('section'); root.id = 'verify-fixture';
    root.style = 'position:fixed;left:20px;top:80px;background:white;z-index:1000';
    root.innerHTML = '<input id="verify-name" aria-label="Verify name" value="private-field-content"><input id="verify-check" type="checkbox"><div id="verify-state">Ready</div><div id="verify-aria"></div><ul id="verify-rows"><li>Verify row A</li><li>Verify row B</li><li>Verify row C</li></ul><button id="verify-submit">Verify submit</button><div id="verify-errors"></div>';
    document.body.prepend(root); window.verifyWrites = 0;
    document.querySelector('#verify-submit').onclick = () => window.verifyWrites++;
    return true;
  })()`);
  const checks = [
    { selector: '#verify-name', condition: 'value_present', expected: true },
    { selector: '#verify-rows > li', condition: 'count', expected: 3 },
    { selector: '.verify-error', condition: 'count', expected: 0 },
    { selector: '#verify-state', condition: 'text', expected: 'Ready' },
    { selector: '#verify-state', condition: 'text', expected: 'Working', not: true },
    { selector: '#verify-check', condition: 'checked', expected: false },
    { condition: 'url', expected: '/probe' },
    { selector: 'textbox', selector_type: 'role', name: 'Verify name', condition: 'count', expected: 1 },
    { selector: 'textbox', selector_type: 'role', name: 'Verify name', condition: 'value_present', expected: true },
  ];
  const passed = await call('wait', { checks });
  assert.equal(passed.status, 'pass', JSON.stringify(passed)); assert.equal(passed.results.length, 9);
  assert.equal(passed.timed_out, false); assert.equal(passed.retry_safe, true);
  assert.ok(!JSON.stringify(passed).includes('private-field-content'));
  const exact = await call('wait', { checks: [{ selector: '#verify-name', condition: 'value', expected: 'private-field-content' }] });
  assert.equal(exact.status, 'pass'); assert.ok(!JSON.stringify(exact).includes('private-field-content'));
  await page(`document.querySelector('#verify-name').value='';document.querySelector('#verify-rows > li:last-child').remove();document.querySelector('#verify-errors').innerHTML='<span class="verify-error">Error</span>';true`);
  const failed = await call('wait', { checks: checks.slice(0, 3), timeout_ms: 200 });
  assert.equal(failed.status, 'fail'); assert.deepEqual(failed.failed, [0, 1, 2]); assert.equal(failed.results[1].actual.count, 2);
  const unavailable = await call('wait', { timeout_ms: 200, checks: [
    { selector: '#verify-aria', condition: 'checked', expected: false, not: true },
    { selector: '#verify-missing', condition: 'text', expected: 'Error', not: true },
    { selector: '#anything', frame: { url: base + '/missing-frame' }, condition: 'absent' },
    { selector: '#verify-rows > li', condition: 'count', expected: 2 },
  ] });
  assert.equal(unavailable.status, 'unavailable'); assert.deepEqual(unavailable.unavailable, [0, 1, 2]);
  assert.equal(unavailable.results[3].status, 'pass');
  const steps = [
    { action: 'click', selector: '#verify-submit', mode: 'dom' },
    { action: 'wait', checks: [{ selector: '#verify-rows > li', condition: 'count', expected: 4 }], timeout_ms: 200 },
    { action: 'click', selector: '#verify-submit', mode: 'dom' },
  ];
  await assert.rejects(call('batch', { dialog_policy: 'accept', steps }), /dialog_policy=ask/);
  assert.equal(await page('verifyWrites'), 0);
  const stopped = await call('batch', { steps });
  assert.equal(stopped.completed, false); assert.equal(stopped.failed_step, 1);
  assert.equal(stopped.verification.status, 'fail'); assert.equal(stopped.retry_failed_step_safe, true);
  assert.equal(await page('verifyWrites'), 1);
  const continued = await call('batch', { steps: [
    { action: 'wait', checks: [{ selector: '#verify-rows > li', condition: 'count', expected: 2 }] },
    { action: 'click', selector: '#verify-submit', mode: 'dom' },
  ] });
  assert.equal(continued.completed, true); assert.equal(await page('verifyWrites'), 2);
  const actionable = await call('wait', { checks: [{ selector: '#verify-submit', condition: 'actionable' }] });
  assert.equal(actionable.status, 'pass', JSON.stringify(actionable));
  await page(`document.querySelector('#verify-state').innerText='x'.repeat(600)+' Complete';setTimeout(()=>{document.querySelector('#verify-name').outerHTML='<input id="verify-name" aria-label="Verify name" value="replacement">'},100);true`);
  const replaced = await call('wait', { checks: [
    { selector: '#verify-name', condition: 'value', expected: 'replacement' },
    { selector: '#verify-state', condition: 'text', expected: 'Complete' },
  ], timeout_ms: 3000 });
  assert.equal(replaced.status, 'pass'); assert.equal(replaced.results[1].actual.text_truncated, true);
  assert.equal(replaced.results[1].actual.total_chars, 609);
  await assert.rejects(call('wait', { checks: [{ selector: '[', condition: 'attached' }] }), error => error.diagnostics.reason === 'selector_invalid');
  await assert.rejects(call('wait', { checks: [{ selector: '#verify-rows > li', condition: 'attached' }] }), error => error.diagnostics.reason === 'selector_ambiguous');
  await page(`(() => {const frame=document.createElement('iframe');frame.id='verify-frame';frame.src=${JSON.stringify(base.replace('127.0.0.1', 'localhost') + '/inner')};document.body.append(frame);return true})()`);
  const framed = await call('wait', { checks: [
    { selector: 'input', frame: { path: ['#verify-frame'] }, condition: 'value_present', expected: false },
    { selector: 'button', selector_type: 'role', name: 'Inner button', frame: { path: ['#verify-frame'] }, condition: 'count', expected: 1 },
  ], timeout_ms: 5000 });
  assert.equal(framed.status, 'pass', JSON.stringify(framed));
  await page(`setTimeout(()=>confirm('Verification must leave this dialog open'),0);true`);
  const modal = await call('wait', { checks: [{ selector: '#verify-state', condition: 'text', expected: 'Never matches' }], timeout_ms: 2000 });
  assert.equal(modal.status, 'unavailable'); assert.equal(modal.results[0].actual.reason, 'dialog_open');
  const dialog = await call('snapshot'); assert.equal(dialog.dialog.type, 'confirm');
  await call('handle_dialog', { accept: false });
  assert.equal(await page('verifyWrites'), 2);
  assert.deepEqual(await focus(), beforeFocus);
  results.cases.push({ scenario: 'wait_verification', checks: passed.results.length, failed: failed.failed,
    unavailable: unavailable.unavailable, batch_stopped: true, replacement: true, oopif: true, dialog_untouched: true, focus_preserved: true });
}
