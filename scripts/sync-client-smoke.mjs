import assert from 'node:assert/strict';
import { randomBytes, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../public/sync.js', import.meta.url), 'utf8').replace(/^export /gm, '');
const API = 'https://api.domibuddy.com';
const endpoint = process.env.SYNC_TEST_ORIGIN || 'http://127.0.0.1:8794';
const empty = () => ({ videos: [], groups: ['English'], seriesCovers: {}, settings: {} });
function makeDevice(db = empty(), store = new Map()) {
  let state, reason, backup, backupBlocked = false, chunkPuts = 0, uploadStarts = 0, offlineChunk = false;
  const timers = new Set();
  const sync = runInNewContext(source + '\n({ initSync, enableSync, createInvite, joinSync, recoverWithCode, syncNow, useCloudVersion, deleteCloud, syncInfo })', {
    localStorage: { getItem: (k) => store.get(k), setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) },
    crypto: webcrypto, TextEncoder, TextDecoder, Uint8Array, Blob, Response,
    btoa, atob, CompressionStream, DecompressionStream, window: {isSecureContext: true},
    document: {visibilityState:'visible', addEventListener(){}}, navigator:{ userAgent:'Chrome/1', maxTouchPoints:0 },
    clearTimeout, setTimeout, setInterval: (fn, ms) => { const timer = setInterval(fn, ms); timers.add(timer); return timer; },
    fetch(url, opts) {
      const value = String(url);
      if (opts.method === 'PUT' && /\/uploads\/[0-9a-f]+$/.test(value)) uploadStarts++;
      if (opts.method === 'PUT' && /\/chunks\//.test(value)) {
        chunkPuts++;
        if (offlineChunk && value.endsWith('/chunks/1')) throw new Error('disconnected');
      }
      return fetch(value.replace(API, endpoint), opts);
    },
  });
  sync.initSync({ getDb:()=>db, applyRemote: (value)=>Object.assign(db, structuredClone(value)), onStatus(info){ state=info.state; reason=info.reason; }, backupLocal(value){ if (backupBlocked) throw new Error("disk full"); backup=structuredClone(value); } });
  return { sync, db, store, state:()=>state, reason:()=>reason, backup:()=>backup, blockBackup:(blocked)=>{backupBlocked=blocked;}, count:()=>({chunkPuts,uploadStarts}),
    blockChunk(){ offlineChunk=true; }, dispose(){ timers.forEach(clearInterval); } };
}

const a = makeDevice();
const b = makeDevice();
const restored = makeDevice();
const child = makeDevice();
const oldChild = makeDevice();
let resumed, legacy;
try {
  const rc = await a.sync.enableSync();
  assert.match(rc, /^DOMI-/);
  const invite = await a.sync.createInvite(endpoint, 'parent');
  await b.sync.joinSync(invite.link.split('#/pair/')[1]);
  assert.equal(b.sync.syncInfo().version, 1);

  a.db.videos.push({ id:'large', platform:'youtube', author:'', title:randomBytes(620000).toString('base64') });
  a.blockChunk();
  await a.sync.syncNow();
  assert.equal(a.state(), 'error');
  assert.ok(JSON.parse(a.store.get('domibuddy:sync')).pending);
  a.dispose();
  resumed = makeDevice(a.db, a.store);
  await resumed.sync.syncNow();
  assert.equal(resumed.state(), 'ok');
  assert.equal(resumed.count().chunkPuts, 1);
  assert.ok(resumed.sync.syncInfo().capacity.bytes > 512 * 1024);
  await b.sync.syncNow();
  assert.deepEqual(b.db.videos, a.db.videos);

  for (const device of [child, oldChild]) {
    const invite = await resumed.sync.createInvite(endpoint, 'child');
    await device.sync.joinSync(invite.link.split('#/pair/')[1]);
  }
  // Older clients have a cloud version but may lack any recorded snapshot baseline.
  await oldChild.sync.syncNow();
  const oldConfig = JSON.parse(oldChild.store.get('domibuddy:sync'));
  delete oldConfig.baseline;
  delete oldConfig.childBaseline;
  oldChild.store.set('domibuddy:sync', JSON.stringify(oldConfig));
  oldChild.dispose();

  await restored.sync.recoverWithCode(rc);
  assert.deepEqual(restored.db.videos, a.db.videos);
  b.db.videos.push({ id:'local-edit', title:'Unsynced on B' });
  child.db.videos[0].author = 'Automatically backfilled';
  await child.sync.syncNow();
  assert.equal(child.count().uploadStarts, 0);
  a.db.videos.push({ id:'remote-edit', title:'Synced by A' });
  await resumed.sync.syncNow();
  await b.sync.syncNow();
  assert.equal(b.state(), 'pending_conflict');
  assert.equal(b.db.videos.at(-1).id, 'local-edit');
  assert.equal(b.db.videos.some((v)=>v.id==='remote-edit'), false);
  assert.equal(b.reason(), 'local_changed');
  await child.sync.syncNow();
  assert.equal(child.state(), 'ok');
  assert.deepEqual(child.db.videos, a.db.videos);
  assert.equal(child.count().uploadStarts, 0);
  legacy = makeDevice(oldChild.db, oldChild.store);
  await legacy.sync.syncNow();
  assert.equal(legacy.state(), 'pending_conflict');
  assert.equal(legacy.reason(), 'baseline_missing');
  assert.equal(legacy.sync.syncInfo().cloudCount, 2);
  assert.equal(legacy.db.videos.length, 1);
  legacy.blockBackup(true);
  await assert.rejects(legacy.sync.useCloudVersion(legacy.sync.syncInfo().cloudVersion), /backup_failed/);
  assert.equal(legacy.db.videos.length, 1);
  legacy.blockBackup(false);
  await assert.rejects(legacy.sync.useCloudVersion(legacy.sync.syncInfo().cloudVersion - 1), /version_changed/);
  assert.equal(legacy.backup(), undefined);
  await legacy.sync.useCloudVersion(legacy.sync.syncInfo().cloudVersion);
  assert.equal(legacy.backup().videos.length, 1);
  assert.deepEqual(legacy.db.videos, a.db.videos);
  assert.equal(legacy.count().uploadStarts, 0);

  child.db.videos[0].title = 'Locally edited title';
  a.db.videos.push({ id:'next-edit', title:'Next cloud version' });
  await resumed.sync.syncNow();
  await child.sync.syncNow();
  assert.equal(child.state(), 'pending_conflict');
  assert.equal(child.reason(), 'local_changed');
  assert.equal(child.db.videos[0].title, 'Locally edited title');

  const big = { id:'oversize', title:randomBytes(2150000).toString('base64') };
  a.db.videos.push(big);
  await resumed.sync.syncNow();
  assert.equal(resumed.state(), 'too_large');
  const before = resumed.count().uploadStarts;
  await resumed.sync.syncNow();
  assert.equal(resumed.state(), 'too_large');
  assert.equal(resumed.count().uploadStarts, before);
  assert.equal(a.db.videos.at(-1), big);
  a.db.videos.pop();
  a.db.videos.push({ id:'smaller-edit', title:'Now fits' });
  await resumed.sync.syncNow();
  assert.equal(resumed.state(), 'ok');
  console.log('Passed compression/encryption, restore, cross-reload resume, local conflict protection, and no repeat oversized uploads, child metadata, legacy conflict counts, backup-first recovery, and stale-version protection.');
} finally {
  const owner = resumed || a;
  if (owner.sync.syncInfo()?.version != null) assert.equal(await owner.sync.deleteCloud(), true);
  for (const d of [a,b,restored,resumed,child,oldChild,legacy]) d?.dispose();
}
