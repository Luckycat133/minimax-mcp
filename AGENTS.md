# minimax-mcp — 工程约定

## 架构

薄 MCP 层 + 本地 gateway，两层严格分开：

```
mcp-server.js            薄入口，只转发
src/mcp/                 协议与工具面：contract / tools / handler / stdio-server
src/gateway/db.js        只读 SQLite（系统 sqlite3 CLI，参数转义后内联）
src/gateway/gui.js       GUI 驱动（调 scripts/mac_gui.py）
scripts/mac_gui.py       CoreGraphics 事件注入，纯 ctypes
skills/minimax-mcp/      配套 Agent Skill
```

改工具面只动 `src/mcp/`；改数据来源只动 `src/gateway/`。handler 不做实现，
只做参数校验、前台校验和错误转换。

## 硬规则

1. **数据库只读。** MiniMax App 运行时有内存缓存，写库会造成状态不一致。
2. **不引第三方依赖。** SQLite 走 CLI，GUI 走 python3，传输自己写。
3. **控制工具必须先过前台校验**，不在前台就返回错误，不允许硬点。
4. **`minimax_send_message` 默认不发送**，`send: true` 才回车；发送后必须查库验证。
5. **加工具要同步更新** `src/mcp/tools.js`、`references/mcp-tool-contracts.json`、
   `glama.json` 里的 tools 计数，以及 `tests/smoke.test.js`。

## 测试

```sh
npm run doctor   # 环境自检（不启动 MiniMax，不点击）
npm test         # 真实 stdio 会话冒烟：initialize → tools/list → 只读调用
```

冒烟测试刻意只调只读工具，这样用户正在用 MiniMax 时也能安全跑。

## 已知限制

- 不能按按钮文字可靠点击（Electron 无 AX 树，中文 OCR 不可用）。
- 切会话要点左侧列表，坐标随布局变。
- 窗口被完全遮挡时后台截到旧帧。
- MCP 工具面版本（CONTRACT_VERSION）与 MCP 协议修订号是两件事，别混。

## 实测踩过的坑（都已修，别改回去）

1. **判断"App 是否在前台"不能看最上层窗口**。浮动面板（NSPanel）会一直躺在最上层，
   但它不是活跃应用。必须用 `lsappinfo front` → `lsappinfo info <ASN>` 拿活跃应用。
2. **`CGWindowListCopyWindowInfo(OnScreenOnly)` 会漏掉隐藏/最小化/在别的 Space 的窗口**，
   那种情况会误判成"App 没有窗口"。用 `kCGWindowListOptionAll` 兜底，并配 `open -a` 拉回来。
3. **取焦点窗口必须按目标 App 自己的 PID 查**，不能按"当前活跃应用"查——
   否则 MCP 宿主自己在前台时就会拿到宿主的窗口，点击直接打到宿主上去。
4. **一个 App 可能同时开多个窗口**（主窗口 + 新建任务页）。按键和输入去的是焦点窗口
   （AXFocusedWindow），不是面积最大的那个。算坐标前先用焦点窗口。
5. **`sqlite3` CLI 不接受绑定参数**：SQL 后面多出来的 argv 会被当成下一条 SQL 执行。
   必须转义后内联。
6. **区域截图的坐标**：`screencapture -R` 用像素，我们的坐标系用点，Retina 上要乘
   backing scale（`CGDisplayPixelsWide / CGDisplayBounds.width`）。本机实测是 1.0，
   但换了分辨率设置就会变，代码里必须留换算。

## 分发

```sh
npm run pack:npm     # 打 tarball 并校验内容（不发布）
npm run pack:mcpb    # 打 .mcpb bundle 并解包验证能 require
```

产物在 `dist/`。两个脚本互不删除对方产物。

## 踩过的坑（打包相关）

- 宿主对 Node 的 `fs.copyFileSync` 有文件类型白名单，`.py` 会被拒
  （`CODEBUDDY_BROKER_DENY`）。构建脚本里拷 `.py` 必须走 shell 的 `cp`。
- `cp -R` 不建父目录，目标父目录不存在会 ENOENT，先 `mkdir -p`。
- `npm pack` 会把 `dist/` 一起塞进去，所以 `dist/` 必须留在 `.gitignore` 里，
  且构建脚本要显式排除。

## OCR 层（2026-10-31 加）

`scripts/ocr.swift` → `.cache/ocr`，macOS Vision，`recognitionLanguages = ["zh-Hans","en-US"]`。
`src/gateway/ocr.js` 包一层：`read(region)` / `find(query, opts)` / `pickLeftmostColumn`。

踩过的坑：

1. **同一个标题会出现两次**（侧栏列表 + 主区域顶栏）。直接取匹配度最高的会点到顶栏，
   把标题变成选中态。必须取**最左那一列**再取最上面一个（`pickLeftmostColumn`）。
   这条有单测盯着，别改回去。
2. **`prefix` 模式不能兜底到 `contains`**。第一版把 `t.includes(q)` 写在 mode 判断外面，
   导致 prefix 模式照样匹配中间片段。匹配规则错了会点错按钮，比找不到更危险。
3. **长锚点跨行必挂**。选项文案常换行渲染，OCR 会切成两条观测。`findByAnchor` 会按
   18 → 12 → 8 → 5 逐级缩短重试。
4. **Vision 的 y 轴向上**，屏幕坐标 y 向下，换算要用 `1 - bbox.maxY`。
5. **Vision 不认纯图标**。没有文字的按钮只能退回截图 + 手算坐标。

## 问卷答案校验（src/mcp/questionnaire.js）

- `optionIds` 和 `selectedOptionIds` 两种写法都收（历史数据用后者）。
- 未知 stepId / optionId 一律报错并点名可选值，**不静默忽略**——静默忽略的表现是
  "点了半天什么都没选中"，极难排查。
- 单选题给多个选项会砍成一个并报错。
- 提交后用 `questionnaire_requests.status` 是否离开 `pending` 做真验证，不信"我点了"。

## 设计取舍（不是照搬任何现成东西，想改先看这里）

### 1. brief 只输出"要处理的"，不平铺
一开始的 `status` / `list_sessions` 是给程序看的，不是给人看的——137 个会话倒出来，
读的人还得自己判断哪个重要。`brief` 把判断做在服务端：
**等你决定 → 报错 → 卡住 → 在跑 → 刚完成**，安静的旧会话直接不输出。

每条的 `why` 是"为什么值得看"，`next` 是"下一步调什么"。没有 `why` 的条目等于噪音。

判据来自实测：
- 会话 `status='error'` 带 `error_message`，这是真实失败（比如 Token 上限），必须报；
- `status='started'` 只表示"这轮没结束"，不等于在生成——有 pending 提问时也是 started，
  所以"等你决定"要排在它前面，否则会把它误报成"在跑"；
- 后台任务失败**不改变会话状态**，光看会话列表必然漏掉，所以单独列 `taskFailures`。

### 2. 三档风险分级，不是二档
MCP 只有 `readOnlyHint` / `destructiveHint` 两个布尔，但"点一下界面"和"替你回句话"
完全不同。内部用 read / ui / commit 三档，对外压成协议字段。
`stop_generation` 归 ui 是刻意的：它是安全阀，加确认等于给刹车加锁。

### 3. 审计是必需品，不是附加项
GUI 操作没有 undo。`~/.minimax-mcp/audit.jsonl` 记 tool / level / 脱敏参数 / 耗时 / 目标坐标。
审计失败绝不能影响主流程，所以 `record()` 全程 try-catch 吞异常。

### 4. 提交后一律回数据库核对，不信"我点了"
`send_message` 查 `local_runtime_message_rows`，`answer_question` 查
`questionnaire_requests.status`。返回里的 `verified` 是数据库事实。

## 设计取舍（不是照搬任何现成东西，想改先看这里）

### 1. brief 只输出"要处理的"，不平铺
一开始的 `status` / `list_sessions` 是给程序看的，不是给人看的——137 个会话倒出来，
读的人还得自己判断哪个重要。`brief` 把判断做在服务端：
**等你决定 → 报错 → 卡住 → 在跑 → 刚完成**，安静的旧会话直接不输出。

每条的 `why` 是"为什么值得看"，`next` 是"下一步调什么"。没有 `why` 的条目等于噪音。

判据来自实测：
- 会话 `status='error'` 带 `error_message`，这是真实失败（比如 Token 上限），必须报；
- `status='started'` 只表示"这轮没结束"，不等于在生成——有 pending 提问时也是 started，
  所以"等你决定"要排在它前面，否则会把它误报成"在跑"；
- 后台任务失败**不改变会话状态**，光看会话列表必然漏掉，所以单独列 `taskFailures`。

### 2. 三档风险分级，不是二档
MCP 只有 `readOnlyHint` / `destructiveHint` 两个布尔，但"点一下界面"和"替你回句话"
完全不同。内部用 read / ui / commit 三档，对外压成协议字段。
`stop_generation` 归 ui 是刻意的：它是安全阀，加确认等于给刹车加锁。

### 3. 审计是必需品，不是附加项
GUI 操作没有 undo。`~/.minimax-mcp/audit.jsonl` 记 tool / level / 脱敏参数 / 耗时 / 目标坐标。
审计失败绝不能影响主流程，所以 `record()` 全程 try-catch 吞异常。

### 4. 提交后一律回数据库核对，不信"我点了"
`send_message` 查 `local_runtime_message_rows`，`answer_question` 查
`questionnaire_requests.status`。返回里的 `verified` 是数据库事实。
