import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ROOT, VERSION } from '../src/config.mjs';

if (!process.env.npm_execpath) throw new Error('Run through npm run test:package');
const npm = args => execFileSync(process.execPath, [process.env.npm_execpath, ...args], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
execFileSync(process.execPath, [join(ROOT, 'scripts/check-package.mjs')], { stdio: 'inherit' });
const packed = JSON.parse(npm(['pack', '--ignore-scripts', '--json']))[0];
const archive = join(ROOT, packed.filename), temp = await mkdtemp(join(tmpdir(), 'attach-package-'));
let hub, ws, client;
try {
  const prefix = join(temp, 'global install');
  npm(['install', '--global', '--prefix', prefix, archive, '--ignore-scripts']);
  const installed = process.platform === 'win32' ? join(prefix, 'node_modules/@evan_zhong/browser-attach') : join(prefix, 'lib/node_modules/@evan_zhong/browser-attach');
  for (const path of ['SKILL.md', 'references/setup.md', 'references/recovery.md', 'references/recipes.md', 'assets/mcp-config.example.json']) {
    const relative = join('skills/browser-attach', path);
    assert.deepEqual(await readFile(join(installed, relative)), await readFile(join(ROOT, relative)));
  }
  const home = join(temp, 'user data'), env = { ...process.env, BROWSER_ATTACH_HOME: home };
  // This setup must use the INSTALLED package, never the source checkout.
  execFileSync(process.execPath, [join(installed, 'bin/browser-attach.mjs'), '--help'], { cwd: temp, env, stdio: 'pipe' });
  const { pathToFileURL } = await import('node:url');
  const { setup } = await import(pathToFileURL(join(installed, 'src/setup.mjs')).href);
  const { startHub } = await import(pathToFileURL(join(installed, 'src/hub.mjs')).href);
  const paired = await setup({ configPath: join(home, 'config.json') });
  const { config, configPath } = paired;
  hub = await startHub(config, { port: 0 });
  await writeFile(configPath, JSON.stringify(config));
  assert.equal(paired.extensionDir, join(home, 'extension'));
  assert.equal(JSON.parse(await readFile(join(paired.extensionDir, 'manifest.json'))).version, VERSION);
  assert.equal(await readFile(join(paired.extensionDir, 'connection.js'), 'utf8'), await readFile(join(installed, 'extension/connection.js'), 'utf8'));
  ws = new WebSocket(`ws://127.0.0.1:${config.port}/extension`, { origin: `chrome-extension://${config.extension_id}` });
  await once(ws, 'open'); const hello = once(ws, 'message');
  ws.send(JSON.stringify({ type: 'hello', token: config.token, browser: { family: 'chrome', instance_id: 'package', run_id: 'one', profile_name: 'test', extension_version: VERSION } }));
  await hello;
  ws.on('message', raw => { const data = JSON.parse(raw.toString()); if (data.id) ws.send(JSON.stringify({ id: data.id, result: { released: true } })); });
  client = new Client({ name: 'package-test', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(installed, 'bin/browser-attach.mjs'), 'mcp', '--config', configPath], cwd: temp, env }));
  const tools = (await client.listTools()).tools;
  assert.equal(tools.length, 24);
  assert.ok(tools.some(tool => tool.name === 'browser_read_control'));
  const checks = tools.find(tool => tool.name === 'browser_wait').inputSchema.properties.checks;
  assert.equal(checks.maxItems, 30);
  assert.ok(checks.items.properties.condition.enum.includes('count'));
  assert.match(tools.find(tool => tool.name === 'browser_snapshot').inputSchema.properties.diff_since.description, /latest/);
  assert.ok(tools.find(tool => tool.name === 'browser_click').inputSchema.properties.observe.anyOf.some(schema => schema.properties?.diff_since));
  assert.ok(tools.some(tool => tool.name === 'browser_logs'));
  assert.ok(tools.find(tool => tool.name === 'browser_logs').inputSchema.properties.view.enum.includes('requests'));
  assert.equal(tools.find(tool => tool.name === 'browser_click').inputSchema.properties.wait_for.properties.checks.maxItems, 30);
  assert.ok(!tools.some(tool => ['browser_console_logs', 'browser_network_logs'].includes(tool.name)));
  const result = await client.callTool({ name: 'browser_discover', arguments: { kind: 'browsers' } });
  assert.equal(JSON.parse(result.content[0].text).browsers[0].browser_id, 'package:one');
  console.log(JSON.stringify({ archive, files: packed.files.length, installedOutsideCheckout: true, stdioTools: tools.length, extensionDirectoryOutsidePackage: true }));
} finally {
  await client?.close(); ws?.close(); await hub?.close();
  await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
