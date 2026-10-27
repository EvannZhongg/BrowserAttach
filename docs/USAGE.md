# BrowserAttach 使用指南

适用于 **0.24.2**：Node.js 22+、Chrome / Edge 125+、23 个 MCP 工具。安装、配对与升级见 [README](../README.md)，宿主配置见 [Agent 集成](AGENT-INTEGRATION.md)，内部机制见 [架构说明](ARCHITECTURE.md)。

本文供按需查阅，不会自动通过 MCP 发送给 agent。MCP 初始化 `instructions` 提供通用规则，工具 description 与参数 schema 提供调用说明；宿主应把 instructions 纳入模型上下文。

## 基本流程

1. `browser_discover(kind="browsers")` 选择配置，取得 `browser_id`。
2. `browser_discover(kind="tabs", browser_id)` 找到目标标签的 `tab_id`。
3. `browser_claim_tab(...)` 独占接管，取得本连接的 `tab_handle`。
4. `browser_snapshot(tab_handle)` 观察页面，使用返回的 ref 或严格 selector 执行动作。
5. 按任务核对页面结果，结束后 `browser_tab_control(action="release", tab_handle)`。

`tab_id` 必须来自本连接最近一次标签发现；`tab_handle` 不能跨连接使用。同一标签只允许一个 owner。claim 可省略 `expected_url` / `expected_title`；提供时须与发现及接管时的身份精确一致。省略标题校验可容忍标题变化，接管后仍应检查返回的当前身份。

普通 `file://` 页面使用相同流程：先在浏览器中打开文件，在 Chrome / Edge 的扩展详情中为 BrowserAttach 开启“允许访问文件网址”，再发现并接管。发现结果的 `controllable` 包含该开关检查；接管、每次操作以及导航到本地文件前都会重新检查，释放控制不受该检查阻塞。改变开关可能重载扩展并作废旧连接与句柄，此时重新发现浏览器及标签再接管。AX、截图、输入、导航和 ref 失效规则与 HTTP(S) 页面一致。内置 PDF 查看器的正文 AX 和截图能力不在本次支持保证内，仍受浏览器限制；不会开放浏览器内部页或任意扩展页。

`browser_open_tab({browser_id, url, active:false})` 默认后台打开 HTTP(S) 标签，返回 tab_id；加载后仍需发现并接管。`browser_tab_control` 的 action 必填：

| action | 行为 |
|---|---|
| `release` | 释放控制，保留页面 |
| `activate` | 选中标签；`focus_window=true`（默认）同时聚焦窗口，false 只选中标签 |
| `close` | 关闭标签并作废句柄，可能丢失未保存状态 |

`discover.kind` 必填；browser_id 仅在 kind=tabs 时使用且必填。focus_window 仅适用于 activate。浏览器发现结果的 `browsers` 只列可控配置，较旧扩展重载期间列在 `upgrades`，失败附带 error；升级步骤见 README。

## 工具速查

| 工具 | 用途 |
|---|---|
| `browser_discover` | 列出浏览器配置或标签及控制状态 |
| `browser_open_tab` | 在指定配置中打开 HTTP(S) 标签 |
| `browser_claim_tab` | 独占接管已发现的标签 |
| `browser_tab_control` | 释放、激活或关闭标签 |
| `browser_snapshot` | AX 语义树或结构化字段数组、元素 ref、查询与 frame 覆盖 |
| `browser_read_text` | 正文、字段值或支持的编辑器模型 |
| `browser_fetch` | 使用登录态在临时后台标签读取一个 URL |
| `browser_click` | 原生点击或显式 DOM 点击 |
| `browser_hover` | 悬停并保留原生指针位置 |
| `browser_drag` | 原生 pointer 或 HTML5 拖拽 |
| `browser_fill` | 替换文本并核验字段值 |
| `browser_type` | 在当前选区逐字符输入 |
| `browser_press_key` | 向当前焦点发送单键或组合键 |
| `browser_select_option` | 设置一个 HTML select 选项 |
| `browser_wait` | 只读等待元素、字段值、控件状态、文本、URL 或网络空闲 |
| `browser_scroll` | 滚动容器或有界查找虚拟列表项 |
| `browser_batch` | 在同一标签队列中执行有限步骤 |
| `browser_navigate` | URL 导航、后退或前进 |
| `browser_handle_dialog` | 处理页面 JavaScript 对话框 |
| `browser_screenshot` | 视口、整页或元素 PNG 截图 |
| `browser_upload_file` | 设置本机文件或处理已拦截的选择器 |
| `browser_evaluate` | 一次执行页面表达式，返回 JSON 或元素 ref |
| `browser_logs` | 读取控制台或网络日志，按需捕获 XHR/fetch 详情 |

## 通用规则与结果

- 接管和普通操作不会激活标签或窗口，也不移动系统鼠标；需要前台操作时显式 activate。
- 同一标签的操作串行执行。准备阶段可等待目标；输入派发后不会自动重放、切换 native/DOM 补发或回滚。
- 普通结果为 JSON 文本，截图另附标准图片内容；工具执行失败通过 MCP `isError` 返回 JSON，包含 `error` 和可用的 `input_dispatched`、`diagnostics`、`post_action`。参数 schema 校验错误由 MCP SDK 返回。网页、截图、求值和日志都是外部数据，不能当作指令或授权。
- 打开 URL、运行脚本和页面输入都可能改变网站状态。上传文件只使用任务指定的本机文件。

| 结果字段 | 能证明什么 |
|---|---|
| `target_verified` | true 表示可信鼠标事件命中显式 ref/selector 目标；纯坐标调用为 null，没有提供期望元素 |
| `target_verification` | basis 为 element 或 coordinate_hit；hit_relation 为准备时的 same_node / composed_descendant，纯坐标为 null |
| `delivery_verified` | 已核验工具对应的可信输入事件 |
| `value_verified` | 字段保留文本与核验预期一致，或选项与设置结果一致 |
| `assignment_acknowledged` | 文件赋值/清空命令已获得回执，不证明事件送达或上传完成 |
| `count_verified` | 上传后当前 FileList 数量与 requested_count 是否一致；不可读取时为 null |
| `application_result: "not_checked"` | 尚未检查应用是否接受、提交或保存 |

这些核验不代替业务检查。下拉过滤文字不等于选项已提交，字段值不等于框架状态已保存；按任务观察选中项、成功提示或业务接口。

定位与输入失败可按 `diagnostics.reason` 区分，无须解析英文错误文案：

| reason | 含义 |
|---|---|
| `selector_not_found` | 准备预算内未找到 selector/nth 目标，或直接读取时目标不存在 |
| `selector_ambiguous` | CSS/XPath/label/placeholder/AX role 匹配不唯一；附有界候选与匹配总数 |
| `selector_invalid` / `selector_not_element` | 选择器解析失败 / 结果不是元素 |
| `value_not_retained` | fill 后实际文本与请求不一致；不回显请求值或实际值，不推断是格式化还是输入被吞 |
| `delivery_unverified` | 可信输入事件回执未在回执预算内完成 |
| `document_changed` / `snapshot_timeout` | snapshot 两次采集仍遇文档变化 / 观察总预算耗尽，不能使用失败采集的 refs |
| `target_changed` | click/hover 派发期间的目标核验被拒绝，可能已有前序输入送达 |
| `preparation_timeout` / `input_timeout` | 无更具体准备原因的超时 / 已进入派发阶段后操作超时 |
| `scroll_search_stopped` | 滚动查找停止，stop_reason 和进度证据见 browser_scroll |

已有 `stale_ref`、`frame_locator`、可操作性及遮挡原因保持各自语义。frame 路径查询失败仍以 `frame_locator` 为 reason，可在 cause 和 selector_diagnostics 中保留底层选择器原因。定位辅助脚本抛出的诊断通过 CDP 单独读取；文档已销毁或无法读取时保留原错误，诊断可能缺失。派发后超时不会沿用准备阶段的定位/可操作性原因。上述原因不是重放许可；结合 `input_dispatched` 与 `post_action` 判断下一步，不推断服务端业务拒绝。

### 结果未知时

超时、回执丢失或派发中断可能发生在动作生效之后。先用快照、截图或日志观察，再决定下一步；不要自动重放或换模式补发。导航和异步 JavaScript 也可能在超时后继续。

如果页面焦点不可用，可显式调用 `browser_tab_control({tab_handle, action:"activate", focus_window:true})`，然后重新 snapshot、定位并核对操作是否仍需要执行。activate 本身不证明之前未送达：只有 `input_dispatched:false` 的准备失败可以在恢复后直接重试；派发后的未知结果仍须先观察。原生菜单确实打开时才用 Escape 关闭。

不确定错误可能附带结构化 `post_action`：delivery=unknown、dialog/dialogs、navigation_observed、frame_navigation_observed、current_url、frame_id、dom_changed。observations.tab/dom 分别报告 available 和不可用时的 error；dom_changed=null 表示 DOM 观察不可用。assessment=observable_effects 表示已有变化证据，即使部分观察不可用也保留；只有标签与 DOM 观察均可用且未发现变化时才返回 no_observable_effects，否则为 observation_unavailable。三者都不证明业务成功或没有派发。DOM 观察未必覆盖字段属性、其他 frame 或服务端变化。`input_dispatched=true` 表示已进入派发阶段，不证明事件送达或脚本完成；false 表示尚未派发，字段缺失则没有确定证据。

`TAB_NOT_READY` 明确表示本次指针输入尚未派发。显式激活或恢复窗口后，重新 snapshot 再执行动作。检查通过后仍可能遇到用户切换标签或浏览器菜单捕获输入，最终以事件回执和错误中的派发状态为准。

## 读取一个 URL

只需读取正文时，发现浏览器配置后调用 fetch，无需接管已有标签：

```js
browser_fetch({browser_id, url:"https://example.com/article", format:"text", wait_until:"load"})
browser_fetch({browser_id, cursor:next_cursor, max_chars:20000})
```

工具使用该配置的登录态，在临时后台标签中读取当前主文档后关闭，不跟随页面链接。临时标签可能短暂出现在标签栏，但不出现在标签发现结果中。网页脚本、子资源和重定向仍会执行。

| 参数 | 默认 / 选择规则 |
|---|---|
| `url` | 首次调用必填；HTTP(S)，不带 URL 凭据 |
| `format` | `text`；另可选 `html` / `json` |
| `wait_until` | `load`；另可选 `commit` / `domcontentloaded` / `network_idle` |
| `timeout_ms` | 15000，范围 100–30000，涵盖创建、等待、采集和清理 |
| `max_chars` | 20000，范围 1–100000，限制文本/HTML 每页长度；JSON 整份返回 |

`network_idle` 在 load 后等待连续 500 ms 无已观察到的活动请求，长连接可能阻止完成；commit 时正文可能仍为空。等待预算会为采集和清理预留时间。未满足等待条件时，仍可返回可读文档并标记降级；没有可读 HTTP(S) 文档或清理失败则报错。

| 返回字段 | 含义 |
|---|---|
| `body` / `contentType` / `url` / `title?` | 正文字符串、文档类型、采集时 URL 和非空标题 |
| `status` / `ok` | 已观察到的文档 HTTP 状态 / 是否 2xx；未知均为 null |
| `ready_state` / `wait_satisfied` | 采集时文档就绪状态 / 本次等待条件是否满足 |
| `degraded` / `degraded_reason` | 是否降级；如 wait_timeout、document_changed、navigation_interrupted、http_error_response |
| `document_changed` | 首次 HTTP(S) 文档提交后是否发生主文档替换，不含 hash 等同文档变化 |
| `body_source` | rendered_document、已确认空体的 http_response，或无法取得正文的 unavailable |

text 是渲染后的 innerText，html 是当前 DOM（`dom:"rendered"`），均非服务器原始响应；json 从文档正文解析并重新序列化。HTTP 404/500 仍可返回正文和 ok=false；2xx 登录墙或软错误仍为 ok=true。无法证明错误响应为空时返回 body_unavailable=true，不能将其当作空响应；DNS/TLS 等传输错误仍失败。

分页与采集限制：

- 一次最多采集 1000000 字符；`capture_truncated=true` 表示尾部已丢失，不能靠续读恢复。JSON 必须在上限内完整有效，超限或解析失败直接报错。
- 文本/HTML 的 `next_cursor` 读取不可变缓存；`truncated` 可能表示尚有分页或采集有损。JSON 忽略 max_chars，整份返回且 next_cursor=null。
- 每连接、每配置最多保留 4 份尚未读完的采集；第 5 份淘汰最久未读取的一份。一次读完或失败的请求不淘汰已有缓存，相同 URL 的调用各自独立。
- 续读只传 browser_id、cursor 和可选 max_chars，不再访问 URL；临时标签关闭不影响缓存，读完或断连清除。过期游标报错。

## 观察：快照与引用

snapshot 返回 AX 语义树，每行 `[token:n] role "name" 状态`；`[token:n]` 是可操作 ref。结果包含 title/url、node_count/total_node_count、truncated/truncation_reason、next_cursor 和 omitted_frames。状态和值来自浏览器，不代表业务已完成。

浏览器提供时保留 hasPopup（弹层类型）、expanded，以及 controls/owns 数组；fields 视图在 ax 中提供相同信息。controls/owns 是浏览器已解析关联的 DOM ID 字符串，不是 ref、AX ID 或后代作用域；可用于明确定位 document 根部的 portal 弹层。没有关联时省略，不根据位置、外观或打开顺序猜测归属；这些事实不代表节点是最终可选叶子或选项已提交。

| 参数 | 用途与默认值 |
|---|---|
| `profile` | `full`；interactive 保留控件、可聚焦/编辑节点及祖先链；fields 返回结构化字段数组，见下文 |
| `include_hidden` | 仅 fields，默认 false；true 额外读取未暴露到 AX 的原生字段，如隐藏 input |
| `text` | true；false 隐去独立正文，保留控件名称和值 |
| `text_limit` | 正文名称预览上限 0–10000；interactive 默认 80，full 默认不截断；控件名称和值保留完整 |
| `query` | 1–2000 字符的名称/value/context 字面子串，不区分大小写；零命中正常返回 |
| `max_nodes` / `max_chars` | 600 / 24000；范围分别为 1–3000 / 1–2000000，两个预算独立 |
| `verbose` | false；true 额外返回 viewport 和 snapshot_id |

full/interactive 查询在当前视图中匹配完整名称/value/context，再截取正文预览；不搜索 role、ref 或未暴露给 AX 的属性。阅读查询保留 full，interactive 会先筛掉正文。视图和查询减少返回量，不减少完整 AX 树采集。

```json
{"tab_handle":"...","query":"保存","max_nodes":20}
```

`next_cursor` 继续同一份观察，保留 refs。续读可省略 profile/text/text_limit/query/include_hidden；显式提供时须与原观察一致。单个节点或字段放不进预算会报出所需大小。主 frame、同进程 iframe 和跨进程 iframe（OOPIF）均可覆盖；未能读取或期间变化的 frame 见 omitted_frames。

新建 snapshot 的采集总预算为 30 秒；遇文档变化或导航造成的上下文失效时，最多间隔 50 ms 完整重读一次，两次共享预算。失败采集的 refs 不会发布；控制权结束、非导航错误及预算耗尽不重试。cursor 续读始终读取原观察，失效时明确报错，不自动切换成新快照。navigate 附带的 snapshot 沿用导航观察的独立预算。

| 事件 | ref / 快照分页的影响 |
|---|---|
| 输入、新 evaluate 表达式 | 快照 cursor 失效；节点及其语义身份未变时 ref 可复用 |
| evaluate 缓存续读 | 不影响当前 refs 或快照分页 |
| 新 snapshot（含新查询或视图） | 旧 refs 和快照 cursor 失效 |
| 主文档导航、同文档导航或更新 | 全部失效 |
| 子 frame 导航或移除 | 该子树 refs 失效，其余保留 |
| 释放、关闭或断连 | 全部失效 |

ref 对应原节点及其可访问身份；节点被替换、脱离文档或 role/name 变化时应重新观察，不会自动匹配同名替代节点。

ref 错误的 diagnostics.reason=stale_ref，cause 区分 snapshot_replaced、document_navigation/document_updated、same_document_navigation、frame_changed、frame_session_changed、element_detached 和 identity_changed 等原因。每标签至多保留最近 1000 个已清理 ref 的失效原因，释放或断连清空；超出范围或未由本次接管创建的 ref 返回 unknown_ref，不推断其来源。

表单控件可附带 `context="性别"` 等邻近文本，在 interactive 或 text=false 下也保留，并参与 query。context 来自有限祖先范围内、仅含一个控件的容器中前一兄弟节点的 AX 文本；只是观察提示，不代表真实标签关联，不改写 AX name，也不参与 ref 身份校验。复杂布局可能没有 context。

### 结构化字段观察

```json
{"tab_handle":"...","profile":"fields"}
{"tab_handle":"...","profile":"fields","query":"邮箱"}
{"tab_handle":"...","profile":"fields","include_hidden":true,"query":"orderId"}
```

fields 视图用 `fields` 数组替代 snapshot 文本，保留重复标签和字段名，避免以标签作为键覆盖数据。`node_count/total_node_count` 与 max_nodes 计数字段，max_chars 仍按完整序列化项计算。`frames` 列出本次观察的 frame_id/URL，读取失败及变化见 omitted_frames。每行示例：

```json
{
  "ref":"token:1", "frame_id":"frame-id",
  "labels":["订单号"], "context":null,
  "ax":{"role":"textbox","name":"订单号","value":"SO-0001","readonly":true},
  "dom":{"tag":"input","id":"order-no","name":"orderNo","type":"text","value":"SO-0001","value_source":"input_value"}
}
```

- `ax` 是浏览器提供的名称、角色、值及 disabled/readonly/required/invalid/checked/selected/expanded/multiselectable 状态；缺失属性不推断为 false。`labels` 来自浏览器 AX 名称的真实 HTML label 来源，context 则是现有有界附近文本，两者不改写 AX name。
- `dom.id/name/type/placeholder` 来自原生 DOM 快照属性；input 缺少 type 时记录 text。`dom.value` 的 value_source 区分 input_value、textarea_value、selected_option、text_content。select 附 multiple 和 selected_options 的值/标签；checkbox/radio 附原生 checked，AX checked=mixed 另行保留。contenteditable/output 的值是捕获的 textContent，不声称为编辑器完整模型。
- 默认包括暴露到 AX 的原生 input/textarea/select/output/contenteditable，以及 AX 字段角色的自定义控件；不把普通按钮当字段。文件 input 即使 AX 角色是 button 也识别为字段。include_hidden=true 才额外包括未暴露到 AX 的原生字段；此类行 ax/ref 可为 null，只提供可观察的 DOM 事实。密码字段省略 DOM 与 AX 值，返回 value_redacted=true。
- 文件 input 的 `dom.files={available,count,names}` 只报告隔离世界读取时的当前本地选择，不读取文件内容，不代表服务端附件数量或接受结果；读取失败为 available=false。上传后组件清空 input 时 count 可为 0。
- query 在 AX 名称/值、labels/context、DOM id/name/placeholder/value 和选中选项值/标签上作字面子串匹配。text/text_limit 只控制正文，不截断字段值。分页续读不重新采集；要核对当前值应发起新的字段观察。
- DOM 与 AX 按所属 frame/session 的 backend 节点身份关联，支持闭合 Shadow DOM 和 OOPIF。两次捕获之间节点被替换时不按 id/name 猜测新节点，只有 AX 事实的行 dom=null；无法判断原生字段类型时也省略 AX value。各 frame 与文件列表分步读取，不提供跨来源原子快照、业务提交值、组件内部模型或并发写入归属判断。读取最终保存结果仍需任务相关的页面或接口证据。

### browser_read_text

`browser_read_text({tab_handle})` 默认读取主 frame 的可见正文，不包含 input/textarea 的当前值，不能据此判断表单为空。单字段用 `browser_read_text({tab_handle, selector:"#name", mode:"value"})`；整张表单用 `browser_snapshot({tab_handle, profile:"fields"})`，可加 query 筛选字段。可用 selector 限定正文范围，或用 frame/frame_id 选择子 frame。

| mode | 来源 |
|---|---|
| `visible`（默认） | innerText |
| `text_content` | textContent |
| `value` | 唯一选中的 input、textarea 或 contenteditable 的值 |
| `editor` | Monaco / CodeMirror 5 的完整模型 |

编辑器须暴露 monaco.editor.getEditors() 或所选节点上的 CodeMirror 5 实例，否则明确报错。返回 source、complete_source、total_chars、returned_chars、truncated 和 next_offset；max_chars 默认 20000，范围 1–100000，offset 默认 0。

next_offset 是下一次实时读取位置，内容变化可造成重复或遗漏；需要一致结果时用 evaluate 一次捕获再分页。DOM 正文不包含未渲染的虚拟行或所有 Shadow DOM，complete_source=false 表示覆盖边界；字段值及支持的编辑器模型为 true。

### 可复用的元素与 frame 寻址

selector 每次重新解析，省略 nth 时必须唯一；歧义立即报错并附最多 10 个候选。输入、点击、拖拽、等待、读取和 batch 共用以下定位方式：

| selector_type | selector 的含义 |
|---|---|
| `css`（默认）/ `xpath` | CSS / XPath 查询 |
| `label` | 关联 HTML label 的文本；折叠空白后精确匹配，支持 for 和包裹式 label |
| `placeholder` | placeholder 属性的完整精确值 |
| `role` | 浏览器 AX role，可另传 `name` 精确匹配 accessible name；包括浏览器提供的隐式角色 |

`name` 仅适用于 role。`nth` 从 0 开始，按 DOM 顺序选择，role 则按 AX 树顺序；准备阶段可等待目标出现。重复匹配应缩小范围或显式 nth，不按可见性猜选。label 不推断兄弟 div 的标签关系，ARIA 命名可通过 role/name 定位。

role 应写为 `selector_type:"role", selector:"link", name:"Claim"`，而不是把 Claim 写入 selector，也不能根据外观假定 role=button。role 准备超时的 selector_not_found 在最后一次成功读取的 AX 树中，按 name（未提供时按 selector）给出不区分大小写的名称子串建议：同名优先，最多 10 项，名称最多 120 字符，截断时标记 name_truncated，omitted_suggestions 表示省略数。suggestions 只辅助重新观察，不改变精确匹配，不自动使用候选。

CSS 使用浏览器原生语法，不支持 Playwright 的 `button:has-text("Claim")`。非法 CSS 的 selector_invalid 附带 hint，可先用 `browser_snapshot({tab_handle, query:"Claim"})` 确认实际 role/name，再用 role 定位；表单也可按真实 HTML label 或 placeholder 精确定位。不自动翻译选择器。

Portal 弹层可组合现有工具定位：先用 snapshot 读取触发字段的 controls/owns，确认唯一且对应当前所需弹层的 DOM ID，再将选项查询限定到该 ID；例如 ID 为 school-options 时，用 XPath `//*[@id='school-options']//*[@role='option' and normalize-space(.)='Southeast University']`。CSS 中的特殊字符应经 CSS.escape 转义；ID 不是现成的选择器。仍须满足唯一匹配，不使用全局 option 的 nth 猜测。关联缺失、多个目标或弹层重建时重新观察；Shadow DOM 中的 ID 不能直接当作 document 根查询，可用 evaluate 返回单个元素 ref。此组合不自动打开弹层或提交选项，也不推断缺失的关联。

```js
browser_fill({tab_handle, selector_type:"label", selector:"工作职责", text:"填写内容"})
browser_click({tab_handle, selector_type:"role", selector:"option", name:"2026"})
```

CSS/XPath/label/placeholder 不穿透 Shadow DOM；可用 AX role 或 ref。role 每次读取所选 frame 的完整 AX 树，不保证比简单 CSS 查询便宜。selector、read_text、evaluate 可用 frame 或 frame_id 指定范围，两者互斥：

```json
{"tab_handle":"...","selector":"#comment","frame":{"path":["iframe[title='Outer']","iframe[title='Inner']"]},"text":"填写内容"}
```

frame.url/title 精确匹配子 frame，path 是逐层且每层唯一的 CSS iframe 路径，可再用 url/title 校验最终 frame。路径每次重解析，歧义报错；ref 已携带 frame/session，不能另传 frame。

例如 iframe 的 id 为 `payment_frame` 时，path 应写为 `["#payment_frame"]`。定位失败的 diagnostics 包含失败步骤和至多 10 个当前 frame 的 id、父 id、URL 及省略数量；快照也会列出 frame id/URL。frame_id 每次按当前 frame tree 校验，不是 ref；iframe 重建或导航后的 ID 应重新观察，不猜测替代目标。

## 输入：可操作性与两种模式

click/hover/fill/type 的输入准备会检查可见、启用、非 inert 和几何稳定；fill 还要求可编辑且非只读。select_option 不要求可见几何。timeout_ms 默认 5000，范围 100–30000，覆盖准备、派发和校验；click/hover/press_key 的派发及回执另有 1250 ms 上限，清理最多 250 ms，长 timeout 主要用于等待目标。

准备失败的 diagnostics.reason 区分 display_none、visibility_hidden、zero_size、disabled、inert、read_only、unstable_geometry 和 no_visible_click_point；遮挡仍使用 obstructed/frame_obstructed。不可操作时附当前矩形及至多 8 层 composed 祖先（含目标）的 display、visibility、opacity、pointer-events、overflow、可滚动方向及 transition 属性/时长，ancestors_truncated 表示更深信息未采集。这些是当前样式证据，不推断 hover 触发条件或动画是否即将结束；opacity=0 不单独拒绝输入。

原生元素指针准备在首次命中检查发现遮挡时，可在同一 timeout_ms 内额外执行一次垂直居中、水平最近的即时滚动，再对同一节点重新检查稳定性、命中与所有 frame 边界。仍被遮挡则失败；不会点击覆盖层、切换 DOM 或激活标签。此补救只发生在尚未派发任何输入时：不用于纯坐标、只读 actionable 等待，或已经按下鼠标的拖拽目的端。

原生 click/hover/drag 要求未冻结/丢弃的标签与未最小化窗口，准备前及派发前各检查一次，单次最多 500 ms。无修饰键的左键单击（button=left、click_count=1、modifiers=[]，均为默认值）可在非活动标签尝试执行，支持 ref、selector 及坐标目标；hover、drag、其他按钮、双击及带修饰键的点击仍要求活动标签。普通点击不会自动激活标签，后台事件送达和网站业务成功仍需分别核验，不能据此假设依赖悬停展开的流程也可后台执行。

窗口失焦、document.visibilityState=hidden 或 document.hasFocus()=false 不独立触发拒绝；Click/Hover 成功结果的 page_state 提供这些诊断信号，以及派发前检查观察到的 tab_active。就绪检查通过不保证后台点击每次送达；实际送达仍需可信事件回执，缺失时报告结果未知，不自动重放或切换 DOM 模式。就绪失败的处理见[结果未知时](#结果未知时)。

native 与 dom 由调用者显式选择。DOM click/fill 使用非可信事件且没有用户激活，不能满足依赖 isTrusted、pointer 事件或用户激活的功能。

### browser_click

| 参数 | 选择规则 |
|---|---|
| `ref` / `selector` / `x`,`y` | 三选一；元素目标自动滚入视口 |
| `coordinate_space` | 坐标目标专用：viewport（默认）严格限制视口内；document 自动滚动顶层文档 |
| `button` / `click_count` | left / 1；另可选 middle、right 和双击 2 |
| `modifiers` | 默认 []；Alt、Control、Meta、Shift |
| `mode` | native（默认）或 dom；DOM 只支持 HTML 元素、左键单击且无修饰键 |
| `offset` | 原生元素内的 {x_ratio,y_ratio}，各为 0–1；默认可见区域中心 |
| `settle_ms` | 派发前等待：0–1000 整数或有序 [min,max] 区间，默认 0 |

原生模式核验对应的 click/dblclick/auxclick/contextmenu，成功返回 delivery_verified=true、events_trusted=true。显式元素目标返回 target_verified=true；坐标调用返回 target_verified=null，仅证明事件送达该坐标命中的节点。目标被遮挡或派发中变化时失败；遮挡错误的 diagnostics 附带 hit_target、命中点及受阻 frame，前序输入可能已经送达。

hit_target 描述实际命中的 tag/id/classes/text/role/disabled，以及所属文档视口 CSS 坐标的 rect、position、z_index、visibility；z_index 不代表全局遮挡顺序。classes 最多 8 项，每项最多 100 字符；最近的 clickable_target 也包含 tag/id/classes。这些是当次 DOM 身份线索，不保证唯一或稳定。clickable_hint 和 clickable_target 仅是启发式提示，不改变实际目标；false 不表示无法响应点击。伪元素命中标记 pseudo_element=true。返回 clicked 始终为顶层视口 CSS 坐标，跨进程 iframe 仍检查祖先遮挡；透视变换 frame 不支持。

DOM 模式调用一次 HTMLElement.click()，返回 method=dom、events_trusted=false。HTML select 的原生点击会在派发前拒绝，改用 select_option；系统弹层已打开时先按 Esc。

### browser_hover / browser_drag

hover 接受原生 click 相同的目标，仅发送 mousemove。清理不移走指针，悬停菜单展开后可直接点击子项：

```js
browser_hover({tab_handle, selector:"#menu"})
browser_click({tab_handle, selector:"#menu .child"})
```

需要等待菜单出现时组合 browser_wait。drag 的 source/destination 各自接受 ref、selector 或 x/y，默认 mode=pointer；steps 默认 20，范围 2–100，默认每步约 16 ms：

```json
{"tab_handle":"...","source":{"selector":"#card"},"destination":{"selector":"#column"},"mode":"html5","steps":20}
```

pointer 用于鼠标驱动控件，核验 pointerdown/move/up；html5 用真实拖拽数据完成 HTML 拖放，核验 dragstart/drop/dragend。目的元素可在按住后滚入视口，包含嵌套容器，但不提供持续的视口边缘自动滚动。成功返回 events_trusted=true、delivery_verified=true；失败或相关文档变化后停止并尝试释放本次手势。

可选落点和节奏：

- click/hover、drag 两端的元素目标可带 offset。指定点越界或被遮挡时失败，不改投中心；旋转/倾斜和多行元素按实际内容区域计算。坐标及 DOM click 不接受 offset。
- 原生 click/drag 可带 settle_ms；区间均匀抽样，等待后复查标签就绪，hover 不支持此等待。
- drag 可带 `trajectory:{curve_px:12,duration_ms:600}`。curve_px 为 −100–100 CSS px 的曲线控制点法向偏移，实际曲线最大偏移约一半；duration_ms 为 100–5000 的插值等待总和，不含准备和收尾。steps 控制采样数，曲线越出视口时停止。省略时使用直线及固定间隔。

两端 document 坐标可同时容纳于顶层视口时，在按下前统一滚动；已可见的轴不重复居中。跨屏时 from/to 是各自派发时的视口坐标，不能用差值推断文档距离。

### browser_select_option

目标必须为 HTML select，允许隐藏或零尺寸；label/value 精确匹配，index 从 0 开始，三者选一。重复 label/value 时用 index 消歧；禁用 select/option/optgroup、继承 inert 的目标被拒绝，含 Shadow DOM host 和 slot 祖先。multiple 控件也只保留所选的一个选项。单步与 batch 使用同一实现。

```json
{"tab_handle":"...","selector":"select[name=city]","label":"上海"}
```

不打开原生弹层或主动聚焦；设置后派发合成 input/change 并核验最终选择，返回 method=dom、events_trusted=false、value_verified=true。

### browser_wait

| condition | 等待内容 |
|---|---|
| `attached` / `visible` | 元素出现 / 非隐藏且有尺寸；visible 不要求启用 |
| `absent` | 严格 selector 不再匹配；隐藏的 DOM 元素仍可能匹配 CSS/XPath，role 查询无匹配不证明 DOM 节点已移除 |
| `actionable` | 可见、启用、非 inert、几何稳定且命中无阻挡；不自动滚动，须已在视口内 |
| `text` | 渲染文本 innerText 含 expected，或与完整旧值 previous 不同；二者选一 |
| `value` | input/textarea/select 的 value 或 contenteditable 的 innerText 与字符串 expected 精确相等；不回显字段值 |
| `checked` | checkbox/radio 的原生状态，否则读取 aria-checked；expected 为 true/false，或字符串 mixed |
| `selected` | option.selected，否则读取 aria-selected；expected 为 true/false |
| `expanded` | details.open，否则读取 aria-expanded；expected 为 true/false |
| `url` | 主 frame URL 含 expected |
| `network_idle` | 已观察的请求 inflight=0，且连续 idle_ms 无活动 |

元素条件必须提供严格 selector，可带 frame/nth；全页渲染文字使用 `selector:"body"`。url/network_idle 不使用元素目标。工具只读等待，超时附带条件及最后状态。

控件状态不要求可见或启用。缺失或无效的 ARIA 状态报告 state=unavailable，不按 false 处理；checkbox.indeterminate 对应 mixed。每次轮询重新解析 selector，节点在重渲染中被替换可继续等待，歧义立即报错；frame 不可用不能证明元素消失。等待只验证明确条件，不证明保存或服务端业务完成，超时不使前序动作变得可安全重放。单步和 batch 使用相同的条件与校验。

```json
{"tab_handle":"...","selector":"#toast","condition":"text","expected":"保存成功","timeout_ms":5000}
```

```json
{"tab_handle":"...","steps":[
  {"action":"click","selector":"#open-picker"},
  {"action":"wait","selector":"#open-picker","condition":"expanded","expected":true}
]}
```

network_idle 的 idle_ms 默认 500，范围 100–10000。它只覆盖接管后观察到的页面/iframe 请求，不包含独立 worker 或 WebSocket 消息；长轮询会阻止满足。请求跟踪溢出时 tracking_overflow=true，不能报告已确认空闲。业务就绪优先等待具体元素或标志。

### browser_fill

支持文本类 input（text/search/email/password/tel/url）、textarea 和 contenteditable。native（默认）聚焦、选中并插入文本，不产生逐字 keydown；dom 写入值并派发合成 input/change，不主动聚焦。

两种模式均核对写入后的文本，返回 value_verified=true。默认预期为 text；可显式传 expected_value 指定页面格式化后的保留值，例如 `{text:"06", expected_value:"6"}`。expected_value 只改变核验内容，实际仍写入 text；允许显式空字符串，单步和 batch 使用相同规则。verification_basis=text/expected_value 说明比较依据；不回显字段内容或预期值，也不据此声称输入事件送达或业务成功。不自动按数字/日期归一化，不等待异步格式化或主动 blur。

input/textarea 按 value 精确比较。contenteditable 的 native 模式在插入前确认替换选区仍覆盖字段，选区丢失时以 fill_selection_lost 停止，不插入文本；插入后临时选择字段内容，按浏览器所选纯文本核验并立即恢复原选区及方向。这能区分真实空行与空 div/br 的编辑占位，不用 innerText 的额外换行判定失败；临时选择可能产生 selectionchange。dom 模式通过 innerText setter 写入文本与可见 br 换行，不使用 innerHTML 或 TrustedHTML，也不主动聚焦，按 innerText 核验。

contenteditable 比较将 CRLF/CR 视为 LF；两种模式均允许请求中的普通空格在相同位置以 NBSP 保留（显式请求的 NBSP 仍须原样保留）。不裁剪首尾空白、不合并空格或空行。节点替换、失焦、页面格式化或异步重建仍可能导致结果未知；不回显字段内容，不自动重放，也不等待编辑器保存。read_text 的 visible/value 仍是 innerText，不是浏览器所选纯文本。

fill 不提供编辑器模型写入。遇编辑器管理选区导致的 fill_selection_lost，先观察并确认可编辑表面，可显式改用 click → press_key(Control+A) → type(focused=true) 输入可打印文本，换行/Tab 分别用 press_key Enter/Tab；随后读取编辑器内容核验。此路径不保证适用于所有编辑器，也不会自动执行或切换模式。普通 textarea/contenteditable 的多行替换可直接使用 fill。

工具不自动 blur 或按 Enter。需要失焦校验时显式 Tab 或点击其他目标；自定义下拉须在输入过滤后点击具体选项。

### browser_type

保留文本与选区，聚焦后逐个 Unicode 字符发送可信键盘输入。页面 preventDefault 可阻止输入；非 ASCII 不模拟系统 IME。换行、Tab 等控制键使用 press_key。

ref、selector、`focused:true` 三选一。focused 固定操作开始时已聚焦的可编辑元素，沿可用 iframe 和开放 Shadow DOM 查找，不主动聚焦或清空内容；原元素失焦或脱离文档后停止，不向新焦点继续输入。focused 不接受 frame/nth/selector_type/name，目标范围由当前焦点确定。

```json
{"tab_handle":"...","selector":"input[role=combobox]","text":"上海","delay_ms":[40,180]}
```

```json
{"tab_handle":"...","focused":true,"text":"上海"}
```

delay_ms 为 0–1000 整数（默认 0）或有序区间，每两个字符间独立抽样，末字符后不等待；实际耗时还含协议开销。text 最多 10000 个 UTF-16 单位，总预算最多 30 秒。失焦或节点替换时停止，失败报告已核验字符数，当前字符仍可能送达；delivery_verified 只核验 keydown。

### browser_batch

一次执行 1–20 步，支持 click/fill/type/press_key/hover/scroll/select_option/wait。元素动作使用 selector（可带 selector_type/name/frame/nth），每步重解析，不接受 ref 或坐标；type 也可使用 focused=true，scroll/wait 可按各自接口不带元素目标。

```json
{"tab_handle":"...","steps":[
  {"action":"fill","selector":"input[placeholder=公司名称]","nth":1,"text":"公司名称"},
  {"action":"press_key","key":"Tab"}
]}
```

整批 timeout_ms 默认 15000，范围 100–30000；每步可设更短期限，与剩余总预算取较早截止时间。所有参数先预检，步骤间不插入其他同标签命令。首个失败、主文档变化、断开接管或未处理对话框会停止，已自动处理的 alert/confirm 可继续。

成功返回 completed=true/results；失败返回 MCP isError=true、completed=false、此前 results、failed_step/error，以及 started_at、next_unattempted_step、retry_failed_step_safe。索引从 0 开始，无后续步骤时 next_unattempted_step=null。

显式 start_at 可跳过已审查的完成前缀，重新提交同一 steps；被跳过的步骤仍做参数验证。先观察失败步骤，再决定重试它还是从下一未尝试步骤继续。retry_failed_step_safe=false 表示已派发或无法确认；整批不具备事务或回滚语义。

### browser_press_key

支持 F1–F12、Enter/Tab/Escape/Backspace、Insert/Delete、方向键、Home/End/PageUp/PageDown，以及 ASCII 字母、数字和 US 键盘标点。

- 标点可直接传字符或物理键名，如 Semicolon、Equal、Minus、Comma、Period、Slash、Backquote、BracketLeft、BracketRight、Backslash、Quote、Space。
- `Shift+1` 生成 !，`Shift+/` 生成 ?；直接传 ?、:、+ 自动补 Shift。加号也可写 Plus，组合键示例 `Control++`；大写字母显式 `Shift+A`。
- Control/Alt/Meta 组合不额外插入文本。成功核验可信 keydown；无法校验的 frame 列入 verification_omitted_frames，浏览器保留快捷键可能被截获。

### browser_scroll

可指定容器 ref/selector（可带 frame），或顶层视口 x/y（默认中心）；正 delta_y 向下，正 delta_x 向右，单位为 CSS 像素。

| mode | 行为与结果 |
|---|---|
| `dom`（默认） | scrollBy，不触发 wheel；返回 scrolled、before/after、scope=document/element |
| `wheel` | 原生 wheel，返回 method=native_wheel、dispatched=true，仅确认派发，不确认页面移动 |

无容器目标时，DOM 模式在该点查找可滚动容器，可进入闭合 Shadow DOM/同源 iframe，跨源 iframe 报错；wheel 由浏览器路由并检查祖先遮挡。

虚拟列表可滚动查找并取得新 ref：

```json
{"tab_handle":"...","selector":"#list","until":{"text":"Row 0487","selector":"button"},"delta_y":200,"max_steps":100,"timeout_ms":15000}
```

until 仅支持 DOM 模式，按文本子串查找已渲染且有尺寸的最深匹配节点；重复匹配用 until.selector 消歧。省略 delta_y 时每步约滚 0.8 个容器高度，max_steps 默认 100、范围 1–500，只计实际滚动次数。

返回 found/ref/frame_id/scroll_steps，不自动点击。没有位移时可继续等内容变化；导航、相关 frame 变化、步数或预算耗尽即停止。未找到不证明服务端没有数据；滚动即使未命中也可能触发加载。

查找停止仍返回 isError，diagnostics.reason=scroll_search_stopped。stop_reason 区分 timeout、max_steps、document_changed、frame_changed、control_changed 或 error；scroll_steps 只计已完成并读回的滚动调用，scroll_pending 表示最后一次滚动已派发但未取得有效结果，last_scroll 保存最近一次已确认的 before/after/scrolled。boundary_observed 表示本次查找曾观察到一次无位移，不证明列表已加载到底，也不说明目标在未渲染数据中不存在。预算耗尽不会重发尚未确认的滚动；先观察当前容器和页面状态再决定下一步。

## 导航、对话框与截图

### 导航

browser_navigate 的 url 与 direction=back/forward 二选一，目的地必须是不带 URL 凭据的 HTTP(S) 或 file:// 页面；本地目标需开启扩展的文件访问权限，前进和后退也检查目的地权限。无历史条目或目的地不受支持时在派发前失败。

| 参数 | 默认 / 说明 |
|---|---|
| `wait_until` | domcontentloaded；可选 commit/load，同文档及 BFCache 恢复无需新的加载事件 |
| `timeout_ms` | 15000，范围 100–40000 |
| `include_snapshot` | true；false 只返回导航结果，不采集新快照 |

成功导航后另有 10000 ms 观察预算。观察失败返回导航结果、observation_error 和 observe_again，不表示导航失败。SPA 仍可能继续异步更新；导航前按任务检查保存状态。Hub 单次操作上限 60 秒，客户端等待 65 秒。

### 对话框

输入、evaluate、navigate、wait 和 batch 可带 dialog_policy=ask/accept/dismiss，默认 ask。显式 accept/dismiss 自动处理操作期间的 JS 对话框，返回 dialogs 的消息、类型和处理结果；自动接受 prompt 使用原默认文本。每个操作/步骤最多自动处理 10 个。

未处理的对话框由 snapshot 返回 dialog，普通页面动作被拒绝；仍可释放标签、读取日志或调用 browser_handle_dialog。后者传 accept，prompt_text 仅用于 prompt，返回原始 type/message/default_prompt 及 accepted；default_button=null，无法读取默认按钮焦点。

beforeunload 仅在浏览器实际弹出时可处理。accept 继续导航，dismiss 返回 navigated=false、cancelled_by_dialog=true。这不覆盖系统权限/文件弹窗，也不提供通用的未保存状态检测。

### 截图

browser_screenshot 默认截图视口，full_page=true 截整页，或用 ref/selector 截取元素；元素目标与 full_page 互斥。元素截图是当前 border box 的外接矩形，保留页面遮挡，不是抠图。

元素截图不自动滚动，可直接采集顶层视口外已渲染的区域；祖先 overflow 裁剪仍保留，因此有渲染 box 不代表截图里能看到该元素。需要滚入视口时先显式滚动，再重新截图并使用新映射。

返回 PNG 与 capture：scope、viewport、css_width/css_height、image_origin_css、image_to_viewport_css。图片像素换算为视口 CSS 坐标：`css = 像素 × scale + offset`。整页图的视口外位置需先滚动再输入。

超时 5 秒，超过 4000 万像素被拒绝；元素无渲染 box、负文档坐标或透视 frame 也会失败。后台渲染停滞时显式 activate，或改读 AX/正文。默认隐藏约 1.2 秒的点击反馈，include_indicators=true 可保留。

## 文件上传

直接使用文件 input/关联 label 的 ref 或 selector（可带 frame）：

```json
{"tab_handle":"...","ref":"<文件输入框 ref>","files":["C:/Users/example/Documents/report.pdf"]}
```

隐藏 input 或自定义上传按钮可先 browser_click；结果或 snapshot 出现 file_chooser.pending=true 后，调用 browser_upload_file 省略 ref/selector，使用被拦截的真实 input，不弹系统文件框。开放 Shadow DOM 也可用 evaluate 返回元素 ref。

- files 是浏览器本机的绝对可读文件路径，最多 100 个；支持中文、空格及空文件，内容不传给 MCP 或 Hub。
- 多文件要求 multiple；禁用控件、目录、webkitdirectory 和失效目标会被拒绝。accept 只是页面提示，网站可自行拒绝格式。
- 赋值/清空命令返回后，assignment_acknowledged=true；requested_count 为请求数量，observed_count 为读回原 input 的当前 FileList 数量，count_verified 表示二者是否一致。页面消费/重置 FileList 导致数量不符时正常返回 count_verified=false；原 input 脱离或读取失败时 observed_count/count_verified=null，并附 observation_error。这些情况不把已获得回执的赋值报告为失败，也不证明应用已接受文件。赋值本身抛错或回执超时仍返回已派发、结果未知的错误，不自动重放。
- 非空文件通过 CDP 设置，返回 method=native、events_trusted=null：没有监听核验事件送达或信任状态。files=[] 清空指定 input 或结束待处理选择，显式派发合成 input/change，返回 method=dom、events_trusted=false。两者均返回 application_result=not_checked、observe_again=true，不证明组件接受、解析或服务端上传完成。
- 跨进程 iframe 的 file input 已支持；File System Access API 的 showOpenFilePicker() 不在范围内。

若网站解析文件后重载表单，先等待具体字段或就绪标志，重新观察，再用新的 selector/batch 补齐确认缺失的字段。upload_file 不等待应用解析完成，不自动重放上传或恢复字段；batch 在主文档变化后停止。

## JavaScript 求值

expression 在页面世界执行一次，默认主 frame，可用 frame/frame_id 指定子 frame。返回函数时调用一次并等待 Promise；多条语句用 IIFE。脚本可访问页面状态和产生写操作，但不提供用户激活或调用 MCP 原生输入的能力。

```json
{"tab_handle":"...","expression":"({title:document.title,count:document.querySelectorAll('a').length})"}
```

| 参数 / 上限 | 说明 |
|---|---|
| `expression` | 最多 100000 字符，与 cursor 二选一 |
| `timeout_ms` | 10000，范围 100–30000，无后台任务或超时后的结果续接 |
| `max_chars` | 20000，范围 1–100000，限制每页 value 的 JSON 长度，不含元数据 |
| 捕获预算 | 1000000 个 JSON 字符 / 50000 节点 / 8 层；损失由 capture_truncated 和 $type=truncated 标记 |

默认 result_type=json。数组按完整项、对象按键值对、字符串按片段分页，返回 result_kind、has_more、next_cursor。单项放不下时返回 budget_too_small、required_chars 和 cursor，提高预算续读；分页不拆分嵌套值，单个嵌套值超过 100000 字符时应在表达式中提取更小字段。

第一页已能返回部分字段、但下一完整项超出当前 max_chars 时，同时返回 `next_item:{key或index,required_chars,exceeds_max_chars}`。直接用该 required_chars 和 next_cursor 续读即可；exceeds_max_chars=true 表示超出允许的最大页预算，需重新设计表达式提取更小结果。重新求值会再次执行脚本，不能自动重放含写入的表达式。

续读传 tab_handle、cursor 和可选 max_chars，省略 expression/frame/frame_id；只读缓存，不执行脚本。每标签最多保留一份结果，输入不改变缓存，新求值、相关文档/frame 变化、释放或断连使其失效。

只读自有可枚举数据属性，不调用 getter。undefined、bigint、NaN/Infinity/-0、date、error、function、symbol、accessor、circular_or_repeated 等特殊值用 $type 标记；Map/Set/DOM 等实例需要稳定结果时应自行转换为普通对象或字符串。

需要操作求值找到的元素时：

```json
{"tab_handle":"...","expression":"() => document.querySelector('#target')","result_type":"element"}
```

只接受所选 frame 中单个、仍连接的 DOM Element，返回 ref/frame_id/AX role/name，失效规则同快照。每份当前观察最多追加 500 个 refs；element 结果无 JSON cursor。异步流程可用 `(async()=>{...})()`，长工作流按可观察检查点拆分。

## 诊断日志

```json
{"tab_handle":"...","kind":"console","level":"error","after_seq":0,"limit":100,"max_chars":24000}
```

kind 必填为 console 或 network，各自独立缓冲与序列。将 next_seq 作为同一标签、同次 claim、同一 kind 的 after_seq；切换过滤条件回看旧事件时从 0 开始。has_more 表示还有事件可扫描，过滤掉的事件也会推进游标。读取不消费日志，也可在 JS 对话框打开时进行。

| 参数 / 返回 | 说明 |
|---|---|
| `limit` / `max_chars` | 默认 100 / 24000；范围 1–200 / 1000–100000，约束 entries |
| `level` | 仅 console：log/debug/info/warning/error |
| `url_contains` | 仅 network：最多 2000 字符；只过滤读取，不限制 capture 范围 |
| `data_loss` / `dropped_through_seq` | 缓冲淘汰及缺口；每类最多 500 条 / 1048576 个 JSON 字符 |

日志从 claim 开始，导航保留，释放、detach、关闭或断连清除，不落盘。控制台含 console、异常/rejection 及浏览器 Log 消息，对象为浅层预览；行列号从 0 开始，timestamp/capture_started_at 为 Unix 毫秒。网络事件为 request/redirect/response/finished/failed/cache，按 session_id/request_id/hop 关联；timestamp 为单调时钟秒，request.wall_time 为 Unix 秒。独立 worker、WebSocket 消息不在覆盖范围。

默认不保存 headers/正文。需要检查 XHR/fetch 时先启用捕获，再触发请求：

```json
{"tab_handle":"...","kind":"network","capture":{"enabled":true,"max_body_bytes":65536}}
```

随后读取 method/status、headers、request_body/response_body（text/format/bytes/truncated）；capture.enabled=false 关闭后续捕获，已有记录保留到正常清理。

Authorization、Proxy-Authorization、Cookie、Set-Cookie 及 JSON/form 中命名的 password/token 等敏感字段始终脱敏，普通业务文本仍可能含个人信息。max_body_bytes 范围 1024–262144；二进制、未捕获、超限或缓存不足的正文标记 unavailable，不能当作空正文。单条放不进读取预算时返回截断预览并推进游标，正文较大时提高 max_chars 或降低捕获上限。捕获不修改缓存、service worker 或请求流量。

## 标签栏控制标记

被控标签临时进入无标题的红色原生分组，扩展按钮显示 RUN；不修改页面标题、favicon 或正文。正常释放恢复原分组，保留用户期间的分组调整，不保证原标签顺序。固定标签不能分组，claim 返回 visual_warning，但仍有徽标。

扩展弹窗“释放全部标签页”部分失败时显示错误并刷新剩余控制数量；detach 失败的标签保留控制权，可再次显式释放。

## 限制与排查

- 范围为 Chrome / Edge 的 HTTP(S) 与授权 file:// 页面，不含浏览器内部页、扩展页、Firefox / WebKit、系统原生 UI、下载管理和网络拦截；不保证内置 PDF 查看器的正文访问。open_tab 和 fetch 仍仅接受 HTTP(S)。
- 后台操作要求浏览器运行且页面未冻结；窗口、渲染状态和网站弹窗仍可能影响送达。原生菜单或标签拖动捕获输入时先结束该交互。
- Hub 日志在配对文件同目录的 hub.log；`browser-attach status` 查看连接，`browser-attach stop` 停止 Hub。
- 宿主将大结果保存为 Artifact 后的长行截断，与工具游标分页不同；宿主适配与升级排查见 [Agent 集成](AGENT-INTEGRATION.md)。
