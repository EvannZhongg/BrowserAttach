# Agent 集成

BrowserAttach 是标准 stdio MCP，共 23 个工具；任何能启动子进程并发现 MCP 工具的 Agent 宿主都可以接入。本文按宿主给出装配步骤；配对与路径要求先读「通用装配」。

| 宿主 | 装配方式 | 配置位置 |
| --- | --- | --- |
| Nosis | `browser-attach setup --nosis` 自动写入 | `~/.nosis/agent_config.json` |
| DeepSeek Harness | 手动追加 patch 条目 | `$DSH_HOME/profiles/<name>/cordis.patch.yml` |

## 通用装配

先完成配对：

```sh
npm install --global @evan_zhong/browser-attach
browser-attach setup
```

`setup` 打印稳定的扩展目录并启动本机 Hub。按 [README](../README.md) 第 1 步在 `chrome://extensions` 或 `edge://extensions` 加载该目录；每个要暴露的浏览器 profile 各加载一次。

宿主侧只需启动 stdio 进程：

```sh
node <安装位置>/bin/browser-attach.mjs mcp --config <配对文件绝对路径>
```

- `BROWSER_ATTACH_HOME` 指向配对文件所在目录。
- Node 可执行文件、CLI 与配对文件一律使用绝对路径。宿主的启动环境（PATH、工作目录、AppData 重定向）不同，重新推导会得到第二份配对。
- 安装位置变化后重新执行 `setup` 并更新宿主条目。Hub 与扩展已经运行 0.17 或更高版本时，安装新版后重连 MCP 会协调空闲 Hub 与扩展自动升级；从更旧版本首次升级需先停止 Hub、重启 MCP 并手动重载一次扩展。其他 MCP 仍连接时关闭它们后重试。正常页面控制要求同版本。

工具前缀由宿主决定，原始工具名不变（`browser_discover`、`browser_claim_tab` 等）。装配后的最小验证在各宿主一致：`browser_discover(kind="browsers")` → `kind="tabs"` → `browser_claim_tab` → `browser_snapshot` → `browser_tab_control(action="release")`。

## Nosis

`setup --nosis` 要求 `~/.nosis/agent_config.json` 已存在（Nosis 已初始化）。该命令在完成普通配对后备份并更新此文件（备份名 `agent_config.json.browser-attach-<时间戳>.bak`），写入：

| 字段 | 值 |
|---|---|
| 服务器名 | `browser_attach` |
| `command` | 执行 setup 的 Node 可执行文件绝对路径 |
| `args` | 当前包 `bin/browser-attach.mjs` 绝对路径、`mcp`、`--config <绝对配对路径>` |
| `env.BROWSER_ATTACH_HOME` | 配对文件所在目录 |
| `startup_timeout_seconds` / `call_timeout_seconds` | `20` / `60` |
| `tools.approval` | `always` |

同时设置 `mcp.enabled = true`。命令与配对路径都固定为绝对路径，因此本机安装位置变化后需要重新执行 `setup --nosis`；请从长期保留的位置安装，而不是临时解压目录。重启或重建 Nosis Runtime 后重新发现工具。

自定义运行目录：

```sh
browser-attach setup --config /absolute/shared-directory/config.json --nosis
```

`setup` 会把解析后的配对路径写进配置，MCP 与 Hub 后续都显式传递同一路径，不会在不同启动环境中重新推导出第二套密钥。`setup` 不会搜索或自动迁移其他应用的私有缓存；已有配对请显式保留原目录。

Windows 安装脚本可直接带该开关：`./scripts/install.ps1 -ConfigureNosis`。

验证：

```sh
python scripts/verify-nosis.py --nosis-root /path/to/Nosis --family chrome
python scripts/verify-nosis.py --nosis-root /path/to/Nosis --family edge
```

脚本读取本机 Nosis 配置，通过 Nosis ToolCatalog 发现 23 个工具，覆盖发现、标签控制、页面操作和结果封装，其中 `browser_logs` 分别覆盖 console/network，验证结果封装、截图到模型消息的图片适配以及 `isError` 后连接仍可用。它用 `browser_open_tab` 在选定配置中创建本地 fixture；同一 family 有多个 profile 时用 `--browser-id <精确 browser_id>` 指定，结束后释放控制。Python 仅用于该测试，不是运行依赖。

## DeepSeek Harness

DSH 通过 `@deepseek-ai/dsh-mcp-client` 条目接入 stdio MCP：一个服务器一个条目，工具暴露为 `mcp__<serverName>__<工具名>`。客户端插件随 harness 提供，不需要为 BrowserAttach 额外安装包。

把条目追加到 patch 层：

- 单个 profile：`$DSH_HOME/profiles/<name>/cordis.patch.yml`；`dsh web` 对应 `web`。
- 本机所有 profile：`$DSH_HOME/cordis.patch.yml`。
- 临时试用：任意 patch 文件，用 `dsh web --patch ./browser-attach.cordis.yml` 叠加。

`$DSH_HOME` 未设置时为 `~/.dsh`。patch 文件是 patch 列表，直接追加 `insert` 条目，不要覆盖其中已有的用户 patch。

```yaml
- insert:
    - id: browser-attach
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: browser_attach
        transport: stdio
        command: 'C:\Program Files\nodejs\node.exe'
        args:
          - 'C:\Users\<用户>\AppData\Roaming\npm\node_modules\@evan_zhong\browser-attach\bin\browser-attach.mjs'
          - mcp
          - --config
          - 'C:\Users\<用户>\.browser-attach\config.json'
        env:
          BROWSER_ATTACH_HOME: 'C:\Users\<用户>\.browser-attach'
        toolCallTimeoutMs: 60000
```

三个路径按本机实际值填写：

```sh
where node        # Windows；macOS / Linux 用 which node
npm root -g       # 全局安装目录；CLI 位于 <root>/@evan_zhong/browser-attach/bin/browser-attach.mjs
```

开发检出可直接指向 `<仓库>/bin/browser-attach.mjs`。macOS / Linux 把示例中的 Windows 路径换成对应的绝对路径，字段不变。

- 子进程启动前，DSH 会删除名字匹配 `KEY|PASSWORD|SECRET|TOKEN` 的环境变量以及全部 `DSH_*`，其余环境变量继承；显式写在 `env` 里的值保留。配对路径已由 `--config` 固定，不依赖工作目录。
- `toolCallTimeoutMs` 默认 `60000`，与 BrowserAttach 推荐的调用超时一致；单个调用确实更慢时再调大。
- `failOnStartupError` 默认 `false`：连接失败只记日志、工具不出现，harness 照常启动。排查连接问题时设为 `true` 可让启动失败直接暴露。
- 工具发现是异步的；启动后等 `mcp__browser_attach__browser_discover` 出现再发第一条指令。
- `web` profile 开启 HMR，修改条目会就地重连；`headless`、`sdk`、`acp` 关闭 HMR，需要重启 harness。
- MCP 工具与原生工具一样经过 DSH 的权限检查与审批策略。

安装新版后重启或重连 harness 即可，启动流程会协调升级；残留失败与手动重载见 [README：本机数据与升级](../README.md#本机数据与升级)。

## 新增宿主

追加小节时至少覆盖：配置位置与可粘贴片段、启动命令的三个绝对路径（Node、CLI、配对文件）、`BROWSER_ATTACH_HOME`、调用与启动超时、审批方式、工具前缀、验证步骤，以及升级后如何重新连接。配对与安全边界只在「通用装配」维护，不逐宿主重复。

## 故障排查

- 工具结果走 MCP 文本内容，截图走标准图片内容；能否进入模型取决于宿主的图片适配、大小预算与模型能力。
- 失效句柄不能跨连接复用，错误后应重新 discover + claim。
- 文件上传只在浏览器本机读取路径，内容不经过 Hub 或模型。
- 宿主把大结果保存为 Artifact 时，嵌套 JSON 长行可能被宿主的读取工具截断；这是宿主的分页行为，不能靠调大 Attach 的预算解决，也不等同于快照游标分页。
- `Connection closed` 时依次检查：宿主的 stderr、配对文件是否可见、`hub.log`、是否有其他 MCP 连接阻止升级，以及扩展清理或自动重载是否失败。扩展设置页可手动重新加载以恢复。
