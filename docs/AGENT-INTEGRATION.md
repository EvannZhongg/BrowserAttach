# Agent 集成

BrowserAttach 提供标准 stdio MCP，共 23 个工具。配对、扩展加载、通用启动参数及 JSON/TOML 配置示例统一维护在随 npm 包分发的 [Setup reference](../skills/browser-attach/references/setup.md)。按宿主使用的格式或配置界面填写同一组连接参数即可接入。

可选的 [browser-attach skill](../skills/browser-attach/SKILL.md) 提供工具选择和任务流程；[Recovery reference](../skills/browser-attach/references/recovery.md) 说明错误分类、部分完成和重新接管。复制整个 skill 目录即可保留其参考文件及配置模板，npm 安装不会自动注册 skill。

适配宿主时复用通用连接参数，仅补充确有差异的配置要求；配对与恢复规则保留在对应参考文件中。
