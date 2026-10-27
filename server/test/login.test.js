import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLoginGuard } from '../lib/loginGuard.js';
import { startTestServer } from './helpers.js';

test('guard: 5 failures lock an IP with escalating backoff; success resets; other IPs unaffected', () => {
  let t = 1_000_000; const g = createLoginGuard({ now: () => t, globalFails: 1000 });
  for (let i = 0; i < 4; i++) { g.fail('a'); assert.equal(g.check('a').ok, true); }
  g.fail('a');
  let c = g.check('a'); assert.equal(c.ok, false); assert.equal(c.retryAfterSec, 30); assert.equal(c.scope, 'ip');
  assert.equal(g.check('b').ok, true);
  t += 31_000; assert.equal(g.check('a').ok, true);
  for (let i = 0; i < 5; i++) g.fail('a');
  assert.equal(g.check('a').retryAfterSec, 60);            // escalated
  t += 61_000; for (let i = 0; i < 5; i++) g.fail('a');
  assert.equal(g.check('a').retryAfterSec, 300);
  t += 301_000; g.success('a');
  for (let i = 0; i < 5; i++) g.fail('a');
  assert.equal(g.check('a').retryAfterSec, 30);            // success reset the ladder
});

test('guard: distributed attempts trigger a GLOBAL lockout', () => {
  let t = 5_000_000; const g = createLoginGuard({ now: () => t });
  for (let i = 0; i < 20; i++) g.fail('ip' + i); // one failure each: no single IP locked
  const c = g.check('fresh-ip');
  assert.equal(c.ok, false); assert.equal(c.scope, 'global'); assert.equal(c.retryAfterSec, 60);
  t += 61_000; assert.equal(g.check('fresh-ip').ok, true);
});

test('login endpoint: lockout returns 429 + Retry-After and refuses even the correct passcode', async () => {
  const t = await startTestServer({ ASSESSMENT_ENGINE: 'mock' });
  try {
    for (let i = 0; i < 4; i++) assert.equal((await t.login('wrong' + i)).status, 401);
    const fifth = await t.login('wrong4');
    assert.equal(fifth.status, 401); assert.equal(fifth.json.error.locked, true);
    const locked = await t.login('test-pass');
    assert.equal(locked.status, 429);
    assert.equal(locked.json.error.code, 'login_locked');
    assert.ok(Number(locked.headers.get('retry-after')) >= 1);
    assert.equal(locked.headers.get('set-cookie'), null);
  } finally { await t.close(); }
});

test('login: empty / non-string / oversize passcodes rejected', async () => {
  const t = await startTestServer({ ASSESSMENT_ENGINE: 'mock' });
  try {
    for (const p of ['', 123, null, 'x'.repeat(500)]) assert.equal((await t.login(p)).status, 401);
  } finally { await t.close(); }
});
