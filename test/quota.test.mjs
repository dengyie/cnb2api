// 测试：mock CNB charge API，不打真实接口。运行：node --test test/quota.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fetchQuota, normalize, render, renderLine } from '../src/quota.mjs';

// Real CNB shapes (trimmed to the fields the CLI reads).
const QUOTA = {
  credit_in_milli: { total: 1_166_000, free: 500_000 },
  dev_in_sec: { total: 5_760_000, free: 5_760_000 }, // 1600 core-h
  ci_in_sec: { total: 576_000, free: 576_000 },       // 160 core-h
};
const VOLUME = {
  credit_in_milli: 85_710,
  dev_in_sec: 382_155,
  ci_in_sec: 43_480,
  freeze_dev_in_sec: 4_800,
  freeze_credit_in_milli: 2_390,
};

function mockCnb(handler) {
  return http.createServer((req, res) => {
    const kind = req.url.split('/').pop();
    res.setHeader('Content-Type', 'application/json');
    handler(kind, req, res);
  });
}

async function withServer(handler, run) {
  const srv = mockCnb(handler);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try { return await run(base); } finally { srv.close(); }
}

// ---- unit-normalization contract ---------------------------------------

test('normalize: milli→credits, sec→core-hours, missing→0', () => {
  const s = normalize('acme', QUOTA, VOLUME);
  assert.equal(s.org, 'acme');
  assert.equal(s.credits.total, 1166);
  assert.equal(s.credits.used, 85.71);
  assert.equal(s.credits.freeze, 2.39);
  assert.equal(s.dev.total, 1600);
  assert.equal(Math.round(s.dev.used), 106); // 382155/3600
  assert.equal(s.ci.total, 160);
  // A field the account lacks must degrade to 0, not NaN/throw.
  const bare = normalize('x', { credit_in_milli: { total: 1000 } }, {});
  assert.equal(bare.credits.total, 1);
  assert.equal(bare.credits.used, 0);
  assert.equal(bare.dev.total, 0);
});

// ---- fetch (both endpoints, concurrent) --------------------------------

test('fetchQuota: folds quota+volume into one snapshot', async () => {
  await withServer((kind, req, res) => {
    // Both must carry the bearer token.
    assert.ok((req.headers.authorization || '').startsWith('Bearer '));
    res.end(JSON.stringify(kind === 'quota' ? QUOTA : VOLUME));
  }, async (base) => {
    const s = await fetchQuota({ org: 'acme', token: 't', base });
    assert.equal(s.credits.total, 1166);
    assert.equal(s.credits.used, 85.71);
    assert.equal(s.ci.used, 43480 / 3600);
  });
});

test('fetchQuota: missing org/token fail fast with a clear message', async () => {
  await assert.rejects(() => fetchQuota({ org: '', token: 't' }), /org slug is required/);
  await assert.rejects(() => fetchQuota({ org: 'acme', token: '' }), /CNB_TOKEN is required/);
});

test('fetchQuota: HTTP 401 surfaces a token hint', async () => {
  await withServer((kind, req, res) => {
    res.writeHead(401);
    res.end('{"message":"unauthorized"}');
  }, async (base) => {
    await assert.rejects(() => fetchQuota({ org: 'acme', token: 'bad', base }), /HTTP 401.*CNB_TOKEN/s);
  });
});

test('fetchQuota: HTTP 404 surfaces an org hint', async () => {
  await withServer((kind, req, res) => { res.writeHead(404); res.end('nope'); },
    async (base) => {
      await assert.rejects(() => fetchQuota({ org: 'ghost', token: 't', base }), /HTTP 404.*org slug/s);
    });
});

// ---- rendering ----------------------------------------------------------

test('render: shows org, all resources, remaining, and no ANSI when NO_COLOR', () => {
  const prev = process.env.NO_COLOR;
  process.env.NO_COLOR = '1';
  try {
    const s = normalize('acme', QUOTA, VOLUME);
    const out = render(s, { now: new Date('2026-09-05T12:00:00Z') });
    assert.ok(out.includes('CNB quota'));
    assert.ok(out.includes('acme'));
    assert.ok(out.includes('Credits'));
    assert.ok(out.includes('Dev'));
    assert.ok(out.includes('CI'));
    assert.ok(out.includes('1,166'));            // thousands separator
    assert.ok(out.includes('in-flight'));         // freeze values present
    assert.ok(out.includes('2026-09-05 12:00:00 UTC'));
    assert.ok(!out.includes('\x1b['), 'NO_COLOR must suppress ANSI');
  } finally {
    if (prev === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = prev;
  }
});

test('render: hides CI row when the org has no CI quota', () => {
  const prev = process.env.NO_COLOR; process.env.NO_COLOR = '1';
  try {
    const s = normalize('acme', { credit_in_milli: { total: 1000 }, dev_in_sec: { total: 3600 } }, {});
    const out = render(s);
    assert.ok(!out.includes(' CI '));
    assert.ok(!out.includes('in-flight'));
  } finally {
    if (prev === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = prev;
  }
});

test('renderLine: compact summary carries used/total/left', () => {
  const s = normalize('acme', QUOTA, VOLUME);
  const line = renderLine(s);
  assert.ok(line.includes('credits'));
  assert.ok(line.includes('85.7'));
  assert.ok(line.includes('1,166'));
  assert.ok(line.includes('left'));
  assert.ok(line.includes('core-h'));
});
