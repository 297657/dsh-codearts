# dsh-codearts —— 签到插件备忘

## 定位

只做「每日签到」，不注册 LLM 适配器、不登录、不改凭据。读宿主已有凭据，
按渠道调用签到端点，结果挂在 `/api/codearts-checkin`，并在启动后 15s 自动跑一轮
（`DSH_CODEARTS_AUTO_CHECKIN_DELAY_MS` 可调，设 0 关闭）。

## 渠道与协议

| 渠道 | 站点 | 状态查询 | 领取 |
| --- | --- | --- | --- |
| `buddy`（CodeBuddy 中国版） | `copilot.tencent.com`（固定） | `POST /v2/billing/meter/checkin-activity-status` | `POST /v2/billing/meter/daily-checkin` |
| `workbuddy` | 凭据里的 `domain`（`.ai` / `.cn`） | 同上 | 同上 |
| `codearts`（华为云） | `snap-access.cn-north-4.myhuaweicloud.com` | `GET /v1/ops/delivery?channel=IDE` | `POST /v1/ops/claim` → `POST /v1/ops/confirm` |

参考实现：`dsh-our-free-model@2.1.0` 的 `vendor/channel-pack/pack.js`
（`credits.ts` / `codearts-credits.ts` 打包产物）。2.8.0 已整体删除签到代码，
npm 上仅 2.0.0 / 2.1.0 两版带参考，用 `npm pack dsh-our-free-model@2.1.0` 取回。

## 关键细节（都是踩出来的）

1. **腾讯侧三个头必须齐**：`X-Domain` / `X-Product: SaaS` / `X-Product-Code`。
   2.1 的取值是 `product.apiDomain || credential.domain`；本插件对 `workbuddy`
   改成**以凭据 domain 优先**，因为同一 provider 存在 `.ai` / `.cn` 两侧账号，
   把 `.cn` 账号的请求发到 `.ai` 只会 401。
2. **判定看响应体 `code`，不看 HTTP 状态**：重复签到是 HTTP 400 + `code:10001`。
   401/403 时网关会返回 HTML，`response.json()` 会抛 `Unexpected token '<'`，
   必须先取文本再解析，否则「凭据过期」会被报成无意义的 JSON 错误。
3. **华为云侧 `Agent-Type` / `X-Language` 必须在签名之后追加**，进 canonical
   request 会让服务端回 `401 APIG.0301`。
4. **`campaignId` 是数字**，按字符串读会得到空串，领取被判「缺少 campaignId」。
5. **领取后若 `id !== null` 必须补 `confirm`**，否则积分停在待确认。
6. `workbuddy` 的 `.ai` 账号实测 `active:false`（换任何头都一样）——那是服务端
   结论，插件如实报 `inactive`，不去发领取请求。是否有活动由账号所在站点决定。

## 验证方式

- 桩 ctx：`node wb-diag/probe-codearts.mjs`（工作区 `2026-10-26-13-05-39`），
  验证路由挂载与 `status` / `claim` 响应结构，只读不写。
- 真实运行时：复制 desktop 的 `package.json` 成临时 profile + junction `node_modules`，
  `dsh --profile <临时> --no-open --port 39xx`，看日志有无 `did not activate`，
  再 `curl /api/codearts-checkin/status?token=...`。
- 只查状态、不领取：直接 import `lib/*.js` 调 `fetchBuddyStatus` / `fetchCodeArtsStatus`。

## 坑

- 插件靠 `link:` 装在 `node_modules/@local/dsh-codearts`，改源码**不需要重装**，
  但**必须重启 DSH** 才生效。
- bundle 条目名必须与 `package.json` 的 `name` 一致（`@local/dsh-codearts`），
  否则浏览器半身/激活会对不上（ofm 2.8.0 踩过，见 dsh-workbuddy/MEMORY.md 第 13 节）。

## 浏览器半身（v0.3.0，2026-11-04）

背景：v0.2.0 只有宿主半身，`/api/codearts-checkin` 能通，但设置里**没有任何入口**，
用户看不到签到状态，只能手动敲 API。这不是故障，是当时没写客户端半身。

现在补了 `client.js`：在 `settings.section` 注册「签到」页（id `dsh-codearts`，
order 37，排在 WorkBuddy 36 之后），展示三渠道每个账号的状态与额度，
提供「立即签到」「刷新」两个按钮。`package.json` 对应加了：

```json
"exports": { ".": "./index.js", "./client": "./client.js" },
"dsh.client": { "platform": "web", "immediately": true, "inject": [] }
```

**客户端半身的三条硬约束**（下次改别再踩）：

1. `window.__ModuleLoader__.load({ id })` 的 `id` **必须等于包名**
   `@local/dsh-codearts`。ofm 的教训：包内 `package.json` 的 `name` 和组合条目名
   不一致时，宿主不会下发客户端半身，设置页凭空消失（宿主半身却照常运行，
   所以只能从「前端 bootstrap 的 plugins 组合列表里有没有你」来判断）。
2. React 方法在文件顶部**解构**拿（`const { createElement: h, useState } = React`），
   所以任何 Mock 必须在加载前就位，事后替换 `React.useState` 不生效。
3. `ctx.slots.inject('settings.section', () => ctx.slots.register(reg, render))`，
   render 返回元素即可；样式用 `ctx.effect` 插 `<style>`，记得返回移除函数。

## 验证方法（改完客户端半身必跑）

```bash
# 1) 渲染桩：注册 + 空态 + 有数据态（抓「渲染抛错」，Node 里跑，不用开 DSH）
node <工作区>/wb-diag/probe-client.mjs

# 2) 真实例：隔离 profile + 独立端口，抓前端 bootstrap 的 plugins 组合列表
#    必须能看到 plugins/??@local/dsh-codearts/client.js&rev=xxxx
#    再拉该组合 URL：应 200，且含 settings.section 与页面文案
```

第 2 步抓到的 `rev` 会随文件内容变化——**改了 client.js 必须重启宿主**，
旧实例内存里还是旧 rev。桌面端不会热更插件代码。

## 账号管理（v0.4.0，2026-11-04）

> v0.5.0 起 CodeArts 也支持页面内添加（见文末「CodeArts 页面内登录」）。

背景：ofm 2.8.0 把 `buddy` / `workbuddy` / `codearts` 三个渠道**整体移出账号池管理**
（只剩 10 个免费渠道），账号数据与凭据仍在 `channel-pack/state.json` + `.credentials.yaml`，
所以模型和签到都能用，但**没有任何入口能新增或退出**。2.1.0 有这些功能，2.8.0 删了。

### 已实现（签到页）

| 操作 | 路由 | 说明 |
| --- | --- | --- |
| 退出账号 | `POST /accounts/remove` | **先 `credentials.unset(ref)` 再删池记录**；凭据清不掉就整体中止，不留「列表没了、密钥还在」 |
| 启用/停用 | `POST /accounts/toggle` | 只改 `enabled`，不碰凭据，随时可恢复 |
| 添加账号 | `POST /accounts/add` | 仅 `buddy` / `workbuddy`：取授权地址→浏览器授权→后台轮询→写凭据 |

### 三个必须守住的约束

1. **只允许操作 `CHANNELS` 里的三家**。账号池里还有 qoder/trae/zcode/raccoon 等，
   它们归 ofm 管；越界删除会让 ofm 的免费渠道失效。
2. **写 state.json 必须原子**（临时文件 + rename）。这个文件 ofm 也在读写，
   中途失败留下半个 JSON 会让整个账号池读不出来。
3. **`credentials.unset` 不可省略**。只删池记录等于留下孤儿密钥：账号看不见了，
   密钥还在文件里，而且下次同名 ref 可能撞车。

### 登录移植（lib/buddy-login.js）

从 2.1.0 `vendor/channel-pack/pack.js` 逐段搬的（`credits.ts` / `buddy-auth.ts`）：
`POST /v2/plugin/auth/state?platform=` → 用户在浏览器授权 → `GET /v2/plugin/auth/token?state=`
轮询 → `GET /v2/plugin/login/account?state=` → 拼凭据 JSON。

产品常量必须逐字段对齐，尤其：
- `buddy`: platform `ide`、endpoint `https://copilot.tencent.com`、UA `CodeBuddyIDE/1.106.1`；
- `workbuddy`: platform `workbuddy-ai`、endpoint `https://www.workbuddy.ai`、UA `WorkBuddy/5.5.2 …`；
- 取账号那步的 `X-Domain` 用 **`token.domain`（服务端本次下发）**，不是产品默认值。

两步式返回很重要：`account.create` 必须**立刻**返回 loginUrl，前端在点击手势里
`window.open('about:blank')` 占位再导航；等 RPC 回来再 open 会被当弹窗拦掉。

### CodeArts 页面内登录（v0.5.0，2026-11-04）

已实现，代码在 `lib/codearts-login.js`。协议全部来自 2.1.0 的
`vendor/channel-pack/src/{oauth,login}.ts`（`npm pack dsh-our-free-model@2.1.0` 可取回）。

**流程**：PKCE + ES256 密钥对 → 本地回调服务器（端口 ≥ 10000）→
`POST https://codearts.huaweicloud.com/portal/authorize` 授权 →
回跳 `/oauth/callback?code=` → 用 PKCE + DPoP 向
`https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens` 换临时 AK/SK/ST。

**四个必须守住的细节**：

1. **`code_challenge_method` 写 `SHA-256`，不是 `S256`**。portal 只认前者。
2. **ES256 的 JWS 签名必须是 64 字节 raw R||S**。Node `crypto.sign()` 默认出 DER，
   必须传 `dsaEncoding: 'ieee-p1363'`。弄错时服务端只回含糊的 `invalid_dpop_proof`。
3. **回调端口必须 ≥ 10000**（`MIN_CALLBACK_PORT`）。低端口 portal 会拒。
4. `htu` 是完整 URL 且**不含 query**，与实际请求目标逐字符一致。

**不引 jose**：原实现依赖 `jose` 做 ES256，这里用 `node:crypto` 的
`generateKeyPairSync` / `createPrivateKey({format:'jwk'})` / `sign` 手搓，无新增依赖。

### ⚠️ refresh_token 是一次性的（最重要的一条）

实测：用同一枚 refresh_token 刷第二次，STS 返回
`400 {"error_code":"STS5.1806","error_msg":"invalid refresh token: 'the refresh token has been used'"}`。

由此推出三条硬约束，**全都踩过**：

1. **探针绝不能碰真实凭据**。一次 `status` 就可能触发续期，把用户账号的
   refresh_token 烧掉，且新 token 只存在于那个进程里——进程一退，账号就废了。
   `wb-diag/probe-codearts.mjs`、`probe-add.mjs`、`probe-accounts.mjs` 现已全部改为
   自建假账号池 + 假凭据 + 假网络，**不再读真实 `~/.dsh`**。
2. **同一账号不能在一轮里刷新两次**。`claimAll` 里「查状态」和「领取」各调一次
   `credentialOf`，天然会刷两次 → 第二次必失败。已加 `refreshInFlight`（在途共享）
   + `refreshCache`（按**被消费掉的那枚旧 refresh_token** 作键缓存 5 分钟）。
   用旧值作键而不是比对当前值：落盘成功时文件里已是新 RT，压根不用再刷；
   落盘失败时文件里仍是旧值，只有旧值能命中。
3. **落盘失败不能丢新凭据**。新 RT 只在刷新响应里，旧的那枚已被标记 used。
   所以 `store.set` 失败降级为「内存保留 + 界面告警」，而不是整体失败。

**AK/ST 寿命约 2 小时**（`credentials.expiration`），`REFRESH_LEAD_MS = 15 分钟`
提前续期。`credentialOf` 在临期/过期/无 expires_at 时自动续期，续期失败但旧凭据
未过期则继续用旧的。

### 验证方式

- `node wb-diag/probe-codearts-login.mjs`（47 项，离线）
  假 fetcher 拦 STS，跑完整回调链路；再用 header 里的 jwk **真验签** DPoP，
  并核对 `sha256(code_verifier) === code_challenge`。
- `node wb-diag/probe-codearts.mjs`（22 项，离线端到端）
  临时 `DSH_HOME` + 假账号池 + 全局 fetch 桩，验证路由、三渠道映射、
  **自动续期 + 写回 + 续期去重**、领取与 confirm、404。
- `node wb-diag/probe-add.mjs [--no-credentials]`（添加路由，含 CodeArts 授权地址）
- `node wb-diag/probe-accounts.mjs [--no-credentials]`（退出/启停/越界拒绝）
- `node wb-diag/probe-client.mjs`（渲染桩：断言三家都有「添加账号」、无残留旧文案）


---

## 模型渠道（v0.6.0，2026-11-04）

CodeArts 的免费额度不只能签到，还能当模型用。v0.6.0 把这条渠道注册进了 DSH，
于是「设置 → 签到」里登录的账号会同时出现在模型选择器里。

### 为什么 provider id 叫 `devcloud` 而不是 `codearts`

Our Free Model 2.8.0 起在 `src/magpie-policy.js` 里把 `codearts|huawei|workbuddy|
codebuddy` 列为拒绝渠道，凡是命中名单的 provider id 与模型行都会被从
`/api/providers`、`/api/upstream` 与网关模型清单里**过滤掉**。用 `devcloud`
（华为云的旧名）不含这些关键词，模型才出得来。这是与既有插件共存的必要取舍。

同理：2.8.0 不只是加了黑名单，`vendor/channel-pack` 里 codearts 的实现被**整段删除**
（`grep codearts vendor/` 计数为 0）。所以「改个开关就能恢复」是不成立的。

### 协议要点（实测，勿凭猜）

- 端点 `https://snap-access.cn-north-4.myhuaweicloud.com/api/v2/chat/completions`
- 鉴权是华为云 `SDK-HMAC-SHA256`（**不是** AWS SigV4）：待签名串只有三行，
  `Authorization: SDK-HMAC-SHA256 Access=<AK>,SignedHeaders=...,Signature=...`，
  canonical URI 末尾必须补 `/`，query 不排序不重编码。见 `lib/sigv4.js`
- **UA 不伪装**：内核 `attributionHeaders()` 发的是
  `deepseek-harness/<ver> (+https://github.com/deepseek-ai/deepseek-harness)`，
  即老实自报身份。对比腾讯系的 `CodeBuddyIDE/1.106.1` 才是伪装。
- `assistant` 消息必须带 `reasoning_content`（空串也要带），否则 deepseek-v4 400
- 思考开关是**顶层** `thinking: {type:'disabled'}`；传 `enabled` 与不传等价
- `tool_stream: true` 让大工具参数分段传输，否则单条 SSE 过大被掐断
- `max_tokens` 上限 65536（131072 实测被拒成空流）

### 额度是积分制，不是「某些模型免费」

`/v1/model/builtin` 的每一行都带 `credit`（input_price/output_price/ratio），
**没有免费的标记位**。`maas_type: benefit` 声明的是「走免费权益积分」，服务端
按账号当前权益决定给不给，不认就回 `InferHub.4004.200`。策略因此是
**默认都带、被拒就去掉并记住**（`noBenefitModels`），每种模型最多多花一次往返。

### 并发会话上限 3（最容易踩的坑）

`TM.00001041` 的真实含义实测是 **「并发会话数已达上限(3个)」**，不是"排队"。
而且：

- 限制**按模型**分别计算（glm-5.3-flash 满了，openpangu-2.0-flash 仍可用）
- 会话释放**有延迟**，实测连续两次请求（间隔 <1 秒）第二次必失败，
  等 100 秒后可再次成功
- 所以短时间反复调试同一个模型会把自己锁死，换模型或等 1~2 分钟

对应实现：收到 `[DONE]` 后**主动 `reader.cancel()`**，否则会一直等对端关连接，
期间该会话在服务端仍算「进行中」，白占名额。

### 模型清单以服务端为准

`/v1/model/builtin` 下发 `context_window`、`max_tokens`、`supports_images`、
`display_enabled` 与 `time_slots`（错峰折扣提示）。这些都直接采用，不再硬编码。
`opengw.developer.huaweicloud.com/api/v1/gateway/config` 实测对部分账号回
`invalid channel, group not found`，所以它只是补充来源，失败不影响可用性。

### 验证

- `node wb-diag/probe-sigv4.mjs` — 18 项，与 2.1.0 的签名实现**逐字节**比对
- `node wb-diag/probe-codearts-llm.mjs` — 52 项，全离线（假 fetch + 假 SSE）：
  消息序列化、请求体、四类流式事件、错误分类、benefit 降级、签名头
- `node wb-diag/probe-codearts.mjs` — 30 项，含适配器五方法契约
- `node wb-diag/probe-sigv4-live.mjs` — 真实网关只读 GET，判断签名是否被接受
- `node wb-diag/probe-codearts-live.mjs [模型] [提示]` — **真实对话**（消耗少量额度）

真实链路已验证：正文流式 ✓、思考开关 ✓、工具调用（分片参数 + 服务端 call id）✓、
usage ✓、finish ✓。

### DSML 工具通道（v0.6.1）

`deepseek-v4-flash` / `deepseek-v4-pro` 不认标准 `tools` 字段：发了它也只会在
正文里输出一段 `<｜DSML｜tool_calls>` 文本。这类模型改走 DSML：

1. **不发 `tools`**，改为把「工具清单 + 语法说明」插进 system 消息（`lib/dsml.js`
   的 `buildDsmlSystemPrompt`）；
2. 从 `delta.content` 和 `delta.reasoning_content` 里解析 DSML 块，翻译回标准
   tool-call 块（`DsmlExtractor`）。

三个必须记住的实现细节：

- 标记用的是**全角竖线** `｜`（U+FF5C），不是 ASCII `|`。源码里一律用
  `\uFF5C` 转义拼常量，别手打全角字符（容易在中转环节被改成半角）。
- **标记会被切在两个 chunk 之间**。提取器在 `normal` 态要扣住「像标记前半截」
  的尾巴（`holdTail`），否则会把 `<｜DSML｜tool_` 当正文吐给用户。探针里专门
  用「逐字符喂」验证这一点。
- 工具调用是**整块到达**的（不像标准通道分片），所以 `block-start` 与完整参数
  一次发完；id 自己造（`dsml-<hex>`），服务端不给 call id。

**判定只认 `^deepseek-v4-(flash|pro)$`。** 实测 `deepseek-v4.1-flash` 支持标准
`tools` + `tool_calls`（真网关返回 `finish: tool-calls`），不要顺手写成
`v4(\.\d+)?`，否则会把本来好用的模型降级成纯文本回答。

**DSML 未在真实网关上验证过**：当前账号的模型清单里没有 v4-flash / v4-pro，
硬填 id 会回 `TM.000010051 您当前无权调用该模型`。所以 DSML 只过了离线验证
（57 项，含逐字符切分、并发调用、残缺块回显）。等账号拿到该模型权限再补真实验证。

### 并发上限的修正（v0.6.1 实测）

之前记的「限制按模型分别计算」**不成立**。实测先撞 glm-5.3-flash 的上限，
换 openpangu-2.0-flash 成功；但同一时段稍后 openpangu 与 glm 同时报
`TM.00001041 并发会话数已达上限(3个)`。更可能是**按账号计 3 个并发会话**，
先前那次成功只是因为前一批会话刚好释放。调试时短时间内反复请求同一账号，
必然把自己锁死——每次调用后要等 1~2 分钟。

---

## 并发会话治理 + 剩余积分（v0.6.2，2026-11-04）

### 限额作用域：确认「按账号」

`wb-diag/probe-codearts-limit-scope2.mjs`：在 A 上开一路持续输出的流并**保持不断**，
此时在 B 上打一次极小请求 —— **B 成功**。结论：`TM.00001041` 是按账号计，
不是按用户/租户。所以「多账号轮转」是真的能加吞吐的（两个账号 = 6 个并发）。

顺带实测到一条容易误判的现象：**A 报满后毫秒级接着打 B，B 也会报满**；
隔 400ms 再打就正常。所以代码里换账号之间加了 400ms 间隔
（`streamChat` 的 `tried > 0` 分支）。别把那次「两个账号同时满」当成按用户计的
证据——它就是突发流量被上游一起挡了。

### 服务端没有「会话列表 / 关闭会话」接口

一次性探过（`wb-diag/probe-codearts-queue.mjs`，只读 GET）：

| 路径 | 结果 |
| --- | --- |
| `/api/v1/queue/list`、`/api/v1/queue`、`/api/v1/queue/tasks` | `404 APIG.0101 接口不存在` |
| `/api/v1/chat/sessions`、`/api/v1/sessions`、`/api/v1/session/list`、`/api/v2/chat/sessions` | 同上 |
| `/api/v1/queue/status` | **存在**，但 `task_id` 必填（缺了回 `PARAM_VALUE_CANNOT_NULL`） |

`queue/status` 的真实形状（实测 200）：

```json
{"task_id":"<账号前缀>:<你传的 task_id>","model":"GLM-5.2","status":"working",
 "queue_length":0,"queue_position":0,"message":"","buttons":[],"links":[]}
```

`status` 取 `waiting|working|error|queue_full`；请求头必须是
`x-snap-traceid` + `Agent-Type: INFERHUB_AGENT` + `X-Language: en`，且这三个头
**在签名之后追加**（2.1.0 的 `queryQueueStatus` 就是这么写的）。
注意 `Agent-Type` 与签到用的 `PromptCenter` 不是一个值。

结论：**「看不到会话」只能做到「看到我们自己发起的流」**。别指望做服务端会话管理。

### 「越用越卡、只能重启」的真正原因：异常路径没断流

`parseSse` 原来只在 `finally` 里 `reader.releaseLock()`，**异常退出不 cancel**。
于是流式请求一旦中途报错（限流、工具参数过大、用户取消……），TCP 连接还挂着，
服务端就一直把这一路算成「会话进行中」。攒够 3 个，之后所有请求都回
`TM.00001041`，看起来像「账号废了」。现在异常路径一律 `reader.cancel()`。

### 本机闸门（`lib/sessions.js`）

- `acquireSlot(accountId)`：每账号并发上限默认 3（= 服务端上限），
  超出的**排队等**（`DSH_CODEARTS_MAX_CONCURRENCY`、上限等待 120s），
  而不是立刻抛错——用户看到的是「思考中」。
- 在途登记：`registerSession` / `inflightOf` / `abortAllSessions`。
  **终止 = abort 控制器 = 断流 = 服务端名额释放**，这是唯一「用户能主动关会话」的手段。
- 冷却：撞满后给账号打 45s 冷却，期间优先换别的账号。
- 退避：全部账号都满时按 3s / 9s / 20s 重试（`DSH_CODEARTS_QUEUE_BACKOFF_MS` 可覆盖，
  探针里压成 `0,0`）。已经吐过正文的流**不重试**（`error.partial`），否则内容会重复。

### HTTP 400 的报文也要分类

用户截图里那句 `codearts: HTTP 400: {"error_code":"TM.00001041",...}` 是旧版本的
直接透传：`TM.00001041` 走的是 **400 而不是 429**，原先只在非 2xx 分支里判 429，
业务码根本没看。现在 `mapHttpError` 按「401/403 → benefit → 无权 → 额度 → 并发 →
其它」的顺序分类，顺序不能乱（先判 429 会把「并发已满」误报成「限流」）。

### 剩余积分：`statistics/plugin` 的 `metrics`

同一个接口（`GET /snap-manager/v1/statistics/plugin`）既给套餐判定，也给积分余额：

```json
{"name":"usageTotalPackageCredit","package_credit_amount":14600,
 "package_credit_used":6581.42,"package_credit_remain":8018.58,
 "package_credit_expiring_amount":53.59}
```

`package_credit_remain` 就是界面上的「剩余积分」。指标名四选一：
`usageTotalPackageCredit` / `usageBasicPackageCredit` /
`usageOnDemandPackageCredit` / `usageBonusPackageCredit`；只有前者是总计。
**必须区分「没有积分指标」（显示 —）和「积分为 0」**，否则用户会以为额度用光了。

展示对齐 ofm 的账号卡：标题行 `· 剩余 8.0K`，账号行 `剩余积分 8.0K`，
再补一行 `积分包：总 14,600 · 已用 6,581 · 即将过期 54`。

### 新增路由与界面

| 路由 | 作用 |
| --- | --- |
| `GET /sessions` | 本机在途流 / 各账号占用与冷却（纯本地，不打上游） |
| `GET /sessions?queue=1` | 附带一次服务端排队探测（用 `lastModel`） |
| `POST /sessions/abort` | 终止全部（或指定 `id`）在途流 |

设置页 CodeArts 卡片多了「会话 N / 上限」面板：在跑的模型、阶段、已跑秒数、
本机排队数、冷却名单，以及「终止全部 / 检查排队」两个按钮。面板 8 秒自刷一次。

### 验证

- `node wb-diag/probe-sessions.mjs` — 49 项，全离线：闸门 FIFO/取消、在途登记、
  错误映射、换账号、退避次数、已吐正文不重试、异常路径断流、本地排队。
- `node wb-diag/probe-client.mjs` — 渲染桩新增「剩余积分 / 会话面板」断言。
- `node wb-diag/probe-codearts-pool-live.mjs` — 实网：多账号池跑通 + 排队状态可用。
- `node wb-diag/probe-codearts-quota-live.mjs` — 实网只读：余额字段与队列端点形状。

## 重复账号与积分口径（v0.6.3，2026-11-04）

用户报「积分不准确」：两个 CodeArts 账号显示**完全相同**的
`剩余 8.0K / 总 14,600 · 已用 6,581.66 · 即将过期 53.35`。

真因不是取数错，是**同一个华为云账号被登录了两次**：

- 两次 `startCodeArtsLogin` 拿到的是不同 AK/SK（`HSTAOFII…` / `HSTAMVI3…`），
  看起来像两个账号，但 `refresh_token` 的 JWT `user_profile` 里
  `account_id` 一模一样（实测 `01a1390acda578b58b26d92238c8827c`，
  `account_name` `hid_kq95xrj_fck2th5`）→ 同一份额度。
- 触发条件：浏览器里已登录华为云时再点「添加账号」，授权会**静默复用**当前
  登录态。用户当时看到「点了没反应」（后台失败无提示），于是又点了一次。
- 后果三个：① 每行都显示同一份余额，像是各有一份；② 标题行把额度加成 16.0K；
  ③ 账号池按 2 个账号放行 6 个并发名额，服务端其实只给 3 个。

修法（都靠身份，不靠 AK/SK/昵称）：

- `lib/identity.js`（新）：`codeArtsIdentity(credential)` 解 `refresh_token`
  →`user_profile`（base64url JSON）→ `{key: account_id, name: account_name}`。
  读不到返回 `undefined`（＝无法判重，不能当「不重复」也不能当「重复」）。
- `lib/duplicates.js`（新）：`findDuplicateAccount`（添加时拦）、
  `markDuplicates`（状态里标 `duplicateOf` / `duplicateName`）。
- `index.js`：`/status` 每行带 `identity`，老账号顺手补写 `identityKey`、
  昵称从 `codearts-xxxx` 换成真实账号名；添加账号在落盘前判重，
  命中就撤掉占位账号 + 推提示；`resolveCodeArtsPool` 与 `claimAll` 都按身份去重
  （同一账号不会占两份并发名额、不会重复签到）。
- `client.js`：标题行跳过 `duplicateOf` 行（额度只算一次）；行上打「同一账号」
  角标 + 一行说明「共用同一份额度，只算一次，留一个即可」；重复行不再重复显示
  剩余积分；积分包明细补 `剩余` 到分位（`剩余 8,018.34`）。
- 新增「后台提示」：`/status` 每渠道带 `notices`（内存 6 条、10 分钟过期）。
  添加账号失败 / 拦下重复都在卡片里说明——之前登录失败是「占位账号悄悄消失」，
  用户只能靠反复点来试，这正是这次重复的来源。

### 验证

- `probe-identity.mjs`（20 项）：JWT 解析、五种异常形态、按 key/凭据兜底判重、
  排除自己、标记顺序不变。
- `probe-credit-dup.mjs`（14 项）：两个同身份账号 → 第二行 `duplicateOf`、
  `identityKey` 补写、昵称换成真实账号名、签到第二行跳过、
  两路并发流的 `accountId` 相同且都用第一份 AK。
- `probe-client.mjs`：新增「剩余 8,018.58 / 同一账号 / 不得出现 16.0K / 登录失败提示」断言。
- 其余 9 个探针回归全绿；真实凭据只读验证：两个 ref 的 `account_id` 相同。

## 首屏性能 + 全渠道余额（v0.6.4，2026-11-04）

用户两条：①「每次进插件 UI 耗时太长」；②「CodeBuddy 那行还是旧样式，需要所有渠道都显示具体数据」。

### 首屏为什么慢

`collectStatus` 原来对**每个账号逐个 `await`**：腾讯系 1 个请求、CodeArts 2 个，
用户 5 个账号就是 10 个 RTT 串起来（还叠加偶尔的凭据续期）。改法三件套：

- **并发**：`mapLimit(tasks, 3, worker)`，账号之间独立请求，3 路并发；
  CodeArts 的 `statistics/plugin` 与 `ops/v1/delivery` 也改成 `Promise.all`。
- **缓存**：`statusCache` + `STATUS_TTL_MS`（默认 90s，`DSH_CODEARTS_STATUS_TTL_MS=0` 关掉）。
  `/status` 默认命中缓存并返回 `cached: true` / `ageMs`；`?refresh=1` 绕过。
  签到、增删、启停都会 `invalidateStatusCache()`。
- **预热**：启动后自动签到跑完立刻填一次缓存，用户点开设置页就是瞬时。

实测（离线桩，每请求 200ms，4 账号 / 6 请求）：首屏 < 900ms（串行约 1.2s+），
第二次 < 100ms 且上游请求数为 0。

⚠️ 身份回填（`updateAccount`）必须**串行落盘**：它是读-改-写，并发写会互相覆盖。
所以并发只用于「查询」，落盘在查询全部结束后统一做。

### 腾讯系余额（新）

`POST /v2/billing/meter/get-user-resource`（body `{}`，头与签到一致）：
`data.Response.Data.Accounts[]` → 每个积分包：
`PackageName` / `CapacityUnit` / `Status`（3 = 过期）/ `ExpiredTime` /
`DeductionEndTime` / `CycleCapacitySize|Remain|Used`（精确值在 `*Precise` 字符串里）。

- `lib/buddy.js`：`parseBuddyCredit(body)`、`fetchBuddyCredit(credential, channel)`。
  `total` = 可用剩余（过期包不计），`expiring` = 7 天内到期的剩余。
  失败一律 `undefined`——余额挂了不能把签到状态拖成 error。
- 实网只读验证（`probe-buddy-credit-live.mjs`）：WorkBuddy 159.25（3 个包 / 2 个名）、
  CodeBuddy「ID 未展示」2,419.66（14 个包 / 3 个名）、「momo」1,526.26（12 个包 / 2 个名）。
  **包多但包名少**，所以界面按包名聚合，只列剩余最大的 3 类，超出显示「等 N 类」。

### 显示口径

用户要求「所有都显示具体数据」，所以**全面取消 `8.0K` 缩写**：

- 行首行尾都走 `thousands()`（`8,018.34`）；标题行合计也用具体数字。
- 每行两行明细：`剩余积分 X · 总 Y · 已用 Z · 即将过期 W`，以及
  `积分包：<包名> 剩余/总额 · …`（按名聚合，最多 3 类）。
- 顶部多了「缓存 · N 秒前 / 刚刚更新」pill，避免「数字怎么没变」变成新疑问；
  「刷新」按钮走 `?refresh=1`。

### 验证

- `probe-status-cache.mjs`（22 项）：余额解析（含 `*Precise`、过期包剔除、7 天到期）、
  首屏耗时、上游请求计数、缓存命中/年龄、`?refresh=1`、写操作失效缓存。
- `probe-client.mjs`：改断言为具体数字（`剩余积分 8,018.58`、`CodeBuddy… 1,026.26/1,300`），
  并明确禁止再出现 `8.0K` 这类缩写。
- 其余 11 个探针回归全绿。

## 跨设备同步包（v0.6.4 附加，2026-11-05）

用户要在其他设备上获得同一套配置，但源码/账号/凭据全在本机，且无 git 仓库。
做了两个工具（`tools/`）：

- `make-sync.mjs`（源设备）：打包插件源码（dsh-codearts、dsh-workbuddy）+
  `~/.dsh` 数据（channel-pack/state.json、.credentials.yaml、ofm 数据、profile
  依赖与补丁参考）到 `D:\dsh-sync-out\dsh-sync-<日期>\`（附真 zip——必须用
  System32 的 bsdtar，Git Bash 的 GNU tar 写的 .zip 其实是 tar 包）。
  `--no-credentials` 可打不含凭据的包。
- `install-sync.mjs`（新设备）：拷插件到 `~/.dsh/plugins-local/`、profile 的
  package.json 写 `link:` 绝对路径、state.json 按账号 id 合并、credentials.yaml
  在 `refs:` 段按引用名追加（只补缺，不覆盖本地）、ofm 数据逐文件补缺、
  patch.yml 只补缺失的 agent-default-model（不整体覆盖）、最后 npm install。

路径基准坑：make-sync 在 `<插件>/tools/` 里，`../..` 是盘根不是插件目录——
曾把整个 D 盘（含 $RECYCLE.BIN，1.1G）打进去。已加防御（源目录必须有 package.json）。

模拟新设备验证 13 项断言全绿（合并/保留/幂等），二轮运行不重复追加。

CodeArts 跨设备警告：refresh_token 一次性，两台设备同时用会互相挤掉，
次要设备应重新登录一次。

## 提示误导问题（v0.6.5，2026-11-06）

用户截图：CodeArts 卡片上两条红字「添加账号失败：CodeArts 登录超时（3 分钟）」+
「这个华为云账号已经添加过」，而账号其实早就在列表里；点「刷新」后原样还在，
看起来像刷新没生效、或者刚刚又失败了一次。

根因：提示是内存里的**事件**（10 分钟 TTL），`/status` 每次把它挂回来，
且前端只渲染 message、不渲染 `at` —— 时间信息丢了，旧事件就等于「刚刚发生」。

改法：
- `/status?refresh=1` 同时 `clearNotices()`：刷新＝看现在，不复活历史事件；
- 另外提供 `POST /notices/clear`（可按 channel），便于单渠道清理；
- 添加账号成功时先清该渠道旧提示，再推一条 info「已添加账号 X」——
  失败提示不会在成功之后继续挂着；
- 「重复添加」从 error 降级为 warn（它不是故障，是拦截提醒）；
- 前端每条提示显示相对时间（刚刚 / N 分钟前 / N 小时前），warn/info 各自配色。

坑：`probe-client` 的渲染桩里，`flatten()` 会**重新调用**函数组件（推进 hook 计数），
用 flatten 判断节点文本会让后续展开拿到 null 状态（页面只剩「正在读取」）。
探针改为「摘掉提示再渲染一次数按钮」+ 样式查源码。

探针：新增 `probe-notices.mjs`（11 项：带 at/级别、刷新清空、按渠道清理、
普通查询保留）；`probe-client` 增加「3 分钟前 / 2 分钟前」与样式断言。
14 个离线探针全绿。
