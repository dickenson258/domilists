import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { syncPayloadTooBig, syncUploadLimit } from '../public/sync.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FREE = 2 * 1024 * 1024;
const MEMBER = 20 * 1024 * 1024;

test('sync upload limit follows the server: 2 MiB free, 20 MiB member, never higher', () => {
  assert.equal(syncUploadLimit(null), FREE);
  assert.equal(syncUploadLimit({}), FREE);
  assert.equal(syncUploadLimit({ limit: 0 }), FREE);
  assert.equal(syncUploadLimit({ limit: FREE, plan: 'free' }), FREE);
  assert.equal(syncUploadLimit({ limit: MEMBER, plan: 'member' }), MEMBER);
  assert.equal(syncUploadLimit({ limit: 99 * 1024 * 1024 }), MEMBER);
});

test('encrypted payload is refused at the server cap, including stored plus new and a previous 413', () => {
  const free = { limit: FREE, bytes: 0 };
  assert.equal(syncPayloadTooBig(free, FREE), false);
  assert.equal(syncPayloadTooBig(free, FREE + 1), true);
  assert.equal(syncPayloadTooBig({ limit: FREE, bytes: FREE }, FREE), false);
  assert.equal(syncPayloadTooBig({ limit: FREE, bytes: FREE + 1 }, FREE), true);
  const blocked = { bytes: 1_500_000, limit: FREE };
  assert.equal(syncPayloadTooBig(free, 1_500_000, blocked), true);
  assert.equal(syncPayloadTooBig(free, 1_499_999, blocked), false);
  assert.equal(syncPayloadTooBig({ limit: MEMBER, bytes: 0 }, 1_500_000, blocked), false);
});

test('a 413 is not in the sync retry set', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public/sync.js'), 'utf8');
  assert.match(src, /result\?\.status === 413/);
  assert.doesNotMatch(src, /new Set\(\[[^\]]*413/);
  assert.match(src, /syncTooLarge|too_large/);
});

test('parent-area copy explains an oversized family list in both languages', () => {
  const i18n = fs.readFileSync(path.join(ROOT, 'public/i18n.js'), 'utf8');
  assert.match(i18n, /不会继续反复上传/);
  assert.match(i18n, /2 MiB/);
  assert.match(i18n, /20 MiB/);
  assert.match(i18n, /will not keep uploading them/);
  const app = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
  assert.match(app, /sync-too-large/);
  assert.match(app, /ensureTooLargeBanner/);
});
