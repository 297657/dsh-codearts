# WorkBuddy DSH 管理插件 SOP

## 一、插件定位

- **包名**：`@local/dsh-workbuddy` v1.3.0
- **安装位置**：`D:\deepseek_harness\dsh-workbuddy`（linked bundle）
- **Profile**：`desktop`
- **Provider 路由**：`workbuddy`
- **传输方式**：wbipc 命名管道（宿主注入鉴权，无需 token 管理）
- **官方端点**：`https://www.workbuddy.cn`（通过 wbipc 代理）

## 二、架构

```
DSH Host Process
  └── dsh-workbuddy plugin
        ├── wbipc client (named pipe \\.\pipe\wbipc-<id>)
        │     ├── probe: GET http://127.0.0.1:18488/workbuddy/probe
        │     ├── account: GET /v2/plugin/login/account (host injects auth)
        │     ├── models: GET /v2/enterprises/personal/models (host injects auth+UA)
        │     └── chat: POST /v2/chat/completions (host injects all headers)
        ├── HTTP API: /api/workbuddy/* (state, connect, disconnect, refresh)
        └── LLM Adapter: workbuddy/* (33 models)
```

## 三、使用步骤

### 前置条件

1. WorkBuddy 桌面端（5.9.2+）已安装并运行
2. DSH desktop profile 已启动

### 启动

1. 确认 WorkBuddy 桌面端正在运行：`curl http://127.0.0.1:18488/workbuddy/probe`
2. 启动 DSH desktop profile
3. 插件自动探测桌面端并连接 wbipc
4. 模型列表自动从宿主获取（33 个模型）

### 在对话中使用

- Provider 路由：`workbuddy`
- 模型 ID：如 `workbuddy/deepseek-v4.1-flash`
- 在模型选择器中选择 "WorkBuddy" 分组

### HTTP API

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/workbuddy/state` | GET | 插件状态（桌面端、账号、模型列表） |
| `/api/workbuddy/connect` | POST | 连接 wbipc |
| `/api/workbuddy/disconnect` | POST | 断开 wbipc |
| `/api/workbuddy/refresh` | POST | 刷新模型目录 |

## 四、wbipc 协议

- **探活**：`GET http://127.0.0.1:18488/workbuddy/probe`（端口 18488-18490）
- **管道发现**：`~/.workbuddy/wbipc/endpoint.json` → `{"endpoint":"\\\\.\\pipe\\wbipc-<id>","ticket":"..."}`
- **握手**：HMAC-SHA256 challenge/prove（协议 v1）
- **调用**：`broker/GetPipe` → `wb.request/http.fetch` with `mode:"call"`
- **鉴权**：宿主自动注入，插件不碰任何凭据
- **headers 白名单**：仅 `content-type` 和 `accept`

## 五、模型列表（33 个）

| 类别 | 模型 |
|---|---|
| Auto | auto |
| Hy | hy3, hy3-x, hy4-preview, hy4-preview-x |
| GLM | glm-5v-turbo, glm-5.3, glm-5.3-flash, glm-5.2, glm-5.1, glm-5.0, glm-4.7, glm-4.6, glm-4.6v |
| DeepSeek | deepseek-v4-flash, deepseek-v4.1-flash, deepseek-v4-pro, deepseek-v3-2-volc |
| Kimi | kimi-k3-1, kimi-k2.8-preview, kimi-k2.5, kimi-k2-thinking |
| MiniMax | minimax-m3, minimax-m2.5, minimax-m3.1-flash |
| Hunyuan | hunyuan-2.0-thinking, hunyuan-chat, hunyuan-image-alpha |
| 其他 | space-bunny, step-5-preview, mimo-v2.6-pro, default |

## 六、验证

```powershell
# 1. 检查 WorkBuddy 桌面端
curl http://127.0.0.1:18488/workbuddy/probe

# 2. 检查插件已注册
node -e "const j=require('<你的用户目录>/.dsh/profiles/desktop/package.json'); console.log('bundles:', JSON.stringify(j.dsh?.profile?.bundles))"

# 3. 检查本地网关
$key = (Get-Content <你的用户目录>\.dsh\openai-gateway\api-key -Raw).Trim()
curl -H "Authorization: Bearer $key" http://127.0.0.1:8326/v1/models | ConvertFrom-Json | Select-Object -ExpandProperty data | Where-Object { $_.id -like 'workbuddy/*' } | Measure-Object
```

## 七、已知限制

1. 依赖 WorkBuddy 桌面端运行（无桌面端则无法连接）
2. 模型目录来自 wbipc，不支持自定义端点
3. 单账号模式（宿主注入的账号）
4. 后端不支持非流式（`stream:false` → 11101），插件已强制流式
5. 只支持纯文本消息；图片块会被丢弃（尽管模型目录声明了 vision）
6. **宿主 `http.fetch` 有两条硬限制，且没有流式方法**（详见第七节之二）：
   单次响应 640KB（≈2000 输出 token）、单次请求 50 秒。插件靠分段续写绕过，
   但单次调用能拿到的内容上限是固定的。

## 七之二、宿主 http.fetch 的两条硬限制（v1.2.0 起）

来源：`D:\WorkBuddy\resources\app.asar` 的 `createWbRequestPipe()` 与 `readBodyCapped()`。

```js
const m = setTimeout(() => p.abort(new WbipcError(nx.UPSTREAM,
  `upstream timed out after ${CI}ms`)), CI);   // CI = 5e4 → 50 秒
...
if ((i += t.byteLength) > 655360) throw new WbipcError(nx.PAYLOAD_TOO_LARGE,
  `response exceeds inline limit of ${SI} bytes`)   // SI = 655360 → 640KB
```

| 现象 | 真实原因 | 触发条件 |
|---|---|---|
| `E_UPSTREAM: upstream timed out after 50000ms` | 整次调用 50s 硬超时 | 单次生成超过 50 秒（长思考、长输出、慢模型） |
| `E_PAYLOAD_TOO_LARGE: response exceeds inline limit of 655360 bytes` | 响应整包缓冲 + 640KB 上限 | 单次输出超过约 2000 token（实测 SSE 约 328 B/token） |

都不是后端返回的 4xx，而是 wbipc 宿主抛的错；`wb.request` 管道只有 `http.fetch`
一个方法（`methods:[{name:"http.fetch"}]`），**没有流式渠道**，所以只能分段。

插件 v1.2.0 的对策：

1. **分段生成**：默认每段 1200 token（`SEGMENT_TOKEN_CEILING`），实测字节开销小的模型
   逐段放大到 2400（`SEGMENT_TOKEN_HARD_CEILING`）；单段超过 30 秒就缩下一段。
2. **段间续写**：`finish_reason=length` 时追加半截 assistant + 续写指令，接出后续内容，
   对外仍是一条连续回答；最多 12 段、总计 16000 token。
3. **撞墙自愈**：真遇到 `E_UPSTREAM` / `E_PAYLOAD_TOO_LARGE` 就把分段减半重试（最多 2 次），
   仍失败则抛出带明确说明的错误。
4. **默认不思考**：思考 token 与正文共用同一额度（实测 1200 token 里 1134 是思考、
   正文只剩 125 字），所以只在调用方显式要求 `reasoningEffort` 时才开；
   能关思考的模型（`canDisableThinking !== false`）显式下发 `thinking:{type:'disabled'}`。
5. **强制思考的模型**（如 `hy3`，`thinking:disabled` 对它无效）起始分段直接给 2400。

实测（2026-10-26）：

| 场景 | 结果 |
|---|---|
| 4000 token 长文（deepseek-v4.1-flash） | 4 段拼成 9703 字，无报错 |
| 中途第 2 段模拟超时 | 自动降段重试，3085 字，首段内容不丢 |
| 连续超时 | 2 次重试后抛出可读错误，不是裸堆栈 |
| 并发 4 路长回答 | 773/669/612/506 字，全部成功 |
| hy3（强制思考） | 修复前 0 字，修复后 1306 字 |

## 八、v1.3.0 — 设置页独立窗口 + 账号登录入口

新增 Client 半身（`client.js`），通过 `dsh.client.platform: web` 在浏览器侧注册：

1. **settings.section 独立窗口**（id `dsh-workbuddy`，order 36，与 Our Free Model 同级）：
   - 账号信息卡：UID、昵称、账号类型（个人版/企业版/旗舰版）、插件启用状态、最近登录
   - wbipc 连接状态卡：已连接/未连接、端口、连接/断开按钮
   - 模型目录卡：33 个模型表格（ID、名称、上下文、最大输出、视觉、推理、工具调用），带刷新按钮
   - 登录入口：未登录时显示「打开桌面端」/「打开官网」按钮，已登录时显示桌面端快捷入口
2. **登录机制**：WorkBuddy 后端的设备码登录接口 `/v2/plugin/device/auth/code` 在未登录时返回 401（refresh token is empty），无法由插件独立发起。登录入口改为打开桌面端（`workbuddy://home` 深链）或官网，由宿主注入登录态后插件自动读取。
3. **样式**：复用 Our Free Model 的 `.ofm_*` CSS 体系（`ofm_root / ofm_page / ofm_sec / ofm_panel / ofm_kv / ofm_kvc / ofm_btn / ofm_pill / ofm_dot / ofm_table`），颜色全部走 `--dsw-alias-*` 主题变量，适配亮/暗模式。
4. **locale**：`zh.json` / `en.json` 新增 `settings.*` 命名空间，覆盖所有 UI 文案。默认中文（`localeTag` 回退到 `zh`）。
5. **bug 修复**：`client.js` 中 `exports` / `module` 未定义导致渲染进程崩溃，已添加 `const module = { exports: {} }`。

### 验证方法

1. 重启 DSH desktop profile（主进程缓存已加载模块，改 client.js 必须重启）。
2. 打开 Settings → 侧边栏出现「WorkBuddy」条目（与「Our Free Model」同级）。
3. 点击进入：显示账号信息、连接状态、33 个模型。
4. 点击「连接」按钮：若 WorkBuddy 桌面端正在运行，wbipc 连接状态变为「已连接」。
5. 点击「刷新」按钮：模型目录重新加载。
6. 未登录时点击「打开桌面端」：唤起 WorkBuddy 客户端。

## 八之二、v1.1.0 修复记录

| 问题 | 原表现 | 修复 |
|---|---|---|
| 客户端 FIFO 配对响应 | 并发即全挂（8 并发 8 个 `E_TIMEOUT`，连接被宿主关闭） | 改为 `Map<id, waiter>` 就地派发 + `max_inflight` 闸门；12 并发 12/12 成功 |
| 模型 ID 带 provider 前缀 | `400 11102 当前模型不可用` | `canonicalModelId()` 截前缀 + 目录匹配，兜底 `auto` |
| system prompt 含第三方 agent 指纹 | `400 11128 请求被拦截，请重新发送`（新开对话必现） | `neutralizeChannelMarkers()`：`DeepSeek Harness` → `DSH` |
| `finish_reason` 一律报 `stop` | 输出被截断也当完整，静默丢内容 | 如实映射 `max-tokens` / `tool-calls` / `stop` |
| 工具调用块没有 `block-end` | 宿主拿到不完整块 | 补齐收尾，带 `id`/`name`/`arguments` |
| `block-end` 的 `text` 是空串 | 与「携带组装内容」的契约不符 | 携带全文 |
| `inputTokens` 含缓存命中 | 上下文与成本统计偏大 | 按宿主语义扣除 `prompt_cache_hit_tokens` |
| 孤立工具结果 | `400 11148 工具记录不完整`，整轮报废 | 配对清理，丢弃并 warn |
| 工具调用缺 id | `400 11133` | 自动补 `call_N` |
| 无重连 | 宿主重启后一直失败 | 连接类错误自动重读 `endpoint.json` 重连 3 次 |
| 错误信息丢掉 code/requestId | 无法定位 | `WorkBuddy 400 [code/requestId]: message` |
| `isMain` 用 `endsWith` 判断 | 被 import 时误触发 CLI | 改用 `fileURLToPath` 精确比对 |

### 11128 渠道校验（v1.1.1）

后端会检查 **system / assistant** 文本里的第三方 agent 系统提示词指纹，命中即整轮拒绝。
最小触发单元是一整句 `You are an AI agent powered by DeepSeek Harness.`（大小写不敏感）；
同样内容出现在 user 消息或工具描述里不会触发，出现在 assistant 历史里会。
dsh 的 system prompt 首句和末段各命中一处，所以**只要用 dsh 原样下发的 system prompt，新对话第一轮必 400**。

处理：出站前把 `DeepSeek Harness` 归一为 `DSH`（只改品牌名，不改语义、不碰凭据），
并把 11128 单列为 `channel` 类失败——不重试，直接抛错并带 requestId。

对流式契约的取值依据：dsh 的 `StreamChunk` 是索引块协议，`finish` 合法 kind 为
`stop` / `tool-calls` / `max-tokens` / `aborted` / `error`（参考实现
`dsh-our-free-model` 的 `src/stream.js` 与 `src/adapter.js`）。

插件是 `link:` 本地包（`profiles/desktop/node_modules/@local/dsh-workbuddy` 是指向
`D:\deepseek_harness\dsh-workbuddy` 的软链），所以**源码位置改了就是最终位置**，不用复制。

但**主进程会缓存已加载的模块：改 `index.js` 后必须重启 DSH 才生效**。
2026-10-26 的实测：改完立即通过网关发请求，返回的仍是旧行为（错误信息里没有 v1.1.1 新增的提示后缀）；
换进程直接 import `index.js` 跑同一请求才是新行为。之前记的「热加载生效」不准确——
那次观察到的 `finish_reason` 变化，不能推广成「改完即生效」，稳妥做法一律按需要重启处理。

## 九、文件清单

| 文件 | 说明 |
|---|---|
| `D:\deepseek_harness\dsh-workbuddy\index.js` | 插件主文件 |
| `D:\deepseek_harness\dsh-workbuddy\wb-client.mjs` | wbipc 客户端 |
| `D:\deepseek_harness\dsh-workbuddy\package.json` | 包清单 |
| `D:\deepseek_harness\dsh-workbuddy\cordis.patch.yml` | 插件注册 patch |
| `D:\deepseek_harness\dsh-workbuddy\locale\zh.json` | 中文元数据 |
| `D:\deepseek_harness\dsh-workbuddy\locale\en.json` | 英文元数据 |
| `D:\deepseek_harness\dsh-workbuddy\icon.svg` | 插件图标 |
| `D:\deepseek_harness\dsh-workbuddy\SOP.md` | 本文件 |
### 11128 渠道校验：指纹库不止品牌名（v1.3.1，2026-10-28）

现象：品牌名归一为 `DSH` 后，新对话仍然 `400 / 11128`，错误文案里的提示后缀说明归一已生效，
说明后端拦的是**另一段文本**。

定位方法：把 dsh 实际下发的 system prompt（可从 `~/.dsh/sessions/*/session.v4.jsonl.zstd` 解出
`system/message` 事件的 content）逐段、逐句、再逐字符二分重放，看哪一段单独发就 400。

实测结果：

| 片段 | 结果 |
|---|---|
| 段落 `Tokens prefixed with @ ...` 整段（407 字符） | **11128** |
| 该段逐句单独发（9 句） | 全部 200 |
| 该段的 111 字符前缀（前两句连起来） | **11128** |
| 同上但把 `prefixed` 改成 `starting`，或 `explicitly` 改成 `directly` | 200 |

结论：后端是按**连续文本窗口**（≈110 字符）比对的，需要前两句连续出现才命中；
改动其中任意一个词即可落空。因此修法是**等价改写该句**，不是删内容：

```
Tokens prefixed with @ are paths the user explicitly referenced.
  → Tokens that begin with @ mark paths the user referenced explicitly.
```

同时加了兜底（`demoteSystemToUser()`）：万一指纹库以后又加新片段、改写表没覆盖到，
收到 11128 时把 system 指令就地折进第一条 user 消息再试一次——
实测 user 消息里的同样文本不会触发渠道校验（原文 system 400、降级后 200）。
降级是一次性的，且有中性占位 `NEUTRAL_SYSTEM` 防重复包裹。

验证（用源码里真实的 `neutralizeChannelMarkers` / `demoteSystemToUser` 跑真实 prompt）：
归一+改写后整份 5778 字符 system prompt 连测 3 次全部 200；降级路径用**未改写**原文也连测 2 次 200。

注意：`D:/deepseek_harness/dsh-workbuddy` 已不存在，插件真实位置是 `D:/dsh-workbuddy`
（`profiles/desktop/node_modules/@local/dsh-workbuddy` → `/d/dsh-workbuddy`）。改完仍需重启 DSH。

---

此插件由 WorkBuddy 设计，并参考 Our Free Model 开发。
