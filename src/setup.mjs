import { randomBytes, createHash } from 'node:crypto';
import { cp, copyFile, mkdir, mkdtemp, readFile, writeFile, chmod, rename, rm, rmdir, readdir, stat } from 'node:fs/promises';
import { join, resolve, dirname, relative, isAbsolute, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, DEFAULT_CONFIG, VERSION, loadConfig, writeJson } from './config.mjs';
import { compareVersions } from '../extension/version.js';

async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') {
    const identity = execFileSync('whoami', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
    const sid = identity.match(/S-1-[\d-]+/)?.[0];
    if (!sid) throw new Error('Cannot determine current Windows user SID');
    execFileSync('icacls', [path, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], { windowsHide: true, stdio: 'pipe' });
  } else await chmod(path, 0o700);
}

export async function setup({ configPath = DEFAULT_CONFIG, extensionDir, port } = {}) {
  configPath = resolve(configPath);
  await privateDirectory(dirname(configPath));
  const manifest = JSON.parse(await readFile(join(ROOT, 'extension/manifest.json'), 'utf8'));
  const extensionId = [...createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32)]
    .map(char => String.fromCharCode(97 + parseInt(char, 16))).join('');
  let config;
  try { config = await loadConfig(configPath); }
  catch (error) { if (error.cause?.code !== 'ENOENT') throw error; }
  port ??= config?.port ?? 47831;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('port must be 1024..65535');
  extensionDir = resolve(extensionDir || config?.extension_dir || join(dirname(configPath), 'extension'));
  const configRelative = relative(extensionDir, configPath);
  if (dirname(extensionDir) === extensionDir || (!isAbsolute(configRelative) && configRelative !== '..' && !configRelative.startsWith('..' + sep)))
    throw new Error('Choose a dedicated extension directory outside the pairing file');
  config ||= { port, token: randomBytes(48).toString('base64url'), extension_id: extensionId };
  if (config.port !== port || config.extension_id !== extensionId) throw new Error('Pairing differs from requested port/extension. Stop the hub and remove the pairing config before a fresh setup.');
  if (config.extension_dir && resolve(config.extension_dir) !== extensionDir) throw new Error('Use the paired extension directory, or a separate pairing config for a different directory.');
  config.extension_dir = extensionDir;
  await writeJson(configPath, config);
  return { config, configPath, extensionDir };
}

// Only the Hub holding the listening port may replace the stable copy.
export async function syncExtension(config) {
  const source = resolve(ROOT, 'extension'), destination = resolve(config.extension_dir);
  const manifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'));
  const backup = destination + '.previous';
  async function installed(directory) {
    try {
      const value = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
      if (value.key !== manifest.key) throw new Error(`Unrecognized extension directory: ${directory}`);
      return value;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try { if ((await readdir(directory)).length) throw new Error(`Unrecognized extension directory: ${directory}`); }
      catch (missing) { if (missing.code !== 'ENOENT') throw missing; }
      return null;
    }
  }
  async function files(directory) {
    const entries = await readdir(directory, { recursive: true });
    const kinds = await Promise.all(entries.map(path => stat(join(directory, path))));
    return entries.filter((_, index) => kinds[index].isFile());
  }
  async function install(directory) {
    await privateDirectory(destination);
    const incoming = await files(directory), existing = await files(destination);
    // Keep the loaded directory itself stable and commit its manifest last.
    for (const path of incoming.filter(path => path !== 'manifest.json')) {
      const target = join(destination, path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await copyFile(join(directory, path), target + '.updating');
      await rename(target + '.updating', target);
    }
    for (const path of existing) if (!incoming.includes(path)) await rm(join(destination, path));
    await writeJson(join(destination, 'manifest.json'), JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')));
  }
  let current = await installed(destination);
  if (current && compareVersions(current.version, VERSION) > 0) throw new Error('Refusing to downgrade the installed extension');
  const previous = destination === source ? null : await installed(backup);
  if (previous) {
    await install(backup);
    current = previous;
    await rm(backup, { recursive: true });
  }
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const stage = destination === source ? source : await mkdtemp(destination + '.staging-');
  try {
    if (stage !== source) await cp(source, stage, { recursive: true, filter: path => !path.endsWith('config.generated.js') });
    await privateDirectory(stage);
    manifest.content_security_policy = { extension_pages: `script-src 'self'; object-src 'self'; connect-src ws://127.0.0.1:${config.port}` };
    await writeJson(join(stage, 'manifest.json'), manifest);
    await writeFile(join(stage, 'config.generated.js'), '// Machine-local pairing secret. Never publish.\nexport const CONNECTION = ' +
      JSON.stringify({ url: `ws://127.0.0.1:${config.port}/extension`, token: config.token }) + ';\n', { mode: 0o600 });
    if (stage !== source) {
      if (current) {
        await privateDirectory(stage + '.previous');
        await cp(destination, stage + '.previous', { recursive: true });
        await rename(stage + '.previous', backup);
      } else {
        try { await rmdir(destination); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        await rename(stage, destination);
        return;
      }
      try { await install(stage); }
      catch (error) { if (current) await install(backup); throw error; }
      if (current) await rm(backup, { recursive: true });
    }
  } finally {
    if (stage !== source) {
      await rm(stage, { recursive: true, force: true });
      await rm(stage + '.previous', { recursive: true, force: true });
    }
  }
}
