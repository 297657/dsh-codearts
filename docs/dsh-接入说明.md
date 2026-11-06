# 接入 DeepSeek Harness（dsh）说明

本机现状：dsh 已安装（`~/.dsh`，web + desktop 两个 profile，模型走 magpie 网关）。
本次已补：全局说明 `~/.dsh/AGENTS.md`、全局技能 `~/.dsh/skills/agent-asset-port/`。

## 一、dsh 认哪四类东西

| 内容 | 落点 | 生效方式 |
|---|---|---|
| 全局约定 | `~/.dsh/AGENTS.md` | 每次请求前作为用户消息前缀注入，改完下轮生效 |
| 项目约定 | 项目根 `AGENTS.md`（或 `CLAUDE.md`，`AGENTS.md` 优先） | 同上，支持 `AGENTS.local.md` 覆盖 |
| 个人技能 | `~/.dsh/skills/<名>/SKILL.md` | 自动发现，改文件热更新 |
| 项目技能 | `.dsh/skills/<名>/SKILL.md` | 优先级最高 |
| MCP 服务 | profile 的 `cordis.patch.yml` | 改完要重启该 profile |

技能发现优先级：`.dsh/skills/` → `.agents/skills/` → `~/.dsh/skills/` → `~/.agents/skills/`。

技能 frontmatter 只有 `name`（kebab-case）和 `description` 是必填，可选 `whenToUse`、`user-invocable`、`disable-model-invocation`。缺必填字段的文件会被直接忽略。

## 二、加 MCP 服务

把 `dsh-mcp.patch.yml` 里的条目追加到 `~/.dsh/profiles/web/cordis.patch.yml` 末尾（那是顶层 YAML 数组，直接追加同级条目即可），然后重启 web profile。

工具名会变成 `mcp__<serverName>__<tool>`，agent 就是这样点名的。

凭据用 `!!js process.env.XXX` 引用，别把 token 写进文件。

## 三、验证

1. 新开一个会话，问"你现在有哪些技能"，应能看到 `agent-asset-port`。
2. 说"把这个技能搬到 Cursor"，确认它自动加载并给出对应目录。
3. MCP 加完看工具列表里有没有 `mcp__xxx__yyy`。

## 四、可选的技能市场插件

想直接浏览安装现成技能：

```
dsh plugin --profile web add github:vonweller/dsh-skillhub
```

装完重启 web profile，设置里会出现 Skill Hub，一键装到 `~/.dsh/skills/`。注意这是社区插件，非官方。

## 五、反方向：DSH 插件访问 WorkBuddy（实测）

WorkBuddy 桌面端在本机起了 LocalProbeServer，端口 18488/18489/18490，路径 `/workbuddy/probe`，用于被别的本地应用发现。

```
GET http://127.0.0.1:18488/workbuddy/probe
→ {"ok":true,"app":"workbuddy-desktop","version":"5.9.2","platform":"win32"}
```

要点：

- 三个端口是候选探测范围，18488 为主端口，其余两个被占用时才会顶上来；探测逻辑就是依次试、命中即停。
- 响应带 `Access-Control-Allow-Origin: *`，浏览器侧的插件也能直接 fetch。
- 除 probe 外的路由没有公开文档，`/health`、`/mcp`、`/v1/models` 都是 404。要调具体能力得先确认路由。
- 需要宿主登录态的调用不要直连 HTTP，走 wbipc：命名管道 `\\.\pipe\wbipc-<id>` + `~/.workbuddy/wbipc/endpoint.json` 里的 ticket 做 HMAC 握手，宿主会自动注入鉴权头。

对照：DSH 自己的 API 在 `127.0.0.1:8326`，未带 key 返回 401 `invalid_api_key`；magpie 模型网关在 `127.0.0.1:3425`。

## 六、注意

- WorkBuddy 专属技能（比如 `wb-auto-checkin`）搬过去跑不了——它依赖 WorkBuddy 宿主的 wbipc 通道和登录态。格式通用不等于内容通用，搬之前先确认脚本依赖的平台接口。
- dsh 还在 developer preview，README 明确说会有破坏性变更，升级前备份 `~/.dsh/sessions` 和 profiles。

---

此插件由 WorkBuddy 设计，并参考 Our Free Model 开发。
