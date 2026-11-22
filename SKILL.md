---
name: mijia-cloud
description: 扫码登录米家，审计、排障和编辑米家 App 的普通自动化与手动控制。查询执行日志、场景依赖、设备状态、红外子遥控器和设备自动化选项。
---

# 米家云端管理

使用本目录的 `scripts/mijia.mjs`，直接连接小米账号与米家服务。需要 Node.js 22+；无安装依赖，Windows/macOS/Linux 均可使用。它是独立客户端，非小米官方发布的 SDK。无需 NAS、网关、浏览器自动化或其他项目。

## 登录并选择家庭

将下面的 `<skill>` 替换为本 skill 的实际绝对路径，不依赖当前工作目录。

```text
node <skill>/scripts/mijia.mjs auth status
node <skill>/scripts/mijia.mjs auth login
node <skill>/scripts/mijia.mjs auth poll
node <skill>/scripts/mijia.mjs home list
```

- `auth login` 返回 `qrFile` 和 `qrUrl`：把二维码图片展示给用户，请用户用米家 App 扫码并确认；不要要求密码或短信验证码。`auth poll` 单次最多等待 30 秒，返回 pending 时可继续等待；过期则 `auth login --restart`。
- 多家庭时，根据用户提供的家庭名选择精确 ID；不清楚时询问。之后加 `--home ID`。
- 默认地区 `cn`。其他地区用 `--region de|us|ru|tw|sg|i2`，并检查该地区的设备。中国区已实测，其他地区需验收。
- 登录状态、操作回执存于用户自己的 `~/.mijia-cloud/<region>/`，与 skill 分离。`--data-dir PATH` 隔离用户/账号，`--auth-file PATH` 可显式使用已有兼容凭据。不要把凭据、二维码、回执、用户家庭数据放进分发包或对话文本。`auth logout` 只清除本地登录。

## 操作方式

```text
node <skill>/scripts/mijia.mjs scene list --home ID
node <skill>/scripts/mijia.mjs scene audit --home ID --out audit.json
node <skill>/scripts/mijia.mjs scene history SCENE_ID --home ID --limit 20
node <skill>/scripts/mijia.mjs scene get SCENE_ID --home ID
node <skill>/scripts/mijia.mjs scene export --home ID --out backup.json
node <skill>/scripts/mijia.mjs scene draft --template SCENE_ID --name 新场景 --home ID --out draft.json
node <skill>/scripts/mijia.mjs scene create --home ID --file draft.json
node <skill>/scripts/mijia.mjs scene update SCENE_ID --home ID --file patch.json
node <skill>/scripts/mijia.mjs scene enable SCENE_ID --home ID
node <skill>/scripts/mijia.mjs scene disable SCENE_ID --home ID
node <skill>/scripts/mijia.mjs scene delete SCENE_ID --home ID
node <skill>/scripts/mijia.mjs device list --home ID
node <skill>/scripts/mijia.mjs device spec DID --home ID
node <skill>/scripts/mijia.mjs device automation DID --home ID
node <skill>/scripts/mijia.mjs device read DID --home ID
```

写操作默认预览；加 `--commit` 才提交。用户已明确授权具体改动时，核对预览后直接提交，无需重复请示。目标、启用范围或删除对象不明确时先澄清。单纯查询、设计方案不授权额外改变设备。

- **排障、精简、重绑**：先看完整规则、实际设备状态、当前引用和执行日志。无引用的手动入口仍可能常用。停用的规则可能由在家、离家、睡眠等场景动态启用。重置后即使场景和主设备 ID 一样，也要核对红外子遥控器及动作按键。详见 [自动化调优](references/automation.md)。
- **规则编辑**：用小范围 patch 并保留未知字段。对象递归合并，数组整体替换。删除前检查引用；新规则先停用保存并回读，再按用户要求启用。模板摘要 `fullDefinition:false` 只用于核查；修改需要 App 或经实证的专用接口。
- **设备能力**：用实际规格检查读写权限、单位、步长和枚举。用米家自动化目录或同型号的 App 生成规则核对 `sc_id`、条件和值编码。配网、解绑或管理操作走米家 App 或经核实的专用接口。命令和编码见 [接口参考](references/api.md)。
- **验证**：分别确认配置保存、规则执行和实物响应。每次写入留有回执。出现 `UNKNOWN`、`verificationError` 或意外 `confirmed:false` 时先独立查询当前状态，再决定是否重试。实测可能开灯、响铃或断电，只有得到测试授权才触发对应设备。

查看完整命令：`node <skill>/scripts/mijia.mjs --help`。只读取当前任务需要的配置；需要大量数据时使用 `--out` 保存，不把设备标识、位置等个人信息发送到额外服务。
