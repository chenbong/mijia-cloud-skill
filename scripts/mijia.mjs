#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
import { parseArgs } from 'node:util';
import { resolve, dirname, join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { Cloud, MijiaError, fail, readJSON, saveJSON } from './cloud.mjs';
import { Client, notificationScene, validateValue } from './client.mjs';
import { auditScenes, sceneHistory } from './inspect.mjs';

const help = `米家云端管理（Node.js 22+，无安装依赖）
node scripts/mijia.mjs <分组> <操作> [ID] [选项]

auth login [--restart] [--out qr.png]  获取二维码，交给用户用米家 App 扫码
auth poll [--wait 20000]              等待扫码确认（单次最多30秒）
auth status | logout                 验证登录 / 清除本地登录
home list                            查询家庭及房间
scene list|get ID|export              查询手动控制和自动化（export 必须 --out）
scene audit                          检查场景引用、待命规则及设备目标
scene history [ID] [--since ISO] [--limit N]  查询场景执行日志
scene draft [--template ID] --out JSON 创建可编辑草稿；无模板时为停用的通知手动场景
scene create --file JSON              新增完整配置；默认停用
scene update ID --file PATCH         递归合并字段，数组整体替换
scene enable|disable ID               启用 / 停用
scene delete|run ID                   删除 / 执行手动场景
device list|get ID|spec ID             查询设备、状态和 MIoT 规格
device automation ID                 查询型号支持的自动化选项
device ir-list ID                    查询设备挂载的红外子遥控器
device read ID [--siid N --piid N]     读取单属性，或全部可读属性
device history ID --siid N --piid N [--since ISO] [--limit N]  查询属性历史
device set ID --siid N --piid N --value JSON
device action ID --siid N --aiid N [--in JSON]
device add|remove                     配网 / 解绑的米家 App 引导，之后重新查询
api read|write --path PATH --file JSON  扩展已核实的官方服务接口

公共选项：--home ID --region cn --auth-file PATH --data-dir PATH --out PATH
写操作默认仅预览；加 --commit 才提交。所有 ID 使用字符串。
`;
const { values: opt, positionals: args } = parseArgs({ allowPositionals: true, strict: true, options: {
  help: { type: 'boolean' }, commit: { type: 'boolean' }, restart: { type: 'boolean' },
  home: { type: 'string' }, region: { type: 'string' }, 'auth-file': { type: 'string' }, 'data-dir': { type: 'string' },
  file: { type: 'string' }, out: { type: 'string' }, template: { type: 'string' }, name: { type: 'string' },
  siid: { type: 'string' }, piid: { type: 'string' }, aiid: { type: 'string' }, value: { type: 'string' }, in: { type: 'string' },
  wait: { type: 'string' }, path: { type: 'string' }, since: { type: 'string' }, limit: { type: 'string' }
} });
function integer(key) { const n = Number(opt[key]); if (!Number.isSafeInteger(n) || n <= 0) fail('INPUT', `--${key} 需要正整数`); return n; }
function sinceTime() {
  if (opt.since === undefined) return undefined;
  const value = /^\d+$/.test(opt.since) ? Number(opt.since) : Math.floor(Date.parse(opt.since) / 1000);
  if (!Number.isSafeInteger(value) || value <= 0 || value > Math.floor(Date.now() / 1000)) fail('INPUT', '--since 需要过去的 ISO 时间或 Unix 秒');
  return value;
}
function historyLimit(max) {
  const limit = opt.limit === undefined ? 100 : integer('limit');
  if (limit > max) fail('INPUT', `--limit 最大为 ${max}`);
  return limit;
}
function json(value) { try { return JSON.parse(value); } catch { fail('INPUT', '参数需要有效的 JSON 值'); } }
async function input() { if (!opt.file) fail('INPUT', '需要 --file JSON 文件'); const data = await readJSON(resolve(opt.file), null); if (!data || typeof data !== 'object' || Array.isArray(data)) fail('INPUT', '文件需要 JSON 对象'); return data; }
async function qr(cloud, login) {
  if (login.authenticated) return login;
  const pending = await readJSON(join(cloud.dir, 'pending.json'), null);
  const path = resolve(opt.out ?? join(cloud.dir, 'login-qr.png'));
  const response = await cloud.fetch(pending.login.qr, { redirect: 'error', signal: AbortSignal.timeout(20000) });
  if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) fail('RESPONSE', '小米二维码图片暂不可用，可使用返回的 qrUrl');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 1024 * 1024) fail('RESPONSE', '二维码图片过大');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await writeFile(path, bytes, { mode: 0o600 });
  return { ...login, qrFile: path };
}
async function main() {
  if (opt.help || !args.length) { process.stdout.write(help); return; }
  if (args.length > 3) fail('INPUT', '一次命令只操作一个明确对象');
  if (Number(process.versions.node.split('.')[0]) < 22) fail('RUNTIME', '需要 Node.js 22 或更新版本');
  const [group, command, id] = args;
  const cloud = new Cloud({ authFile: opt['auth-file'], dataDir: opt['data-dir'], region: opt.region });
  const client = new Client(cloud);
  let result;
  if (group === 'auth') {
    if (command === 'login') result = await qr(cloud, await cloud.login(Boolean(opt.restart)));
    else if (command === 'poll') result = await cloud.poll(opt.wait ? Number(opt.wait) : 20000);
    else if (command === 'status') result = await cloud.status();
    else if (command === 'logout') result = await cloud.logout();
    else fail('INPUT', '未知登录操作');
  } else if (group === 'home' && command === 'list') {
    result = (await client.homes()).map(h => ({ id: String(h.id), name: h.name, ownerUid: String(h.uid), rooms: (h.roomlist ?? []).map(r => ({ id: String(r.id), name: r.name })) }));
  } else if (group === 'scene') {
    const home = await client.home(opt.home);
    if (command === 'create') result = await client.saveScene(home, null, await input(), opt.commit);
    else if (command === 'audit') {
      const [scenes, devices] = await Promise.all([client.scenes(home), client.devices(home)]);
      result = auditScenes(scenes, devices);
    } else if (command === 'history') {
      const sceneId = id && (/^\d+$/.test(id) ? id : client.selectScene(await client.scenes(home), id).scene_id);
      result = await sceneHistory(cloud, home, { sceneId, since: sinceTime(), limit: historyLimit(40000) });
    }
    else {
      const list = await client.scenes(home);
      if (command === 'list') result = list.map(s => ({ sceneId: s.scene_id, name: s.name, kind: s.kind, enabled: s.enable, fullDefinition: s.fullDefinition }));
      else if (command === 'export') {
        if (!opt.out) fail('INPUT', '导出需要 --out 路径');
        result = { exportedAt: new Date().toISOString(), homeId: String(home.id), scenes: list.map(s => ({ sceneId: s.scene_id, name: s.name, kind: s.kind, enabled: s.enable, fullDefinition: s.fullDefinition, definition: s.definition, summary: s.definition ? undefined : s })) };
      } else if (command === 'draft') {
        if (!opt.out) fail('INPUT', '草稿需要 --out 路径');
        result = opt.template ? structuredClone(client.selectScene(list, opt.template, true).definition) : notificationScene();
        for (const key of ['scene_id', 'uid', 'home_id', 'template_id', 'create_time', 'update_time', 'sub_usIds', 'parent_usId', 'scene_id_v1', 'common_used_roomIds']) delete result[key];
        result.name = opt.name ?? `新建-${result.name}`; result.enable = false; result.local_dev = ''; result.common_use = false;
      } else {
        if (!id) fail('INPUT', '需要场景 ID 或唯一名称');
        const scene = client.selectScene(list, id, !['get', 'run'].includes(command));
        if (command === 'get') result = { sceneId: scene.scene_id, kind: scene.kind, fullDefinition: scene.fullDefinition, scene: scene.definition ?? scene };
        else if (command === 'update') result = await client.saveScene(home, scene, await input(), opt.commit);
        else if (command === 'enable' || command === 'disable') result = await client.saveScene(home, scene, { enable: command === 'enable' }, opt.commit);
        else if (command === 'delete') result = await client.deleteScene(home, scene, opt.commit);
        else if (command === 'run') result = await client.runScene(home, scene, opt.commit);
        else fail('INPUT', '未知场景操作');
      }
    }
  } else if (group === 'device') {
    if (command === 'add' || command === 'remove') {
      result = { requiresMiHomeApp: true, operation: command, steps: command === 'add' ? ['用户打开米家 App → 右上角 + → 添加设备。', '按型号提示完成附近发现、配网和绑定，并选择家庭/房间。', 'Agent 重新执行 device list 验证新设备。'] : ['先查询目标 DID、名称及引用该设备的场景，并向用户说明受影响内容。', '用户在米家 App 中选择该设备 → 设置 → 删除设备。解绑可能触发设备恢复出厂。', 'Agent 重新执行 device list 验证解绑；不要自动删除关联场景。'] };
    } else {
      const home = await client.home(opt.home);
      if (command === 'list') result = await client.devices(home);
      else {
        if (!id) fail('INPUT', '需要设备 DID 或唯一名称');
        const device = await client.device(home, id);
        if (command === 'get') result = device;
        else if (command === 'automation') result = await client.automationOptions(device);
        else if (command === 'ir-list') result = await client.irChildren(device);
        else {
          const spec = await client.spec(device);
          if (command === 'spec') result = spec;
          else if (command === 'read') {
            let requests;
            if (opt.siid || opt.piid) { const siid = integer('siid'), piid = integer('piid'); client.property(spec, siid, piid, 'read'); requests = [{ siid, piid }]; }
            else requests = spec.services.flatMap(s => (s.properties ?? []).filter(p => p.access?.includes('read')).map(p => ({ siid: s.iid, piid: p.iid })));
            result = await client.getProperties(device, requests);
          } else if (command === 'history') {
            const siid = integer('siid'), piid = integer('piid');
            client.property(spec, siid, piid, 'read');
            const end = Math.floor(Date.now() / 1000), start = sinceTime() ?? end - 86400;
            if (start >= end) fail('INPUT', '属性历史起始时间需早于当前时间');
            const limit = historyLimit(1000);
            const records = await cloud.request('/user/get_user_device_data', { did: device.did, type: 'prop', key: `${siid}.${piid}`, time_start: start, time_end: end, limit });
            if (!Array.isArray(records)) fail('RESPONSE', '设备属性历史格式错误');
            result = { did: device.did, siid, piid, start, end, limit, records };
          } else if (command === 'set') {
            const siid = integer('siid'), piid = integer('piid'), property = client.property(spec, siid, piid, 'write'), value = json(opt.value);
            validateValue(property, value);
            const before = property.access.includes('read') ? await client.getProperties(device, [{ siid, piid }]) : null;
            result = await client.mutate({ operation: 'device.set', before: { device, property: { siid, piid }, value: before }, after: { value } },
              () => cloud.request('/miotspec/prop/set', { params: [{ did: device.did, siid, piid, value }] }, { write: true }),
              async response => {
                const code = Array.isArray(response) ? response[0]?.code : undefined;
                const readback = property.access.includes('read') ? await client.getProperties(device, [{ siid, piid }]) : null;
                const confirmed = (code === 0 || code === 1) && readback?.[0]?.code === 0 && readback[0].value === value;
                return { accepted: code === 0 || confirmed, confirmed: Boolean(confirmed), response, readback };
              }, opt.commit);
          } else if (command === 'action') {
            const siid = integer('siid'), aiid = integer('aiid'), service = spec.services.find(s => s.iid === siid), action = service?.actions?.find(a => a.iid === aiid);
            if (!action) fail('UNSUPPORTED', '设备规格不包含此动作');
            const values = json(opt.in ?? '[]');
            if (!Array.isArray(values) || values.length !== (action.in ?? []).length) fail('INPUT', '动作参数数量与设备规格不符');
            for (let i = 0; i < values.length; i++) { const p = service.properties?.find(p => p.iid === action.in[i]); if (!p) fail('SPEC', '缺少动作参数规格'); validateValue(p, values[i]); }
            result = await client.mutate({ operation: 'device.action', before: device, after: { siid, aiid, in: values } },
              () => cloud.request('/miotspec/action', { params: { did: device.did, siid, aiid, in: values } }, { write: true }),
              async response => ({ accepted: response?.code === 0, confirmed: false, acceptedByDevice: response?.code === 0, response, message: '动作需根据实际目标另行查验效果' }), opt.commit);
          } else fail('INPUT', '未知设备操作');
        }
      }
    }
  } else if (group === 'api') {
    const readPaths = new Set([
      '/v2/message/v2/check_new_msg', '/v2/homeroom/gethome_merged', '/home/home_device_list',
      '/v2/home/device_list_page', '/miotspec/prop/get', '/scene/history', '/user/get_user_device_data',
      '/v2/irdevice/controllers', '/v2/irdevice/controller/info', '/v2/irdevice/controller/keys',
      '/v2/ircode/controller/functions',
      ...['GetSceneList', 'GetSimpleSceneList', 'GetTplSceneList', 'GetCommonUsedSceneList'].map(s => '/appgateway/miot/appsceneservice/AppSceneService/' + s)
    ]);
    if (!opt.path) fail('INPUT', '需要 --path 已核实的接口路径');
    const body = await input();
    if (command === 'read') { if (!readPaths.has(opt.path)) fail('INPUT', '该路径不在已知只读接口列表中；不要将未知操作当作查询'); result = await cloud.request(opt.path, body); }
    else if (command === 'write') result = await client.mutate({ operation: 'api.write', after: { path: opt.path, body } }, () => cloud.request(opt.path, body, { write: true }), async response => ({ confirmed: false, response, message: '需用独立查询确认写入效果' }), opt.commit);
    else fail('INPUT', '未知接口操作');
  } else fail('INPUT', '未知命令，使用 --help 查看帮助');
  if (opt.out && !(group === 'auth' && command === 'login')) { const file = resolve(opt.out); await saveJSON(file, result); console.log(JSON.stringify({ ok: true, output: file, count: Array.isArray(result) ? result.length : undefined })); }
  else console.log(JSON.stringify({ ok: true, result }, null, 2));
}
main().catch(e => {
  const error = e instanceof MijiaError ? { code: e.code, message: e.message, ...e.details } : { code: 'LOCAL', message: '本地操作失败，请检查运行环境、参数或文件权限' };
  console.error(JSON.stringify({ ok: false, error })); process.exitCode = 1;
});
