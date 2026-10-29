# 验证报告

当前版本 **0.32.0**（2026-10-29）。本文件按次版本组织：每个次版本先给语义变化，再给验证结果，补丁差异合并为单行。浏览器验证使用本地 fixture 或临时 profile；本机配对链路的部署核对记录在各次版本下。原始日志保存在被忽略的 `test-results/`。

## 0.32（当前）

- 能力：browser_wait 顶层单条件归一化为单项 checks，只剩一套条件检查器、轮询与结果封装；两种输入均返回 status/results/timed_out/retry_safe，不再返回旧 satisfied/current，条件不符或不可读不设置 isError（参数、定位歧义、权限及控制权错误仍走工具错误）。单项同样支持 count/value_present/not；wait 只接受 dialog_policy=ask，batch 对两种写法的非 pass 均停止。返回契约变更，调用方需改读 status 与 results[i].actual。
- 精简：公共定位、动作观察预算和对话框策略集中到初始化 instructions，参数及 batch steps 保留短提示与特有约束。tools/list 从 91,189 降至 77,943 字符，含 instructions 的合计从 93,607 降至 81,375（−13.1%）；移除 description 后 24 个工具定义逐项一致，排除说明与注释后 MCP 执行代码一致。
- 验证：并发 4 的全套单测 400 项通过，新增两种输入的通过/不符/不可用、否定、隐私和既有对话框等价断言；stdio 核验单项 fail 亦为正常报告，并检查互斥参数预检与整数传递。Chrome / Edge 隔离 verify 组通过（三态、完整失败/不可用索引、batch 停止、OOPIF、模态保持、不抢焦点），Chrome primitives 组通过；Edge primitives 的 wait 用例通过，其后既有 html5_offscreen 拖拽因测试页 inactive 返回 TAB_NOT_READY，未修改无关拖拽行为。短预算末轮读取不完整允许返回 unavailable，集成检查只按 retry_safe 对 observation_timeout/not_observed_in_round 有界重查，不重放 batch 或输入。记录：unit-0320.log、contract-0320-final.log、stdio-0320-final-2.log、verify-0320-{chromium,edge}-final.log、primitives-0320-{chromium,edge}.log。
- 打包与部署：包外安装、71 文件、24 工具及扩展目录独立检查通过。Hub 与 Chrome/Edge 扩展均为 0.32.0 / ready，稳定副本 47 个非生成资源核验一致（manifest 按配对配置生成，内容一致）。实际配对链路核验顶层单条件与单项数组返回完全相同、不含 satisfied/current、精确值不回显、单项 fail/unavailable 不设置 isError、batch 非 pass 停止且本地写入只发生一次、原活动标签保持；测试页已关闭。记录：package-0320.log、runtime-0320.log、deployment-0.32.0.json。既有 MCP 会话需重新连接以加载新 schema 与 instructions。
## 0.31

- 能力：browser_wait 新增互斥的 checks[]（1–30 项），同一预算内整轮验证，返回 pass/fail/unavailable、期望/实际、零基 failed/unavailable 索引及仅作用于本次只读检查的 retry_safe。新增精确 count、非空 value_present 和简单 not；不可读、缺失标量目标、无效 ARIA 及网络跟踪溢出不因取反通过。保留单条件接口及超时报错方式，字段值及精确值期望不回显。
- 边界：复用严格定位、DOM/AX 检查器与网络事实；同组 DOM 条件合并读取，AX 按浏览器节点身份去重计数。frame 单次解析与分组子预算避免缺失 frame 独占等待，当前轮未读项不继承旧成功；claim/document/frame 变化阻止旧证据通过，后读 AX 组不能覆盖先读 DOM 组的 frame 版本。checks 仅允许 ask，不处理对话框、不滚动或派发输入；batch 在非 pass 时停止并保留 verification，含继承策略的参数预检先于首次输入。
- 验证：并发 4 的全套单测 399 项通过，新增 14 项验证组覆盖三态、否定、隐私、交替通过、集合/唯一定位、XPath 非元素、frame/AX 不可用、缓慢分组、文档/frame/control 变化、跨组版本、节点替换、可操作性、网络溢出、batch 停止及对话框；stdio 检查新 schema、互斥参数预检、整数传递和普通 fail 结果不设置 isError。Chrome / Edge 隔离 verify 组通过，覆盖 9 条一次判定、完整失败/不可用索引、精确值不回显、batch 预检与停止/继续、后台 actionability、长文本完整比较、重渲染、严格定位、OOPIF、模态保持与不抢焦点。
- 打包：包外安装、71 文件、24 工具、新 checks schema 及稳定扩展目录检查通过。记录：unit-0310-final.log、verify-0310-{chromium,edge}.log、wait-verify-{chromium,edge}.json、package-0310.log。
- 本机部署：断开占用的 MCP 连接后，协调升级完成，Hub 与 Chrome/Edge 扩展均为 0.31.0 / ready；稳定扩展副本 47 个非生成资源逐文件一致。新 stdio 会话核验 24 工具及 checks schema，实际配对链路的后台本地 fixture 验证多条件通过、fail/unavailable、精确值不回显、batch 非 pass 停止且写入只发生一次、原活动标签保持；测试页已关闭。200 ms 短预算下允许末轮读取未完成而报告 unavailable，不能据此重放前序动作。记录：runtime-0310.log、deployment-0.31.0.json。既有 MCP 会话需重新连接以加载新 schema。

## 0.30

- 能力：snapshot(diff_since="latest") 在扩展的标签队列内复用当前基线，无需调用方保存 ID；结果始终明确 mode=diff/full。无基线、fields 视图、视图改变或基线失效时返回 full/reset_reason，不跨文档作差分。显式 ID 保持严格，未读页附 snapshot_id/next_cursor，失效游标不作为可用续读位置返回。
- 动作组合：单个动作及整批末尾支持 observe={diff_since:"latest"或显式ID,max_nodes?,max_chars?,verbose?,timeout_ms?}；动作前绑定基线/视图并预检，动作后在剩余总预算内采集，默认观察上限 5 秒。观察失败独立保留原动作结果，已派发未知结果可以附观察证据而不重放；步骤 observe 保持控件 selector 形式，不自动每步读取整页 AX。仍不减少 getFullAXTree 成本，不提供页面稳定或业务成功保证。
- 验证：并发 4 的全套单测 385 项通过，新增 19 项覆盖 latest 建立/继承/重置、严格 ID、未读/失效分页、claim/frame/document 边界、失败不推进基线、一次动作后观察、预算与迟到结果、未知派发序列化及整批末尾观察；stdio 检查新增联合 schema 的传递和非法混合参数预检。Chrome 156 / Edge 156 隔离 snapshots 组通过，新增 fill/click/batch 一次调用增量、稳定 ref、换视图和动作导航后的显式全量重置；既有 Shadow DOM、iframe/OOPIF 与差分重建用例继续通过。
- 打包与部署：包外安装、71 文件、24 工具及新 observe schema 检查通过。Hub 与 Chrome/Edge 扩展为 0.30.0 / ready；稳定副本 47 个非生成资源哈希一致，manifest 版本与身份核对通过。实际配对链路的后台本地 fixture 验证 latest 首读 no_baseline、fill/click/batch 一次调用附带增量与稳定 ref、换视图 view_changed 后旧 ref 以 snapshot_replaced 失效、未读分页在派发前被拒（input_dispatched=false 且点击未发生）及不抢焦点。已有 MCP 会话需重新连接以加载新 schema。记录：unit-0300.log、latest-hub-final.log、snapshot-diffs-0300-{chromium,edge}.log、snapshot-diffs-{chromium,edge}.json、package-0300.log、runtime-0300.log、runtime-mcp-0.30.0.json、deployment-0.30.0.json。

## 0.29

- 能力：snapshot(diff_since=snapshot_id) 在全量 AX 采集后返回 full/interactive 语义变化，以基线行范围表示插入、删除、重排及属性变化；保留身份未变的 ref。snapshot_id 始终返回，verbose 仅额外返回 viewport。fields 暂不支持增量；普通新 snapshot 仍废弃旧 ref。
- 边界：只接受最新且完整读完、frame 覆盖完整的基线；视图参数继承并绑定。增量分页可重建视图，分页期间 frame 失效明确失败；文档/frame/session/claim 变化不得跨基线发布，覆盖缺失不当成删除，预算或采集失败不推进仍有效的基线。定向观察追加的 ref 在查询结果外也会重新核验。README、共享 instructions 和 skill 改为在下一步依赖新状态或结果不确定时观察。
- 验证：全套单测以并发 4 单独运行，366 项通过；与双浏览器集成同时运行时，3 个既有短超时断言失败，单独复跑全部通过。新增 20 项差分测试涵盖空变化、同名替换、稳定 ref、查询和合并正文、属性顺序、千节点随机重排重建、分页及双预算、失效和超时迟到。Chrome 156 与 Edge 156 隔离 snapshots 组通过，包含闭合 Shadow DOM、同进程 iframe、OOPIF、局部值变化、分支增删移动、同名替换、精确重建和不抢焦点；fixture 的局部更新变化片段为 226 字符，原正文为 6324 字符，仅说明输出减少，不减少全量 AX 读取。
- 打包与部署：包外安装、stdio schema 与配对目录检查通过，70 文件、24 工具。Hub 与配对 Chrome/Edge 扩展更新为 0.29.0 / ready，稳定副本 46 个非生成资源哈希一致，manifest 版本与身份核对通过；实际配对链路使用后台本地 fixture 核验新 schema、空变化（changes=[]）、局部值变化的单行片段、保留 ref 实际点击、节点替换后旧 ref 以 element_detached 失效，以及 fields 视图拒绝增量。已有 MCP 会话需重新连接以加载新 schema。记录：unit-0290.log、snapshot-unit-0290-final.log、snapshot-diffs-0290-{chromium,edge}.log、snapshot-diffs-{chromium,edge}.json、package-0290.log、deployment-0.29.0.json、runtime-mcp-0.29.0.json。

## 0.28

- 0.28.2：popups[].dom.text 在 CDP 返回前改为最多 120 字符预览，超过上限保留 text_truncated=true；控件文本仍为 1000，选项、选中/活动项与 refs 不变。共享 instructions 明确弹层选项/选中活动项用 read_control，整页字段值/状态用 snapshot(fields)；仍采集整个 frame AX，不宣称协议成本或总输出一定更低。全套单测 346 项通过（control.test.mjs 16 项，含新增的弹层文本预览边界用例；hub stdio 断言 24 个工具与 instructions 选型）；隔离 controls 组在 Chrome 156.0.8078.48 与 Edge 156.0.4314.42 通过；打包检查通过（69 文件、24 工具）；Hub 与 Chrome/Edge 扩展为 0.28.2 / ready，45 个非生成文件哈希一致，新 stdio 会话确认为 24 个工具且 instructions 含选型规则。测试脚本改用 CDP Extensions.loadUnpacked 加载扩展：品牌 Chrome/Edge 已忽略 --load-extension，且 --disable-extensions-except 会让 CDP 加载的扩展不启动。记录：control-preview-unit-0282.log、package-0282.log、controls-0282-chromium.log、controls-0282-edge.log、deployment-0.28.2.json、runtime-mcp-0.28.2.json。

- 0.28.1：拖拽与动作后观察共用原动作截止时间，不另开观察预算；增加截止时间回归测试。

- 能力：新增 `browser_read_control`，分开读取原生 DOM/AX 值、显示文本、明确关联的弹层、activedescendant 及当前暴露的活动/选中选项，复用既有 refs，保留文档/frame/session/claim 校验；不推断组件库内部模型、完整虚拟列表或业务提交。
- 输入：可选 `observe` 在同一队列和剩余预算内读取显式控件；观察失败保留原输入回执，失败步骤与整批末尾观察分开返回。`press_key` 新增不聚焦的目标守卫及可信事件目标/frame 证据，支持闭合 Shadow DOM；遮挡诊断分开请求目标和遮挡物。batch 上限由 20 调整为 30，续跑索引最大为 29。
- 修复：元素命中关系比较显式统一到目标 frame 的同一隔离 world，避免对子 frame 定向读取后，默认 wrapper 混用造成 CDP 跨 world 参数错误。
- 验证：`npm test` 345 项通过（+16）；Chromium 156 headless controls、preparation、extended、controlled forms 组通过，Edge 156 headless controls 组通过；覆盖过滤框 value 为空但显示值已提交、零高度弹层外壳、选项截断、明确所有权、观察失败不覆盖输入、焦点守卫、闭合 Shadow DOM、同进程 iframe 与 OOPIF。`test:package` 69 个文件、24 个 MCP 工具，包外安装后 stdio 检查通过。
- 部署：本机 Hub stop/start 完成；Chrome、Edge 扩展自动重载为 0.28.1 / ready，稳定副本 manifest 身份一致，44 个非生成文件 SHA-256 一致。新建 stdio 会话实际确认 24 个工具、batch maxItems=30 和两个配对浏览器的 read_control 能力；已有 MCP 会话需重新连接以加载新 schema。记录：`unit-0281.log`、`controls-{chromium,edge}.json`、`preparation-chromium.json`、`extended-chromium.json`、`forms-chromium.json`、`package-0281.log`、`deployment-0.28.1.json`、`runtime-mcp-0.28.1.json`。

## 0.27

- 语义：`browser_logs` 新增 `kind=navigation`，`event=requested/committed/same_document` 分别保留浏览器给出的 reason/disposition、frame、loader、URL 与 navigation_type，独立缓冲与游标；不把相邻请求与提交配对，不把 `scriptInitiated` 推断成某段脚本导致跳转。网络事件补 `loader_id` 与 `initiator`，浏览器 Log 补 `request_id`。
- 证据边界：console、异常、浏览器 Log 与 network initiator 只保留事件已提供的调用栈，最多 8 帧、两层内联异步父栈，`async_depth` 标层级，函数名/URL/script_id 裁到 200/2000/100，`stack_truncated` 标记帧数、父链与未展开 `parentId` 造成的缺失；不额外启用 Debugger、不查远端父栈、不保留 `objectId`。
- 读取边界：不带 `capture` 的日志读取只校验所有权并遵守标签队列，不访问页面、不读实时标签元数据，空白页、不支持的 URL、元数据不可用或有 JS 对话框时仍可读；带 `capture`（含 `enabled=false`）仍要求当前页受支持且文件访问已授权。工具数、参数数、权限、依赖不变。
- 验证：`npm test` 329 项通过（+8）；Chromium 156 headless tabs 组 6 项检查、71 次调用通过，含 about:blank 前后的三类证据与独立分页；`npm run test:package` 67 个文件、23 个工具。Edge tabs 组与 files 组本版未重跑。
- 部署：Hub stop/start 后 Chrome、Edge 扩展自动重载至 0.27.0 / ready（无需手动 Reload），稳定副本 manifest 版本与身份一致、其余 42 个非生成文件 SHA-256 一致；两个真实浏览器各做一次定点检查（navigation 日志、栈与 initiator、空白后缓冲读取、capture 与普通操作仍被拒），未新增或激活其他标签。记录：`deployment-0.27.0.json`、`logs-navigation-{unit,package}-0270.log`、`npm-live-chromium-tabs.json`。

## 0.26

- 0.26.0：已有 claim 的标签变为 `about:blank` 后，显式 URL 或前进/后退导航可在原标签恢复，目标 URL、文件授权、所有权、队列与 ref 失效规则不变；普通操作和新 claim 仍拒绝空白页，错误说明恢复或释放路径。说明层明确复用已有任务标签、`open_tab` 同 URL 已开仍新建、`fetch` 会执行站点脚本。
- 验证：`npm test` 321 项；Chromium 156 与 Edge 156 临时 profile 通过 tabs 5 组、files 7 组集成检查；`test:package` 67 个文件、23 个工具；Hub 与两扩展 0.26.0 / ready，42 个非生成文件一致（`deployment-0.26.0.json`）。
- 站点实测（用户授权）：猎聘简历页编辑态原页约 14.1 秒后自清空，单标签接管亦约 8 秒后清空，重复标签不是必要条件；独立 Browser Use 捕获 `security.min.js` 上报与紧随其后的 `Page.frameRequestedNavigation(reason=scriptInitiated)`，指向 DevTools 检测式白屏。原句柄导航可用但不保证持续稳定，未修改或提交简历，也未屏蔽站点检测。

## 0.25

- 0.25.0：`browser_open_tab` 新增 `claim`（默认 false），claim=true 单次调用取得句柄、不改写发现记录；创建与接管非原子，失败保留页面与已知身份，超时或断连报 `claimed=null`、`outcome_unknown`，清理失败返回恢复句柄。
- 0.25.1：skill 随 npm 包分发（SKILL.md 主干 + setup/recovery/recipes + MCP 模板），移除 Nosis 专有 CLI 选项与安装脚本；打包检查核对 skill 逐字节一致与版本戳。
- 0.25.2：native fill 派发前只读预检完整替换选区，拒绝已识别的 Monaco/CodeMirror 5 代理 textarea 并返回 `editor_proxy`；新增 `verification_source` 与 `verification_basis` 区分回读来源和预期来源；`read_text mode=editor` 细分不可用/歧义，text wait 预览补 `total_chars`/`text_truncated`。
- 验证：0.25.0 全量 313 项、两浏览器 tabs 各 20 次调用 4 组检查；0.25.1 config+hub 20 项；0.25.2 相关 10 文件 163 项与两浏览器 preparation 各 7 组；`test:package` 62（0.25.0）→ 67 个文件、23 个工具；三次均完成 Hub stop/start 与扩展自动重载（`deployment-0.25.2.json`）。
- 边界：内容编辑器的第三方实现、选区事件与 insertText 的非原子性、选择器与占位换行仍可能返回结果未知，不自动重试或补发。

## 0.24

- 0.24.0：`pointer.prepare` 在本次输入尚未派发且元素或祖先 frame 遮挡时额外居中一次（复用总预算），坐标、只读 actionable 与拖拽按下后的目的端不做补救；`fill`/batch fill 新增 `expected_value`，写入仍用 `text`。
- 0.24.1：role 精确定位失败时复用最后一次 AX 树给出最多 10 项名称建议（不操作目标），非法 CSS 保留原始解析错误并附替代提示；原生回执丢失与派发超时提示先激活再重新定位，明确激活不证明未送达；full/interactive/fields 观测共享 30 秒总预算，文档竞态最多重读一次。
- 0.24.2：精简 instructions、工具与参数描述，初始化加 tools/list 由 56,638 降至 51,605 字符（−8.9%），description 后 23 个工具定义逐项一致；无浏览器执行实现变更。
- 0.24.3：修复 fields 对原生 input/textarea 空值字符串索引 −1 的解码，显式返回 `dom.value=""` 并保留 `value_source`，密码值仍不输出。
- 验证：`npm test` 293 → 301 项，0.24.2 与 0.24.3 只跑相关子集（41 项、52 项）；preparation 专项两浏览器各 4 组；完整 live-smoke 各 402 次调用、38 项检查（0.24.1、0.24.3 为 420 次调用、40 项检查）；`test:package` 62 个文件、23 个工具。
- 边界：一次居中不解决所有遮挡；`expected_value` 只核验当时保留文本，不证明送达、blur 校验或业务保存；名称建议不证明目标唯一。

## 0.23

- 0.23.0：新增 `snapshot(profile=fields)` 结构化字段视图（真实 HTML label、DOM/AX 值区分、多选与 mixed、隐藏字段显式读取、密码省略、字段分页与 ref）。
- 0.23.1：contenteditable 按输入模式核验（native 渲染换行与 NBSP、DOM 精确文本），拒绝跨表示掩盖的段落/空格/空行变化。
- 0.23.2：核验改为读取浏览器所选纯文本并恢复选区端点与方向，替换选区丢失时不发 `insertText`；`type` 参数错误区分非字符串、长度与控制字符。
- 0.23.3：普通空格被页面写成同位置 NBSP 时两种模式都算保留；折叠空格、丢失显式 NBSP、数量或位置变化仍失败。
- 0.23.4：补 `mcpName` 与根 `server.json`（官方 schema 校验通过），首次发布 MCP 官方 Registry。
- 0.23.5：上传改为读回 FileList 数量（`assignment_acknowledged`/`count_verified` 分层），命中元素与最近可点击祖先补 id/classes 线索；`read_text` 明确不含 input 值。
- 0.23.6：快照与 fields 共用弹层语义（hasPopup/expanded/controls 与 owns idrefs），上传回执与读回分离，scroll until 停止返回 `stop_reason`、`scroll_pending` 与已走步数。
- 验证：`npm test` 253 → 290 项；完整 live-smoke 由 281 次调用/31 项检查增至 398 次调用/38 项检查（含 Gmail 同形 DOM、Trusted Types 页面、真实 change 消费 FileList）；`test:package` 61 → 62 个文件、23 个工具；各次均完成本机部署与扩展自动重载。

## 0.22

- 0.22.0：非活动标签上的单次无修饰左键点击（ref/selector/viewport/document 坐标）可取可信回执且不激活标签；hover、拖拽、其他按键、双击与带修饰键仍要求活动标签，`page_state` 带 `tab_active`，拒绝时 `input_dispatched=false`。
- 0.22.1：定位与输入失败统一为结构化 `diagnostics.reason`（selector_not_found/ambiguous/invalid、value_not_retained、delivery_unverified、target_changed、preparation/input_timeout），frame 路径保留底层原因；派发后超时不复用准备期诊断。
- 验证：`npm test` 243 → 246 项；`interaction-smoke --regressions` 两浏览器各 35 个场景；完整 live-smoke 255 → 267 次调用、27 → 29 项检查；`test:package` 60 个文件、23 个工具。
- 边界：真实既有 profile 中 Chrome 对从未激活的后台页可能取不到回执，报告未知且不重放（Edge 可取到）；原因码不推断业务成功，也不授权重放。

## 0.21

- 0.21.0：新增可操作性原因与有限祖先样式/滚动/过渡证据、`wait` 的原生状态条件（checked/selected/expanded 等）及分型后的动作后观察证据。
- 0.21.1：按职责拆分 controller 测试与内部模块，补齐网络状态、结构化未知结果、对话框策略恢复与 select 异常跨 CDP 边界回归；含真实并发升级验证。
- 验证：`npm test` 236 → 240 项；`--primitives` 两浏览器各 22 个场景；文件页面 50 次调用 5 组检查；完整集成各 254 次调用；`test:package` 51 → 60 个文件、23 个工具。
- 边界：状态等待只确认指定页面状态，不推断业务成功；ARIA 缺失报 unavailable，role 无匹配不证明 DOM 已移除。

## 0.20

- file:// 支持：发现与接管检查实时 `isAllowedFileSchemeAccess`，普通操作与 batch 每步重查，导航目标（含历史条目）在派发前校验；停权后仍可释放，detach 失败保留控制权。`open_tab`/`fetch` 仍限 HTTP(S)。
- 验证：`npm test` 226 项；两浏览器 files 组各 5 组集成检查（中文/空格/# 路径、主文档与本地 iframe AX、PNG、原生输入与 DOM batch、HTTP↔file 导航）；HTTP live-smoke 254 次调用；`test:package` 52 个文件、23 个工具。
- 边界：浏览器内部页与任意扩展页仍拒绝接管；内置 PDF 正文的 AX/截图兼容性未验收。

## 0.19

- 闭合 Shadow DOM 的命中归一化与 trusted 点击、同进程子 frame 局部坐标、slot/ShadowRoot 祖先关系、select 只读准备与 inherit inert 拒绝、frame 候选诊断与超时保留、结构化错误证据跨扩展 → Hub → stdio MCP 传递。
- 验证：`npm test` 219 项；两浏览器 `--issues` 10、`--primitives` 21、`--extended` 13 个场景；完整集成各 254 次调用；`test:package` 51 个文件、23 个工具。
- 边界：诊断只报告可观测事实，不解释任意站点禁用原因；overflow 祖先裁剪下的元素截图为空白（保留该语义）。

## 0.18

- 新增真实 HTML label/placeholder、AX role 与 focused 定位，每次重新解析、唯一性检查与树顺序，失焦即停止；快照支持 context 查询。
- 验证：`npm test` 213 项；输入集成两浏览器各 21 个场景、扩展集成各 13 个场景；`test:package` 50 个文件、23 个工具。
- 边界：label 只认真实 HTML 关联；role 每次采集所选 frame 完整 AX 树；已知观察：接管后动态增删跨源 iframe 时 `network_idle` 曾以 inflight=1 超时，本次未修。

## 0.17

- 0.17.1：并发升级与冷启动、旧配对缺 `extension_dir` 的回落、`release_all` 部分失败的错误回传与控制权保留、弹窗释放失败提示。
- 0.17.2：滚动最深匹配、隐藏中间节点与歧义候选改为线性筛选，深树与宽树不再栈溢出；text wait 只比较渲染文字。
- 验证：`npm test` 200 → 207 项；`test:upgrade` 两浏览器临时 profile 并发升级并重连成功；输入集成各 20 个场景；完整集成各 254 次调用（1.2 万节点分页约 15.3/16.6 秒）；`test:package` 50 个文件、23 个工具。
- 边界：12 万个显式 group 节点的快照仍触及 MCP 60 秒请求超时；`max_nodes` 只控分页，不代表超大页面能按期完成。

## 0.16

- 新增非中心可信点击与 offset、settle 区间、逐字区间输入、曲线 pointer 拖拽与 HTML5 拖拽，batch 参数预检与真实 stdio 转发；超时后停止且调试分离取消待点击。
- 验证：`npm test` 184 项；输入集成两浏览器各 19 个场景；完整集成 244 次调用；`test:package` 48 个文件、23 个工具。
- 边界：不据此声称能通过任意站点的行为验证；拖拽与输入只证明送达。

## 0.15

- 0.15.0：`fetch` 支持 commit/domcontentloaded/load/network_idle 等待与超时降级，主文档替换后跟随 loader，HTTP 错误响应带状态与正文来源。
- 0.15.1：快照新增 AX 字面 `query` 与 `verbose`，默认精简元数据；同一构造表单的序列化输出由 908 降至 443 字符（−51.2%），tools/list 总量因新增参数略增 1.1%。
- 验证：`npm test` 172 → 176 项；完整集成 238 → 244 次调用；真实 URL 校验 httpbin 500/503 与 403 验证页；`test:package` 46 → 47 个文件、23 个工具。

## 0.14

- `fetch` 补主文档 frame/loader 状态匹配、HTTP 错误正文与 `ok` 区分、渲染后 DOM 标记、JSON 整份返回、四份缓存交叉续读与 LRU 淘汰。
- 验证：`npm test` 165 项；完整集成两浏览器各 230 次调用（重定向、404/500、登录墙、子框架 404、90 万字符 JSON）；`test:package` 46 个文件、23 个工具。

## 0.13

- 0.13.0：新增 `fetch` 单页读取（text/html/json、后台临时页、不可变分页、owner 隔离与断连清理），工具数 22 → 23。
- 0.13.1：描述文本由 18,716 降至 11,469 字符（−38.7%），移除 description 后 23 个工具 schema 完全一致。
- 验证：`npm test` 159 项；完整集成各 219 次调用；`test:package` 46 个文件、23 个工具。

## 0.12

- 新增 interactive 快照、document/pointer/HTML5 拖拽与按轴滚动、条件等待、HTML select、batch、历史导航与未知结果不重放；22 个工具。
- 验证：`npm test` 149 项；`--primitives` 16 个场景；`test:package` 45 个文件、22 个工具；200 段正文 fixture 中 full 首屏 23,302 字符仍需续页，interactive 为 947 字符。

## 0.12 之前

- Edge 155 `--primitives` 10 个场景、`--extended` 12 个场景通过；Edge 完整 stdio MCP 集成 192 次调用（扩展版本 0.10.0）。
- `select_option` 明确 `events_trusted=false`，native select 点击在派发前拒绝；拖拽与输入只证明送达。

## 复跑

```sh
npm test
npm run test:package
node scripts/live-smoke.mjs --executable /path/to/browser --family edge
node scripts/interaction-smoke.mjs --primitives --headless --executable /path/to/browser --family edge
node scripts/interaction-smoke.mjs --extended --headless --executable /path/to/browser --family edge
```

真实浏览器测试需要允许命令行加载扩展的 Chromium / Edge，并只操作临时 profile 与本地 fixture。

## 已知限制

- 未覆盖独立 worker / service worker、WebSocket 消息、`window.showOpenFilePicker()`、目录上传、下载管理和网络拦截。
- 后台截图可能因浏览器暂停渲染在 5 秒后超时；原生菜单和标签拖动可能抑制输入。
- readiness 是派发前的保守条件，不保证 compositor 或业务处理；派发后丢失可信回执仍报结果未知，不把“没观察到效果”当作零效果证明。
- 拖拽的自动滚动是目的元素驱动的滚入视口，不提供持续边缘滚动任务。
- `select_option` 不制造可信事件；`network_idle` 只覆盖 claim 后观察到的页面/iframe 请求。
- Monaco / CodeMirror 5 分支通过接口级测试，未针对第三方生产编辑器或特定 React/Vue 版本做站点验收。
- 计时数据仅代表本机 fixture，不构成对任意网站的耗时承诺。
- 未针对已登录 Gmail / Overleaf / ChatGPT 生产页面验收；结果受登录状态、验证页、网络与应用初始化影响，降级保证以实际可读文档为准。

## 历史验证

- 0.8.0（2026-10-21）：`npm test` 118 项；20 个工具、40 个发布文件；Chromium 156 / Edge 155 各 191 次真实调用通过。
- 0.7.0（2026-10-21）：`npm test` 110 项；19 个工具、40 个发布文件；Chromium 156 / Edge 155 各 191 次真实调用通过。
