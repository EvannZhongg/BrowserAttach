import { homedir } from 'node:os';
import { join, resolve, dirname, isAbsolute } from 'node:path';
import { readFile, mkdir, writeFile, rename, chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
const configuredHome = process.env.BROWSER_ATTACH_HOME;
if (configuredHome && (!isAbsolute(configuredHome) ||
    (process.platform === 'win32' && !/^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/i.test(configuredHome)))) {
  throw new Error('BROWSER_ATTACH_HOME must be an absolute directory shared by setup, MCP and Hub.');
}
export const DATA_DIR = configuredHome
  ? resolve(configuredHome)
  // Packaged Windows hosts can redirect AppData into different private views.
  : process.platform === 'win32' ? join(homedir(), '.browser-attach')
    : join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'browser-attach');
export const DEFAULT_CONFIG = join(DATA_DIR, 'config.json');
export const VERSION = '0.33.0';

export async function loadConfig(path = DEFAULT_CONFIG) {
  let config;
  try { config = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { throw new Error(`Cannot read pairing config ${path}${error.code ? ` (${error.code})` : ''}. Run browser-attach setup.`, { cause: error }); }
  // Pre-0.17 pairings did not record the extension directory; their setup default
  // was a sibling `extension` directory next to the pairing file.
  if (config.extension_dir === undefined) config.extension_dir = join(dirname(resolve(path)), 'extension');
  if (typeof config.token !== 'string' || config.token.length < 32 ||
      typeof config.extension_dir !== 'string' || !isAbsolute(config.extension_dir) ||
      !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535 ||
      !/^[a-p]{32}$/.test(config.extension_id)) throw new Error('Invalid pairing config. Run browser-attach setup.');
  return config;
}

export async function writeJson(path, data) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  if (process.platform !== 'win32') await chmod(path, 0o600);
}
