# Setup and MCP configuration

Use this reference to install the server, pair the extension or configure a missing MCP connection. An existing working connection needs no setup.

## Pair the local browser

The npm package below is this skill's companion MIT-licensed open-source server: [source repository](https://github.com/EvannZhongg/BrowserAttach). Installation adds its CLI and extension files; `setup` creates the local pairing and starts the Hub. Load the extension and configure the host connection explicitly.

```sh
npm install --global @evan_zhong/browser-attach
browser-attach setup
```

`setup` prints the pairing file and stable extension directory, and starts the local Hub. In `chrome://extensions` or `edge://extensions`, enable Developer mode and load that directory as an unpacked extension in each intended profile. The extension options can give profiles recognizable names.

The default data directory is `%USERPROFILE%/.browser-attach` on Windows and `${XDG_DATA_HOME:-~/.local/share}/browser-attach` on macOS/Linux. Use the paths printed by setup. To keep an existing custom pairing, pass `--config /absolute/shared/config.json`.

For an already-open ordinary `file://` page, enable **Allow access to file URLs** in the extension details. `open_tab` and `fetch` accept HTTP(S) only.

## Configure the MCP connection

Use the host's MCP configuration file, registration command or settings UI to supply these values on the browser machine:

| Setting | Value |
| --- | --- |
| Server name | `browser_attach` |
| Transport | `stdio` |
| Command | Absolute path to Node.js |
| Arguments | Absolute CLI path, `mcp`, `--config`, absolute pairing file path |
| Environment | `BROWSER_ATTACH_HOME` set to the pairing file's directory |
| Timeouts, if configurable | 20 seconds for startup, 60 seconds per tool call |

Find Node with `where node` on Windows or `which node` on macOS/Linux. `npm root -g` locates the global package root; the CLI is `@evan_zhong/browser-attach/bin/browser-attach.mjs` below it. A development checkout can supply the CLI path instead. Absolute paths keep hosts with different working directories or environments on the same pairing.

For hosts using a JSON `mcpServers` object, merge [mcp-config.example.json](../assets/mcp-config.example.json) into their configuration and replace the sample paths. This template pins the local executable and pairing paths for stable setup. Windows JSON paths can use forward slashes or escaped backslashes.

For hosts using TOML server tables, such as Codex, the same connection is expressed as:

```toml
[mcp_servers.browser_attach]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/browser-attach/bin/browser-attach.mjs", "mcp", "--config", "/absolute/shared/config.json"]
startup_timeout_sec = 20
tool_timeout_sec = 60

[mcp_servers.browser_attach.env]
BROWSER_ATTACH_HOME = "/absolute/shared"
```

Codex accepts this in `~/.codex/config.toml` or a trusted project's `.codex/config.toml`; see its [MCP configuration reference](https://developers.openai.com/codex/mcp). Use the current host's documented format and configuration scope when adapting the entry. Preserve other configured servers.

Hosts sharing the setup shell's default data directory can alternatively launch `npx --yes --package=@evan_zhong/browser-attach@latest browser-attach mcp`. Use `npx.cmd` if the Windows host requires the command extension; use the explicit pairing path when the host environment differs.

## Verify and update

Reconnect the host and confirm the tools are available. Discover profiles, discover the intended tabs, claim a test page, take a snapshot, then release it. Tool prefixes vary by host; original `browser_*` names do not. The host must pass MCP initialization instructions to the model as well as tool schemas; screenshots require forwarding MCP image content.

After installing an update, reconnect the MCP host. Hub/extension versions from 0.17 onward support coordinated upgrades when idle; another connected MCP client can block an upgrade. Older pairings require stopping the Hub and manually reloading the extension once. If an upgrade fails, check the host's stderr and `hub.log` beside the pairing file, then use the extension's reload control if needed. Rediscover and claim after reconnecting.
