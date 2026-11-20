import assert from 'node:assert/strict';
import { randomBytes, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../public/sync.js', import.meta.url), 'utf8').replace(/^export /gm, '');
const API = 'https://api.domibuddy.com';
const endpoint = process.env.SYNC_TEST_ORIGIN || 'http://127.0.0.1:8794';
const empty = () => ({ videos: [], groups: ['English'], seriesCovers: {}, settings: {} });
function makeDevice(db = empty(), store = new Map()) {
  let state, chunkPuts = 0, uploadStarts = 0, offlineChunk = false;
  const timers = new Set();
  const sync = runInNewContext(source + '\n({ initSync, enableSync, createInvite, joinSync, recoverWithCode, syncNow, deleteCloud, syncInfo })', {
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
  sync.initSync({ getDb:()=>db, applyRemote: (value)=>Object.assign(db, structuredClone(value)), onStatus(info){state=info.state;} });
  return { sync, db, store, state:()=>state, count:()=>({chunkPuts,uploadStarts}),
    blockChunk(){ offlineChunk=true; }, dispose(){ timers.forEach(clearInterval); } };
}

const a = makeDevice();
const b = makeDevice();
const restored = makeDevice();
let resumed;
try {
  const rc = await a.sync.enableSync();
  assert.match(rc, /^DOMI-/);
  const invite = await a.sync.createInvite(endpoint);
  await b.sync.joinSync(invite.link.split('#/pair/')[1]);
  assert.equal(b.sync.syncInfo().version, 1);

  a.db.videos.push({ id:'large', title:randomBytes(620000).toString('base64') });
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

  await restored.sync.recoverWithCode(rc);
  assert.deepEqual(restored.db.videos, a.db.videos);
  b.db.videos.push({ id:'local-edit', title:'Unsynced on B' });
  a.db.videos.push({ id:'remote-edit', title:'Synced by A' });
  await resumed.sync.syncNow();
  await b.sync.syncNow();
  assert.equal(b.state(), 'pending_conflict');
  assert.equal(b.db.videos.at(-1).id, 'local-edit');
  assert.equal(b.db.videos.some((v)=>v.id==='remote-edit'), false);

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
  console.log('Passed compression/encryption, restore, cross-reload resume, local conflict protection, and no repeat oversized uploads.');
} finally {
  const owner = resumed || a;
  if (owner.sync.syncInfo()?.version != null) assert.equal(await owner.sync.deleteCloud(), true);
  for (const d of [a,b,restored,resumed]) d?.dispose();
}
