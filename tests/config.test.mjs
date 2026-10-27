import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { ROOT, loadConfig } from '../src/config.mjs';

const configModule = new URL('../src/config.mjs', import.meta.url).href;
function resolveInChild(env, cwd) {
  const childEnv = { ...process.env, ...env };
  if (env.BROWSER_ATTACH_HOME === undefined) delete childEnv.BROWSER_ATTACH_HOME;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
    `const c = await import(${JSON.stringify(configModule)}); console.log(JSON.stringify({data: c.DATA_DIR, config: c.DEFAULT_CONFIG}));`],
  { env: childEnv, cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }));
}

test('Windows default is outside AppData and independent of LOCALAPPDATA and cwd', { skip: process.platform !== 'win32' }, async t => {
  const temp = await mkdtemp(join(tmpdir(), 'attach-path-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const other = join(temp, 'other cwd'); await mkdir(other);
  const a = resolveInChild({ BROWSER_ATTACH_HOME: undefined, LOCALAPPDATA: join(temp, 'virtual view') }, temp);
  const b = resolveInChild({ BROWSER_ATTACH_HOME: undefined, LOCALAPPDATA: join(temp, 'normal view') }, other);
  assert.deepEqual(a, b);
  assert.equal(a.data, join(homedir(), '.browser-attach'));
  assert.equal(a.config, join(a.data, 'config.json'));
});

test('absolute shared home wins across process environments; relative home is rejected', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'attach-path-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const shared = join(temp, '中文 shared data');
  const actual = resolveInChild({ BROWSER_ATTACH_HOME: shared, LOCALAPPDATA: join(temp, 'ignored') }, ROOT);
  assert.equal(actual.data, shared);
  assert.equal(actual.config, join(shared, 'config.json'));
  assert.throws(() => resolveInChild({ BROWSER_ATTACH_HOME: './unstable-relative' }, temp), error =>
    error.stderr.toString().includes('BROWSER_ATTACH_HOME must be an absolute directory'));
  if (process.platform === 'win32') assert.throws(() => resolveInChild({ BROWSER_ATTACH_HOME: '\\drive-relative' }, temp), error =>
    error.stderr.toString().includes('BROWSER_ATTACH_HOME must be an absolute directory'));
});

test('legacy pairing without extension_dir defaults to the sibling extension directory', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'attach-legacy-config-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const configPath = join(temp, 'config.json');
  await writeFile(configPath, JSON.stringify({ token: 'x'.repeat(48), port: 47831, extension_id: 'a'.repeat(32) }));
  const loaded = await loadConfig(configPath);
  assert.equal(loaded.extension_dir, join(temp, 'extension'));
});
