import test from 'node:test';
import assert from 'node:assert/strict';

// usage 累计器单元测试：record 聚合 + snapshot 结构
// 注意：重复 import() 返回 ESM 缓存中的同一模块实例（单例），
// 断言一律用 before 相对值，勿假设从零开始。
const mod = () => import('../src/usage.mjs');

test('record aggregates totals and snapshot exposes boot contract', async () => {
  const u = await mod();
  const before = u.snapshot().totals;
  u.record({ prompt: 100, completion: 50 });
  u.record({ prompt: 10, completion: 5, errors: 1 });
  const snap = u.snapshot();
  assert.equal(snap.totals.prompt, before.prompt + 110);
  assert.equal(snap.totals.completion, before.completion + 55);
  assert.equal(snap.totals.requests, before.requests + 2);
  assert.equal(snap.totals.errors, before.errors + 1);
  assert.match(snap.boot_id, /^[0-9a-z]+-[0-9a-z]+$/);
  assert.ok(!Number.isNaN(Date.parse(snap.booted_at)));
});

test('record without usage counts request + error only', async () => {
  const u = await mod();
  const before = u.snapshot().totals;
  u.record({ errors: 1 }); // 上游失败，无 usage
  const after = u.snapshot().totals;
  assert.equal(after.requests, before.requests + 1);
  assert.equal(after.errors, before.errors + 1);
  assert.equal(after.prompt, before.prompt);
});

test('accounting contract: fields exist and remain non-empty', async () => {
  const u = await mod();
  const snap = u.snapshot();
  for (const k of ['prompt', 'completion', 'requests', 'errors']) {
    assert.ok(k in snap.totals, `totals.${k} must exist`);
  }
  for (const k of ['boot_id', 'booted_at', 'totals']) {
    assert.ok(k in snap, `snapshot.${k} must exist`);
  }
});
