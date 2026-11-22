# mijia-cloud｜米家云端管理

用米家 App 扫码登录，查询和管理米家里的普通自动化、手动场景和设备。需要 **Node.js 22+**，无需安装 npm 依赖。可作为 Skill 加载，也可直接在终端运行。脚本直接连接小米云端服务。

- 查询家庭、房间、设备状态和红外子遥控器。
- 检查自动化引用、失效动作和执行日志，导出配置备份。
- 新建、编辑、启停场景，读取或控制设备。写操作默认预览，通过 `--commit` 提交。

## 安装

下载仓库源码，或执行 `git clone https://github.com/chenbong/mijia-cloud.git`。保留整个 `mijia-cloud` 目录，包括 `SKILL.md`、`scripts/` 和 `references/`。

| 使用方式 | 安装方法 |
| --- | --- |
| Codex | 放到 `~/.agents/skills/mijia-cloud/`。[Codex Skills 文档](https://learn.chatgpt.com/docs/build-skills) |
| Claude Code | 放到 `~/.claude/skills/mijia-cloud/`，可用 `/mijia-cloud` 调用。[Claude Code Skills 文档](https://code.claude.com/docs/en/skills) |
| WorkBuddy | 在技能页面选择「添加技能 → 上传技能」，导入本地技能包。[WorkBuddy 技能文档](https://cloud.tencent.com/document/product/1831/134432) |
| 其他 Agent 或终端 | 支持加载 `SKILL.md` 且能运行本地 Node.js 的 Agent 可以加载整个目录，也可以直接使用下方命令。 |

WorkBuddy 用户用 Git 下载后，可在仓库目录执行 `git archive --format=zip --prefix=mijia-cloud/ -o ../mijia-cloud.zip HEAD` 生成导入包。

## 扫码登录

在 `mijia-cloud` 目录中运行：

```sh
node scripts/mijia.mjs auth login
```

打开输出里 `qrFile` 指向的二维码图片，用米家 App 扫码并确认，再执行：

```sh
node scripts/mijia.mjs auth poll
node scripts/mijia.mjs home list
```

如果轮询结果仍是 `pending`，再次运行 `auth poll`。

## 使用示例

将 `HOME_ID` 和 `SCENE_ID` 换成自己的家庭和场景 ID。

```sh
node scripts/mijia.mjs device list --home HOME_ID
node scripts/mijia.mjs scene list --home HOME_ID
node scripts/mijia.mjs scene audit --home HOME_ID
node scripts/mijia.mjs scene history SCENE_ID --home HOME_ID --limit 10

# 预览停用，核对后提交
node scripts/mijia.mjs scene disable SCENE_ID --home HOME_ID
node scripts/mijia.mjs scene disable SCENE_ID --home HOME_ID --commit
```

也可以直接告诉 Agent：「用 mijia-cloud 检查我的米家自动化，找出失效引用，先只读检查。」

登录凭据、二维码和回执保存在本机。请勿上传这些文件或包含家庭信息的导出。更多用法见 [接口参考](references/api.md) 和 [自动化调优指南](references/automation.md)。[GPL-3.0-or-later](LICENSE)。
