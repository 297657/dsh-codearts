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
| 模型渠道 | 注册 `devcloud/*` provider，DSH 对话可直接走 CodeArts 模型（DSML 工具通道支持） |
| 跨设备同步 | `tools/make-sync.mjs` 打包插件+配置，`--plugin-only` 可打不含账号数据的纯插件包 |

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
  codearts.js       CodeArts 签到协议（AK/SK 签名）
  codearts-login.js CodeArts 登录与 token 刷新
  sessions.js       会话并发闸门与终止
  accounts.js       账号清单读写
  credentials.js    凭据读取（refs: 段解析）
  identity.js       refresh_token JWT 身份解析（账号判重）
  duplicates.js     重复账号标记
  buddy.js          CodeBuddy/WorkBuddy 签到与积分
  buddy-login.js    CodeBuddy 扫码登录
  sigv4.js          华为云 SigV4 签名
  dsml.js           DSML 工具通道协议
tools/
  make-sync.mjs     打同步包（--plugin-only 打纯插件包）
  install-sync.mjs  同步包安装器（合并式，不破坏目标已有数据）
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

## 🔒 数据安全约定

本仓库**只放代码和文档，不放任何个人数据**。已入库内容经 [`tools/secret-scan.mjs`](tools/secret-scan.mjs) 全量扫描确认：无账号凭据、无 JWT、无 AK/SK、无邮箱/手机号、无个人目录路径。

- 凭据与账号清单始终留在本机 `~/.dsh/`（`.credentials.yaml`、`channel-pack/state.json` 等），由 `.gitignore` 排除；
- 每次 `git commit` 前自动跑敏感信息扫描（`.git/hooks/pre-commit`），命中即阻止提交；
- 新设备安装插件后，账号需在该设备上重新登录，不从仓库同步；
- 文档示例中的用户名路径统一写作 `<你的用户目录>`。

手动自查：`node tools/secret-scan.mjs`（全量）或 `node tools/secret-scan.mjs --staged`（仅暂存区）。

## 相关文档

- [docs/功能清单.md](docs/功能清单.md) — 版本沿革与功能点清单
- [docs/dsh-workbuddy-SOP.md](docs/dsh-workbuddy-SOP.md) — 配套插件 dsh-workbuddy 的标准操作流程
- [docs/dsh-接入说明.md](docs/dsh-接入说明.md) — DSH 平台的插件/技能/MCP 接入方式
- [MEMORY.md](MEMORY.md) — 开发备忘（协议细节与踩坑记录）
- [tools/SYNC-README.md](tools/SYNC-README.md) — 跨设备同步包使用说明

## 环境要求

- DSH（DeepSeek Harness）桌面版，profile `desktop`
- Node.js ≥ 18
- 各渠道账号凭据已存在于 `~/.dsh/.credentials.yaml`（或通过插件登录页添加）

---

此插件由 WorkBuddy 设计，并参考 Our Free Model 开发。
