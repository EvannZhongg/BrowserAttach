import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessions } from '../extension/sessions.js';

const run = operation => operation();
function fixture(hook = async () => {}) {
  const calls = [];
  const sessions = createSessions(async (target, method, args) => { calls.push({ target, method, args }); return hook(target, method, args); }, () => {});
  const attach = id => sessions.event({ tabId: 9 }, 'Target.attachedToTarget', { sessionId: id, targetInfo: { type: 'iframe', targetId: id } });
  return { sessions, calls, attach, chooserCalls: () => calls.filter(call => call.method === 'Page.setInterceptFileChooserDialog') };
}

test('ordinary main and child session initialization preserves native file dialogs', async () => {
  const f = fixture(); await f.sessions.start(9); f.attach('child'); await f.sessions.settle(9);
  assert.equal(f.chooserCalls().length, 0);
});

test('capture covers existing and newly attached iframe sessions then disables all of them', async () => {
  const f = fixture(); await f.sessions.start(9); f.attach('child'); await f.sessions.settle(9);
  await f.sessions.interceptFileChoosers(9, true, run);
  f.attach('nested'); await f.sessions.settle(9);
  await f.sessions.interceptFileChoosers(9, false, run);
  for (const id of [undefined, 'child', 'nested']) assert.deepEqual(f.chooserCalls().filter(call => call.target.sessionId === id).map(call => call.args.enabled), [true, false]);
  f.attach('later'); await f.sessions.settle(9);
  assert.ok(!f.chooserCalls().some(call => call.target.sessionId === 'later'));
});

test('late iframe initialization cannot re-enable capture after cleanup', async () => {
  let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  const f = fixture(async (target, method) => { if (target.sessionId && method === 'Page.enable') await gate; });
  await f.sessions.start(9);
  await f.sessions.interceptFileChoosers(9, true, run);
  f.attach('slow');
  await f.sessions.interceptFileChoosers(9, false, run);
  finish(); await f.sessions.settle(9);
  assert.deepEqual(f.chooserCalls().filter(call => call.target.sessionId === 'slow').map(call => call.args.enabled), [false]);
});

test('cleanup attempts every session and surfaces live failures while tolerating detached frames', async () => {
  const f = fixture(async (target, method, args) => {
    if (method === 'Page.setInterceptFileChooserDialog' && !args.enabled && target.sessionId === 'child') throw new Error('Disable failed');
  });
  await f.sessions.start(9); f.attach('child'); f.attach('nested'); await f.sessions.settle(9);
  await f.sessions.interceptFileChoosers(9, true, run);
  await assert.rejects(f.sessions.interceptFileChoosers(9, false, run), /Disable failed/);
  assert.equal(f.chooserCalls().filter(call => !call.args.enabled).length, 3);
  f.sessions.event({ tabId: 9 }, 'Target.detachedFromTarget', { sessionId: 'child' });
  await f.sessions.interceptFileChoosers(9, false, run);
});
