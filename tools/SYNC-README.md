# DSH 同步包使用说明

这个包把你在这台电脑上配置的 **DSH 签到 / 免费模型环境**完整带走：

- `plugins/dsh-codearts` — CodeArts 签到 + 免费模型渠道插件（源码，含积分显示、会话面板等全部功能）
- `plugins/dsh-workbuddy` — WorkBuddy 签到插件源码
- `data/state.json` — 全部账号清单（qoder / trae / CodeBuddy / WorkBuddy / CodeArts …）
- `data/credentials.yaml` — **账号登录凭据**（见下方安全提示）
- `data/our-free-model/` — Our Free Model 插件的设置、模型可用性、订阅数据
- `data/reference-cordis.patch.yml` — 界面与默认模型等偏好（944 行），供参考对齐
- `data/meta.json` — 打包时间、来源机器、插件版本

## 新设备上的步骤

前提：已安装 **DeepSeek Harness** 并启动过一次（能出现 `~/.dsh` 目录），且装有 **Node.js**（npm）。

```bat
cd 解压后的目录
node install.mjs
```

脚本会自动完成：拷插件源码 → 写 profile 依赖 → 合并账号与凭据 → 补默认模型配置 → `npm install`。
完成后**重启 DeepSeek Harness**，到「设置 → 签到」检查各账号是否正常显示积分与签到状态。

## 安全提示（重要/此为说明文档，实际打包时需注意不可包含敏感信息）

- 本包**若包含登录凭据**，只可通过私密渠道传输：
  自己的网盘、微信「文件传输助手」、U 盘。**不要发群聊或公开链接。**
- 导入成功、确认新设备能登录后，建议删除传输链路上的包与解压目录。

## CodeArts（华为云）特别说明

refresh_token 是**一次性的**：一台设备续期后，另一台设备手里的旧凭据立即失效。
两台设备**不要同时**用 CodeArts 渠道跑模型。想两台都用：在次要设备上
「设置 → 签到 → CodeArts → 添加账号」重新登录一次即可（各拿各的凭据，互不影响）。

## 常用变体

```bat
node install.mjs --no-install   :: 只落文件，不自动跑 npm install
node make-sync.mjs --no-credentials :: （在源设备上）打一个不含凭据的包
```

## 打包（源设备）

以后本机配置有更新，重新打一个包即可：

```bat
cd D:\dsh-codearts\tools
node make-sync.mjs
```

输出在 `D:\dsh-sync-out\dsh-sync-<日期>\`（附同名 zip）。
