import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Runs through the real extension on disposable profiles. The worker hook only
// records protocol traffic; it forwards every command to Chromium unchanged.
export async function checkFileChoosers({ call, page, evaluate, tab, dir, base, focus, results }) {
  const before = await focus();
  const file = join(dir, '中文 upload.txt');
  await writeFile(file, 'file chooser regression');
  await evaluate(`(() => {
    globalThis.chooserTrace = [];
    globalThis.originalChooserSend = chrome.debugger.sendCommand;
    chrome.debugger.sendCommand = async (target, method, args) => {
      if (method === 'Page.setInterceptFileChooserDialog') chooserTrace.push({ target, enabled: args.enabled });
      return originalChooserSend.call(chrome.debugger, target, method, args);
    };
  })()`);
  const trace = () => evaluate('chooserTrace');
  const reset = () => evaluate('chooserTrace.length = 0');
  const restored = async () => {
    const commands = await trace();
    assert.ok(commands.some(command => command.enabled));
    const targets = new Map();
    for (const command of commands) targets.set(JSON.stringify(command.target), command.enabled);
    assert.ok([...targets.values()].every(enabled => !enabled), JSON.stringify(commands));
    return commands;
  };
  try {
    await page(`(() => {
      document.body.innerHTML = '<input type="file" id="file" hidden><button id="choose">Choose</button><button id="delayed">Delayed</button><button id="picker">Picker</button><button id="activation">Activation</button><button id="nothing">Nothing</button><button id="disabled" disabled>Disabled</button><button id="dialog">Dialog</button>';
      window.uploadClicks = 0; window.noChooserClicks = 0; window.fileChanges = 0;
      const input = document.querySelector('#file');
      input.onchange = () => fileChanges++;
      document.querySelector('#choose').onclick = () => { uploadClicks++; input.click(); };
      document.querySelector('#delayed').onclick = () => { uploadClicks++; setTimeout(() => input.click(), 80); };
      document.querySelector('#picker').onclick = () => { uploadClicks++; input.showPicker(); };
      document.querySelector('#nothing').onclick = () => noChooserClicks++;
      document.querySelector('#dialog').onclick = () => alert('Upload dialog fixture');
      return true;
    })()`);
    await call('click', { selector: '#choose' });
    assert.equal((await trace()).length, 0);
    assert.equal((await call('snapshot')).file_chooser, undefined);
    await call('upload_file', { selector: '#file', files: [file] });
    assert.equal(await page('document.querySelector("#file").files[0].text()'), 'file chooser regression');
    assert.equal((await trace()).length, 0);
    results.cases.push({ scenario: 'ordinary_click_and_direct_upload_do_not_intercept' });

    for (const [selector, mode] of [['#choose', 'native'], ['#choose', 'dom'], ['#delayed', 'native'], ['#picker', 'native']]) {
      // DOM input never creates user activation; seed it with a separate,
      // explicit native action before testing sites that require activation.
      if (mode === 'dom') await call('click', { selector: '#activation' });
      await reset();
      const clicks = await page('uploadClicks');
      const clicked = await call('click', { selector, mode, capture_file_chooser: true });
      assert.equal(clicked.file_chooser.pending, true, JSON.stringify({ selector, mode, clicked }));
      assert.equal(await page('uploadClicks'), clicks + 1);
      const commands = await restored();
      await call('upload_file', { files: [file] });
      assert.equal(await page('document.querySelector("#file").files[0].text()'), 'file chooser regression');
      assert.equal((await call('snapshot')).file_chooser, undefined);
      results.cases.push({ scenario: 'explicit_capture_then_upload', selector, mode, commands });
    }

    await reset();
    const missed = await call('click', { selector: '#nothing', capture_file_chooser: true, timeout_ms: 350 });
    assert.equal(missed.delivery_verified, true);
    assert.equal(missed.file_chooser.pending, false);
    assert.equal(missed.file_chooser.reason, 'not_opened');
    assert.equal(await page('noChooserClicks'), 1);
    await restored();
    await assert.rejects(call('upload_file', { files: [] }), /No pending/);
    results.cases.push({ scenario: 'missing_chooser_preserves_click_without_replay', missed });

    await reset();
    await assert.rejects(call('click', { selector: '#disabled', capture_file_chooser: true, timeout_ms: 200 }));
    await restored();
    await reset();
    await assert.rejects(call('click', { selector: '#dialog', capture_file_chooser: true }));
    await restored();
    await call('handle_dialog', { accept: true });
    results.cases.push({ scenario: 'preparation_and_dialog_failures_restore_manual_selection' });

    // Newly created background OOPIFs may not have layout yet. Foreground is an
    // explicit fixture setup action, then restored before checking focus.
    await call('activate_tab');
    await page(`(() => { const frame = document.createElement('iframe'); frame.id = 'upload-child'; frame.src = ${JSON.stringify(base.replace('127.0.0.1', 'localhost') + '/inner')}; document.body.append(frame); return true; })()`);
    const frame = { path: ['#upload-child'] };
    await call('evaluate', { frame, expression: `() => {
      document.body.innerHTML = '<input type="file" id="child-file" hidden><button id="child-choose">Choose in frame</button>';
      document.querySelector('#child-choose').onclick = () => document.querySelector('#child-file').click();
      return true;
    }` });
    await reset();
    const childClick = await call('click', { frame, selector: '#child-choose', capture_file_chooser: true });
    assert.equal(childClick.file_chooser.pending, true);
    const childCommands = await restored();
    assert.ok(childCommands.some(command => command.target.sessionId && command.enabled));
    await call('upload_file', { files: [file] });
    const childFiles = await call('evaluate', { frame, expression: '() => document.querySelector("#child-file").files.length' });
    assert.equal(childFiles.value, 1);
    await call('click', { frame, selector: '#child-choose', capture_file_chooser: true });
    await page('document.querySelector("#upload-child").remove()');
    await call('snapshot');
    await assert.rejects(call('upload_file', { files: [] }), /No pending/);
    results.cases.push({ scenario: 'oopif_capture_upload_and_detach_cleanup', commands: childCommands });

    await reset();
    await call('batch', { steps: [{ action: 'click', selector: '#choose', capture_file_chooser: true }] });
    await restored();
    await call('upload_file', { files: [] });
    await reset();
    await call('click', { selector: '#choose' });
    assert.equal((await trace()).length, 0);
    assert.equal((await call('snapshot')).file_chooser, undefined);
    const previousActive = before.find(window => window.id === tab.windowId).active[0];
    await evaluate(`chrome.tabs.update(${previousActive}, {active: true})`);
    assert.deepEqual(await focus(), before);
    results.cases.push({ scenario: 'batch_capture_and_later_ordinary_click_restore_manual_behavior', tab_id: tab.id });
  } finally {
    await evaluate('chrome.debugger.sendCommand = originalChooserSend; delete globalThis.originalChooserSend; delete globalThis.chooserTrace;');
  }
}
