# dsh-token-ledger

DSH Web 的**自记账 token 用量插件** —— 解决「provider 只显示钱、不显示 token」的问题。

OpenCode Go（及其它 provider）会在每次请求的流式响应里精确上报四个数字：
**未命中输入 / 输出 / 缓存读 / 缓存写**。但官方用量面板只按金额显示，DSH 界面
也不聚合它们。本插件把每次请求的这四个数字**自己记下来**：

- **宿主端**：订阅会话事件流（与 DSH 内置 token-meter 同源），把每个请求步骤的
  usage 折叠成一行记录，追加写入磁盘 JSONL 账本（默认
  `~/.dsh/dsh-token-ledger/<日期>.jsonl`），按 今日 / 近7日 / 近30日 / 累计
  汇总，通过 `/token-ledger/*` 路由提供给浏览器。
- **浏览器端**：会话顶部新增「用量」页（与「对话」「轨迹」并列）：统计卡
  （总 token / 缓存未命中 / 缓存命中 / 输出）+ 每次请求的堆叠柱状图
  （蓝=未命中、绿=命中、紫=输出），支持**按请求 / 按小时 / 按天 / 按轮次**
  四种查看模式，悬停柱子查看明细，每 15 秒自动刷新。

## 与 dsh-opencode-go-quota 的关系

- [dsh-opencode-go-quota](https://github.com/GLFzr/dsh-opencode-go-quota)：
  显示 OpenCode Go **额度**（5小时/周/月用量百分比圆环 + 额度告急时向模型注入
  提醒）——回答「还剩多少钱的额度」；
- 本插件（dsh-token-ledger）：逐请求记录 **token 用量**（未命中/命中/输出）——
  回答「到底用了多少 token」。

两者数据源不同、互不依赖，可同时安装：额度圆环在输入框模型选择器左侧，
本插件在会话顶部「用量」页。

## 插件自身耗多少 token？

**≈ 0（零模型 token）**：

- 宿主端是纯本地 Node 代码：折叠事件、追加文件，不调用任何 LLM；
- 浏览器端只是 fetch 本地路由 + 渲染，不注入任何 system prompt；
- 插件不修改任何发送给模型的请求内容，也不占用上下文窗口；
- 唯一的"成本"是浏览器加载几 KB 的 JS bundle —— 那是流量，不是 token。

## 记账口径

| 显示项 | 计算 | 来源 |
|---|---|---|
| 缓存未命中 | `input + cacheWrite` | provider 上报（未命中输入 + 缓存写入） |
| 缓存命中 | `cacheRead` | provider 上报（DeepSeek 64-token 块对齐） |
| 输出 | `output` | provider 上报 |
| 总 token | 四者之和 | 与 DSH token-meter 的 `usageTokens()` 同口径 |

- 同一请求步骤的多次 usage 采样按「最后一次为准」替换，不会重复计数；
- provider 未上报时（极端情况）用字符数/4 估算输出，条目标记
  `estimated-output`，汇总里单独计数，不冒充精确值；
- 宿主进程重启后自动回填当前存活会话（幂等）。

## 安装

```bash
dsh plugin --profile web add <本目录绝对路径>
# 重启 dsh web 后生效
```

## 卸载

```bash
dsh plugin --profile web remove dsh-token-ledger
```

账本文件保留在磁盘上，不会随卸载删除。

## 配置（cordis.patch.yml 或 cordis.yml）

```yaml
- id: token-ledger
  config:
    ledgerDir: C:/Users/me/.dsh/dsh-token-ledger   # 账本目录，默认 <DSH_HOME>/dsh-token-ledger
    retentionDays: 366                              # 保留天数，超期日文件自动删除
```

## 历史回填

插件启动时自动回填**内存中存活**的会话。更早的冷会话可手动补录（宿主从磁盘
会话日志按需加载并折叠，幂等、可重复执行）：

```bash
curl -X POST "http://127.0.0.1:3080/token-ledger/backfill?sessionId=<会话id>"
```

## 验证（怎么确认它准）

插件自带四层验证，全部可重复执行：

1. **单元测试**（折叠/去重/估算/重载幂等/自检路由）：

   ```bash
   cd <插件目录> && node tests/smoke.mjs
   ```

2. **离线重放 + 在线对账**（不依赖 DSH 运行时，独立解析磁盘账本，
   校验每行格式、键唯一性、重复键 token 一致性，再与运行中的
   `/token-ledger/summary` 逐字段对账）：

   ```bash
   node scripts/verify.mjs                # 默认读 ~/.dsh/dsh-token-ledger，对账 127.0.0.1:3080
   ```

3. **宿主自检端点**（内存态 vs 磁盘重放逐字段对比，任何不一致都是 bug）：

   ```bash
   curl http://127.0.0.1:3080/token-ledger/verify
   # → { "consistent": true, "mismatches": [], ... }
   ```

4. **与 DSH 官方 token-meter 投影交叉验证**（最强证据）：对同一会话折叠到官方
   投影的 checkpoint seq，逐字段对比 `~/.dsh/storages/session_projcache.json`
   里的 `tokenUsage` 投影：

   ```bash
   curl "http://127.0.0.1:3080/token-ledger/verify-fold?sessionId=<会话id>&maxSeq=<投影seq>"
   ```

   本机实测：2 个历史会话 × 4 字段（input/output/cacheRead/cacheWrite）全部 MATCH。

5. **人工端到端**：刷新页面 → 会话头部出现「用量」tab → 查看统计卡与柱状图 →
   发一条消息后悬停柱子，请求数 +1、数字增大。

实际数据特征（可作为正确性佐证）：DeepSeek 系缓存的命中量按 64-token 块
对齐，账本里 `cacheRead` 应几乎全部是 64 的整数倍（本机实测 338/338）。

## 数据

每条记录一行 JSON（追加写，损坏行自动跳过，不影响其余数据）：

```json
{"v":1,"key":"<sessionId>:<turn>:<step>","ts":1755500000000,"session":"...","cwd":"E:\\dsh",
 "provider":"opencode-go","model":"deepseek-v4-flash","kind":"provider",
 "input":1234,"output":567,"cacheRead":8901,"cacheWrite":0}
```

- `kind: provider` = provider 精确上报；`kind: estimated-output` = 估算输出；
- `total = input + output + cacheRead + cacheWrite`（四个桶互斥，同 token-meter 口径）。

## 常见问题

### 「用量」页显示「数据不可用」？

宿主路由没起来：确认插件已 add 并重启了 dsh web；打开浏览器控制台看
`[dsh-token-ledger]` 日志。

### 历史会话能回填吗？

能。插件启动时自动回填内存中存活的会话；更早的冷会话用上面的
`/token-ledger/backfill` 手动补录（幂等，可重复执行）。

### 想长期保留数据？

默认保留 366 天。把 `retentionDays` 调大即可；账本是纯文本 JSONL，随时可自行备份/分析。

## 许可

MIT
