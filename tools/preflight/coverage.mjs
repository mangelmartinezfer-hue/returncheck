import { execFileSync } from 'node:child_process';
import { context } from './core.mjs';

function git(root, args) { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 10 * 1024 * 1024 }); }
function resolveBase(root, base) {
  if (!/^[a-f0-9]{40}$|^origin\/main$/.test(base)) throw new Error('BASE_INVALID');
  if (/^0{40}$/.test(base)) base = 'origin/main';
  git(root, ['rev-parse', '--verify', `${base}^{commit}`]);
  return base;
}
export function changedPaths(root, base = process.env.PREFLIGHT_BASE || 'origin/main') {
  base = resolveBase(root, base);
  // Base to working tree includes committed, staged and unstaged edits, including
  // rename destinations. Deleted input files are detected by their manifests.
  const tracked = git(root, ['diff', '--name-only', '-z', '--diff-filter=ACMRTUXB', base, '--']);
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z']);
  return [...new Set((tracked + untracked).split('\0').filter(Boolean))].sort();
}
export function orphanedInputs(root, covered, base = process.env.PREFLIGHT_BASE || 'origin/main') {
  base = resolveBase(root, base);
  const manifests = git(root, ['ls-tree', '-r', '--name-only', '-z', base, '--', 'preflight/jobs']).split('\0').filter(p => p.endsWith('.json'));
  const present = new Set((git(root, ['ls-files', '-z']) + git(root, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0'));
  const orphaned = new Set();
  for (const path of manifests) {
    const m = JSON.parse(git(root, ['show', `${base}:${path}`]));
    const inputs = [m.body_file, m.envelope_file, m.replay?.body_file, m.replay?.envelope_file, m.snapshot_file, ...(m.files ?? []).map(f => f.path), ...(m.records ?? []).map(r => r.source?.file), ...(m.runs ?? [])];
    for (const input of inputs) if (typeof input === 'string' && present.has(input) && !covered.has(input)) orphaned.add(input);
  }
  return [...orphaned].sort();
}
export function classify(path) {
  if (/^(src|tools)\/.*\.m?js$/.test(path) || /^test\/(.*\.m?js|fixtures\/.*)$/.test(path)) return 'code-or-test';
  if (/^(README\.md|AGENTS\.md|docs\/.*\.md|preflight\/(README\.md|jobs\/README\.md|reviews\/README\.md))$/.test(path)) return 'documentation';
  if (/^(package(-lock)?\.json|wrangler\.toml|schema[^/]*\.sql|\.gitignore|\.gitattributes|\.github\/.*)$/.test(path)) return 'configuration';
  if (/^preflight\/(payment|ucp|corpus|metrics)\.json$/.test(path) || /^preflight\/jobs\/.+\.json$/.test(path)) return 'manifest';
  return 'requires-manifest';
}
export function coverage(root, reports, paths) {
  const c = context(root, 'coverage');
  try {
    const inputs = new Set(reports.flatMap(r => r.artifacts.map(a => a.path.replace(/\\/g, '/'))));
    const reviews = new Set(reports.filter(r => r.manifest?.startsWith('preflight/jobs/')).map(r => r.manifest.replace('preflight/jobs/', 'preflight/reviews/')));
    if (paths === undefined) for (const input of orphanedInputs(root, inputs)) c.error('ORPHANED_INPUT_AFTER_MANIFEST_CHANGE', input);
    c.report.changed_files = (paths ?? changedPaths(root)).map(path => {
      const category = classify(path);
      const covered = category !== 'requires-manifest' || inputs.has(path) || reviews.has(path);
      c.check(covered, 'UNREGISTERED_WORK', path);
      return { path, category, covered };
    });
  } catch { c.error('COVERAGE_BASE_UNAVAILABLE', 'PREFLIGHT_BASE'); }
  return c.finish();
}
