// SPDX-License-Identifier: GPL-3.0-or-later
import { fail, fingerprint } from './cloud.mjs';

export function auditScenes(scenes, devices) {
  const knownScenes = new Set(scenes.map(scene => String(scene.scene_id)));
  const knownDevices = new Map(devices.map(device => [device.did, device]));
  const incoming = new Map();
  const missingScenes = [];
  const deviceReferences = [];

  for (const scene of scenes) {
    const definition = scene.definition ?? scene;
    const source = { sceneId: String(scene.scene_id), name: scene.name, enabled: scene.enable };
    const actions = [
      ...(definition.scene_action?.actions ?? []),
      ...(definition.scene_else_action?.actions ?? [])
    ];
    for (const action of actions) {
      const payload = action.payload_json;
      const id = payload?.scene_id ?? payload?.us_id;
      if ([2, 3].includes(action.type) && id) {
        const sceneId = String(id);
        const operation = action.type === 2 ? 'run' : payload.enable === true ? 'enable' : 'disable';
        const entry = { ...source, operation };
        if (!knownScenes.has(sceneId) || action.nested_scene_info?.delete_mark) {
          missingScenes.push({ ...entry, targetSceneId: sceneId, targetLabel: action.name });
        }
        const callers = incoming.get(sceneId) ?? [];
        callers.push(entry);
        incoming.set(sceneId, callers);
      }
      if (payload?.did) deviceReferences.push({ ...source, did: String(payload.did), field: 'action' });
    }
    for (const [field, entries] of [
      ['trigger', definition.scene_trigger?.triggers ?? []],
      ['condition', definition.scene_condition?.conditions ?? []]
    ]) {
      for (const entry of entries) {
        const did = entry.extra_json?.did ?? entry.did;
        if (entry.src === 'device' && did) deviceReferences.push({ ...source, did: String(did), field });
      }
    }
  }

  const unlistedDevices = [];
  const offlineDevices = [];
  for (const row of deviceReferences) {
    const device = knownDevices.get(row.did);
    if (!device) unlistedDevices.push({ ...row, infrared: row.did.startsWith('ir.') });
    else if (device.online === false) offlineDevices.push({ ...row, deviceName: device.name });
  }
  const unique = rows => [...new Map(rows.map(row => [fingerprint(row), row])).values()];
  const inventory = scenes.map(scene => ({
    sceneId: String(scene.scene_id),
    name: scene.name,
    kind: scene.kind,
    enabled: scene.enable,
    fullDefinition: scene.fullDefinition,
    referencedBy: unique(incoming.get(String(scene.scene_id)) ?? [])
  }));
  return {
    scenes: inventory,
    unreferencedManualScenes: inventory.filter(scene => scene.kind === 'manual' && !scene.referencedBy.length),
    disabledAutomationsWithoutEnablingRule: inventory.filter(scene =>
      scene.kind === 'automation' && !scene.enabled && !scene.referencedBy.some(row => row.operation === 'enable')),
    missingSceneReferences: unique(missingScenes),
    unlistedDeviceReferences: unique(unlistedDevices),
    offlineDeviceReferences: unique(offlineDevices)
  };
}

export async function sceneHistory(cloud, home, { sceneId, since, limit = 100 } = {}) {
  const ownerUid = Number(home.uid);
  const uid = Number((await cloud.load()).userId ?? ownerUid);
  if (![uid, ownerUid].every(v => Number.isSafeInteger(v) && v > 0)) fail('INPUT', '执行历史要求有效的米家账号和家庭所有者 ID');
  const pageSize = sceneId ? 1000 : Math.max(100, Math.min(limit, 1000));
  const params = { home_id: Number(home.id), uid, owner_uid: ownerUid, command: 'history', limit: pageSize };
  const found = new Map();
  let oldestScanned = null;
  let newestScanned = null;
  let stopReason = 'page-limit';

  for (let page = 0; page < 40; page++) {
    const cursor = oldestScanned === null ? {} : { timestamp: oldestScanned + 1 };
    const r = await cloud.request('/scene/history', { ...params, ...cursor });
    if (!Array.isArray(r?.history)) fail('RESPONSE', '场景运行日志格式错误');
    if (!r.history.length) { stopReason = 'exhausted'; break; }
    const rows = r.history.map(row => ({ ...row, time: Number(row.time), userSceneId: String(row.userSceneId ?? '') }));
    if (rows.some(row => !Number.isSafeInteger(row.time) || row.time <= 0)) fail('RESPONSE', '场景运行日志时间无效');
    const oldest = Math.min(...rows.map(row => row.time));
    const newest = Math.max(...rows.map(row => row.time));
    if (oldestScanned !== null && newest > oldestScanned) { stopReason = 'cursor-stalled'; break; }
    for (const row of rows) {
      if ((since === undefined || row.time >= since) && (!sceneId || row.userSceneId === sceneId)) {
        found.set(fingerprint(row), row);
      }
    }
    newestScanned ??= newest;
    if (oldest === oldestScanned) {
      stopReason = rows.length < pageSize ? 'exhausted' : 'cursor-stalled';
      break;
    }
    oldestScanned = oldest;
    if (found.size >= limit) { stopReason = 'limit-reached'; break; }
    if (since !== undefined && oldest < since) { stopReason = 'since-reached'; break; }
  }
  return {
    entries: [...found.values()].sort((a, b) => b.time - a.time).slice(0, limit),
    oldestScanned,
    newestScanned,
    stopReason
  };
}
