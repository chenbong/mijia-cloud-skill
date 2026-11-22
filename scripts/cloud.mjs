// SPDX-License-Identifier: GPL-3.0-or-later
// Xiaomi cloud protocol/authentication adapted from Do1e/mijia-api and xgg.
// See ../NOTICE and ../LICENSE. This is an independent client, not an official SDK.
import { randomBytes, createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export class MijiaError extends Error {
  constructor(code, message, details = {}) { super(message); this.code = code; this.details = details; }
}
export const fail = (code, message, details) => { throw new MijiaError(code, message, details); };
export async function readJSON(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; fail('FILE', '无法读取有效 JSON 文件'); }
}
export async function saveJSON(path, data) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  try { await writeFile(temp, JSON.stringify(data, null, 2), { mode: 0o600, flag: 'wx' }); await rename(temp, path); }
  finally { await unlink(temp).catch(() => {}); }
}
export const fingerprint = value => createHash('sha256').update(JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v) ?? 'undefined').digest('hex');
export function rc4(key, bytes) {
  if (!key.length) fail('CRYPTO', '缺少密钥');
  const s = Uint8Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i++) { j = (j + s[i] + key[i % key.length]) & 255; [s[i], s[j]] = [s[j], s[i]]; }
  let i = 0; j = 0;
  const out = Buffer.alloc(bytes.length);
  for (let n = -1024; n < bytes.length; n++) {
    i = (i + 1) & 255; j = (j + s[i]) & 255; [s[i], s[j]] = [s[j], s[i]];
    if (n >= 0) out[n] = bytes[n] ^ s[(s[i] + s[j]) & 255];
  }
  return out;
}
export function nonce() { const b = Buffer.concat([randomBytes(8), Buffer.alloc(4)]); b.writeUInt32BE(Math.floor(Date.now() / 60000), 8); return b.toString('base64'); }
export const signedNonce = (security, n) => createHash('sha256').update(Buffer.from(security, 'base64')).update(Buffer.from(n, 'base64')).digest('base64');
const signature = (path, key, params) => createHash('sha1').update(['POST', path, ...Object.entries(params).map(([k, v]) => `${k}=${v}`), key].join('&')).digest('base64');
export function encode(path, body, security, n) {
  const key = signedNonce(security, n), params = { data: JSON.stringify(body) };
  params.rc4_hash__ = signature(path, key, params);
  for (const k of Object.keys(params)) params[k] = rc4(Buffer.from(key, 'base64'), Buffer.from(params[k])).toString('base64');
  return new URLSearchParams({ ...params, signature: signature(path, key, params), ssecurity: security, _nonce: n }).toString();
}
export function decode(text, security, n) {
  // Scene history can return 64-bit IDs as JSON numbers instead of strings.
  const preserveInteger = (_key, value, context) =>
    typeof value === 'number' && !Number.isSafeInteger(value) && /^-?\d+$/.test(context?.source ?? '')
      ? context.source
      : value;
  try { return JSON.parse(text, preserveInteger); } catch {}
  const bytes = rc4(Buffer.from(signedNonce(security, n), 'base64'), Buffer.from(text, 'base64'));
  const body = bytes[0] === 31 && bytes[1] === 139 ? gunzipSync(bytes, { maxOutputLength: 8 * 1024 * 1024 }) : bytes;
  return JSON.parse(body.toString('utf8'), preserveInteger);
}
function trustedURL(value) {
  let url; try { url = new URL(value); } catch { fail('RESPONSE', '登录服务返回了无效地址'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !['account.xiaomi.com', 'mijia.tech', 'api.io.mi.com'].some(h => url.hostname === h || url.hostname.endsWith(`.${h}`))) fail('RESPONSE', '登录服务返回的地址不在小米服务范围内');
  return url;
}
function credentials(data = {}) {
  for (const key of ['userId', 'cUserId', 'serviceToken', 'passToken', 'deviceId', 'pass_o', 'ua']) {
    if (data[key] != null && (typeof data[key] !== 'string' && typeof data[key] !== 'number' || /[\r\n;]/.test(String(data[key])))) fail('AUTH_FILE', '登录文件字段无效');
  }
  if (data.ssecurity != null && !/^[A-Za-z0-9+/]+={0,2}$/.test(data.ssecurity)) fail('AUTH_FILE', '登录文件字段无效');
  return data;
}
export class Cloud {
  constructor(options = {}) {
    this.region = options.region ?? process.env.MIJIA_REGION ?? 'cn';
    if (!['cn', 'de', 'us', 'ru', 'tw', 'sg', 'i2'].includes(this.region)) fail('INPUT', '不支持的地区');
    this.dir = resolve(options.dataDir ?? process.env.MIJIA_DATA_DIR ?? join(homedir(), '.mijia-cloud', this.region));
    this.authFile = options.authFile ?? process.env.MIJIA_AUTH_FILE ?? join(this.dir, 'auth.json');
    this.timeout = options.timeout ?? 20000; this.fetch = options.fetch ?? globalThis.fetch;
    this.api = this.region === 'cn' ? 'https://api.mijia.tech/app' : `https://${this.region}.api.io.mi.com/app`;
  }
  async load() { return credentials(await readJSON(this.authFile, {})); }
  async save(auth) { await saveJSON(this.authFile, credentials({ ...auth, saveTime: Date.now() })); }
  async fetchText(url, init = {}, timeout = this.timeout) {
    try {
      const res = await this.fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(timeout) });
      const text = await res.text();
      if (text.length > 8 * 1024 * 1024) fail('RESPONSE', '服务器响应过大');
      return { res, text };
    } catch(e) { if (e instanceof MijiaError) throw e; fail('NETWORK', '网络请求中断或超时'); }
  }
  async account(url, auth, cookie = '', timeout) {
    const { res, text } = await this.fetchText(trustedURL(url), { headers: { 'User-Agent': auth.ua, Cookie: cookie } }, timeout);
    if (!res.ok) fail('AUTH', '小米账号登录请求失败', { status: res.status });
    try { return JSON.parse(text.replace(/^&&&START&&&/, '')); } catch { fail('RESPONSE', '无法解析小米登录响应'); }
  }
  cookie(auth) { return ['deviceId', 'pass_o', 'passToken', 'userId', 'cUserId'].filter(k => auth[k]).map(k => `${k}=${auth[k]}`).concat('uLocale=zh_CN').join(';'); }
  init(auth = {}) {
    const id = randomBytes(20).toString('hex').toUpperCase();
    const pass_o = auth.pass_o ?? randomBytes(8).toString('hex');
    return { ...auth, pass_o, deviceId: auth.deviceId ?? randomBytes(12).toString('base64url'), ua: auth.ua ?? `Android-15-11.0.701-Xiaomi-23046RP50C-OS2.0.212.0.VMYCNXM-${id}-CN-${randomBytes(16).toString('hex').toUpperCase()}-${randomBytes(16).toString('hex').toUpperCase()}-SmartHome-MI_APP_STORE-${id}|${id}|${pass_o}-64` };
  }
  async callback(location, auth) {
    let url = trustedURL(location); const cookies = {};
    for (let i = 0; i < 6; i++) {
      const { res } = await this.fetchText(url, { headers: { 'User-Agent': auth.ua, Cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join(';') } });
      for (const line of res.headers.getSetCookie()) {
        const match = /^([^=;\s]+)=([^;]*)/.exec(line);
        if (match && ['serviceToken', 'cUserId', 'userId', 'passToken'].includes(match[1])) cookies[match[1]] = match[2];
      }
      if ([301, 302, 303, 307, 308].includes(res.status)) { url = trustedURL(new URL(res.headers.get('location'), url)); continue; }
      const result = credentials({ ...auth, ...cookies });
      if (!res.ok || !result.serviceToken || !result.ssecurity || !result.cUserId) fail('AUTH', '登录未完成，请重新扫码');
      await this.save(result); return;
    }
    fail('AUTH', '小米登录重定向次数过多');
  }
  async refresh() {
    const auth = this.init(await this.load());
    if (!auth.passToken) fail('AUTH', '请先用米家 App 扫码登录');
    const data = await this.account('https://account.xiaomi.com/pass/serviceLogin?_json=true&sid=mijia&_locale=zh_CN', auth, this.cookie(auth));
    if (data.code !== 0 || !data.location || !data.ssecurity) fail('AUTH', '登录已过期，请重新扫码');
    await this.callback(data.location, { ...auth, ssecurity: data.ssecurity });
  }
  async perform(path, body, write = false) {
    const auth = await this.load();
    if (!auth.serviceToken || !auth.ssecurity || !auth.cUserId) fail('AUTH', '请先用米家 App 扫码登录');
    const n = nonce(); let envelope;
    try {
      const { res, text } = await this.fetchText(this.api + path, { method: 'POST', headers: {
        'User-Agent': auth.ua ?? 'mijia-cloud', 'Content-Type': 'application/x-www-form-urlencoded',
        'accept-encoding': 'identity', 'miot-accept-encoding': 'GZIP', 'miot-encrypt-algorithm': 'ENCRYPT-RC4', 'x-xiaomi-protocal-flag-cli': 'PROTOCAL-HTTP2',
        Cookie: `cUserId=${auth.cUserId};yetAnotherServiceToken=${auth.serviceToken};serviceToken=${auth.serviceToken};countryCode=CN;locale=zh_CN;timezone_id=${Intl.DateTimeFormat().resolvedOptions().timeZone};PassportDeviceId=${auth.deviceId ?? ''};channel=MI_APP_STORE`
      }, body: encode(path, body, auth.ssecurity, n) });
      if ([401, 403].includes(res.status)) fail('AUTH', '登录已过期');
      if (!res.ok) fail('HTTP', '小米接口 HTTP 请求失败', { status: res.status });
      try { envelope = decode(text, auth.ssecurity, n); } catch { fail('RESPONSE', '无法解析小米接口响应'); }
      if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) fail('RESPONSE', '小米接口响应格式错误');
    } catch(e) {
      if (write && e.code !== 'AUTH') fail('UNKNOWN', '写入结果未知，未重发；请先查询服务器状态', { cause: e.code });
      throw e;
    }
    if ([3, 401, 403].includes(envelope.code)) fail('AUTH', '登录已过期');
    if (envelope.code && envelope.code !== 0) fail('API', '小米接口拒绝请求', { serverCode: envelope.code });
    if (!Object.hasOwn(envelope, 'result')) fail(write ? 'UNKNOWN' : 'RESPONSE', '小米接口未返回结果，未重发');
    return envelope.result;
  }
  async request(path, body = {}, { write = false } = {}) {
    if (!/^\/[A-Za-z0-9_./-]+$/.test(path) || path.split('/').some(s => s === '.' || s === '..')) fail('INPUT', '无效接口路径');
    if (write) { await this.request('/v2/message/v2/check_new_msg', { begin_at: Math.floor(Date.now() / 1000) - 3600 }); return this.perform(path, body, true); }
    try { return await this.perform(path, body); }
    catch(e) { if (e.code !== 'AUTH') throw e; await this.refresh(); return this.perform(path, body); }
  }
  async status() {
    try { await this.request('/v2/message/v2/check_new_msg', { begin_at: Math.floor(Date.now() / 1000) - 3600 }); return { authenticated: true, region: this.region }; }
    catch(e) { if (e.code !== 'AUTH') throw e; return { authenticated: false, region: this.region }; }
  }
  async login(restart = false) {
    if ((await this.status()).authenticated) return { authenticated: true, reused: true };
    const pendingPath = join(this.dir, 'pending.json');
    const pending = await readJSON(pendingPath, null);
    if (!restart && pending?.expiresAt > Date.now()) return this.loginInfo(pending);
    const auth = this.init(await this.load());
    const data = await this.account('https://account.xiaomi.com/pass/serviceLogin?_json=true&sid=mijia&_locale=zh_CN', auth, this.cookie(auth));
    if (data.code === 0 && data.location && data.ssecurity) { await this.callback(data.location, { ...auth, ssecurity: data.ssecurity }); return { authenticated: true, reused: true }; }
    const query = trustedURL(data.location).searchParams;
    for (const [k, v] of Object.entries({ theme: '', bizDeviceType: '', _hasLogo: 'false', _qrsize: '240', _dc: String(Date.now()) })) query.set(k, v);
    const login = await this.account(`https://account.xiaomi.com/longPolling/loginUrl?${query}`, auth);
    if (login.code !== 0 || !login.lp || !login.qr || !login.loginUrl) fail('RESPONSE', '小米未返回有效二维码');
    for (const key of ['lp', 'qr', 'loginUrl']) trustedURL(login[key]);
    const next = { auth, login, expiresAt: Date.now() + 120000 };
    await saveJSON(pendingPath, next);
    return this.loginInfo(next);
  }
  loginInfo(pending) { return { authenticated: false, status: 'pending', qrUrl: pending.login.qr, expiresAt: new Date(pending.expiresAt).toISOString(), next: 'auth poll' }; }
  async poll(wait = 20000) {
    if (!Number.isInteger(wait) || wait < 1000 || wait > 30000) fail('INPUT', '等待时间须为 1000–30000 毫秒');
    const path = join(this.dir, 'pending.json'), pending = await readJSON(path, null);
    if (!pending || pending.expiresAt <= Date.now()) fail('QR_EXPIRED', '二维码过期，请重新发起登录');
    let data;
    try { data = await this.account(pending.login.lp, credentials(pending.auth), '', Math.min(wait, pending.expiresAt - Date.now())); }
    catch(e) { if (e.code === 'NETWORK' && pending.expiresAt > Date.now()) return this.loginInfo(pending); throw e; }
    if ((data.code ?? 0) !== 0 || !data.location) fail('AUTH', '扫码授权未成功，请重新登录');
    const auth = { ...pending.auth };
    for (const key of ['ssecurity', 'passToken', 'userId', 'cUserId']) if (data[key] != null) auth[key] = data[key];
    await this.callback(data.location, auth); await unlink(path);
    return { authenticated: true };
  }
  async logout() { await unlink(this.authFile).catch(e => { if (e.code !== 'ENOENT') throw e; }); await unlink(join(this.dir, 'pending.json')).catch(e => { if (e.code !== 'ENOENT') throw e; }); return { authenticated: false, localCredentialsRemoved: true }; }
  async receipt(record) { const path = join(this.dir, 'receipts', `${Date.now()}-${randomBytes(4).toString('hex')}.json`); await saveJSON(path, { recordedAt: new Date().toISOString(), ...record }); return path; }
}
