// SPDX-License-Identifier: GPL-3.0-or-later
import { fail, fingerprint, saveJSON } from './cloud.mjs';
const scenesPath = '/appgateway/miot/appsceneservice/AppSceneService/';
export function merge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return structuredClone(patch);
  const result = base && typeof base === 'object' && !Array.isArray(base) ? structuredClone(base) : {};
  for (const [k, v] of Object.entries(patch)) {
    if (['__proto__', 'prototype', 'constructor'].includes(k)) fail('INPUT', '不允许的 JSON 字段');
    result[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge(result[k], v) : structuredClone(v);
  }
  return result;
}
export function contains(actual, expected) {
  if (expected === null || typeof expected !== 'object') return actual === expected;
  if (!actual || typeof actual !== 'object' || Array.isArray(expected) !== Array.isArray(actual)) return false;
  if (Array.isArray(expected) && actual.length !== expected.length) return false;
  return Object.entries(expected).every(([k, v]) => contains(actual[k], v));
}
export function validateValue(spec, value) {
  const fmt = spec.format;
  if (fmt === 'bool' && typeof value !== 'boolean' || fmt === 'string' && typeof value !== 'string') fail('INPUT', '属性值类型与设备规格不符');
  if (/^(u?int\d*|float|double)$/.test(fmt)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || /int/.test(fmt) && !Number.isInteger(value)) fail('INPUT', '设备属性需要有效数值');
    const bounds = { uint8: [0, 255], uint16: [0, 65535], uint32: [0, 4294967295], int8: [-128, 127], int16: [-32768, 32767], int32: [-2147483648, 2147483647] }[fmt];
    if (bounds && (value < bounds[0] || value > bounds[1])) fail('INPUT', '属性数值超出类型范围');
  }
  if (spec['value-list'] && !spec['value-list'].some(v => v.value === value)) fail('INPUT', '属性值不在设备枚举内');
  const range = spec['value-range'];
  if (range && (typeof value !== 'number' || value < range[0] || value > range[1] || range[2] && Math.abs((value - range[0]) / range[2] - Math.round((value - range[0]) / range[2])) > 1e-7)) fail('INPUT', '属性数值超出范围或不符合步长');
}
export function newScene(home, input) {
  const result = structuredClone(input);
  for (const key of ['create_time', 'update_time', 'sub_usIds', 'scene_id_v1', 'parent_usId']) delete result[key];
  return { ...result, scene_id: '0', uid: String(home.uid), home_id: String(home.id), template_id: '0', enable: input.enable ?? false, common_use: false, local_dev: '', temporary: false };
}
export function notificationScene(name = '新建手动控制') {
  return { name, type: 1, enable: false, enable_push: false, value_format: 1, scene_version: 0, data_type: 0,
    scene_trigger: { express: 0, triggers: [{ id: 0, order: 1, src: 'user', key: 'user.click', extra: '', name: '', value: '', value_type: 5, extra_json: { voice_alias: { alias: [], use_title: 1 } }, value_json: null, protocol_type: 2, sc_id: 0, from: 0, value_operation: 0, std_sc_id: '', duration: 0, option_ids: [], data_ver: 0, need_fill: 0 }] },
    scene_condition: { express: 0, conditions: [] },
    scene_action: { mode: 1, actions: [{ id: 0, order: 1, group_id: 0, type: 1, name: '发送通知', payload_json: { delay_time: 0, title: '智能通知', desc: '测试通知' }, protocol_type: 2 }] },
    timewindow: { from: '0 0 0 * * * *', to: '0 0 0 * * * *', filter: '', extra: '', time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone } };
}
export class Client {
  constructor(cloud) { this.cloud = cloud; }
  async homes() {
    const r = await this.cloud.request('/v2/homeroom/gethome_merged', { fg: true, fetch_share: true, fetch_share_dev: true, limit: 300, app_ver: 7, plat_form: 0 });
    if (!Array.isArray(r?.homelist)) fail('RESPONSE', '家庭列表格式错误');
    return r.homelist;
  }
  async home(id) {
    const list = await this.homes();
    const selected = id ? list.find(h => String(h.id) === String(id)) : list.length === 1 ? list[0] : null;
    if (!selected) fail('INPUT', '请用 --home 明确指定可访问的家庭 ID');
    if (!Number.isSafeInteger(Number(selected.id))) fail('RESPONSE', '家庭 ID 超出安全数值范围');
    return selected;
  }
  async devices(home) {
    const result = []; const seen = new Set(); let cursor = '';
    for (let page = 0; page < 100; page++) {
      const r = await this.cloud.request('/home/home_device_list', { home_owner: home.uid, home_id: Number(home.id), limit: 200, start_did: cursor, get_split_device: true, support_smart_home: true, get_cariot_device: true, get_third_device: true });
      if (!Array.isArray(r?.device_info)) fail('RESPONSE', '设备列表格式错误');
      for (const d of r.device_info) {
        const rooms = (home.roomlist ?? []).filter(room => room.dids?.includes(d.did));
        result.push({ did: String(d.did), name: d.name, model: d.model, online: d.isOnline, spec_type: d.spec_type, pid: d.pid, home_id: String(home.id), room_id: rooms.length === 1 ? String(rooms[0].id) : null, room: rooms.length === 1 ? rooms[0].name : null });
      }
      if (!r.has_more) return [...new Map(result.map(d => [d.did, d])).values()];
      if (!r.max_did || seen.has(r.max_did)) fail('RESPONSE', '设备分页没有推进');
      cursor = r.max_did; seen.add(cursor);
    }
    fail('RESPONSE', '设备分页超过上限');
  }
  async device(home, id) {
    const matches = (await this.devices(home)).filter(d => d.did === id || d.name === id);
    if (matches.length !== 1) fail('INPUT', '设备不存在或名称重复，请使用精确 DID');
    return matches[0];
  }
  async spec(device) {
    if (!device.spec_type?.startsWith('urn:miot-spec-v2:device:')) fail('UNSUPPORTED', '该设备未提供 MIoT 规格');
    const { res, text } = await this.cloud.fetchText(`https://miot-spec.org/miot-spec-v2/instance?${new URLSearchParams({ type: device.spec_type })}`);
    if (!res.ok) fail('SPEC', '无法读取设备规格');
    let r; try { r = JSON.parse(text); } catch { fail('SPEC', '规格格式错误'); }
    if (!Array.isArray(r.services)) fail('SPEC', '规格缺少服务定义');
    return r;
  }
  async automationOptions(device) {
    const query = new URLSearchParams({ model: device.model, preview: '0' });
    const { res, text } = await this.cloud.fetchText(`https://home.mi.com/cgi-op/api/v1/baike/v2/scene?${query}`);
    if (!res.ok) fail('RESPONSE', '无法读取小米设备自动化目录');
    let data;
    try { data = JSON.parse(text).data; } catch { fail('RESPONSE', '设备自动化目录格式错误'); }
    if (!Array.isArray(data?.launch) || !Array.isArray(data?.action_list)) fail('RESPONSE', '设备自动化目录缺少触发项或动作项');
    return { model: device.model, triggers: data.launch, actions: data.action_list };
  }
  async irChildren(device) {
    const r = await this.cloud.request('/v2/irdevice/controllers', { parent_id: device.did });
    if (!Array.isArray(r?.controllers)) fail('RESPONSE', '红外子设备列表格式错误');
    return r.controllers.map(({ did, name, model, category }) => ({ did: String(did), name, model, category }));
  }
  property(spec, siid, piid, access) {
    const p = spec.services.find(s => s.iid === siid)?.properties?.find(p => p.iid === piid);
    if (!p || !p.access?.includes(access)) fail('UNSUPPORTED', `该设备规格不支持此属性的 ${access} 操作`);
    return p;
  }
  async getProperties(device, requests) {
    const result = [];
    for (let i = 0; i < requests.length; i += 20) {
      const r = await this.cloud.request('/miotspec/prop/get', { params: requests.slice(i, i + 20).map(p => ({ did: device.did, siid: p.siid, piid: p.piid })) });
      if (!Array.isArray(r)) fail('RESPONSE', '属性读取结果格式错误');
      result.push(...r);
    }
    return result;
  }
  async scenes(home) {
    const body = { home_id: Number(home.id), owner_uid: home.uid, app_version: 12 };
    const full = await this.cloud.request(scenesPath + 'GetSceneList', body);
    const simple = await this.cloud.request(scenesPath + 'GetSimpleSceneList', { ...body, get_type: 2 });
    if (!Array.isArray(full?.scene_info_list) || !Array.isArray(simple?.manual_scene_info_list) || !Array.isArray(simple?.auto_scene_info_list)) fail('RESPONSE', '场景列表格式错误');
    const definitions = new Map(full.scene_info_list.map(s => [s.scene_id, s]));
    return [...simple.manual_scene_info_list.map(s => ({ ...s, kind: 'manual' })), ...simple.auto_scene_info_list.map(s => ({ ...s, kind: 'automation' }))].map(s => ({ ...s, definition: definitions.get(s.scene_id) ?? null, fullDefinition: definitions.has(s.scene_id) }));
  }
  selectScene(list, id, full = false) {
    const matches = list.filter(s => s.scene_id === id || s.name === id);
    if (matches.length !== 1) fail('INPUT', '场景不存在或名称重复，请使用精确场景 ID');
    if (full && !matches[0].fullDefinition) fail('UNSUPPORTED', '模板场景只有摘要，不能用通用编辑覆盖；请在米家 App 中修改');
    return matches[0];
  }
  async mutate(plan, send, verify, commit) {
    if (!commit) return { preview: true, operation: plan.operation, before: plan.before ?? null, after: plan.after ?? null, changes: plan.changes ?? null, next: '确认符合用户要求后，加 --commit 执行' };
    const record = { ...plan, status: 'sending' }, receipt = await this.cloud.receipt(record);
    let result;
    try {
      result = await send();
    } catch(e) {
      record.status = e.code === 'UNKNOWN' ? 'unknown' : 'failed'; record.error = { code: e.code ?? 'LOCAL', details: e.details ?? {} };
      await saveJSON(receipt, record);
      if (e.details) e.details.receipt = receipt;
      throw e;
    }
    let verification;
    try {
      verification = await verify(result);
    } catch (e) {
      verification = { confirmed: false, verificationError: { code: e.code ?? 'LOCAL', message: '提交后回读失败，请先独立查询当前状态' } };
    }
    record.status = verification.confirmed ? 'confirmed' : 'not-confirmed';
    record.result = result;
    record.verification = verification;
    await saveJSON(receipt, record);
    return { accepted: true, ...verification, receipt };
  }
  async saveScene(home, current, input, commit) {
    const fresh = await this.scenes(home);
    if (current) {
      const now = this.selectScene(fresh, current.scene_id, true);
      if (fingerprint(now.definition) !== fingerprint(current.definition)) fail('CONFLICT', '场景刚被其他操作修改，请重新读取后再编辑');
      for (const k of ['scene_id', 'home_id', 'uid', 'template_id', 'create_time', 'scene_id_v1', 'sub_usIds', 'parent_usId']) if (Object.hasOwn(input, k) && fingerprint(input[k]) !== fingerprint(current.definition[k])) fail('INPUT', `不能通过编辑修改 ${k}`);
    }
    const desired = current ? merge(current.definition, input) : newScene(home, input);
    if (!desired.name?.trim() || !Array.isArray(desired.scene_trigger?.triggers) || !desired.scene_trigger.triggers.length || !Array.isArray(desired.scene_action?.actions) || !desired.scene_action.actions.length || typeof desired.enable !== 'boolean') fail('INPUT', '场景需有名称、触发条件、执行动作和有效启用状态');
    if (!current && fresh.some(s => s.name === desired.name)) fail('CONFLICT', '同名场景已存在，请先查询，避免重复创建');
    const beforeIds = new Set(fresh.map(s => s.scene_id));
    return this.mutate({ operation: current ? 'scene.update' : 'scene.create', homeId: String(home.id), before: current?.definition, after: desired },
      () => this.cloud.request(scenesPath + 'Edit', desired, { write: true }), async result => {
        const id = String(result?.scene_id ?? current?.scene_id ?? '');
        const list = await this.scenes(home);
        const newMatches = !id ? list.filter(s => s.name === desired.name && !beforeIds.has(s.scene_id)) : [];
        const after = id ? list.find(s => s.scene_id === id) : newMatches.length === 1 ? newMatches[0] : null;
        const expected = current ? input : Object.fromEntries(Object.entries(desired).filter(([k]) => !['scene_id', 'uid', 'home_id', 'create_time', 'update_time', 'local_dev'].includes(k)));
        return { sceneId: after?.scene_id ?? (id || null), confirmed: Boolean(after?.definition && contains(after.definition, expected) && (current || !beforeIds.has(after.scene_id))), enabled: after?.enable ?? null, definition: after?.definition ?? null };
      }, commit);
  }
  async deleteScene(home, scene, commit) {
    if (!scene.fullDefinition || scene.definition.template_id && scene.definition.template_id !== '0') fail('UNSUPPORTED', '模板场景不使用通用删除接口');
    const current = this.selectScene(await this.scenes(home), scene.scene_id, true);
    if (fingerprint(current.definition) !== fingerprint(scene.definition)) fail('CONFLICT', '场景刚被其他操作修改，请重新读取后再删除');
    return this.mutate({ operation: 'scene.delete', homeId: String(home.id), before: scene.definition },
      () => this.cloud.request('/scene/delete', { identify: '', us_id: scene.scene_id }, { write: true }),
      async result => ({ confirmed: result === true && !(await this.scenes(home)).some(s => s.scene_id === scene.scene_id), sceneId: scene.scene_id }), commit);
  }
  async runScene(home, scene, commit) {
    if (scene.kind !== 'manual') fail('INPUT', '只能手动执行手动控制场景');
    return this.mutate({ operation: 'scene.run', homeId: String(home.id), before: { scene_id: scene.scene_id, name: scene.name } },
      () => this.cloud.request(scenesPath + 'NewRunScene', { scene_id: scene.scene_id, scene_type: 2, phone_id: 'null', home_id: String(home.id), owner_uid: home.uid }, { write: true }),
      async result => ({ accepted: result === true, confirmed: false, acceptedByCloud: result === true, message: '接口接受不代表所有设备动作均完成，请查询相关设备状态' }), commit);
  }
}
