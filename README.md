# dsh-codearts — DSH 多渠道签到与状态面板插件

DSH（DeepSeek Harness）的 Cordis 插件，挂在 `~/.dsh` 宿主上运行。核心做两件事：

1. **每日签到**：自动领取三个免费渠道的每日积分，无需人工操作；
2. **状态面板**：在 DSH 设置页提供可视化界面，展示各账号签到状态、剩余积分、并发会话情况，并支持页面内登录账号、终止会话。

## 功能总览

| 能力 | 说明 |
| --- | --- |
| 三渠道签到 | `buddy`（CodeBuddy 中国版）/ `workbuddy` / `codearts`（华为云 CodeArts），启动后 15s 自动跑一轮 |
| 剩余积分显示 | 三渠道余额面板：WorkBuddy / CodeBuddy 精确积分、CodeArts 资源包余量，按包聚合 |
| 会话治理 | 查询排队状态（`/api/v1/queue/status`）、并发闸门（每账号 3 路）、主动终止、45s 冷却 |
| 账号管理 | 设置页内 CodeBuddy 扫码登录、CodeArts AK/SK 登录，多账号池按身份判重（refresh_token JWT 解析） |
| 模型渠道 | CodeArts 注册 `devcloud/*` provider，可直走 CodeArts 模型（DSML 工具通道）；WorkBuddy 注册别名 `wbai/*`，经本机 wbipc 走 WorkBuddy 在线模型（分段续写、11128 指纹改写内建） |
| 跨设备同步 | `tools/make-sync.mjs` 打包插件+配置，`--plugin-only` 可打不含账号数据的纯插件包 |
| 手机 / 桌面跨平台（v0.8.0+） | 同一份代码在桌面 DSH 与手机 DSH Go 本机引擎上都可用；凭据走宿主 `ctx.credentials` 双通道 |
| WorkBuddy 手机直连（v0.9.0） | WorkBuddy 模型渠道不再依赖 Windows 桌面端：桌面走 wbipc，手机用凭据直连网关，两端都能用 |

详细的功能版本沿革见 [docs/功能清单.md](docs/功能清单.md)。

## 安装

本插件通过 `link:` 方式安装（改源码即时生效，重启 DSH 后加载）：

```
# 1. 源码放到任意目录，如 D:\dsh-codearts
# 2. profile 的 package.json 中加依赖
#    "@local/dsh-codearts": "link:D:/dsh-codearts"
# 3. npm install 后重启 DSH

# 或直接使用跨设备同步包（推荐，含自动安装器）：
# 同步包解压后执行
node install.mjs
```

## 目录结构

```
index.js          宿主半身：路由注册、状态缓存、账号池、提示系统
client.js         浏览器半身：设置页 UI（签到/会话/积分/账号管理）
lib/
  codearts-llm.js   CodeArts 模型渠道（账号池轮转、排队等待、流式）
  workbuddy-llm.js   WorkBuddy 模型渠道（传输自适应、分段续写、11128 指纹改写）
  wbipc-client.js   WorkBuddy 桌面端命名管道客户端（HMAC 握手 + JSON-RPC）
  workbuddy-direct.js WorkBuddy 凭据直连客户端（手机用，构造网关头直连 /v2/chat/completions）
  codearts.js       CodeArts 签到协议（AK/SK 签名）
  codearts-login.js CodeArts 登录与 token 刷新
  sessions.js       会话并发闸门与终止
  accounts.js       账号清单读写
  credentials.js    凭据读取（明文文件 + ctx.credentials 服务双通道，跨平台）
  identity.js       refresh_token JWT 身份解析（账号判重）
  duplicates.js     重复账号标记
  buddy.js          CodeBuddy/WorkBuddy 签到与积分
  buddy-login.js    CodeBuddy 扫码登录
  sigv4.js          华为云 SigV4 签名
  dsml.js           DSML 工具通道协议
tools/
  make-sync.mjs     打同步包（--plugin-only 打纯插件包）
  install-sync.mjs  同步包安装器（合并式，不破坏目标已有数据）
  install-phone.mjs 手机本机引擎一键安装器（自动探测 profile、建软链，无需 npm install）
docs/             说明文档（功能清单、SOP、DSH 接入说明）
```

## 环境变量（均可覆盖，有默认值）

| 变量 | 作用 |
| --- | --- |
| `DSH_CODEARTS_AUTO_CHECKIN_DELAY_MS` | 启动后自动签到延迟（默认 15000，0 关闭） |
| `DSH_CODEARTS_STATUS_TTL_MS` | 状态缓存 TTL（0 关闭缓存） |
| `DSH_CODEARTS_QUEUE_WAIT_PLAN_MS` | 排队重试计划（默认 3/9/20 秒） |

## ⚠️ 已知关键约束

- **CodeArts 的 refresh_token 是一次性的**：刷新即作废，多设备共用账号会互相踢下线。次要设备需重新登录。
- CodeArts 每账号**并发会话上限 3**，插件内置闸门，勿在插件外并发调用。
- 判定签到结果看响应体 `code` 字段而非 HTTP 状态（重复签到是 HTTP 400 + `code:10001`）。
- **WorkBuddy 模型渠道有两种传输**：桌面端在跑时走 wbipc 命名管道（官方路径）；否则用登录凭据直连网关（v0.9.0 起，手机可用）。两者都要本设备登录了 WorkBuddy 账号。渠道校验（11128）校验的是消息文本指纹（system/assistant 里的第三方 agent 片段），插件已内置改写 + system 降级两道处理。
- 直连模式遇到 `11140`（账号因异常活动被风控）时属服务端策略，与平台无关；稍后重试或降低请求频率即可，不要短时间内重复探测。

## 📱 手机 / 桌面跨平台（v0.8.0+）

同一份代码同时支持桌面 DSH 与手机 DSH Go 的**本机引擎**（PRoot Linux + Node.js + `~/.dsh`）。做法照搬 Our Free Model：让平台差异只存在于少数能安全降级的边界。

| 能力 | 桌面端 | 手机 DSH Go | 原因 |
| --- | --- | --- | --- |
| 三渠道签到 | ✅ | ✅ | 纯 HTTP + SigV4，与平台无关 |
| 页面内登录 / 添加账号 | ✅ | ✅ | OAuth / PKCE / DPoP + 本地回环 HTTP 回调 |
| CodeArts 模型渠道 `devcloud/*` | ✅ | ✅ | 纯 HTTPS 到华为云，账号池在 `~/.dsh` |
| 凭据读取 | 明文文件 + 服务 | 走 `ctx.credentials` 服务 | 手机没有桌面明文 YAML，只有宿主凭据服务 |
| WorkBuddy 模型渠道 `wbai/*` | ✅（wbipc） | ✅（凭据直连，v0.9.0） | 桌面有命名管道走 wbipc；手机用凭据构造网关头直连 |

实现要点：

- **凭据双通道**（`lib/credentials.js` 的 `resolveCredential`）：优先 `ctx.credentials.resolve(ref)`（宿主决定存储与解密），失败回退读明文文件。写凭据本来就用 `credentials.set`，两端一致。
- **WorkBuddy 传输自适应**（`lib/workbuddy-direct.js`，v0.9.0）：`wbai` 渠道在桌面端在跑时走 wbipc；否则用 `ctx.credentials` 里的 WorkBuddy 凭据直接请求 `https://{domain}/v2/chat/completions`。逆向 WorkBuddy 客户端确认：11128「渠道校验」校验的是消息文本指纹（≈110 字符连续窗口比对）而非设备签名，网关身份头（Bearer + X-User-Id/X-Enterprise-Id + X-IDE-* + x-codebuddy-request 等）全部可从凭据和固定值构造。插件内置指纹改写 + system 降级两道处理。`DirectClient` 与 `WbipcClient` 接口一致，适配器无感切换。两端都没有（无桌面端且未登录 WorkBuddy）才不注册渠道。
- **新环境账号池**：`channel-pack/state.json` 不存在时按空池初始化并自动建目录，手机首次添加账号不会失败。
- 手机上首次使用需在各渠道**重新登录**（CodeArts 是一次性 refresh_token，多设备不能共用同一份凭据）。WorkBuddy 直连需本设备先添加一个 WorkBuddy 账号（设置页扫码登录）。

### 在手机 DSH Go 上一键安装

本仓库是公开仓库，手机可直接下载。在本机引擎的终端/对话里执行（把整段一次性粘贴）：

```sh
cd /root 2>/dev/null || cd "$HOME"
curl -fsSL -o dsh-codearts.zip https://codeload.github.com/297657/dsh-codearts/zip/refs/heads/main \
  && python3 -c "import zipfile;zipfile.ZipFile('dsh-codearts.zip').extractall('.')" \
  && cd dsh-codearts-main \
  && node tools/install-phone.mjs
```

- 没有 `python3` 时改用 `unzip -o dsh-codearts.zip && cd dsh-codearts-main`（Alpine 先 `apk add unzip`；Ubuntu 先 `apt install unzip`）。
- 脚本只用 Node 内置模块，不跑 `npm install`、不联网、不碰账号与凭据；自动探测 `~/.dsh`（或 `/root/.dsh`、`DSH_HOME`）下所有 profile，逐个写 `link:` 依赖 + 软链，改动前自动备份（`.bak-phone-<时间戳>`），重复运行幂等。
- 可用 `--home <目录>` / `--profile <名字>` 指定路径，或先加 `--dry-run` 预演。
- 跑完在 DSH Go 里 **设置 › 本机引擎 › 重启引擎**，再到 **设置 › 插件** 确认已安装。这个插件是 `@local/` 私有包，不在插件市场里，重启后出现在「已安装」而非市场。
- 若本机引擎没有终端入口，也可把上面这条作为一条指令直接发给 DSH Go 的对话，让它在本机执行。

安装到手机：用 `tools/make-sync.mjs --plugin-only` 打纯插件包，或把源码放到手机 DSH Go 本机引擎的 profile 里用 `link:` 安装，重启后生效。

## 🔒 数据安全约定

本仓库**只放代码和文档，不放任何个人数据**。已入库内容经 [`tools/secret-scan.mjs`](tools/secret-scan.mjs) 全量扫描确认：无账号凭据、无 JWT、无 AK/SK、无邮箱/手机号、无个人目录路径。

- 凭据与账号清单始终留在本机 `~/.dsh/`（`.credentials.yaml`、`channel-pack/state.json` 等），由 `.gitignore` 排除；
- 每次 `git commit` 前自动跑敏感信息扫描（`.git/hooks/pre-commit`），命中即阻止提交；
- 新设备安装插件后，账号需在该设备上重新登录，不从仓库同步；
- 文档示例中的用户名路径统一写作 `<你的用户目录>`。

手动自查：`node tools/secret-scan.mjs`（全量）或 `node tools/secret-scan.mjs --staged`（仅暂存区）。

## 相关文档

- [docs/功能清单.md](docs/功能清单.md) — 版本沿革与功能点清单
- [MEMORY.md](MEMORY.md) — 开发备忘（协议细节与踩坑记录）
- [tools/SYNC-README.md](tools/SYNC-README.md) — 跨设备同步包使用说明

## 环境要求

- DSH（DeepSeek Harness）桌面版（profile `desktop`）**或**手机 DSH Go 的本机引擎
- Node.js ≥ 18
- 各渠道账号在该设备上已登录（桌面端凭据在 `~/.dsh/.credentials.yaml` 或宿主凭据服务；手机端在 `ctx.credentials` 服务）
- 使用 WorkBuddy 模型渠道时：桌面端需在跑 WorkBuddy；手机端需本设备已登录 WorkBuddy 账号（走凭据直连，无需桌面端）

---

此插件由 WorkBuddy 设计，并参考 Our Free Model 开发。
