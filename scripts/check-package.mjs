import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { ROOT, VERSION } from '../src/config.mjs';

for (const path of ['package.json', 'extension/manifest.json', 'server.json']) {
  if (JSON.parse(await readFile(new URL(`../${path}`, import.meta.url), 'utf8')).version !== VERSION) throw new Error(`Version mismatch: ${path}`);
}
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const serverJson = JSON.parse(await readFile(new URL('../server.json', import.meta.url), 'utf8'));
if (!packageJson.mcpName || packageJson.mcpName !== serverJson.name) throw new Error('MCP Registry name mismatch');
if (serverJson.packages[0].identifier !== packageJson.name || serverJson.packages[0].version !== VERSION)
  throw new Error('MCP Registry package mismatch');

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const result = JSON.parse(execFileSync(npm, ['pack', '--dry-run', '--ignore-scripts', '--json'], {
  cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'],
}))[0];
const names = result.files.map(file => file.path);
if (!names.includes('server.json')) throw new Error('Package is missing server.json');
for (const path of ['SKILL.md', 'references/setup.md', 'references/recovery.md', 'references/recipes.md', 'assets/mcp-config.example.json']) {
  const entry = `skills/browser-attach/${path}`;
  if (!names.includes(entry)) throw new Error(`Package is missing ${entry}`);
}
const skill = await readFile(new URL('../skills/browser-attach/SKILL.md', import.meta.url), 'utf8');
if (!skill.includes(`  version: "${VERSION}"`)) throw new Error('Skill version mismatch');
const quickConfig = JSON.parse(await readFile(new URL('../mcp-config.json', import.meta.url), 'utf8')).mcpServers.browser_attach;
const stableConfig = JSON.parse(await readFile(new URL('../skills/browser-attach/assets/mcp-config.example.json', import.meta.url), 'utf8')).mcpServers.browser_attach;
const [[cliName, cliPath]] = Object.entries(packageJson.bin);
if (quickConfig.command !== 'npx' || JSON.stringify(quickConfig.args) !== JSON.stringify(['--yes', `--package=${packageJson.name}@latest`, cliName, 'mcp']))
  throw new Error('Quick-start MCP config differs from the package CLI');
if (stableConfig.type !== 'stdio' || !stableConfig.args?.[0]?.endsWith(`/${cliPath}`) ||
    stableConfig.args.length !== 4 || stableConfig.args[1] !== 'mcp' || stableConfig.args[2] !== '--config' ||
    stableConfig.args[3] !== `${stableConfig.env?.BROWSER_ATTACH_HOME}/config.json`)
  throw new Error('Stable MCP config must launch the CLI with the shared pairing file');
for (const path of names) {
  if (/config\.generated\.js|(^|\/)(\.local|\.venv|test-results|node_modules)\//.test(path)) throw new Error(`Private file included in package: ${path}`);
}
for (const path of ['extension/connection.js', 'extension/version.js', 'extension/errors.js', 'extension/page-url.js']) if (!names.includes(path)) throw new Error(`Package is missing ${path}`);
for (const path of ['src/hub-runtime.mjs', 'extension/observation.js', 'extension/snapshot-diff.js', 'extension/control.js', 'extension/target-description.js', 'extension/fields.js', 'extension/pointer.js', 'extension/dialogs.js', 'extension/network.js', 'extension/log-data.js', 'extension/fetch-page.js', 'extension/screenshot.js', 'extension/upload.js']) if (!names.includes(path)) throw new Error(`Package is missing ${path}`);
for (const path of ['bin/browser-attach.mjs', 'src/mcp.mjs', 'src/hub.mjs', 'extension/manifest.json', 'extension/evaluate.js', 'extension/fetch.js', 'extension/locator.js', 'extension/batch.js', 'extension/wait.js', 'extension/outcomes.js', 'extension/scroll.js', 'extension/drag.js', 'extension/text.js', 'extension/diagnostics.js', 'extension/sessions.js', 'extension/actionability.js', 'extension/limits.js', 'extension/icons/BrowserAttach.png']) {
  if (!names.includes(path)) throw new Error(`Package is missing ${path}`);
}
console.log(`Package boundary verified (${names.length} files, no generated pairing secret).`);
