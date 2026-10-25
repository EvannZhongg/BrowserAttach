# 验证报告

当前版本 **0.23.5**（2026-10-25）。浏览器验证使用本地 fixture 和临时 profile；测试链路在各项下说明。

## 当前版本

- read_text 的工具描述与使用指南明确：默认正文不包含 input/textarea 当前值；单字段使用 mode=value，整表使用 snapshot(profile=fields)。complete_source 表示来源覆盖，分页仍以 next_offset 为准。
- 上传完成后读回原 input 的 FileList 数量，files_set 不再直接回显请求数量；数量不符或节点脱离时报告 file_count_not_retained、已派发且结果未知。派发或读回异常均保留未知结果，不自动补发。非空路径返回 method=native、events_trusted=null；清空返回 method=dom、events_trusted=false；两者 application_result=not_checked，不声称事件送达、组件登记或上传完成。
- 命中元素及最近可点击祖先补充 id/classes；classes 至多 8 项，每项 100 字符，作为当前身份线索，沿用原有遮挡检查与派发边界。
- 文档整理：升级协调、日志上限与边界描述原先在 README、Agent 集成与架构文档中重复，现各自保留一处并按读者分层（用户步骤 / 宿主装配 / 协议实现）；中文 README 与英文对齐 file:// 范围与后台单击规则；使用指南中的字段、frame、日志与上传示例改用中性占位值，不再引用测试 fixture 的字段名与业务数据。
- `npm test`：284 项通过。新增上传后页面重置/节点脱离与读回异常不重放的回归，补充清空结果、未检查的应用状态和有界 class 诊断断言。
- Chromium 156、Edge 155 headless 完整 stdio MCP `live-smoke`：各 388 次调用、36 项检查通过。新增 FileList 读回及结果语义核验，真实 change 处理器立即清空文件时返回未知结果且仅触发 1 次 change；跨 frame 遮挡保留 class/祖先身份且未误点。保留隐藏 input、选择器、清空、多文件、OOPIF 上传及其他既有回归。
- `npm run test:package`：包外安装与 stdio MCP 通过，23 个工具、62 个发布文件，无配对密钥。未增加工具、参数、依赖或权限，版本递增至 0.23.5。
- 本机部署：通过 stop/start 重启，Hub 为 0.23.5 / ready，Chrome、Edge 扩展均为 0.23.5 / ready；稳定扩展副本的 43 个文件已核对，manifest 版本/身份一致，其余非生成文件 SHA-256 一致。现有客户端需重连并重新发现、接管。
- 剩余边界：FileList 核验仅为当时数量，不核验内容或服务器持久化；页面已经消费文件也可能导致未知结果。class 线索不保证唯一或跨重渲染稳定。本轮未操作真实业务表单。

## 0.23.4 验证

- 补充 npm 包的 `mcpName` 和根目录 `server.json`，包含 Registry 名称、展示名称、描述、源码/文档链接及 npm stdio 启动信息；元数据通过官方 2025-12-11 JSON Schema 校验。
- `npm test`：282 项通过。仅调整发布元数据、版本与打包检查，未修改页面操作实现，未重复运行真实浏览器 fixture 测试。
- `npm run test:package`：包外安装与 stdio MCP 通过，23 个工具、62 个发布文件，无配对密钥。`server.json` 已纳入发布包；打包检查覆盖 Registry 名称、npm 包名及版本一致性。
- 本机部署：协调升级因现有 MCP 连接占用拒绝后，通过 stop/start 重启；Hub 为 0.23.4 / ready，Chrome、Edge 扩展均为 0.23.4。稳定扩展副本的 43 个文件已核对：manifest 版本/身份一致，其余非生成文件 SHA-256 一致。现有客户端需重连并重新发现、接管。
- 已发布 npm `@evan_zhong/browser-attach@0.23.4`（registry latest，含 `mcpName`），并以 GitHub 账号登录 `mcp-publisher` 发布 Registry 元数据：`io.github.EvannZhongg/browser-attach` 0.23.4 状态 active、`isLatest=true`，可通过 `GET /v0.1/servers?search=io.github.EvannZhongg/browser-attach` 检索。

## 0.23.3 验证

- `npm test`：282 项通过。DOM contenteditable 与 native 共用同位置普通空格 → NBSP 的单向容差；补充首尾/连续空格、混合空格、显式 NBSP 保留与丢失、空格数量及位置变化的回归。input/textarea 的精确 value 比较保持原状。
- Chromium 156、Edge 155 headless 完整 stdio MCP `live-smoke`：各 385 次调用、35 项检查通过。页面同步将普通空格改成 NBSP 时 DOM fill 成功；CSS 折叠空格或页面丢失显式 NBSP 时仍返回 value_not_retained、未知结果，每次仅派发 1 次 input，不重放。
- `npm run test:package`：包外安装与 stdio MCP 通过，23 个工具、61 个发布文件，无配对密钥。未增加工具、参数、依赖或权限，按比较修复递增至 0.23.3。
- 本机部署：协调升级完成，Hub 为 0.23.3 / ready，Chrome、Edge 扩展均为 0.23.3；稳定扩展副本的 43 个文件已核对，manifest 版本/身份一致，其余非生成文件 SHA-256 一致。
- 本次未增加选区事件或竞态处理机制。原有 selectionchange、非原子检查及业务保存边界保留；重启后的客户端需重连并重新发现、接管。

## 0.23.2 验证

- `npm test`：275 项通过。覆盖浏览器所选纯文本的换行编码、NBSP 和实际文本差异；核验恢复选区端点及方向，DOM 不操作选区；替换选区丢失不发送 insertText。type 参数错误区分非字符串、长度和控制字符。
- Chromium 156、Edge 155 headless 完整 stdio MCP `live-smoke`：各 364 次调用、34 项检查通过。新增 Gmail 同形 DOM 的空行、连续空行、首尾换行、空文本，以及含旧段落内容的连续原生替换；原生 input 可信，核验后光标仍折叠。DOM 写入可见 br 换行并保持已有焦点；真实空行数量不匹配仍返回未知结果、不重放。
- Trusted Types 专用页面确认 innerHTML 字符串赋值抛出 TypeError；native/DOM 均能在该页完成含空行文本及单行替换。页面在 focus 后主动折叠替换选区时，返回 fill_selection_lost，正文不变且 input 事件为 0。type 的换行错误经真实 MCP 提示 press_key/Enter。
- `npm run test:package`：包外安装与 stdio MCP 通过，23 个工具、61 个发布文件，无配对密钥。未增加工具、参数、依赖或权限，按输入及核验修复递增至 0.23.2。
- 本机部署：协调升级因现有 MCP 连接占用拒绝后，按 stop/start 重启；Hub 为 0.23.2 / ready，Chrome、Edge 扩展均为 0.23.2。稳定扩展副本逐文件核对，manifest 保留机器 CSP，其余非生成文件 SHA-256 一致。
- 当前边界：native 核验暂时选择文本，可能触发 selectionchange；选区检查与 insertText 不具备原子性，不能消除所有页面竞态。未操作真实 Gmail 草稿，不证明自动保存或发送正确。read_text 的 visible/value 保持 innerText；type 仍只接受可打印字符，换行显式 press_key Enter；hash 路由变化仍按现有规则使 ref 失效。重启后的客户端需重连并重新发现、接管。

## 0.23.1 验证

- `npm test`：273 项通过。新增 contenteditable 按输入模式核验的 19 个子用例，覆盖 native 渲染换行、CRLF/CR、普通空格以 NBSP 保留、显式 NBSP、空文本和 Unicode；DOM 精确文本；拒绝另一种文本表示掩盖的段落、字符、空格与空行变化，失败保持未知结果且不补发。
- Chromium 156、Edge 155 headless 完整 stdio MCP `live-smoke`：各 302 次调用、32 项检查通过。真实原生输入验证首尾 NBSP、CRLF/CR 与中文多行；DOM 精确文本和同步格式化造成的跨表示不匹配经过扩展 → Hub → MCP 返回 `value_not_retained`。两种模式的受控不匹配均只产生 1 次 input，不切换模式或重放；多行原生插入本身可产生多个 input 事件。
- `npm run test:package`：包外安装与 stdio MCP 通过，23 个工具、61 个发布文件，无配对密钥。未增加工具、参数、依赖或扩展权限，版本按校验修复递增至 0.23.1。
- 本机部署：协调升级因已有 MCP 连接拒绝后，按 stop/start 重启；Hub 为 0.23.1 / ready，Chrome、Edge 扩展均为 0.23.1。稳定扩展目录 `F:\.nosis\browser-attach\extension` 的 43 个文件已核对：manifest 版本/身份一致，其余非生成源码/资源 SHA-256 一致。
- 当前边界：native contenteditable 不裁剪空白、不合并空行，富文本占位换行或异步重建仍可能返回结果未知；不增加编辑器适配、自动重试或保存核验。未在真实 Gmail 草稿上验证；本机已有 MCP 客户端需重连并重新发现、接管。

## 0.23.0 验证

- `npm test`：253 项通过。新增结构化字段保留重复标签、真实 HTML label 来源与附近 context、DOM/AX 值区分、原生多选与 mixed 状态、隐藏字段显式读取、密码值省略、节点身份缺失不按名称合并、完整行双预算分页、session 级 DOM 捕获复用与文件选择只读采集。覆盖输入后 cursor 失效且 ref 保留、新观察替换旧 ref、子 frame 变化只移除子树、文档捕获中导航不恢复旧引用。
- Chromium 156、Edge 155 headless 完整 stdio MCP `live-smoke`：各 281 次调用、31 项检查通过。真实 DOMSnapshot 与 AX 关联验证重复 HTML 标签、TEXTS28 字段名查询、格式化/只读值、多选原始值/标签、checkbox mixed、隐藏输入、密码省略、闭合 Shadow DOM、同源 iframe、OOPIF、文件选择数量/中文文件名、分页与字段 ref 操作；单纯观察不派发 input。保留输入、截图、上传、对话框、日志与 12000 节点 AX 分页回归。
- `npm run test:package`：包外安装与 stdio MCP 通过，23 个工具、61 个发布文件，无配对密钥；新增 fields 模块纳入包边界检查。没有新工具、依赖或扩展权限，观察能力扩展升至 0.23.0。
- 本机部署：协调升级因已有 MCP 连接拒绝后，按 stop/start 重启；Hub 为 0.23.0 / ready，Chrome、Edge 扩展均为 0.23.0。稳定扩展目录 `F:\.nosis\browser-attach\extension` 的 43 个文件已核对：manifest 版本一致，其余非生成源码/资源 SHA-256 一致。
- 当前边界：跨 frame、AX/DOM/FileList 分步采集不具备事务或并发写入归属；自定义组件内部模型、最终提交值和服务端附件状态仍需任务相关检查。隐藏原生字段可能无 AX/ref，未关联 DOM 身份的 AX 行省略值；缺失或失败的 frame 保留 omitted_frames。已有 MCP 客户端需重连刷新字段视图参数并重新发现/接管。

## 0.22.1 验证

- `npm test`：246 项通过。新增隔离世界选择器诊断经 CDP 异常对象读取、单步/read_text/wait/batch 传递及 frame 路径底层原因保留；诊断读取失败保留原异常并清理 wrapper。补充准备/派发超时分类、派发后不沿用准备诊断、fill 值不匹配保留未知结果且不回显字段值。后续新增的 click 目标变化原因断言另通过 15 项指针回归。
- Chromium 156、Edge 155 headless 完整 stdio MCP `live-smoke`：各 267 次工具调用、29 项检查通过。新增真实 CSS/XPath 语法错误、CSS/AX role 歧义、缺失 selector、read_text/wait/batch 错误原因经过扩展 → Hub → MCP 的检查；原生 fill 同步格式化返回 value_not_retained、input_dispatched=true 及 post_action，真实 input 事件仅 1 次。保留上传、对话框、OOPIF、日志、后台输入与大 AX 树回归。
- Edge 首次与 Chromium 并行执行时，原有遮挡检查在 500 ms 准备预算内超时，未派发输入；未修改该检查预算，独立复跑完整脚本通过。
- `npm run test:package`：包外安装与 stdio MCP 通过，23 个工具、60 个发布文件，无配对密钥。未增加工具、参数、依赖或扩展权限，版本按诊断修复递增至 0.22.1。
- 本机部署：协调升级因现有 MCP 连接拒绝后，使用项目 stop/start 重启；Hub 为 0.22.1 / ready，已配对 Chrome、Edge 均为 0.22.1。稳定扩展目录 `F:\.nosis\browser-attach\extension` 的 42 个文件已核对：manifest 版本一致，其余非生成文件 SHA-256 一致。
- 当前边界：原因码不推断业务成功或服务端拒绝，也不授权重放；文档/上下文销毁导致异常诊断无法读取时保留原错误，diagnostics 可能缺失。已有 MCP 客户端需重连，重新发现和接管标签。

## 0.22.0 验证

- `npm test`：243 项通过。新增非活动标签的单次左键单击（ref / selector / viewport / document 坐标）仍取得可信回执且不激活标签；hover、拖拽、其他按键、双击与带修饰键的点击仍在派发前以 `TAB_NOT_READY` 拒绝；派发前的就绪检查允许左键单击期间的标签切换，仍拒绝视图冻结或目标丢弃，`page_state` 带 `tab_active`。
- Chromium 156、Edge 155 headless：`interaction-smoke --regressions` 各 35 个场景通过。后台 ref / selector / viewport / document / offset 各 3 次（每浏览器 15 次，合计 30 次）均 `delivery_verified` 且标签激活与窗口焦点状态不变；连续两次后台 batch、后台回执丢失（1 次效果、不重放）、后台遮挡（未派发）、受限动作组、settle 期间切换标签等场景通过。
- Chromium 156 `interaction-smoke` 默认场景 17 项通过，覆盖前台、后台 ref 与坐标、遮挡窗口、缩放、hover 偏移、闭合 Shadow DOM 与导航。
- Chromium 156、Edge 155 完整 stdio MCP `live-smoke`：各 255 次工具调用、27 项检查通过；后台 ref / selector / 坐标点击均在 `tab_active=false` 下取得可信送达，显式激活、DOM 模式与命中提示的既有行为保持。
- `npm run test:package`：仓库外安装与 stdio MCP 通过，23 个工具、60 个发布文件，无配对密钥；未增加工具、参数、依赖或扩展权限。次版本反映点击就绪语义的变化。
- 本机部署：Hub 从工作区重启为 0.22.0 / ready；已配对 Chrome、Edge 均上报 0.22.0；稳定扩展目录 `F:\.nosis\browser-attach\extension` 的 42 个文件逐一核对与工作区一致。
- 真实既有 profile 探测：从未激活的后台页面上，Edge 取得可信回执并产生 1 次点击；Chrome 未取得回执，返回结果未知、`input_dispatched=true` 且未重放（0 次效果）。验证日志为本地忽略目录 `test-results/` 中的 `*-0220*` 文件。
- 当前边界：非活动标签只允许单次左键单击，送达仍以可信回执为准；无回执时报告结果未知，不自动激活、不重放、不切换 DOM 模式。hover、拖拽与其他点击变体继续要求活动标签。

## 0.21.1 验证

- `npm test`：240 项通过。原 controller 测试按观察、指针、键盘输入、对话框、截图/上传、滚动、求值和 fetch 分组，共用原有 fixture；保留控制权、队列、权限和清理的集成测试。新增不依赖日志的网络状态、错误文案无关的结构化未知结果、观察启动前失败仍恢复对话框策略，以及 select 异常跨 CDP 边界后保留结果未知证据的回归。
- Chromium 156、Edge 155 完整 stdio MCP 集成：各 254 次工具调用通过，覆盖快照/ref、输入、上传、截图、导航、对话框、fetch、日志、嵌套 OOPIF 和 12000 个语义节点分页；Edge `interaction-smoke --primitives --headless` 22 个场景通过。
- Chromium 文件页面集成：50 次工具调用、5 组检查通过，覆盖实时文件权限、中文/空格/# 路径、主文档与 iframe 观察、原生输入、HTTP↔file 导航和控制权清理。
- Chromium 真实升级验证通过：同一临时 profile 内两个并发启动者完成 Hub 与扩展升级至 0.21.1，确认自动 runtime 重载及升级后页面操作。旧协议版本由当前代码修改版本号构造，不代表真实 0.16 扩展具备自动升级能力。
- `npm run test:package`：仓库外安装和 stdio MCP 通过，60 个发布文件、23 个工具，无配对密钥。未增加工具、参数、依赖或扩展权限；补丁版本用于内部职责重构与清理修复。
- 本机部署：Hub 已停止并从工作区重启，健康接口为 0.21.1 / ready；已配对 Chrome、Edge 均自动重载并实际重连为 0.21.1。稳定扩展目录 `F:\.nosis\browser-attach\extension` 的 42 个非生成文件已核对：manifest 按 JSON 内容一致，其余文件字节一致。新 stdio 连接返回 0.21.1 和 23 个工具。
- 验证日志与本机同步校验在本地忽略目录 `test-results/refactor-0.21.1/`；已有 MCP 客户端需重新连接以载入新版进程。

## 0.21.0 验证

- `npm test`：236 项通过。新增可操作性原因、有限祖先样式/滚动/transition 证据、零透明度放行、slot 继承 inert、无可见落点且保留既有派发事实、ref 历史上限及释放清理、身份解析期间文档变化、动作后观察不可用/未见变化/正面证据分型，以及明确状态等待的参数、严格匹配、节点替换、缺失 ARIA 状态和字段值不回显验证。
- Chromium、Edge headless：`interaction-smoke --primitives` 各 22 个场景通过。新增扩展 → Hub 的真实 DOM 验证：一次 DOM 点击后在 batch 等待替换后的字段值、原生 checked/selected、AX role 定位的 aria-expanded/aria-selected、CSS/role 无匹配；原生 mixed、隐藏 DOM 不等于 CSS 无匹配、缺失状态不等于 false、等待超时后写次数仍为 1，以及旧 ref 的 snapshot_replaced 诊断。原有原生输入、hover、拖拽及滚动场景继续通过。
- `npm run test:package`：包外安装与 stdio MCP 通过，23 个工具、51 个发布文件，无配对密钥；未增加依赖或扩展权限。MCP 测试同时覆盖新 wait 条件在单步和 batch 中的 schema、布尔 false/mixed 传递与参数预检。
- 本机部署：Hub 已停止并从工作区重启，健康接口为 0.21.0 / ready；Chrome、Edge 均自动重载并上报 0.21.0。稳定扩展目录 `F:\.nosis\browser-attach\extension` 的 manifest 为 0.21.0，其余 33 个非生成源码/资源文件 SHA-256 与工作区一致。新 stdio 连接返回 0.21.0、23 个工具和新增 wait 条件；已有 MCP 客户端需重新连接以刷新 schema。
- 当前边界：状态等待只确认指定的页面状态，不推断业务成功；ARIA 缺失/无效时继续报告 unavailable。role 无匹配不证明 DOM 已移除；不可用 frame 不作为元素消失证据。ref 原因历史每标签限 1000 条；不自动重绑定、补发或切换输入模式。

## 0.20.0 验证

- `node --test tests/*.test.mjs`：226 项通过。新增 file:// 发现与接管的实时授权、普通操作与 batch 中途停权、HTTP→file 导航派发前检查、文件导航后的 ref/分页失效、停权后可靠释放及 detach 失败保留控制权、历史目标权限检查和迟到权限回执不派发导航。
- Chromium 156、Edge 155 headless：`node scripts/live-smoke.mjs --executable <浏览器路径> --files` 各通过 5 组集成检查。复用扩展 → Hub → stdio MCP 链路，验证中文/空格/# 文件路径、真实扩展设置中的文件权限开关、发现后独占接管且不激活、主文档与本地 iframe AX、PNG 截图、ref 原生 fill/type/按键/click 与 trusted 事件、DOM batch、文件 URL/前进/后退及 HTTP↔file 导航、旧 ref/cursor 失效、释放/连接断开/关闭后的控制权清理。测试脚本只在临时 profile 的扩展管理页切换权限；权限变更触发扩展重载后重新发现浏览器连接。
- Chromium 156 原有 HTTP(S) `live-smoke`：254 次工具调用通过，包含 fetch、正文查询与分页、输入、对话框、上传、OOPIF、日志及大 AX 树回归。
- `npm run test:package`：包外安装与 stdio MCP 通过，23 个工具、52 个发布文件，无配对密钥；未增加依赖或扩展权限。
- 本机部署：Hub 已停止并从工作区重启，健康接口为 0.20.0 / ready；Chrome、Edge 均自动重载并上报 0.20.0。稳定扩展目录 `F:\.nosis\browser-attach\extension` 的 manifest 为 0.20.0，其余 33 个非生成源码/资源文件 SHA-256 与工作区一致。已有 MCP 客户端需重新连接以刷新工具描述与连接句柄。
- 当前边界：open_tab / fetch 仍仅支持 HTTP(S)；浏览器内部页和任意扩展页仍拒绝接管。内置 PDF 正文 AX/截图兼容性未纳入本次验收。

## 0.19.0 验证

- `npm test`：219 项通过。覆盖 ShadowRoot 命中归一化、同进程子 frame 的局部命中坐标、slot/ShadowRoot 祖先关系、归一化后仍拒绝遮挡、frame 候选诊断及超时保留、select 的只读准备和继承 inert、文本等待缺 selector 提示，以及扩展 → Hub → 客户端 → stdio MCP 的结构化错误证据传递。保留原有输入、导航、所有权、清理和升级回归。
- Chromium 156、Edge 155 headless：`--issues` 各 10 个场景、`--primitives` 各 21 个场景、`--extended` 各 13 个场景通过。新增场景验证闭合 Shadow DOM 的真实 trusted 点击与 userActivation、实际 ShadowRoot 上的命中归一化、遮挡节点 rect/样式诊断、纯坐标验证范围、隐藏 select 的单步/batch 一致性和禁用/inert 拒绝、frame 定位候选、同进程与 OOPIF 的嵌套滚动/缩放/高度变化、元素截图、上传后 reload 及显式补填、求值超时后已观察到导航的 post_action。
- Chromium、Edge 完整 stdio MCP 集成：各 254 次调用通过，覆盖实际扩展与 Hub 链路、嵌套 OOPIF、输入、上传、导航、日志、截图和 12000 个语义节点分页。测试退出前经 CDP 正常关闭所创建的临时浏览器，避免 Windows Edge 重启实际主进程后仅结束 launcher 留下 profile 锁；Edge 完整重跑后正常退出。
- `npm run test:package`：仓库外安装与 stdio MCP 通过，23 个工具、51 个发布文件，不含配对密钥；无新增依赖和扩展权限。新增结构化结果及隐藏 select 能力，版本递增到 0.19.0。
- 本机部署：Hub 已从工作区重启，健康接口返回 0.19.0 / ready；原 Chrome、Edge 两个 profile 均已自动重载并上报 0.19.0。稳定扩展目录 `F:\.nosis\browser-attach\extension` 的 manifest 为 0.19.0，其余 32 个非生成源码/资源文件 SHA-256 与工作区一致。已有 MCP 客户端需重新连接以载入新版工具描述。
- 复现结论：带嵌套滚动、缩放和 iframe 高度变化的同进程/OOPIF 点击及后续坐标点击均送达目标，未复现所述约 88px 偏差；不能据此排除原站其他布局组合。上传触发 reload 后清空已填字段已复现，显式等待、观察后再 batch 补填成功，上传事件仅一次。顶层视口外元素截图保留真实内容且不改变滚动；overflow 祖先裁剪下的目标截图为空白，已人工查看 PNG，文档明确保留此裁剪语义。
- 当前范围：未在原 iCIMS 页面或真实验证码上复测；不新增 diagnose、跨导航字段重放引擎或截图默认自动滚动。诊断只报告当前可观测事实，不解释任意应用业务禁用原因，不把字段保留、可信事件或用户激活视为业务成功。

## 0.18.0 验证

- `npm test`：213 项通过。新增真实 HTML label/placeholder 匹配、AX role/name 唯一性与树顺序、每次重新解析、focused 参数互斥、失焦停止、batch 预校验、快照 context 查询与 ref 身份、嵌套求值预算首屏提示回归。最后的定位错误文案调整另通过 12 项定位/原语定向测试。
- Chromium 156、Edge 155 headless：输入集成各 21 个场景、扩展集成各 13 个场景通过。覆盖关联标签填写、placeholder 和 AX role 字段读取、坐标聚焦后输入、延迟打开的自定义 option、闭合 Shadow DOM role 点击、开放 Shadow DOM 焦点输入、同进程及跨进程 iframe 的 role/focused 输入、字段切换焦点后停止，以及缓存续读不重放表达式。测试通过扩展和 Hub 操作页面；CDP 仅用于临时 fixture 设置/断言及关闭测试浏览器。
- `npm run test:package`：包外安装与 stdio MCP 通过，23 个工具、50 个发布文件，不含配对密钥；工具能力扩展，未新增工具、依赖或扩展权限。
- 本机部署：Hub 已从工作区重启，健康接口返回 0.18.0 / ready；Chrome、Edge 均已自动重载并上报 0.18.0。稳定扩展目录 `F:\.nosis\browser-attach\extension` 的 manifest 为 0.18.0，其余 31 个非生成源码/资源文件 SHA-256 与工作区一致。原有 MCP 客户端需要重新连接以刷新 schema。
- 当前边界：label 仅使用真实 HTML 关联，不推断兄弟 div；context 是有界观察提示，不改写 AX name。role 每次采集所选 frame 的完整 AX 树。evaluate 仍按完整嵌套项分页，10 秒默认、最多 30 秒，未加入任意脚本检查点或截图布局 token。
- 额外测试观察：接管后动态插入再移除跨源 iframe 的组合场景中，后续 network_idle 曾以 inflight=1 超时，原因未在本次定位改动中解决；跨进程输入另在接管前已加载 iframe 的 fixture 中验证通过。本次不包含网络跟踪修复。

## 0.17.2 验证

- `npm test`：207 项通过。新增滚动最深匹配、隐藏中间节点、多个分支歧义和候选上限回归；10000 个匹配只做 9999 次包含关系检查，每个文字命中候选只读一次几何信息。保留渲染文本的 expected/previous 比较与预览截取、1.5 万层深树的 full/interactive 遍历和正文合并、15 万节点观察的分页回归。用修改前的实现分别复现深树递归和宽树数组参数展开的 `Maximum call stack size exceeded`。
- 同版本滚动优化：Chromium 156 与 Edge 155 headless 输入集成各 20 个场景通过，包含真实 DOM 的隐藏中间节点、最深匹配 ref、兄弟分支歧义、selector 消歧及原有延迟加载滚动。保留 10000 候选上限、文字与可见性条件；筛选只比较文档顺序中的相邻匹配，不再两两比较，不代表选择器、子树文字和布局读取的总成本也是线性的。
- Chromium 156 与 Edge 155 headless 完整 stdio MCP 集成：各 254 次调用通过。真实 DOM 验证 script/style/隐藏子节点字面量不会提前满足 text wait，expected 与 previous 均等待渲染文字变化；1.2 万个显式语义节点在 max_nodes=1 下完成采集和续页，分别约 15.3 秒、16.6 秒。
- 剩余限制：Chromium 上 12 万个显式 group 节点的真实快照调用仍触及 MCP 60 秒请求超时。迭代渲染和逐项合并只消除栈及函数参数数量上限，不减少完整 AX 采集成本；max_nodes 仅控制分页，不代表超大页面能在现有预算内完成。
- `npm run test:package`：仓库外安装运行通过，23 个工具、50 个发布文件，不含配对密钥；无新增工具、运行依赖或扩展权限。
- 本机部署：Hub 从工作区重启，健康接口返回 0.17.2 / ready；`F:\.nosis\browser-attach\extension` 的 manifest 为 0.17.2，其余 31 个非生成源码/资源文件与工作区逐字节一致。滚动优化按要求保持版本号，现有自动重载协议只处理版本递增，已打开的浏览器需手动重新加载扩展才能应用本次优化；已有 MCP 连接需重新连接。

## 0.17.1 验证

- `npm test`：200 项通过。新增并发升级与冷启动、旧配对缺少 `extension_dir` 的兼容回落、`release_all` 部分失败时的错误回传与剩余控制权保留、弹窗释放失败提示和显式重试，以及原有升级、清理和连接回归。
- Chromium 156 与 Edge 155：`npm run test:upgrade -- --executable <路径>` 均通过。临时 profile 开启开发者模式后，两个并发启动者将 Hub 和真实扩展从当前代码改版本号构造的兼容旧协议 0.16.9 升到 0.17.1；确认同一 profile、实际 runtime 重载后的版本，以及升级后发现/接管 → AX 查询 → DOM 点击 → 查询结果 → 释放。CDP 只用于临时 profile 的开发者模式设置，页面操作走扩展与 Hub。该脚本验证升级协议本身，不代表真实 0.16 扩展能自行重载；真实旧版本首次升级仍需手动重载。
- `npm run test:package`：仓库外安装运行通过，23 个工具、50 个发布文件；由已安装包中的 Hub 同步稳定扩展目录并运行 stdio MCP，不含配对密钥，无新增运行依赖或扩展权限。
- 本机部署：Hub 已从工作区重启并返回 0.17.1 / ready；`F:\.nosis\browser-attach\extension` 已同步，manifest 为 0.17.1。Chrome、Edge 均上报 0.17.1 并已重连。

## 0.16.0 验证

- `npm test`：184 项通过。新增 offset 的变换/越界处理、延迟区间校验、默认路径不采样随机数、拖拽曲线与精确终点、batch 参数预检、真实 stdio MCP 参数转发，以及 settle/拖拽超时后停止和调试分离取消待点击的回归。
- Chromium 156 与 Edge 155 headless 输入集成：各 19 个场景通过（扩展 → 独立 Hub 客户端）。新增非中心可信点击、offset hover、settle、区间逐字输入、曲线 pointer 与 HTML5 拖拽；实际记录移动坐标、可信事件和按键时间，保留原有默认路径及跨屏拖拽验证。不据此声称能通过任意网站的行为验证。
- Chromium 156 完整 stdio MCP 集成：244 次调用通过，保留发现/接管、输入、导航、OOPIF、日志、分页及临时页清理覆盖。
- `npm run test:package`：仓库外安装运行通过，23 个工具、48 个发布文件，版本 0.16.0；无新增依赖或扩展权限，不包含本机配对密钥。
- 本机部署：Hub 已从工作区重启，健康接口返回 0.16.0；扩展同步至 `F:\.nosis\browser-attach\extension`，29 个源码/资源文件哈希一致，manifest 版本为 0.16.0。Chrome 与 Edge 均已重新连接并上报 0.16.0；MCP 客户端需刷新连接以获取新 schema。

## 0.15.1 验证

- `npm test`：176 项通过。新增 AX 字面查询（名称/合并正文/value、预览前匹配、interactive 视图、零命中）、查询分页与新旧 ref 生命周期、默认精简/verbose 元数据、当前/祖先 frame 的遮挡诊断、诊断节点失效保留主错误，以及 drag 已派发预算不能误报“未派发”的回归。
- Chromium 156 与 Edge 155 headless 完整 stdio MCP 集成：各 244 次调用通过。新增真实 AX 查询返回的 ref 可用于原生 hover、查询分页和 verbose 续页、零命中及 ancestor frame 的实际遮挡文字；保留输入、导航、OOPIF、日志、分页和临时页关闭链路。
- 同一构造表单 AX（2 个字段、2 个按钮，固定 URL/ref 前缀）比较 JSON 字符数：0.15.0 默认 908，0.15.1 默认 443（减少 51.2%），query=save 为 332。这里只衡量固定 fixture 的序列化输出，不代表题述表单、token 数或 AX 采集耗时。
- 实际 MCP tools/list：仍为 23 个工具；紧凑 JSON 从 36703 增至 37116 UTF-8 字节（新增 query/verbose 参数及说明，约 +1.1%），格式化 JSON 从 75945 增至 76502 字节。未声称 schema 总量下降；不新增工具分组、依赖或扩展权限。
- `npm run test:package`：仓库外安装运行通过，23 个工具、47 个发布文件，版本为 0.15.1；发布包不含本机配对密钥。
- 本机部署：已把扩展同步至 `F:\.nosis\browser-attach\extension`，关键模块与源码一致，Hub 健康接口返回 0.15.1。临时 Chromium 加载该实际副本连接共享 Hub，AX 查询 → 原生点击 → 查询确认页面变化通过。验证结束时用户原有浏览器尚未重新连接；仍需在 Chrome/Edge 重新加载扩展，并刷新 MCP 连接以获取新 schema。

## 0.15.0 验证

- `npm test`：172 项通过。新增 commit / DOMContentLoaded、等待超时后的降级采集、主文档替换后跟随 loader、采集期间只读重试、等待完成后换文档的身份核对、HTTP 错误响应关联及空体判断，以及标签创建/关闭超时和迟到清理；保留断连、控制权变化与不重放导航的回归覆盖。
- Chromium 156 与 Edge 155 headless 完整 stdio MCP 集成：各 238 次调用通过。新增阻塞 load 时的早期等待及超时降级、load 前 location.replace、SSE 阻塞 network_idle，以及空体 418/500/503 的状态码和正文来源；同时验证既有输入、导航、OOPIF、分页与临时页关闭链路。
- Chromium 临时配置访问真实 URL：`https://httpbin.org/status/500` 与 `/status/503` 分别在约 689 ms、384 ms 返回对应状态、`ok=false`、空正文及 `http_error_response` 标记。`https://chatgpt.com/` 在约 2253 ms 返回 403 验证页的文档结果，未复现客户端跳转，不将该结果视为登录应用验收。
- `npm run test:package`：仓库外安装运行通过，23 个工具、46 个发布文件，版本为 0.15.0；无新增扩展权限与依赖。

## 0.14.0 验证

- `npm test`：165 项通过。新增主文档 frame/loader 状态匹配、未知状态、日志淘汰后状态保留、HTTP 错误正文、渲染后 DOM 标记、空标题省略、JSON 整份返回、四份缓存交叉续读与 LRU 淘汰；读完/失败的请求不淘汰已有缓存，同 URL 独立采集，保留断连及迟到回执不续跑的回归覆盖。
- Chromium 156 与 Edge 155 headless 完整 stdio MCP 集成：各 230 次调用通过。实际验证重定向后的 HTTP 200、404/500 保留正文并返回 ok=false、200 登录墙不误判成 HTTP 错误、子框架 404 不污染主文档状态、动态 DOM 插入与 dom=rendered、900000 字符 JSON 在 max_chars=400 下整份返回、超限 JSON 报错、四份缓存交叉续读与第 5 份 LRU 淘汰，以及临时页关闭和不激活。
- `npm run test:package`：仓库外安装运行通过，23 个工具、46 个发布文件，版本为 0.14.0；无新增扩展权限与依赖。

## 0.13.1 验证

- 描述精简：实际 MCP 初始化与 tools/list 的描述文本从 18716 降至 11469 字符，减少 38.7%（不含 schema 结构，不等于 token 数）；instructions / 工具描述 / 参数说明分别为 1893 / 3949 / 5627 字符。跨工具规则、工具语义、参数选择规则与文档实现细节各自归位。
- 对比精简前后的实际 MCP 输出：23 个工具的名称与输入 schema 在移除 description 后完全一致；类型、枚举、默认值、范围与 required 均未改变。
- `npm test`：159 项通过；`npm run test:package`：仓库外安装运行通过，23 个工具、46 个发布文件，版本为 0.13.1。本次只调整描述与版本，未修改浏览器操作实现，未重复运行真实浏览器用例。

## 0.13.0 验证

- `npm test`：159 项通过。新增单页 fetch 参数、三种格式、采集上限、缓存分页、owner 隔离、断连清理、初始化与导航超时、文档/控制权变化、关闭失败保留所有权和迟到回执不续跑；保留原有 149 项回归覆盖。
- `npm run test:package`：仓库外含空格路径安装运行通过，23 个 MCP 工具、46 个发布文件；包含 `fetch.js`，不包含配对密钥，版本为 0.13.0。
- Chromium 156 与 Edge 155 headless 完整 stdio MCP 集成：各 219 个调用通过。新增后台临时页不激活、单次导航、重定向与 HttpOnly 登录 Cookie、网络空闲等待延迟内容、无链接爬取、text/HTML/JSON、不可变分页、1000000 字符采集上限、非法 JSON 和导航超时后关闭；同时覆盖原有输入、OOPIF、上传、日志、截图与导航链路。

## 0.12.0 验证

- `npm test`：149 项通过。覆盖 interactive 快照的控件/祖先筛选、文本预览与原始 ref 身份、视图绑定分页、独占控制、快照/ref 生命周期、严格 selector 与有界歧义候选、原生/DOM 输入、逐字输入、hover、pointer/HTML5 拖拽、document 拖拽坐标差值与按轴滚动、滚动边界后的延迟加载、条件等待、HTML select、batch、历史导航、OOPIF、日志、上传、截图、对话框和未知结果不重放。
- `npm run test:package`：仓库外含空格路径安装运行通过，22 个 MCP 工具、45 个发布文件；包含 `drag.js` / `wait.js` / `scroll.js` / `outcomes.js`，不包含配对密钥。版本为 0.12.0，示例配置使用 `@latest`。
- Chromium headless `--primitives`：16 个场景通过，包含 interactive 快照、document 坐标纵向 pointer/HTML5 拖拽、普通 pointer/HTML5 拖拽、取消 pointerdown 默认行为后的可信回执、滚动边界后延迟增长和歧义候选。含 200 段正文的 fixture 中，默认 full 首屏 23302 字符且仍需续页，interactive 为 947 字符且无需续页；该比较只衡量返回内容，不代表 AX 采集提速。

## 升级前的浏览器验证

- Edge 155 headless `--primitives`：10 个场景通过，包含 hover 停留后点击子项、一次快照的 ref 连续输入并跨只读 evaluate 保持有效、替换节点拒绝、label/value/index 下拉选择、三种等待失败、pointer/HTML5 拖拽和目的元素滚入视口。
- Edge 155 完整 stdio MCP 集成：192 个调用通过，包含嵌套 OOPIF、原生/DOM 输入、遮挡、上传、日志、按键、滚动与导航；扩展报告 `extension_version=0.10.0`。
- Chromium 156、Edge 155 headless `--extended`：各 12 个场景通过，包含 ref 生命周期、选择框、拖拽、等待、历史导航和 OOPIF。
- `select_option` 明确返回 `events_trusted=false`；native select 点击在派发前拒绝。拖拽和输入只证明送达，不证明页面业务成功。

## 复跑

```sh
npm test
npm run test:package
node scripts/live-smoke.mjs --executable /path/to/browser --family edge
node scripts/interaction-smoke.mjs --primitives --headless --executable /path/to/browser --family edge
node scripts/interaction-smoke.mjs --extended --headless --executable /path/to/browser --family edge
```

真实浏览器测试需要允许命令行加载扩展的 Chromium / Edge 可执行文件，并只操作临时 profile 与本地 fixture。原始结果保存在被忽略的 `test-results/` 目录（`primitives-*.json`、`npm-live-*.json`、`extended-*.json`）。

## 已知限制

- 未覆盖独立 worker / service worker、WebSocket 消息、`window.showOpenFilePicker()`、目录上传、下载管理和网络拦截。
- 后台截图可能因浏览器暂停渲染而在 5 秒后超时；原生菜单和标签拖动可能抑制输入。
- readiness 是派发前的保守条件，不保证 compositor 或业务处理；输入真正派发后丢失可信回执仍报告 Outcome is unknown，不把“没观察到效果”当作零效果证明。
- 拖拽的自动滚动是目的元素驱动的滚入视口，不提供持续边缘滚动任务。
- `select_option` 不制造可信事件；`network_idle` 只覆盖 claim 后观察到的页面/iframe 请求。
- Monaco / CodeMirror 5 分支通过接口级测试，未针对第三方生产编辑器或特定 React/Vue 版本做站点验收。
- 计时数据仅代表本机 fixture，不构成对任意网站的耗时承诺。
- 未针对已登录 Gmail / Overleaf / ChatGPT 生产页面验收；这些页面可受登录状态、验证页、网络与应用初始化影响。降级保证以实际可读文档为准，不保证业务正文在期限内出现。

## 历史验证

- 0.8.0（2026-10-21）：`npm test` 118 项通过；20 个工具、40 个发布文件；Chromium 156 / Edge 155 各 191 次真实调用通过。
- 0.7.0（2026-10-21）：`npm test` 110 项通过；19 个工具、40 个发布文件；Chromium 156 / Edge 155 各 191 次真实调用通过。
