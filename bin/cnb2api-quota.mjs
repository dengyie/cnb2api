#!/usr/bin/env node
// cnb2api-quota — show CNB AI credits + core-hours from your terminal.
//
//   CNB_TOKEN=... CNB_REPO_SLUG=your-org/repo npx cnb2api-quota
//   cnb2api-quota --org your-org --json
//
// Reads the CNB charge API directly; it does not touch the running proxy, so it
// works whether or not the workspace is up. Zero dependencies.
import { fetchQuota, render, renderLine } from '../src/quota.mjs';

function parseArgs(argv) {
  const o = { org: '', mode: 'full' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.mode = 'json';
    else if (a === '--line') o.mode = 'line';
    else if (a === '--org') o.org = argv[++i] || '';
    else if (a === '-h' || a === '--help') o.mode = 'help';
    else if (a.startsWith('--org=')) o.org = a.slice(6);
  }
  return o;
}

const HELP = `cnb2api-quota — CNB credits + core-hours in your terminal

Usage:
  cnb2api-quota [--org <org>] [--json | --line]

Options:
  --org <org>   Org slug to query. Defaults to the org part of CNB_REPO_SLUG.
  --json        Print the normalized snapshot as JSON.
  --line        Print a compact one-line summary (good for prompts/status bars).
  -h, --help    Show this help.

Environment:
  CNB_TOKEN         Required. A CNB token that can read the org's charge quota.
  CNB_REPO_SLUG     org/repo; the org part is used when --org is omitted.
  QUOTA_ORG         Org override, takes precedence over CNB_REPO_SLUG.
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === 'help') { process.stdout.write(HELP); return; }

  const slug = process.env.CNB_REPO_SLUG || '';
  const org = args.org || process.env.QUOTA_ORG || slug.split('/')[0] || '';
  const token = process.env.CNB_TOKEN || '';

  const snap = await fetchQuota({ org, token });

  if (args.mode === 'json') process.stdout.write(JSON.stringify(snap, null, 2) + '\n');
  else if (args.mode === 'line') process.stdout.write(renderLine(snap) + '\n');
  else process.stdout.write(render(snap) + '\n');
}

main().catch((e) => {
  process.stderr.write(`cnb2api-quota: ${e.message}\n`);
  process.exit(1);
});
