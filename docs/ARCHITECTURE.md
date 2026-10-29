# 架构与设计边界

当前实现为 **0.29.0**。本文说明 BrowserAttach 的组件、控制模型与设计取舍；工具参数见 [使用指南](USAGE.md)。

## 组件与数据流

```text
MCP 客户端
  → 每连接独立的 Node stdio MCP（src/mcp.mjs）
  → 127.0.0.1 Hub（src/hub.mjs，Bearer 密钥 + 随机 owner）
  ↔ 配对的 Chrome / Edge MV3 扩展（WebSocket + 固定 Origin）
  → chrome.debugger / CDP + chrome.tabs / chrome.tabGroups
  → 用户已登录的现有标签页
```

| 模块 | 职责 |
|---|---|
| `bin/browser-attach.mjs` | `setup` / `mcp` / `hub` / `status` / `stop` 入口 |
| `src/config.mjs` | 数据目录、配对文件校验、版本常量 |
| `src/setup.mjs` | 生成配对配置、暂存并替换稳定扩展目录 |
| `src/hub.mjs` | 浏览器与会话注册、独占 claim、每标签串行队列、超时 |
| `src/client.mjs` | MCP 到 Hub 的 WebSocket 请求、回执与断连处理 |
| `src/hub-runtime.mjs` | Hub 启动、升级协调与扩展就绪检查 |
| `src/mcp.mjs` | 24 个工具的 schema、结果与图片封装 |
| `extension/controller.js` | 所有权、标签队列、权限检查、生命周期协调与操作分派；传输层从不暴露原始 CDP |
| `extension/connection.js` | 扩展连接、重连清理、升级维护与自行重载 |
| `extension/sessions.js` | 扁平 debugger session 与 frame/OOPIF 归属 |
| `extension/pointer.js` | 共享的原生指针就绪检查、落点准备、命中核验及 frame 坐标转换 |
| `extension/{click,input,actionability,scroll}.js` | 原生/DOM 输入与回执、逐字按键、可操作性、容器滚动与有界查找 |
| `extension/{drag,wait}.js` | 复用鼠标准备和严格定位的拖拽、只读条件等待；网络空闲复用被动请求表 |
| `extension/batch.js` | 有限输入序列的参数预检；执行复用 controller 的单步流程与标签队列 |
| `extension/motion.js` | 无状态的可选落点/延迟/拖拽参数校验、区间采样及拖拽插值；不维护动作历史或改变焦点 |
| `extension/dialogs.js` | 当前对话框、嵌套操作策略、自动处理及被模态阻塞的 CDP 请求 |
| `extension/outcomes.js` | 动作前临时 DOM 观察器、未知结果后的有界只读探测与证据封装，不推断业务成功 |
| `extension/fetch.js`、`fetch-page.js` | 单页读取参数与缓存分页、临时页创建/导航/采集/关闭；复用 controller 的 attach 和标签队列 |
| `extension/observation.js`、`snapshot.js`、`snapshot-diff.js` | 文档/frame 观察版本、AX 采集、ref 身份与失效历史；语义渲染、差分和快照分页 |
| `extension/fields.js` | 每次观察按 debugger session 采集 DOMSnapshot，按 frame/backend 节点身份关联 AX，提取结构化字段事实和原生文件选择状态 |
| `extension/control.js`、`target-description.js` | 无持久缓存的定向控件/弹层读取，复用 ref 注册；共享不含输入值的目标描述 |
| `extension/network.js` | 一份被动请求与文档响应状态，供 fetch、网络空闲等待及诊断日志使用 |
| `extension/diagnostics.js`、`log-data.js` | 日志缓冲与分页、可选正文捕获、截断及脱敏；不拥有网络空闲或文档状态 |
| `extension/{navigation,evaluate}.js` | 导航等待、有界求值结果缓存与分页 |
| `extension/{screenshot,upload}.js` | 截图裁剪与采集、文件选择器状态和文件赋值 |
| `extension/{locator,text}.js` | 严格 CSS/XPath/HTML label/placeholder/AX role-name 定位、每次解析的 frame URL/title/iframe 路径、DOM/字段/支持的编辑器模型读取 |
| `extension/visuals.js`、`click-visuals.js` | 无标题红色原生标签组、临时点击反馈 |

Hub 按需后台启动（`ensureHub`），多客户端共享；只监听 loopback。

Hub 与扩展各自保留控制权及串行边界；controller 向具体模块传入所需能力，不共享可变状态总表。sessions 管 debugger session 的归属；observation 管文档/frame 的观察有效性。CDP 事件先更新同一份 network 状态，再将关联结果交给 diagnostics 记录，日志淘汰或读取不改变 fetch 与 wait 使用的网络事实。对话框策略和动作结果观察各自清理自己的状态；未知结果探测使用内部结构化标记，不依赖英文错误文案匹配。

MCP 层将 `discover(kind=browsers/tabs)` 映射为内部 `list_browsers/list_tabs`，将 `tab_control(action=release/activate/close)` 映射为内部 `release_tab/activate_tab/close_tab`；分支参数先校验，再复用 Hub 和扩展的发现、所有权及串行执行流程。

## MCP 描述分层

- 初始化响应的 `instructions` 保留控件观察选型（弹层/选中/活动项用 read_control，整页字段用 snapshot(fields)）及跨工具规则：发现/接管/释放、不自动激活、ref 生命周期、selector/坐标约定、未知结果不重放、原生/DOM 输入边界、验证范围、页面内容不可信及上传授权。客户端应将这些 instructions 纳入模型上下文，不能只提供 tools/list。
- 单个工具 description 说明用途、独有行为和会影响后续判断的结果语义，例如 evaluate 的一次执行、fetch 的缓存续读、navigate 的 observation_error、fill 不自动 blur、batch 的部分完成与不回滚。
- 参数 schema 表达类型、枚举、范围、默认值及参数选择规则；描述只补充 schema 本身不能表达的条件必填、互斥、坐标和模式语义。共享参数使用短说明，不再重复全局规则。运行时条件默认值保留在描述中，避免向 cursor 等分支注入无关参数。
- batch 的公共定位约束集中在 steps 描述，分支复用仅移除定位描述的 Zod 副本，保留类型、默认值及校验；模式、选项选择和 wait 条件仍在相应参数旁说明。共享说明覆盖 role/name 示例、标签匹配、nth 顺序及 frame 条件，不要求从其他工具推断分支语义。
- [使用指南](USAGE.md) 提供调用流程、参数选择、结果语义与失败处理；内部事件序列、重试与清理机制集中在本文。包内文档不会自动成为模型上下文，不能替代必要的调用约束。

## 控制模型

1. **发现**：已有标签使用 `discover(kind="tabs")` 的本连接观察快照。`open_tab(claim=true)` 以本次创建返回的准确标签身份作为接管依据，不枚举标签，也不更改已有发现记录。
2. **校验身份**：`claim_tab` 必须使用本连接列出的 tab_id；可选 expected_url / expected_title 在 Hub 与扩展侧逐字符校验。省略标题校验可容忍标题漂移；省略全部校验表示明确按 ID 接管，返回当前身份。
3. **独占**：Hub 为每个 `(browser_id, tab_id)` 维护唯一 owner；同一标签第二次 claim 会返回已有的 `tab_handle`（同 owner）或报错（其他 owner）。Hub 在请求扩展接管前预留句柄，扩展在 debugger attach 前预留 owner；初始化中的释放会排在同一标签队列中，detach 通知后的迟到结果不能恢复句柄。初始化清理时 detach 失败保留控制权。
4. **句柄**：`tab_handle` 是 Hub 生成的随机 UUID，只在当前 MCP 连接内有效；跨连接不共享。
5. **串行**：Hub 与扩展都对每个标签维护 Promise 队列，动作不会并发穿插。
6. **超时**：Hub 单次浏览器操作 60 秒，客户端等待 65 秒。Hub 超时会关闭该客户端连接并释放它的 claim，错误文本明确提示"结果可能未知"。
7. **清理**：`tab_control(action="release")` 先移除可视标记，再 `debugger.detach`，最后才忘记 claim——detach 失败不会静默把标签交给别人。断连、标签关闭、浏览器重启、用户停止调试都会清理状态。

claim 与普通输入都不激活标签或窗口，也不移动系统鼠标；需要前台渲染时显式调用 `tab_control(action="activate")`。

`open_tab` 的 claim 默认 false。为 true 时，Hub 在创建成功后复用同一个 claim 流程，扩展在标签队列内最多等待 15 秒让初始 URL 可用，再执行当前 URL 权限检查和 attach。该等待只观察，不重发导航，也不要求最终 URL 与请求 URL 相等；已有标签的可选精确身份校验不变。创建到接管之间不承诺原子性，其他 owner 先取得控制时返回冲突。成功只证明已接管，不证明加载完成；接管失败保留页面并在错误的 open_tab 字段报告已知创建结果。清理失败时提供保留控制的恢复句柄；Hub 超时仍沿用断连及 release_owner 清理，未知创建结果不自动重放。

普通 file:// 文档复用同一套 claim、队列、CDP session、观察与输入流程。page-url.js 统一 HTTP(S)/file URL 及凭据校验，controller 通过 chrome.extension.isAllowedFileSchemeAccess 检查用户文件授权；发现结果反映该开关，接管、普通操作和 batch 每一步重新检查。navigation 对 URL 及历史目标调用同一个校验器，检查计入派发前的准备预算；权限检查迟到不会触发导航。释放、关闭和显式激活不受文件权限校验阻塞，detach 失败仍保留控制权。open_tab 与 fetch 保持 HTTP(S) 范围，不新增 host 权限或本地文件读取接口。内置 PDF 内容仍受浏览器调试边界约束，不承诺其 AX 或截图覆盖。

当前页检查与导航目标校验分开：已接管标签变为 `about:blank` 时，controller 允许显式 navigate 经过现有导航流程恢复，URL 和前进/后退目标仍须通过 page-url 与文件授权校验；普通观察、输入和新 claim 继续拒绝空白页。沿用已有控制权和队列，不创建标签、不自动导航或激活；文档变化仍使旧 ref 失效。其他不支持的当前页及已撤销文件权限的页面不获得导航恢复例外。纯日志读取只访问 claim 缓冲，不使用当前页准入条件；捕获配置修改仍使用当前页检查。

## 单页读取

`browser_fetch` 是一次 URL 读取：Hub 按显式 `browser_id` 把请求交给配对扩展；controller 创建后台 `about:blank` 临时标签，在其队列内复用 attach/session 初始化后只导航一次，按显式 commit / domcontentloaded / load / network_idle 等待，在隔离世界读取主文档，再于 finally 关闭。总 deadline 预留读取与清理时间；等待未满足时可采集当前文档并标记降级，创建和关闭也有界。创建的迟到回执只能触发清理。它不接管已有页面，不创建浏览器或窗口。临时标签在扩展内记录 owner，并从标签发现列表排除；即使关闭或初始化失败，也不能被其他连接接管。关闭失败保留临时页记录并报告，release_owner/releaseAll 再次尝试关闭；正常已有标签的 detach 边界保持不变。

正文按 owner 保留至多 4 份各最多 1000000 字符的不可变采集，cursor 定位采集而非 URL；LRU 淘汰最久未读取的未完成采集，读完、owner 或扩展断连清除。一次读完和失败的请求不淘汰已有缓存。分页不执行脚本、不导航，临时标签关闭不会删除缓存。JSON 在采集上限内整份返回，不按 max_chars 拆分。导航等待跟随同一标签后续主文档 loader，完成时保留实际满足条件的文档身份；采集期间文档变化最多只读重采 3 次，状态码始终匹配本次采集的 frame/loader。控制权变化立即失败，断连后的迟到结果不能复活缓存。格式、采集上限与分页语义见使用指南。

HTTP 状态复用 network.js 的 Network.responseReceived 观察，按主文档 frame/loader 精确匹配；额外保留 requestId、响应 URL、MIME、空体证据和加载错误码，只从匹配状态的 ExtraInfo 补充 Content-Length，防止重定向 hop、跨 session 请求和缓存 304 混淆。独立于可淘汰的日志正文保留至多 500 项文档状态元数据，断连/detach 清理。不新增 webRequest 或 host 权限，不重复请求页面。未匹配时 status/ok 返回 null；ok 仅表示 HTTP 2xx。ERR_HTTP_RESPONSE_CODE_FAILURE 若有已匹配的 HTTP 响应，返回状态及已确认的空体；不能证明正文为空时标记 unavailable，不采集浏览器错误页为目标正文。其他传输错误仍失败。HTML 标记 dom=rendered，保留观察到的 DOM，不声称是服务器原文；空标题省略。

## 观察模型

- **AX 渲染**：从 `Accessibility.getFullAXTree` 读取，移除 `InlineTextBox`，合并纯文本列表项与段落名称，丢弃 `generic` / `none` 且无名称无状态的节点，只保留少量状态属性和浏览器提供的 value、invalid。树遍历、交互视图筛选和正文合并使用迭代，跨 frame 逐项合并结果，避免深树递归和大数组参数展开溢出；分页前仍采集并渲染完整 AX 树，max_nodes 不限制采集成本。每行 `[token:n] role "name"`，`token` 是创建该 ref 时的随机前缀，增量中可沿用更早观察的 ref；这些字段不证明应用已保存。
- **弹层语义**：AX 树与 fields 共用同一提取函数，保留 hasPopup 与浏览器已解析的 controls/owns DOM idrefs；不输出内部 AX/backend ID、不推断归属、不注册额外 refs。expanded 沿用原有状态提取；查询、分页和 ref 生命周期不变。
- **交互视图**：可选 `profile=interactive` 在同一渲染器中仅保留 AX 控件角色、可聚焦/可编辑节点及其祖先链和控件内文本，不以 backendNodeId/ref 是否存在判断交互性。独立文本和合并正文可隐藏或截取预览，控件名称、值和 ref 的原始 AX 身份保留；默认 `full` 行为不变。筛选仍读取完整 AX 树，只降低输出与分页成本；视图参数绑定分页观察。
- **文本查询与精简输出**：`snapshot(query=...)` 复用同一次 AX 渲染，按当前视图中节点的完整名称（含合并正文）、value 或字段 context 做不区分大小写的字面子串筛选，只输出匹配行和对应 frame 标题；不搜索 role/ref 或任意 DOM 属性，不新增索引缓存。新查询仍采集新观察并使旧 refs 失效，query 与分页绑定。始终返回 snapshot_id，默认省略 viewport 和重复规则说明，`verbose=true` 额外返回 viewport。
- **语义差分**：full/interactive 的 diff_since 在全量采集后，按 frame/session/AX 节点身份及语义行对齐；最长递增子序列在 O(n log n) 内保留共同节点的顺序，以基线行范围表示新增、删除、移动和属性变化，避免后代变化扩大成整棵祖先树替换。不暴露另一套可操作 ID，不减少 getFullAXTree 成本。复用现有每标签观察，仅保存最新完整视图和当前差分页；旧视图不形成历史链。按 frame/session/backend/role/name/ignored 索引复用已核验身份的 refs，未进入当前查询结果的额外 refs 也需在本次 AX 中核验；普通新 snapshot 仍废弃旧 refs。
- **差分基线与提交**：最新 snapshot_id 对应的视图必须读完全部分页且 frame 覆盖完整；视图参数绑定基线，fields 不支持增量。输入过早使分页失效不会把未读完的观察标为完成。文档/frame/session 失效、frame 读取失败均明确拒绝增量，不推断删除；只在输出首分页成功后发布新观察并退役消失/身份变化的 refs。采集或输出失败不推进仍有效的基线，迟到结果不能发布；主文档变化不得跨基线重试。变化项可跨页，以 line_offset/complete 拼接后按基线 start_line 倒序应用。
- **字段上下文**：表单控件可附带 context 并参与 query，保留至多 160 字符的前一兄弟分支 AX 文本；只在四层以内 generic/none/group 祖先、单控件容器中查找，每次容器/文本遍历分别限制 64/32 节点。不将其伪装为 accessible name，不用于 label 定位或 ref 身份验证；interactive/text=false 也保留提示。
- **结构化字段**：profile=fields 复用相同观察状态、ref 注册、上下文提取、双预算分页与失效模型，以 fields 数组输出 DOM 与 AX 事实。每个 debugger session 在本次观察内至多一次 DOMSnapshot.captureSnapshot；按文档 frameId 与 backendNodeId 关联，不用选择器或名称推断身份，不逐字段读取普通 DOM 属性。DOMSnapshot 同时保留闭合 Shadow DOM、原生实时值与选项状态；只对文件 input 在隔离世界读取 FileList 的数量/名称，并释放 object group。默认限于 AX 暴露的原生字段与 AX 字段角色；include_hidden 显式加入 AX 缺失的原生字段，其 ref 可空。密码值不进入字段结果及查询。名称来自 AX，labels 来自 HTML label 名称来源，context 保持提示语义；原生/AX 值不合并成业务提交值。会话内 DOM 捕获只存在于本次采集，续读使用既有 entries，不增加持久 DOM 缓存。AX/DOM/FileList 与跨 frame 读取不是原子事务。
- **ref 解析**：ref 保存 `backendNodeId`、所属 frame/session 和观察时的 AX role/name；动作时重新 `DOM.resolveNode` 并用局部 AX 查询核对语义身份。输入与求值不清空 refs，只使快照分页失效；原节点仍连接时可复用，节点替换、role/name 改变、文档或 frame 变化时安全失败，不按 role/name 猜测替代节点。
- **ref 失效诊断**：controller 每标签保留最近至多 1000 个已清理 ref 的 cause/frame_id，不保留 DOM 对象、字段值或替代定位信息。普通新观察、文档/frame 变化及对话框清理记录各自原因；解析时单独报告节点脱离、session 或 AX 身份变化。释放、断连、关闭和 detach 清空历史，淘汰后返回 unknown_ref。
- **双预算**：`max_nodes` 限制节点数，`max_chars` 限制每行序列化后的累计字符数；两者独立，任一耗尽都会返回 `next_cursor`。
- **续读**：续读沿用同一份 `state`（`entries`、`refs`、`nextOffset`），所以 refs 在分页过程中保持有效。单个节点放不进预算时直接报错要求提高预算，避免静默截断尾部。
- **观察恢复**：普通新 snapshot 使用 30 秒总预算，full/interactive/fields 遇主文档变化或导航上下文失效时最多完整重读一次，间隔 50 ms，两次共享 deadline；与 navigate 的观察共用 retryObservation，导航本身不重发。每次采集使用独立 refs、entries 与字段读取器，发布前校验文档版本及同一 claim。超时的底层读取迟到不能继续发布，控制权结束不重试；cursor 续读不重采集。
- **frame 失效**：主文档导航或文档更新清空整份观察；子 frame 导航、移除或 session detach 只使该子树失效，并把受影响 frame 写入 `omitted_frames`。
- **OOPIF**：`Target.setAutoAttach` 以 `flatten: true` 递归附着 iframe target，每个 session 独立 enable Runtime / Log / Network / Page / DOM / Accessibility，frame 与 session 的映射由 `sessions.js` 维护。

## 输入模型

原生输入是默认路径，流程为：

```text
解析 ref → 可操作性等待（可见/启用/非 inert/几何稳定）
→ 滚入视口 → 重新确认 → 命中检查与遮挡检查
→ 在隔离世界安装校验 → 一次性派发 move/down/up
→ 等待可信事件回执
```

- **type 与 fill**：fill 替换文字，type 保留选区，逐字符复用原生按键与 keydown 回执；字符之间可延迟，不把 insertText 伪装成键盘序列。浏览器处理 keypress/input 及 preventDefault，非 ASCII 不模拟系统 IME。fill 对 input/textarea 精确核验 value；native 在 insertText 前另核对替换选区与焦点，丢失则停止，避免已知失效选区造成追加。contenteditable 的 native 核验临时选中内容并读取浏览器 Selection.toString，finally 恢复原选区及方向；复用浏览器对编辑占位 br/div 的纯文本语义，不实现 HTML 解析器。此过程可能触发 selectionchange，不插入额外文本。dom 使用 innerText setter 生成可见 br，再核验 innerText，无 HTML sink、不主动聚焦。两者统一 CRLF/CR 为 LF，两种模式均仅允许请求中的普通空格在同位置以 NBSP 保留；不合并空白或空行，不等待异步保存，差异仍报告结果未知。
- **焦点输入与语义定位**：type 的 focused=true 与 ref/selector 互斥，复用 press_key 的 frame/开放 Shadow DOM 焦点解析，固定最初可编辑元素并逐字检查，不重新聚焦。selector_type 的 label/placeholder 在隔离世界按真实 HTML 关联/属性查询，role/name 每次读取所选 frame 的 AX 树并严格匹配，以 AX 树顺序支持 nth；统一返回原有节点结构，继续复用输入、命中核验及 batch 流程，无组件库适配器。
- **定位与输入恢复提示**：非法 CSS 附原生语法及 role/label/placeholder 提示，不实现 Playwright 兼容层。role 准备失败仅在错误路径复用最后一次 AX 树，给出有界名称建议，不额外查询、不改变匹配或自动操作。原生回执未知时提示显式 activate 后重新观察，并保留禁止自动重放的边界；fill_selection_lost 提示可显式选择键盘编辑路径，不自动补发。
- **只重试准备**：等待阶段可以反复轮询，但一旦派发就不再重试。超时分为"未派发"和"已派发、结果未知"两种错误文本。
- **原生指针就绪检查**：准备前和派发前各做一次至多 500 ms 的有界检查；要求未冻结/丢弃的 tab 与未最小化的窗口。无修饰键的左键单击可在非活动标签尝试执行；hover、drag、其他按钮、双击及带修饰键的点击仍要求活动标签。检查失败以 TAB_NOT_READY 明确报告当前指针输入未派发，并提示 tab_control(action=activate) → snapshot → 所请求动作。click/hover 成功结果的 page_state.tab_active 记录派发前检查观察到的活动状态。普通操作不主动激活；仅显式 tab_control(action=activate) 在 focus_window=true 时请求窗口聚焦和 Page.bringToFront。
- **焦点信号边界**：OS 窗口失焦、遮挡或 document.visibilityState=hidden 不一定阻止 CDP 输入；document.hasFocus() 在 iframe 导航后也可能为 false。这些值作为 page_state 诊断，不独立拒绝点击。实际送达仍由隔离世界的可信事件回执校验；没有回执时不自动重放。
- **送达预算**：原生 click/hover/press_key 的派发及可信回执另有 1250 ms 上限，清理最多 250 ms；系统菜单捕获输入时快速释放队列，仍报告结果未知并提示 Esc，不自动重放。
- **hover 与 drag**：hover 复用点击准备与隔离校验，仅派发一次 mouseMoved，清理不移走指针。drag 显式区分 pointer 与 HTML5；后者从真实 dragstart 截获 DragData，再用 CDP 派发 dragover/drop，校验可信 dragstart/drop/dragend。目的节点在按住后滚入视口；所有步骤共用标签队列和总预算，失败时只取消/释放本次手势。
- **可选输入参数**：显式 offset 在元素 content quad 上插值后沿用命中与 OOPIF 边界检查；settle_ms 在 click/drag 首次派发前等待并复查就绪。drag trajectory 只替换既有插值段，采用法向控制点、平滑进度及随机间隔权重；type 的 delay_ms 可逐间隔独立区间采样。所有等待共用总预算，超时后没有继续派发的链；省略参数时不使用随机数，沿用既有确定性路径。不新增 tab 级历史、冷却、自动激活或重放路径。
- **条件等待**：wait 复用严格 selector、可操作性和命中检查，支持出现、无匹配、可见、可操作、字段值精确相等、checked/selected/expanded、文本/URL 子串及网络空闲。控件优先读取明确的原生属性，否则读取对应 ARIA 属性；缺失/无效状态保持 unavailable，不当作 false。字段值不回显；文本使用 innerText，比较在 500 字符预览截取前完成。每次只读轮询重新解析 selector，可在节点替换时重读，歧义立即失败；AX 无匹配不证明 DOM 移除。单步与 batch 共享条件 schema 和参数校验，等待超时不改变前序动作的派发事实。
- **可操作性诊断**：区分 display_none、visibility_hidden、zero_size、disabled、inert、read_only 和 unstable_geometry；无可见落点单独返回 no_visible_click_point。失败时最多采集 8 层 composed 祖先的样式、滚动方向和 transition 属性/时长，成功路径保留原有几何就绪语义；不以 opacity=0 拒绝输入，不自动 hover、移除遮挡或等待推断出的组件状态。
- **派发前居中**：pointer.prepare 在 obstructed/frame_obstructed 且预算尚未派发输入时，对同一元素额外 scrollIntoView({block:center,inline:nearest,behavior:instant}) 一次，复用原预算并重跑完整准备与 frame 命中检查，不递归尝试。scroll=false、坐标输入和拖拽按下后的目的端不使用该补救；原有滚入视口与输入回执边界不变。
- **显式保留值**：fill 可用 expected_value 替代 text 作为现有文本核验函数的输入，prepareFill/insertText 仍使用 text。verification_basis 区分来源，不回显内容；不增加格式猜测、异步等待或 blur。fillOptions 统一校验单步、MCP 与 batch 预检，未指定时保持原有精确比较及 contenteditable 容差。
- **字段与编辑器边界**：fill 复用 prepareFill 的只读预检，在标记派发前拒绝已识别的 Monaco/CM5 代理 textarea；实际聚焦/赋值前再次检查，不增加适配器注册或私有全局扫描。native 对暴露选区偏移的 input/textarea 验证完整替换范围，email 保留 select() 与最终值核验。verification_source 记录 dom_value/selection_text/inner_text，与预期来源 verification_basis 分开。页面侧代理诊断经 checkedValue 跨 CDP 保留；选区/值核验失败仍保留未知结果与禁止重放语义。
- **模型读取与等待诊断**：editor 模式只接受明确暴露且关联唯一编辑器的字符串模型；能力缺失/异常与多实例歧义分别返回 editor_model_unavailable/editor_model_ambiguous，所选节点调用也使用 checkedValue 保留诊断，不用 DOM 视图补全。text wait 继续完整比较 innerText，仅对预览增加长度、截断和容器回读提示；不增加业务新鲜度状态。
- **原生下拉**：select_option 不要求可见或稳定几何，先只读核对节点、禁用/inert 祖先与唯一选项，再在一次派发中复查并用 selectedIndex setter 和合成 input/change 设置，核验保留结果并返回 events_trusted=false。单步和 batch 共用实现。native click 的 select 命中（含 UA shadow 内部节点和关联 label）在派发前拒绝。
- **命中提示**：普通命中保留实际 hit node，沿父元素、Shadow host、slot 查找最近的 HTML/ARIA 可点击候选，返回 clickable_target；hint=false 表示未识别候选，不代表无法响应事件。CSSPseudoElement 先解析为事件所属的 originating element，提示标记 pseudo_element=true，并使用该元素安装事件校验。语义候选不会被用于替换点击目标。
- **遮挡失败诊断**：requested_target 与 blocked_by 分别描述请求目标及遮挡物，hit_target 保留实际命中语义。请求目标描述最多额外读取 100 ms，失败仍保留 backend/frame ID；当前 frame 的遮挡复用已读取的 hit_target；祖先 frame 遮挡额外用至多 200 ms 读取命中描述，诊断节点消失时保留原遮挡错误与 backend node ID。命中元素与最近可点击祖先均附 tag/id/classes，classes 至多 8 项、每项 100 字符，只作当次身份线索，不生成唯一 selector 或替换目标。错误包含命中点和受阻 frame。根据共享预算的派发状态区分“未派发”和“结果未知”，避免 drag 按住后准备目的节点时误报零输入。
- **滚动查找诊断**：until 未命中或中断时保留 isError，以 scroll_search_stopped 和 stop_reason 区分预算、步数、文档/frame/控制权变化及其他异常；记录已确认的滚动次数、最后结果和是否有未确认调用。一次无位移只作为 boundary_observed 证据，继续只读等待列表增长，不声明数据到底。超时后不接续循环或重发滚动。
- **上传证据**：非空文件通过 DOM.setFileInputFiles 设置；清空由 DOM 赋值并派发合成 input/change。命令回执与 FileList 核验分层：assignment_acknowledged=true 后单独返回 requested_count、observed_count 与 count_verified，数量不符不是赋值错误；节点脱离或读取失败以 null 和 observation_error 表达，不能覆盖已有命令回执。赋值本身异常/超时仍报告已派发、结果未知，不补发设置或事件。非空路径 events_trusted=null，不把 CDP 回执作为事件送达核验；清空路径 events_trusted=false，两者 application_result=not_checked，不推断组件登记或服务器接收。
- **送达不等于业务完成**：原生 click/hover 的 delivery_verified 表示可信事件送达；target_verified=true 只用于显式元素目标，纯坐标为 null，target_verification 标明 element/coordinate_hit 和准备时的 same_node/composed_descendant。hit_relation 按 composed 祖先遍历处理 slot/ShadowRoot，派发后仍由隔离世界事件路径核验。元素命中关系比较先把双方 backend 节点显式解析到目标 frame 的同一隔离 world，避免先前定向读取留下的默认 wrapper 导致跨 world 对象比较失败。value_verified 表示字段保留文本与核验预期一致；点击、按键、fill 和 batch 返回 `application_result: "not_checked"`。fill 不证明 React 状态、选项提交、blur 校验或保存完成。
- **定向控件观察**：read_control 在同一标签队列中按显式目标读取 DOM 与所属 frame 的 AX，分开保留原生值、显示文本、状态、明确的 controls/owns 弹层及 activedescendant。仍使用所属 frame 的 getFullAXTree，定向指输出范围与 ref 稳定性，不表示减少 AX 采集成本；弹层 DOM 文本在 CDP 返回前裁为 120 字符预览，超出标记 text_truncated，控件本身的文本上限仍为 1000。只遍历目标/明确弹层子树中的当前 AX 选项，不猜组件库、列表全集或所有权；活动与选中项独立保留。复用当前观察状态新增/复用至多 500 个额外 ref，不替换快照或分页；读取后检查文档/frame/session/claim，清理隔离与定位 wrappers，无持久组件缓存。输入及 batch 的可选 observe 复用相同读取，受剩余预算约束；观察失败与输入结果分层，已派发失败可保留独立证据，不重放、不声称应用成功。
- **键盘目标证据**：press_key 可带只检查、不聚焦的 ref/selector 守卫。准备期核对目标及 composed 后代焦点，可信回执再次核对实际事件路径并报告目标/frame；闭合 Shadow DOM 在相应 root 捕获路径。守卫不匹配时停止，派发后的不匹配尝试阻止事件继续传播但仍属未知结果；每次均排队 keyUp。无目标按键保持当前焦点语义。
- **有限多步输入**：batch 在现有标签队列内执行 1–30 步 click/fill/type/press_key/hover/scroll/select_option/wait，共享至多 30 秒预算，每步可另设更短超时；不增加后台任务、循环或脚本引擎；元素目标使用每步重新解析的 selector，type 也接受 focused=true。所有参数先验证，selector 每步重解析，尚未出现的目标只在准备阶段等待；歧义立即报错。首个失败、主文档变化或接管结束后停止，返回此前结果与失败索引；不回滚、不重放、不自动激活或切换输入模式。start_at 显式跳过已完成前缀，返回 failed_step、next_unattempted_step、retry_failed_step_safe；没有后台作业或自动选择续跑点。
- **OOPIF 坐标**：点击从顶层派发。逐层用 `DOM.getBoxModel` 把坐标换算到祖先文档，并用 `DOM.getNodeForLocation` 确认该位置确实落在 frame owner 上，防止祖先页面的遮挡被跳过。
- **命中对象**：伪元素先解析 originating Element；ShadowRoot 通过其 elementFromPoint 重新取得实际命中 Element，同进程子 frame 先把 session 坐标映射到所属文档视口。不将 ShadowRoot 直接当 Element 或无条件改成 host。后续身份、遮挡和事件回执检查保持一致；命中描述附带 frame-local rect 和样式诊断。
- **DOM 模式**：`mode: "dom"` 是显式的、受控的降级路径，用于原生菜单或标签拖动暂时捕获输入时操作普通 HTML 控件。它调用 `HTMLElement.click()` 或原生 value setter，事件非可信、无用户激活，且绝不会在原生失败后自动启用。
- **对话框策略**：ask 仍为默认；单操作/单步骤的显式 accept/dismiss 在事件回调中解除 JS 模态阻塞，保留消息与处理结果，最多自动处理 10 个。beforeunload dismiss 快速取消本次导航等待，实际主文档变化仍会停止 batch。
- **未知结果探测**：在可能写入的操作准备期安装目标 frame 的临时 MutationObserver；观察用的 frame 解析只尝试一次，不等待不存在的 frame 消耗动作准备预算。仅在不确定失败后做一次有界只读探测，回传对话框、导航、DOM 变动；读取最多 300 ms、清理最多 100 ms。observations.tab/dom 分别提供 available 及错误；任意正面变化证据保留 observable_effects，只有标签与 DOM 均可读且未见变化才返回 no_observable_effects，其他情况为 observation_unavailable。不可用 DOM 结果为 null；任何 assessment 都不证明业务成功或没有派发，不自动重放。扩展、Hub、客户端用 errors.js 保留 error 文本及 input_dispatched、post_action、diagnostics、observation；MCP 工具执行失败返回 isError 与 JSON，batch 失败采用相同证据字段。
- **元素截图/求值 ref**：复用既有截图 clip/元数据与 ref 注册/失效模型，分别增加元素 border box 截图和显式单 DOM Element 结果；不暴露 Runtime objectId。JSON 求值自动调用函数一次并等待 Promise，缓存续读不执行脚本。
- **求值预算提示**：JSON 仍按顶层完整项分页；已有输出而下一项超出预算时，在同一响应提供 next_item 的 key/index、required_chars 和是否超过最大页预算。提示只读取缓存，不展开或改写嵌套值，也不提供任意脚本的执行进度。
- **历史导航**：在已有 navigate 中选择 URL 或 back/forward，按 history entry 与主 frame 生命周期等待；同文档/BFCache 恢复不等新的加载事件，不用 evaluate 重放导航。
- **导航后观察**：导航成功后的快照另有 10 秒预算，文档变化或执行上下文销毁等瞬时错误最多只重读一次；权限错误和预算耗尽不重试。观察失败保留导航结果并附 observation_error，不重新派发导航。
- **不做通用 CDP 透传**：`browser_evaluate` 是页面表达式 API，不是 CDP 通道；没有暴露任意 domain/method 的工具。

## 诊断模型

`browser_logs` 通过必填 `kind=console/network/navigation` 读取控制台、网络与导航日志。三类日志共享所有权、生命周期、分页和预算接口；事件结构与过滤条件由 `kind` 区分，各自维护独立缓冲。工具层只有一套 schema 和调用路由，不引入聚合状态机。

- 每次 claim 开启 Runtime / Log / Network 观察，默认 `Network.enable` 把正文缓冲区设为 0；显式 capture 才启用每 session 2 MiB 总量和单资源上限，OOPIF 新 session 继承本次 claim 配置。
- 三类 append-only 缓冲各自维护 `seq`：读取使用 `after_seq` + `limit` + `max_chars`；续读位置必须与 tab claim 和 kind 一起保存。网络和导航流量不会挤掉控制台错误。console 的 level 与 network 的 url_contains 不得跨类使用。同一 requestId 的重定向用 `hop` 区分，完成事件后追加而不是覆盖请求行。
- controller 在标签队列内先检查 owner/handle；不带 capture 的读取直接访问诊断模块，不经过 perform 的页面结果探测、当前 URL 校验或实时标签元数据读取。capture 修改仍校验当前页面和文件授权；保留已取得的历史缓冲不授予新的页面访问权限。日志响应只附 tab_id/tab_handle，不再补实时 title/url/active。
- 导航记录复用 Page 事件，区分 requested、committed 和 same_document；请求原因不当作提交结果，不新增关联或因果推断状态。observed_at 为扩展接收时间；控制台与网络 timestamp 各自保留原始时钟基准，不混排为统一时间轴。
- 统一裁剪事件已有栈：总共最多 8 帧、两层内联异步父栈，保留 async_depth 和截断标记，不查询 parentId 或启用 Debugger。网络 initiator 仅写入 request 行，网络事实表只增加 loader_id，不保存调试栈；浏览器 Log 保留可用的 request_id。
- 上限为每类 500 条 / 1,048,576 字符，活跃请求表 500 项；淘汰记录 `dropped_through_seq`，读取返回 `data_loss`。
- 导航保留缓冲，tab_control(action=release) / detach / 关闭 / 断连清理；不落盘、不修改缓存策略与 service worker。默认不读取 headers/正文；按需开启只捕获之后的 XHR/fetch，凭据头和命名敏感字段脱敏，解压后体积、并发读取、浏览器缓存和扩展日志均有界，未捕获/超限明示 unavailable。
- 正文读取最多 8 个并发任务；已知解压后超限的响应不读取。请求关联表溢出时可能缺少 URL/hop，但保留 request_id；控制台与网络时间戳分别采用 Unix 毫秒和 CDP 单调秒，不合并为统一时间轴。

## 安全与隐私

- Hub 只监听 `127.0.0.1`；HTTP 端点拒绝任何带 `Origin` 的请求，客户端必须携带 Bearer 密钥。
- 扩展连接固定校验 `chrome-extension://<extension_id>` Origin 与随机 token。同版本才注册为可控浏览器；已配对的较旧扩展仅进入维护连接，收到重载请求后校验本机文件、完成清理再自行重载。客户端握手同样要求版本一致。
- 配对文件 `config.json` 与生成的 `extension/config.generated.js` 含密钥：目录在 Windows 上用当前用户 SID 收紧 ACL，在 POSIX 上为 `0700`/`0600`；发布包检查会拒绝包含 `config.generated.js`。
- 扩展具备 `debugger` 与 `tabGroups` 权限，操作使用用户现有登录态；只应接入信任的 MCP 客户端。网页内容、控制台与网络日志均视为非可信数据。
- 文件上传只传路径，Hub 与模型都不接触文件内容；选择文件可能立即把内容发给网站，因此只传任务明确指定的文件。

## 设计取舍

| 能力 | 决策 | 原因 |
|---|---|---|
| 定位方式 | AX ref + CSS/XPath/label/placeholder/role-name selector，可显式 nth | ref 保持观察身份，selector 每次重解析；省略 nth 仍严格要求唯一；context 仅作观察辅助，不猜测标签关系 |
| 动作重试 | 只重试派发前的准备 | 网页操作可能提交真实数据，重复派发不可接受 |
| DOM 模式 | 需要显式 `mode: "dom"` | 非可信事件、无用户激活，不能当作原生输入的透明替代 |
| hover / drag | 原生指针工具，复用 click 准备 | 纯悬停和可信拖拽无法由 click 或页面 evaluate 等价表达 |
| HTML select / checkbox | select_option；checkbox 仍用 click + 观察 | select 的系统弹层会捕获输入，直接赋值必须明确合成事件；checkbox 无需新增工具 |
| 网络拦截 | 只读事件，不拦截、不改写 | 拦截会改变网站行为并扩大故障面；诊断需求用被动日志满足 |
| trace / video | 不提供 | 会大量保存网站内容，存储与隐私成本高于收益 |
| 独立 worker / WebSocket | 不订阅 | 需要额外的 target 管理；当前以页面与 iframe 为主 |
| 浏览器引擎 | 仅 Chrome / Edge 125+ | 依赖 `chrome.debugger`、`tabGroups` 与扁平 session，其他引擎没有等价能力 |
| 用户配置 | 复用现有已登录 profile | 这是产品定位：不创建隔离 context、不导出 cookie、不启动独立自动化浏览器 |
| 分发 | npm 包 + 稳定扩展副本 | 避免 npx 缓存目录变化导致扩展失效；不保留 Python 运行时或旧配对兼容层 |

## 版本与兼容

`package.json`、`src/config.mjs`、`extension/manifest.json` 的版本必须一致。MCP 示例配置使用 `@latest`，MCP 启动、`start` 和 `setup` 共用升级协调：检查已配对 Hub → 空闲 Hub 暂停接入并确认扩展清理 → 旧 Hub 退出 → 新 Hub 独占端口后同步扩展 → 旧扩展自行重载 → 确认新版重连。该自动路径要求 Hub 与扩展已经具备 0.17 的 `connection.js` 维护协议；更旧版本的首次升级必须先停止 Hub、重启 MCP 并手动重载扩展（旧 Hub 没有升级端点，旧扩展也不处理重载命令）。MCP 在 stdio 就绪前即连接 Hub，尚未调用工具的 MCP 会话也会阻止升级。有客户端、断连清理或在途请求时返回占用错误，关闭其他 MCP 连接后重试；不强制打断页面动作。

Hub 的监听端口同时保证同一配对的文件同步只有一个执行者。扩展先完整暂存，保留稳定目录本身，逐文件替换并最后提交 manifest；替换失败恢复旧文件，进程在替换中退出时通过 `.previous` 副本恢复。配对密钥、端口和自定义目录保留，旧包不得降级新版 Hub 或扩展。扩展重载记录尝试，防止失败后无限循环；派发重载不代表升级成功，启动协调仍等待实际版本。未打开的 profile 在下次连接时处理；首次安装仍需手动加载扩展。此流程不热替换正在运行的 MCP 进程。
