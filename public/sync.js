// 多设备同步（免账号、端到端加密、按设备授权）
// - 家长设备生成一把随机的"同步密钥"。服务器只拿到由它算出的家庭编号，以及 AES-GCM 加密后的片单，没有密钥就读不了内容。
// - 每台设备有自己的访问凭证。新设备只能用家长设备生成的一次性邀请加入（扫码 / 链接，24 小时内有效），
//   密钥和邀请都放在网址 # 后面，浏览器不会把它们发给任何服务器。
// - 家长可以查看、改名、移除设备；移除时可以让那台设备清空同步来的片单（下次联网时生效）。
// - 同步的内容：视频、分组、家长密码（哈希）、每日时长等家长设置；每台设备自己的语言、观看进度、今日时长不同步。
const API = 'https://api.domibuddy.com/v1/sync/';
const STORE = 'domibuddy:sync';
const CHUNK_BYTES = 512 * 1024;
const FREE_BYTES = 2 * 1024 * 1024;
const MEMBER_BYTES = 20 * 1024 * 1024;
// 服务器（domilists-cloud）对 v2 的限制：最新一份密文，免费 2 MiB、会员 20 MiB（原始字节，不是 base64）。
// 已存的字节加上这一份还不能超过上限的 2 倍。AES-GCM 密文 = gzip 后的长度 + 16 字节标签，再加 12 字节 IV，一共 +28。
// 旧的 v1 接口在 base64 密文超过 1_000_000 字符时直接 413；现在不再走那条单次上传。
export function syncUploadLimit(capacity) {
  const advertised = Number(capacity?.limit);
  const limit = Number.isFinite(advertised) && advertised > 0 ? advertised : FREE_BYTES;
  return Math.min(limit, MEMBER_BYTES);
}
export function syncPayloadTooBig(capacity, encryptedSize, blocked) {
  const limit = syncUploadLimit(capacity);
  const stored = Number(capacity?.bytes);
  const used = Number.isFinite(stored) && stored > 0 ? stored : 0;
  if (encryptedSize > limit || used + encryptedSize > limit * 2) return true;
  // 服务器已经用 413 拒绝过这么大（或更大）的一份，而且上限没有变高：不要再传。
  if (blocked && encryptedSize >= blocked.bytes && limit <= blocked.limit) return true;
  return false;
}
const SETTINGS = ['pinHash', 'dailyLimit', 'autoplayNext', 'biliNative', 'shield', 'sandbox', 'sandboxSites', 'sandboxYoukuDefault', 'ytKey'];

export const syncSupported = () => !!(globalThis.crypto?.subtle && window.isSecureContext && globalThis.CompressionStream && globalThis.DecompressionStream);

// cfg：{ key, deviceId, token, role, version, at }
let cfg = null;
try { cfg = JSON.parse(localStorage.getItem(STORE)) || null; } catch {}
if (cfg && !cfg.token) cfg = null; // 旧版（没有设备凭证）的同步配置：作废
const saveCfg = () => { try { cfg ? localStorage.setItem(STORE, JSON.stringify(cfg)) : localStorage.removeItem(STORE); } catch {} };

const b64u = (bytes) => btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join('')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64 = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const digest = (label, key) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(label + ':' + key));

let derived = null;
async function keys(key = cfg.key) {
  if (derived?.key === key) return derived;
  const [id, enc] = await Promise.all([digest('id', key), digest('enc', key)]);
  derived = { key, id: hex(id).slice(0, 32), aes: await crypto.subtle.importKey('raw', enc, 'AES-GCM', false, ['encrypt', 'decrypt']) };
  return derived;
}
async function decrypt(s, key) {
  const { aes } = await keys(key);
  const raw = unb64(s);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, aes, raw.slice(12));
  return JSON.parse(new TextDecoder().decode(pt));
}
async function call(method, path = '', body, { auth = true, v2 = false, binary = false } = {}) {
  const current = cfg;
  const { id } = await keys(current.key);
  checkSession(current);
  const headers = {
    ...(auth && current.token ? { authorization: `Bearer ${current.deviceId}.${current.token}` } : {}),
    ...(body ? { 'content-type': binary ? 'application/octet-stream' : 'application/json' } : {}),
  };
  const api = v2 ? API.replace('/v1/', '/v2/') : API;
  const response = await fetch(api + id + path, { method, headers, body: binary ? body : body ? JSON.stringify(body) : undefined, cache: 'no-store' });
  if (binary && method === 'GET' && response.ok) return { status: response.status, bytes: new Uint8Array(await response.arrayBuffer()) };
  let data = {};
  try { data = await response.json(); } catch {}
  if (cfg === current && response.status === 410 && data.error === 'revoked') revoked(!!data.wipe);
  return { status: response.status, ...data };
}

// 设备名：例如"iPad · Safari"、"Mac · Chrome"
export function deviceName() {
  const ua = navigator.userAgent;
  // iPadOS 的 Safari 默认伪装成 Mac，只能用触摸点数区分
  const os = /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? 'iPad'
    : /iPhone/.test(ua) ? 'iPhone' : /Android/.test(ua) ? (/Mobile/.test(ua) ? 'Android' : 'Android 平板') : /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
  const br = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  return [os, br].filter(Boolean).join(' · ') || 'Device';
}

// ---------------------------------------------------------------- 与 app.js 的接口
let hooks = null; // { getDb, applyRemote(snapshot), onStatus(state), onRevoked(wipe) }
let lastPrint = '', pushTimer = null, applying = false, busy = Promise.resolve();
let rejectedPrint = null;
const snapshot = (db) => ({ groups: db.groups, videos: db.videos, seriesCovers: db.seriesCovers, settings: Object.fromEntries(SETTINGS.filter((k) => k in db.settings).map((k) => [k, db.settings[k]])) });
const print = (snap) => JSON.stringify(snap);
const status = (state, extra = {}) => hooks?.onStatus?.({ state, at: cfg?.at || null, ...extra });
const queue = (fn) => (busy = busy.then(fn, fn));

export const syncOn = () => !!cfg?.token;
export const syncInfo = () => (cfg ? { at: cfg.at || null, version: cfg.version || 0, role: cfg.role, deviceId: cfg.deviceId, beta: !!cfg.beta, since: cfg.since || null, capacity: cfg.capacity, cloudVersion: cfg.cloudVersion, cloudCount: cfg.cloudCount } : null);
export const isParentDevice = () => cfg?.role === 'parent';

function revoked(wipe) {
  cfg = null; derived = null; lastPrint = ''; rejectedPrint = null; saveCfg();
  clearTimeout(pushTimer);
  hooks?.onRevoked?.(wipe);
  status('revoked', { wipe });
}

const snapshotHash = (serialized) => digest('snapshot-v2', serialized).then(hex);
function childSnapshotHash(serialized) {
  const value = JSON.parse(serialized);
  for (const video of value.videos) {
    if (video.platform === 'youtube') {
      delete video.author;
      delete video.authorUrl;
    }
    if (video.platform === 'baidupan') delete video.thumb;
  }
  return snapshotHash(print(value));
}
function observeCloudList(current, head, count) {
  if (current.cloudVersion !== head.version) delete current.cloudCount;
  current.cloudVersion = head.version;
  if (Number.isInteger(count)) current.cloudCount = count;
}
const conflict = (reason) => { status('pending_conflict', { reason }); return false; };
const hashBytes = (raw) => crypto.subtle.digest('SHA-256', raw).then(hex);
const isCurrent = (current) => cfg === current;
const cloudCapacity = (r, current = cfg) => {
  if (r.capacity && current === cfg) { current.capacity = r.capacity; saveCfg(); }
};
const retryable = new Set([429, 500, 502, 503, 504]);
async function retry(fn) {
  for (let n = 0; ; n++) {
    try {
      const result = await fn();
      // 413 是片单超过容量，不是暂时故障。再试只会打成每小时几百次的循环。
      if (result?.status === 413 || !retryable.has(result?.status) || n === 2) return result;
    } catch (e) {
      if (n === 2 || e.message === 'sync_session_changed' || e.message === 'too_large') throw e;
    }
    await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** n));
  }
}
const checkSession = (current) => { if (!isCurrent(current)) throw new Error('sync_session_changed'); };
const v2 = (current, method, path = '', data, options = {}) => {
  checkSession(current);
  return call(method, path, data, { ...options, v2: true });
};
async function transform(raw, format) {
  const stream = new Blob([raw]).stream();
  const output = format === 'compress' ? new CompressionStream('gzip') : new DecompressionStream('gzip');
  return new Uint8Array(await new Response(stream.pipeThrough(output)).arrayBuffer());
}
async function measurePayload(serialized) {
  const compressed = await transform(new TextEncoder().encode(serialized), 'compress');
  return { compressed, encryptedSize: compressed.length + 28 };
}
async function prepareUpload(current, serialized, fingerprint, compressed) {
  if (!compressed) compressed = (await measurePayload(serialized)).compressed;
  checkSession(current);
  const encryptedSize = compressed.length + 28;
  if (syncPayloadTooBig(current.capacity, encryptedSize, current.blockedUpload)) {
    const error = new Error('too_large');
    error.encryptedSize = encryptedSize;
    throw error;
  }
  const encodedHash = await hashBytes(compressed);
  const previous = current.pending;
  const reusable = previous?.fingerprint === fingerprint && previous.encodedHash === encodedHash && previous.base === current.version;
  if (previous && !reusable) await cancelPending(current);
  checkSession(current);
  const iv = reusable ? unb64(previous.iv) : crypto.getRandomValues(new Uint8Array(12));
  const { aes } = await keys(current.key);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, compressed));
  checkSession(current);
  const bytes = new Uint8Array(12 + ciphertext.length);
  bytes.set(iv);
  bytes.set(ciphertext, 12);
  const upload = reusable ? previous : {
    id: hex(crypto.getRandomValues(new Uint8Array(16))), iv: b64(iv), encodedHash, fingerprint, base: current.version || 0,
  };
  current.pending = upload;
  saveCfg();
  return { upload, bytes };
}
async function cancelPending(current) {
  if (!current.pending) return;
  const result = await retry(() => v2(current, 'DELETE', '/uploads/' + current.pending.id));
  checkSession(current);
  if (result.status !== 200 && result.status !== 404) throw new Error(result.error || 'HTTP ' + result.status);
  delete current.pending;
  saveCfg();
}
const chunksOf = (bytes) => Array.from({ length: Math.ceil(bytes.length / CHUNK_BYTES) },
  (_, i) => bytes.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES));
const manifestHash = async (chunks) => hashBytes(new TextEncoder().encode((await Promise.all(chunks.map(hashBytes))).join('')));
async function uploadSnapshot(current, serialized, fingerprint, compressed) {
  const { upload, bytes } = await prepareUpload(current, serialized, fingerprint, compressed);
  const chunks = chunksOf(bytes), hash = await manifestHash(chunks), path = '/uploads/' + upload.id;
  const start = () => retry(() => v2(current, 'PUT', path, { base: upload.base, bytes: bytes.length, hash }));
  for (let attempt = 0; attempt < 2; attempt++) {
    const begin = await start();
    if (begin.status !== 200 || begin.version != null) return begin;
    if (begin.chunkBytes !== CHUNK_BYTES || !Array.isArray(begin.received)) throw new Error('bad_manifest');
    const received = new Set(begin.received);
    let expired = false;
    for (const [i, chunk] of chunks.entries()) {
      if (received.has(i)) continue;
      const result = await retry(() => v2(current, 'PUT', path + '/chunks/' + i, chunk, { binary: true }));
      if (result.status === 404) { expired = true; break; }
      if (result.status !== 200) return result;
    }
    if (expired) continue;
    const done = await retry(() => v2(current, 'POST', path));
    if (done.status !== 404) return done;
  }
  throw new Error('upload_expired');
}

async function readSnapshot(current, head) {
  if (!head.upload) {
    if (!head.ciphertext) throw new Error('snapshot_unavailable');
    return decrypt(head.ciphertext, current.key);
  }
  if (head.chunkBytes !== CHUNK_BYTES || !Number.isSafeInteger(head.bytes) || head.bytes < 28 || head.bytes > 20 * 1024 * 1024 ||
      !/^[a-f0-9]{32}$/.test(head.upload) || !/^[a-f0-9]{64}$/.test(head.hash)) throw new Error('bad_manifest');
  const raw = new Uint8Array(head.bytes);
  for (let offset = 0; offset < head.bytes; offset += CHUNK_BYTES) {
    const result = await retry(() => v2(current, 'GET', '/uploads/' + head.upload + '/chunks/' + (offset / CHUNK_BYTES), undefined, { binary: true }));
    if (result.status === 404) throw new Error('version_changed');
    if (result.status !== 200) throw new Error(result.error || 'HTTP ' + result.status);
    if (!result.bytes || result.bytes.length !== Math.min(CHUNK_BYTES, head.bytes - offset)) throw new Error('bad_manifest');
    raw.set(result.bytes, offset);
  }
  if (await manifestHash(chunksOf(raw)) !== head.hash) throw new Error('bad_manifest');
  const { aes } = await keys(current.key);
  const clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.subarray(0, 12) }, aes, raw.subarray(12));
  const snap = JSON.parse(new TextDecoder().decode(await transform(clear, 'decompress')));
  if (!Array.isArray(snap?.videos) || !Array.isArray(snap.groups)) throw new Error('bad_snapshot');
  return snap;
}

let started = false;
export function initSync(h) {
  hooks = h;
  if (!syncOn() || !syncSupported()) return;
  const current = cfg;
  queue(async () => {
    if (!isCurrent(current)) return;
    if (await pull()) await push();
  });
  if (started) return;
  started = true;
  const refresh = () => syncOn() && document.visibilityState === 'visible' && queue(async () => {
    if (await pull()) await push();
  });
  setInterval(refresh, 60000);
  document.addEventListener('visibilitychange', refresh);
}

export function onSaved() {
  if (!syncOn() || !syncSupported() || applying || !hooks) return;
  const serialized = print(snapshot(hooks.getDb()));
  if (serialized === lastPrint || serialized === rejectedPrint) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => queue(async () => { if (await pull()) await push(); }), 1500);
}

async function rememberOversize(current, serialized, fingerprint, encryptedSize, fromServer) {
  if (!isCurrent(current)) return;
  if (current.pending) {
    try { await cancelPending(current); } catch { /* 下次能传得下的时候会再取消 */ }
  }
  if (!isCurrent(current)) return;
  current.rejectedSnapshot = fingerprint;
  current.rejectedLimit = syncUploadLimit(current.capacity);
  if (fromServer && encryptedSize > 0) current.blockedUpload = { bytes: encryptedSize, limit: current.rejectedLimit };
  rejectedPrint = serialized;
  saveCfg();
  status('too_large');
}

async function push() {
  if (!syncOn()) return;
  const current = cfg, serialized = print(snapshot(hooks.getDb()));
  if (serialized === lastPrint) return;
  const fingerprint = await snapshotHash(serialized);
  if (!isCurrent(current)) return;
  if (fingerprint === current.baseline) { lastPrint = serialized; return; }
  const limit = syncUploadLimit(current.capacity);
  if (current.rejectedSnapshot === fingerprint && current.rejectedLimit === limit) {
    rejectedPrint = serialized;
    return status('too_large');
  }
  try {
    status('syncing');
    const { compressed, encryptedSize } = await measurePayload(serialized);
    if (!isCurrent(current)) return;
    if (syncPayloadTooBig(current.capacity, encryptedSize, current.blockedUpload)) {
      return rememberOversize(current, serialized, fingerprint, encryptedSize, false);
    }
    const result = await uploadSnapshot(current, serialized, fingerprint, compressed);
    checkSession(current);
    cloudCapacity(result, current);
    if (result.status === 413) return rememberOversize(current, serialized, fingerprint, encryptedSize, true);
    if (result.status === 409 && result.error === 'conflict') {
      await pull();
      return;
    }
    if (result.status !== 200) throw new Error(result.error || 'HTTP ' + result.status);
    const childBaseline = current.role === 'child' ? await childSnapshotHash(serialized) : undefined;
    checkSession(current);
    finishSnapshot(current, result, fingerprint, JSON.parse(serialized).videos.length, childBaseline);
    lastPrint = serialized;
    status('ok');
  } catch (error) {
    if (!isCurrent(current)) return;
    if (error.message === 'too_large') return rememberOversize(current, serialized, fingerprint, error.encryptedSize || 0, false);
    status('error', { error: String(error.message || error) });
  }
}

function finishSnapshot(current, head, fingerprint, count, childBaseline) {
  observeCloudList(current, head, count);
  current.childBaseline = childBaseline;
  current.version = head.version;
  current.at = head.updatedAt;
  current.baseline = fingerprint;
  delete current.pending;
  delete current.initialHash;
  delete current.rejectedSnapshot;
  delete current.rejectedCloudVersion;
  delete current.rejectedLimit;
  delete current.blockedUpload;
  rejectedPrint = null;
  saveCfg();
}

async function pull(retryVersion = true) {
  if (!syncOn()) return false;
  const current = cfg;
  status('syncing');
  try {
    const head = await retry(() => v2(current, 'GET'));
    checkSession(current);
    if (head.status === 404 || head.status === 401) { status('gone'); return false; }
    if (head.status !== 200) throw new Error(head.error || 'HTTP ' + head.status);
    cloudCapacity(head, current);
    if (head.role) current.role = head.role;
    observeCloudList(current, head);
    let local = print(snapshot(hooks.getDb())), localHash = await snapshotHash(local);
    checkSession(current);
    if (current.pending?.id === head.upload && head.upload) {
      finishSnapshot(current, head, current.pending.fingerprint);
    }
    const child = current.role === 'child';
    if (current.initialHash) {
      if (current.initialHash !== localHash) return conflict('initial_changed');
      await downloadInitial(current, head);
      status('ok');
      return true;
    }
    if (!head.version && !current.version) {
      status('ok');
      return true;
    }
    const sameVersion = head.version === current.version;
    if (sameVersion && current.baseline && (!child || current.childBaseline || current.baseline === localHash)) {
      const childLocal = child && (current.baseline !== localHash || !current.childBaseline)
        ? await childSnapshotHash(local) : undefined;
      checkSession(current);
      if (current.baseline === localHash) {
        const count = JSON.parse(local).videos.length;
        observeCloudList(current, head, count);
        if (child && !current.childBaseline) { current.childBaseline = childLocal; saveCfg(); }
        lastPrint = local;
        status('ok');
      } else if (child && childLocal === current.childBaseline) {
        lastPrint = local;
        status('ok');
      } else if (current.rejectedSnapshot === localHash && current.rejectedLimit === syncUploadLimit(head.capacity)) {
        rejectedPrint = local;
        status('too_large');
      }
      return true;
    }
    const remote = await readSnapshot(current, head);
    observeCloudList(current, head, remote.videos.length);
    const remotePrint = print(snapshot({ ...remote, settings: remote.settings || {} }));
    const remoteHash = await snapshotHash(remotePrint);
    checkSession(current);
    // Re-read after downloading: edits made during the transfer must not be replaced.
    const latest = print(snapshot(hooks.getDb()));
    if (latest !== local) { local = latest; localHash = await snapshotHash(local); }
    const childLocal = child ? await childSnapshotHash(local) : undefined;
    const childRemote = child ? await childSnapshotHash(remotePrint) : undefined;
    checkSession(current);
    if (local !== print(snapshot(hooks.getDb()))) return conflict('during_pull');
    const safeChildUpdate = child && (childLocal === childRemote || childLocal === current.childBaseline);
    if (sameVersion && !current.baseline && !child) {
      // Existing v1 devices may already have edits the old client failed to upload.
      // Establish the server baseline, then compress and send any differences.
      current.baseline = remoteHash;
      saveCfg();
      if (remoteHash === localHash) { lastPrint = local; status('ok'); }
      return true;
    }
    if (sameVersion && current.baseline && localHash !== remoteHash && !safeChildUpdate) {
      // The raw baseline still establishes that this device is editing the current cloud version.
      if (child && remoteHash === current.baseline) { current.childBaseline = childRemote; saveCfg(); }
      return true;
    }
    if (localHash !== remoteHash && !safeChildUpdate && (!current.baseline || localHash !== current.baseline)) {
      return conflict(current.baseline ? 'local_changed' : 'baseline_missing');
    }
    if (localHash !== remoteHash) await applyDownloaded(current, head, remote);
    else {
      finishSnapshot(current, head, localHash, remote.videos.length, childLocal);
      lastPrint = local;
    }
    status('ok');
    return true;
  } catch (error) {
    if (!isCurrent(current)) return false;
    if (retryVersion && error.message === 'version_changed') return pull(false);
    if (error.message === 'pending_conflict') return conflict('initial_changed');
    status('error', { error: String(error.message || error) });
    return false;
  }
}

async function applyDownloaded(current, head, snap) {
  applying = true;
  try {
    const applied = hooks.applyRemote(snap);
    // The hook applies synchronously, then awaits local storage durability. Edits during that await stay dirty.
    const stored = print(snapshot(hooks.getDb()));
    await applied;
    checkSession(current);
    const fingerprint = await snapshotHash(stored);
    const childBaseline = current.role === 'child' ? await childSnapshotHash(stored) : undefined;
    checkSession(current);
    lastPrint = stored;
    finishSnapshot(current, head, fingerprint, snap.videos.length, childBaseline);
  } finally { applying = false; }
}

export async function enableSync() {
  const key = b64u(crypto.getRandomValues(new Uint8Array(32)));
  const serialized = print(snapshot(hooks.getDb()));
  if ((await measurePayload(serialized)).encryptedSize > FREE_BYTES) throw new Error('too_large');
  const current = cfg = { key, version: 0, at: null };
  lastPrint = '';
  try {
    const response = await v2(current, 'POST', '', { name: deviceName() }, { auth: false });
    if (response.status !== 200) throw new Error(response.error || 'HTTP ' + response.status);
    Object.assign(current, { deviceId: response.deviceId, token: response.token, role: response.role,
      capacity: response.capacity, beta: !!response.beta, since: response.updatedAt });
    statusCache = null;
    saveCfg();
  } catch (error) {
    cfg = null; derived = null; saveCfg();
    throw error;
  }
  await queue(push);
  initSync(hooks);
  if (!current.version) return null;
  try { return await newRecoveryCode(); } catch { return null; }
}

// 家长设备生成邀请链接（role：child 孩子设备 / parent 家长的另一台设备）
export async function createInvite(base, role = 'child') {
  if (!cfg?.version) throw new Error('snapshot_unavailable');
  const r = await call('POST', '/invites', { role });
  if (r.status !== 200) throw new Error(r.error || 'HTTP ' + r.status);
  return { link: `${base}#/pair/${cfg.key}.${r.invite}`, expiresAt: r.expiresAt, role: r.role };
}

// 加入：用邀请登记本设备，下载云端片单替换本设备的
export async function joinSync(code) {
  const [key, invite] = String(code || '').split('.');
  if (!/^[A-Za-z0-9_-]{43}$/.test(key || '') || !/^[A-Za-z0-9_-]{43}$/.test(invite || '')) throw new Error('bad_link');
  const prev = cfg;
  const initialHash = await snapshotHash(print(snapshot(hooks.getDb())));
  const current = cfg = { key, version: 0, at: null, initialHash };
  derived = null;
  try {
    const r = await v2(current, 'POST', '/devices', { invite, name: deviceName() }, { auth: false });
    if (r.status !== 200) throw new Error(r.error || 'HTTP ' + r.status);
    Object.assign(current, { deviceId: r.deviceId, token: r.token, role: r.role });
    saveCfg();
  } catch (error) {
    if (cfg === current) { cfg = prev; derived = null; }
    throw error;
  }
  try { await downloadInitial(current); } finally { initSync(hooks); }
}

async function downloadInitial(current, initialHead) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const head = !attempt && initialHead ? initialHead : await retry(() => v2(current, 'GET'));
    if (head.status !== 200) throw new Error(head.error || 'HTTP ' + head.status);
    cloudCapacity(head, current);
    try {
      const snap = await readSnapshot(current, head);
      observeCloudList(current, head, snap.videos.length);
      const local = print(snapshot(hooks.getDb()));
      const fingerprint = await snapshotHash(local);
      checkSession(current);
      if (fingerprint !== current.initialHash || local !== print(snapshot(hooks.getDb()))) {
        throw new Error('pending_conflict');
      }
      await applyDownloaded(current, head, snap);
      return;
    } catch (error) {
      if (error.message !== 'version_changed' || attempt) throw error;
    }
  }
}

// ---------------------------------------------------------------- 恢复码
// 形如 DOMI-7K3P-QX9M-2RTW-H8VN-5CJA（20 个字符，100 位随机）。由它派生：
//   rid：服务器查找用的编号（服务器再取一次哈希保存）
//   包装密钥：PBKDF2 → AES-GCM，用来加密同步密钥后存到服务器
// 服务器只有 rid 的哈希和包装后的密钥，没有恢复码就解不开。
const RC_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // 去掉了容易看错的 0 O 1 I
const RC_SALT = new TextEncoder().encode('domibuddy-recovery-v1');
export function normalizeRecovery(input) {
  const s = String(input || '').toUpperCase().replace(/^\s*DOMI[-\s]*/, '').replace(/[^A-Z0-9]/g, '');
  return s.length === 20 && [...s].every((c) => RC_ALPHABET.includes(c)) ? s : null;
}
export const formatRecovery = (n) => 'DOMI-' + n.match(/.{4}/g).join('-');
async function rcKeys(n) {
  const rid = hex(await digest('rid', n));
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(n), 'PBKDF2', false, ['deriveKey']);
  const wrap = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: RC_SALT, iterations: 200000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return { rid, wrap };
}
// 家长设备：生成（或重新生成）恢复码；旧的立即作废
export async function newRecoveryCode() {
  if (!cfg?.version) throw new Error('snapshot_unavailable');
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  const n = Array.from(bytes, (b) => RC_ALPHABET[b & 31]).join('');
  const { rid, wrap } = await rcKeys(n);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrap, new TextEncoder().encode(cfg.key)));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv); out.set(ct, 12);
  const r = await call('PUT', '/recovery', { rid, wrapped: b64(out) });
  if (r.status !== 200) throw new Error(r.error || 'HTTP ' + r.status);
  cfg.recovery = formatRecovery(n);
  saveCfg();
  return cfg.recovery;
}
export const recoveryCode = () => cfg?.recovery || null;
// 新设备：用恢复码找回，成为家长设备，下载片单
export async function recoverWithCode(input) {
  const n = normalizeRecovery(input);
  if (!n) throw new Error('bad_code');
  const { rid, wrap } = await rcKeys(n);
  const r = await fetch(API.replace('/v1/', '/v2/').replace(/sync\/$/, 'recover'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rid, name: deviceName() }) });
  let d = {};
  try { d = await r.json(); } catch {}
  if (r.status !== 200) throw new Error(d.error || 'HTTP ' + r.status);
  const raw = unb64(d.wrapped);
  const key = new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, wrap, raw.slice(12)));
  derived = null;
  if ((await keys(key)).id !== d.syncId) throw new Error('bad_code');
  const initialHash = await snapshotHash(print(snapshot(hooks.getDb())));
  const current = cfg = { key, deviceId: d.deviceId, token: d.token, role: 'parent', version: 0, at: null, recovery: formatRecovery(n), initialHash };
  saveCfg();
  try { await downloadInitial(current); } finally { initSync(hooks); }
}

// 测试期状态：能否新开同步、剩余名额、站内通知（服务器缓存 60 秒）
let statusCache = null;
export async function serviceStatus() {
  if (statusCache && Date.now() - statusCache.at < 60000) return statusCache.data;
  try {
    const r = await fetch(API.replace(/sync\/$/, 'sync-status'), { cache: 'no-store' });
    const data = r.ok ? await r.json() : null;
    statusCache = { at: Date.now(), data };
    return data;
  } catch { return null; }
}

export const syncNow = () => queue(async () => { if (await pull()) await push(); });

export function useCloudVersion(expectedVersion) {
  if (!syncOn()) return Promise.reject(new Error('session_changed'));
  const current = cfg;
  const local = print(snapshot(hooks.getDb()));
  return queue(async () => {
    checkSession(current);
    const head = await retry(() => v2(current, 'GET'));
    checkSession(current);
    if (head.status !== 200) throw new Error(head.error || 'HTTP ' + head.status);
    try {
      if (!head.version || head.version !== expectedVersion) throw new Error('version_changed');
      const remote = await readSnapshot(current, head);
      checkSession(current);
      if (local !== print(snapshot(hooks.getDb()))) throw new Error('local_changed');
      try { await hooks.backupLocal(JSON.parse(local)); }
      catch { throw new Error('backup_failed'); }
      checkSession(current);
      const latest = await retry(() => v2(current, 'GET'));
      checkSession(current);
      if (latest.status !== 200) throw new Error(latest.error || 'HTTP ' + latest.status);
      if (latest.version !== head.version) throw new Error('version_changed');
      if (local !== print(snapshot(hooks.getDb()))) throw new Error('local_changed');
      cloudCapacity(latest, current);
      await applyDownloaded(current, head, remote);
      status('ok');
    } catch (error) {
      if (isCurrent(current) && error.message === 'version_changed') await pull();
      throw error;
    }
  });
}

export async function listDevices() {
  const r = await call('GET', '/devices');
  if (r.status !== 200) throw new Error(r.error || 'HTTP ' + r.status);
  return r;
}
export async function renameDevice(deviceId, name) {
  const r = await call('PUT', '/devices/' + deviceId, { name });
  if (r.status !== 200) throw new Error(r.error || 'HTTP ' + r.status);
}
export async function removeDevice(deviceId, wipe) {
  const r = await call('DELETE', '/devices/' + deviceId + (wipe ? '?wipe=1' : ''), undefined, { v2: true });
  if (r.status !== 200) throw new Error(r.error || 'HTTP ' + r.status);
}
// 本设备退出同步（保留本地片单；云端和其他设备不受影响）
export async function leaveSync() {
  if (cfg?.token) { try { await call('DELETE', '/devices/self', undefined, { v2: true }); } catch {} }
  cfg = null; derived = null; saveCfg();
}
// 删除云端数据（家长设备）：所有设备都会停止同步
export async function deleteCloud() {
  const r = await call('DELETE', '', undefined, { v2: true });
  if (r.status !== 200 && r.status !== 404) return false;
  cfg = null; derived = null; saveCfg();
  return true;
}
