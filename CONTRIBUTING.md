# Contributing to BrowserAttach

欢迎提交问题和 Pull Request。讨论较大功能前，请先说明使用场景与现有工具无法满足的需求。

## 开发与验证

使用 Node.js 22+，从仓库根目录执行：

```sh
npm ci
npm test
npm run test:package
npm pack --dry-run
```

浏览器交互改动还应按 [README](README.md#本地开发) 运行真实浏览器 fixture 测试。测试必须使用可丢弃的页面和配置，不应修改真实账号数据。

修改版本时同步 `package.json`、`package-lock.json`、`src/config.mjs`、`extension/manifest.json`、`server.json`、MCP 配置及安装示例。扩展和 Hub 必须保持版本一致。

`server.json` 用于发布 MCP 官方 Registry 元数据；其中 `name` 与 `package.json.mcpName` 必须完全一致，`packages[0].identifier` 与 npm 包名一致，包版本填写准确版本。先发布包含 `mcpName` 的 npm 包，再执行 `mcp-publisher login github` 和 `mcp-publisher publish`。`npm run test:package` 会检查名称、版本和发布文件的一致性。

## 提交内容

- 说明实际问题、修改后的行为和相关验证。
- 保留明确接管、独占控制、释放和结果未知时不重放的语义。
- 避免开发者本机绝对路径；资源相对模块定位，用户数据按平台目录或显式配置定位。
- 不提交生成的配对配置、令牌、Hub 日志、浏览器配置或截图中的个人信息。

报告问题时附最小复现、预期/实际结果及系统、Node、浏览器和扩展版本。提交贡献即表示同意按项目的 [MIT License](LICENSE) 提供贡献内容。
