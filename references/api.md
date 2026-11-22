# 命令与接口

`node <skill>/scripts/mijia.mjs ...`，Node.js 22+。路径允许空格，调用时正确引用。所有公共选项可放在命令后；各次调用保持相同的地区和数据目录。

## 引用与执行历史

```text
scene audit --home HOME --out audit.json
scene history --home HOME --limit 100
scene history SCENE_ID --home HOME --since 2026-01-01T00:00:00+08:00 --limit 100
```

`scene audit` 逐条列出被哪些场景执行、启用或停用。输出包括无当前引用的手动入口、没有已知启用入口的停用规则，以及未列出或离线的设备目标。红外目标未出现在家庭设备清单时，继续查父设备和遥控器接口。模板摘要和 App 外入口可能使图不完整。

`scene history` 支持当前场景名称或数字 ID。数字 ID 也可查询已删除的场景。日志按时间倒序输出，`userSceneId` 保留为字符串。 `oldestScanned` 和 `newestScanned` 指扫描到的家庭日志时间，不是某条规则的首末执行时间。 `stopReason` 标明已达到时间范围、返回数量、可读取历史边界或分页上限。 `--since` 接受 Unix 秒或带时区的 ISO 时间，`--limit` 控制返回条数。一次最多扫描 40 页，遇到游标停滞会返回已查数据。

## 场景编辑

先 `scene list --home HOME`，再 `scene get ID --home HOME`。`scene get` 同时给出 `kind`、`fullDefinition` 和 `scene`。`scene draft --template ID --out draft.json --home HOME` 会保留完整触发、动作、组合和时间编码，清除原场景身份，停用新草稿。没有模板时，`scene draft --out draft.json --home HOME` 生成停用的通知手动场景。

改名与停用的 patch 示例：

```json
{"name":"走廊无人关灯","enable":false}
```

`scene update ID --file patch.json --home HOME` 仅预览；同样参数加 `--commit` 提交。对象递归合并，数组整体替换，`null` 写为 null。替换 triggers/conditions/actions 数组时，先完整读取数组，保留不应丢失的项与属性。不要把 `scene get` 的外层包装直接当作 create/update 的输入。新增输入为一个场景对象，需含 `name`、`scene_trigger.triggers` 和非空 `scene_action.actions`，不是列表。

普通场景主要字段：

| 字段 | 用途 |
|---|---|
| `scene_trigger.express`, `triggers[]` | 触发条件及组合编码 |
| `scene_condition.express`, `conditions[]` | 附加条件及组合编码 |
| `scene_action.mode`, `actions[]` | 动作、顺序和参数 |
| `scene_else_action` | 原场景的否则分支（若有，原样保留） |
| `timewindow`、`timespan` | 生效时段、时区及其他时间配置 |
| `enable` | 启停 |

触发项常见 `src`、`key`、`value_type`、`value_json`、`value_operation`、`duration`、`extra_json`、`sc_id`、`protocol_type`。属性和事件的规则 key 常为 `prop.SIID.PIID` 和 `event.SIID.EIID`。`device automation` 返回目录使用的带型号 key 及原生选项 ID。新增时同时参照已有同类定义的结构和目标型号的官方选项。目录列出的持续时间和阈值不能替代该家庭设备的实际历史上报。动作常见 `type`、`payload_json`、`order`。已验证普通场景中 `type:2` 调用手动场景，`type:3` 按 `payload_json.enable` 启停规则。组合和数值边界沿用同类已验证配置。

常见全日窗口为 `from/to: "0 0 0 * * * *"`；固定时刻窗口可使用相同编码，例如 `"0 0 8 * * * *"` 到 `"0 0 22 * * * *"`。保留 `time_zone`、`filter`、`extra`；`extra:"night"` 等是命名时段，不擅自转换为固定小时。

`scene enable/disable/delete ID --home HOME [--commit]` 管理普通场景。删除不会自动删除引用该场景的其他场景，先检查导出中的嵌套引用。`scene run ID` 只接受手动控制，提交需 `--commit`，返回不等于所有实物动作完成。

`scene export --out export.json --home HOME` 是读取与备份记录，不是可直接导入的恢复包。普通完整定义可逐条制成草稿，核对设备 ID、家庭和启用状态后重建；模板摘要不能当作完整恢复源。

## 设备

```text
device list --home HOME
device get DID --home HOME
device spec DID --home HOME
device automation DID --home HOME
device ir-list HUB_DID --home HOME
device read DID --siid 2 --piid 1 --home HOME
device history DID --siid 3 --piid 2 --since 2026-01-01T00:00:00+08:00 --limit 100 --home HOME
device set DID --siid 2 --piid 1 --value true --home HOME [--commit]
device action DID --siid 2 --aiid 1 --in '[]' --home HOME [--commit]
```

SIID/PIID/AIID 必须来自目标设备实际规格。`--value`、`--in` 是 JSON，动作入参是按规格 `in` 顺序排列的数组。写属性前检查 `access` 包含 `write`。部分设备属性写入返回 `code:1`，仅在实际属性回读为目标值时确认成功。动作调用和仅写属性需要独立证据确认实物响应。`device history` 默认查过去 24 小时，单次最多请求 1000 条服务器已存储的属性上报。

`device ir-list` 用父设备 DID 查询当前红外子遥控器。用 `api read --path /v2/irdevice/controller/keys --file request.json` 核对按键，JSON 请求体为 `{"did":"ir.…"}`。有状态空调遥控器的普通按键列表可能为空，可查询 `/v2/irdevice/controller/info` 得到 `controller_id`，再查 `/v2/ircode/controller/functions` 获取温度、模式和风速范围。

`device add/remove` 返回米家 App 中配网/解绑的协作步骤，不创建虚假设备，不把本地列表删除当作云端解绑。删除设备可能导致恢复出厂，相关自动化不会因此自动清除。用户在 App 操作后，重新读取设备和相关场景验证。

## 已核实接口的扩展调用

```text
api read --path /miotspec/prop/get --file request.json
api write --path /已核实接口 --file request.json [--commit]
```

只访问固定地区的小米云端，不能指定其他主机。read 只允许脚本中列明的只读接口；write 默认预览、保存操作回执、单次提交、不自动重试，结果需独立查询确认。此入口用于有官方文档、可靠源码或用户抓包证据的设备改名、分房、解绑、专用模板等接口。没有证据时不猜路径，不试删现有设备，不宣称这些接口已验证。

| 能力 | 接口 |
|---|---|
| 小米账号扫码、刷新 | `account.xiaomi.com/pass/serviceLogin`、`/longPolling/loginUrl`，以及服务返回的轮询/回调 URL |
| 家庭 | `/v2/homeroom/gethome_merged` |
| 家庭设备列表 | `/home/home_device_list`（分页） |
| 设备属性、动作 | `/miotspec/prop/get`、`/miotspec/prop/set`、`/miotspec/action` |
| 完整场景/摘要 | `/appgateway/miot/appsceneservice/AppSceneService/GetSceneList`、`GetSimpleSceneList`（`app_version:12`） |
| 新增、修改、启停 | 同服务 `Edit`，新增 `scene_id:"0"`，修改保留原 ID |
| 普通场景删除 | `/scene/delete`，`{"identify":"","us_id":"原场景ID"}` |
| 执行手动控制 | 同服务 `NewRunScene` |
| 场景执行历史 | `/scene/history`，`command:"history"`，带家庭 ID、当前用户 UID、家庭所有者 UID、数量和可选 `timestamp` 游标 |
| 设备属性历史 | `/user/get_user_device_data`，属性使用 `type:"prop"`、`key:"SIID.PIID"` 和 Unix 秒范围 |
| 红外子设备及按键 | `/v2/irdevice/controllers`、`/v2/irdevice/controller/info`、`/v2/irdevice/controller/keys`、`/v2/ircode/controller/functions` |
| 型号自动化选项 | 小米米家产品百科 `https://home.mi.com/cgi-op/api/v1/baike/v2/scene?model=MODEL&preview=0` |

接口由小米服务提供，本客户端未获得官方 SDK 背书；App 内部接口可能变化。公开插件 SDK 的 `Service.scene` 依赖 App 宿主，不能把本客户端包装成官方插件 SDK。

## 来源

- [小米官方自动化说明](https://iot.mi.com/v2/new/doc/plugin/other/automation-develop)
- [官方场景模块](https://github.com/MiEcosystem/miot-plugin-sdk/blob/master/miot-sdk/service/scene.js)
- [官方场景 V2 模块](https://github.com/MiEcosystem/miot-plugin-sdk/blob/master/miot-sdk/service/sceneV2.js)
- [官方设备删除说明](https://iot.mi.com/v2/new/doc/plugin/other/device-delete)
- [云端请求协议与 Edit 实现记录](https://imkero.net/posts/mihome-app-api/)
- 登录及加密协议实现来源和许可证见 skill 根目录 `NOTICE` 与 `LICENSE`。
