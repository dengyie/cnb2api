// CNB quota reporting: pull the org's charge quota + usage and render it for a
// terminal. Zero dependencies — native fetch + ANSI escapes only.
//
// Data model (CNB charge API, values are cumulative for the billing period):
//   GET /{org}/-/charge/quota   → allowances  (…_in_sec.total / .free, credit_in_milli.total/free)
//   GET /{org}/-/charge/volume  → consumption (…_in_sec used, credit_in_milli used, freeze_* in-flight)
// Units: *_in_milli ÷ 1000 = credits; *_in_sec ÷ 3600 = core-hours.

const CNB_API = 'https://api.cnb.cool';

// ---- fetch --------------------------------------------------------------

// Read one charge sub-resource. Returns parsed JSON or throws a message that is
// already human-readable (no stack noise) — the CLI prints it verbatim.
async function getCharge(base, org, token, kind, timeoutMs) {
  const url = `${base}/${org}/-/charge/${kind}`;
  let r;
  try {
    r = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const why = e.name === 'TimeoutError' ? `timed out after ${timeoutMs}ms` : (e.cause || e).toString();
    throw new Error(`request to /${org}/-/charge/${kind} failed: ${why}`);
  }
  if (!r.ok) {
    const body = (await r.text().catch(() => '')).slice(0, 200);
    const hint = r.status === 401 || r.status === 403
      ? ' (check CNB_TOKEN and that it can read this org)'
      : r.status === 404 ? ' (check the org slug)' : '';
    throw new Error(`/${org}/-/charge/${kind} → HTTP ${r.status}${hint}${body ? `: ${body}` : ''}`);
  }
  return r.json();
}

// Fetch both endpoints concurrently and fold them into a flat, unit-normalized
// snapshot. `opts` lets tests inject { base, fetchImpl } without a network.
export async function fetchQuota({ org, token, timeoutMs = 15_000, base = CNB_API } = {}) {
  if (!org) throw new Error('org slug is required (CNB_REPO_SLUG=org/repo or --org)');
  if (!token) throw new Error('CNB_TOKEN is required to read charge quota');
  const [quota, volume] = await Promise.all([
    getCharge(base, org, token, 'quota', timeoutMs),
    getCharge(base, org, token, 'volume', timeoutMs),
  ]);
  return normalize(org, quota, volume);
}

// ---- normalize ----------------------------------------------------------

const milli = (v) => (Number(v) || 0) / 1000;      // credits
const secH = (v) => (Number(v) || 0) / 3600;       // core-hours

// Build a { org, credits, dev, ci, storage } view. Missing fields degrade to 0
// rather than throwing — CNB may omit a resource an account doesn't have.
export function normalize(org, quota = {}, volume = {}) {
  const q = quota || {};
  const v = volume || {};
  const cq = q.credit_in_milli || {};
  return {
    org,
    credits: {
      total: milli(cq.total),
      used: milli(v.credit_in_milli),
      freeze: milli(v.freeze_credit_in_milli),
    },
    dev: {
      total: secH((q.dev_in_sec || {}).total),
      used: secH(v.dev_in_sec),
      freeze: secH(v.freeze_dev_in_sec),
    },
    ci: {
      total: secH((q.ci_in_sec || {}).total),
      used: secH(v.ci_in_sec),
    },
  };
}

// ---- render -------------------------------------------------------------

const useColor = () => process.stdout.isTTY && process.env.NO_COLOR === undefined;
const paint = (code, s) => (useColor() ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const dim = (s) => paint('2', s);
const bold = (s) => paint('1', s);
const cyan = (s) => paint('36', s);

// Green under 60%, yellow 60–85%, red above — the usual traffic-light read.
function tone(pct) {
  if (pct >= 85) return '31';
  if (pct >= 60) return '33';
  return '32';
}

// Unicode meter with fractional last cell, so 3% still shows something.
function bar(pct, width = 24) {
  const p = Math.max(0, Math.min(100, pct));
  const full = Math.floor((p / 100) * width);
  const frac = (p / 100) * width - full;
  const partials = ' ▏▎▍▌▋▊▉';
  const head = frac > 0 && full < width ? partials[Math.round(frac * 7)] : '';
  const filled = '█'.repeat(full) + head;
  const track = filled + dim('─'.repeat(Math.max(0, width - filled.length)));
  return paint(tone(p), track);
}

const fmtNum = (n, d = 0) => Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

// One resource line: label, bar, used/total, percent, right-aligned to line up.
function row(label, used, total, unit, decimals) {
  const pct = total > 0 ? (used / total) * 100 : 0;
  const usedS = fmtNum(used, decimals);
  const totalS = fmtNum(total, decimals);
  const amount = `${usedS} / ${totalS} ${unit}`;
  const pctS = `${pct.toFixed(pct < 10 ? 1 : 0)}%`.padStart(5);
  return `  ${bold(label.padEnd(8))} ${bar(pct)}  ${paint(tone(pct), pctS)}  ${dim(amount)}`;
}

// Full report block. Kept as a pure string builder so tests assert on output.
export function render(snap, { now = new Date() } = {}) {
  const L = [];
  L.push('');
  L.push(`  ${cyan('◆')} ${bold('CNB quota')}  ${dim(snap.org)}`);
  L.push('');
  L.push(row('Credits', snap.credits.used, snap.credits.total, 'cr', 1));
  L.push(row('Dev', snap.dev.used, snap.dev.total, 'core-h', 1));
  if (snap.ci.total > 0) L.push(row('CI', snap.ci.used, snap.ci.total, 'core-h', 1));

  const inflight = [];
  if (snap.credits.freeze > 0) inflight.push(`${fmtNum(snap.credits.freeze, 1)} cr`);
  if (snap.dev.freeze > 0) inflight.push(`${fmtNum(snap.dev.freeze, 1)} core-h`);
  if (inflight.length) {
    L.push('');
    L.push(`  ${dim('in-flight (not yet settled):')} ${inflight.join(', ')}`);
  }

  const remain = snap.credits.total - snap.credits.used;
  L.push('');
  L.push(`  ${dim('remaining credits:')} ${bold(fmtNum(remain, 1))} cr` +
    `   ${dim('as of')} ${dim(now.toISOString().replace('T', ' ').slice(0, 19))} UTC`);
  L.push('');
  return L.join('\n');
}

// Compact one-liner for scripts / prompts: `--json`'s human cousin.
export function renderLine(snap) {
  const remain = snap.credits.total - snap.credits.used;
  const pct = snap.credits.total > 0 ? (snap.credits.used / snap.credits.total) * 100 : 0;
  return `credits ${fmtNum(snap.credits.used, 1)}/${fmtNum(snap.credits.total, 1)} (${pct.toFixed(0)}% used, ${fmtNum(remain, 1)} left) · dev ${fmtNum(snap.dev.used, 1)}/${fmtNum(snap.dev.total, 0)} core-h`;
}
