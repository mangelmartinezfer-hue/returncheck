import { context, object } from './core.mjs';
import { profiles } from './profiles.mjs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readdirSync } from 'node:fs';

export function run(root, profile, manifest = `preflight/${profile}.json`) {
  const c = context(root, profile);
  c.report.manifest = manifest;
  try {
    if (!Object.hasOwn(profiles, profile)) { c.error('UNKNOWN_PROFILE', 'profile'); return c.finish(); }
    const m = c.json(manifest);
    if (!c.check(object(m) && m.schema_version === 1 && m.profile === profile, 'MANIFEST_INVALID', manifest)) return c.finish();
    profiles[profile](c, m);
  } catch {
    // Never print input bytes, signatures, credentials or raw parser exceptions.
    c.error('INPUT_UNREADABLE_OR_INVALID', manifest);
  }
  return c.finish();
}

// Only registered manifests are inputs; never execute modules supplied by a job.
// Symlinks are rejected so discovery cannot leave the root or loop indefinitely.
export function registeredJobs(root) {
  const paths = [];
  function visit(dir) {
    for (const entry of readdirSync(resolve(root, dir), { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const path = `${dir}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error('JOB_SYMLINK');
      if (entry.isDirectory()) visit(path);
      else if (entry.name.endsWith('.json')) paths.push(path);
      else if (entry.name !== 'README.md' && entry.name !== '.gitkeep') throw new Error('JOB_EXTENSION');
    }
  }
  visit('preflight/jobs');
  return paths;
}

export function runAll(root) {
  const reports = ['payment', 'ucp', 'corpus'].map(p => run(root, p));
  const c = context(root, 'registry');
  try {
    for (const path of registeredJobs(root)) {
      try {
        const m = c.json(path);
        reports.push(run(root, object(m) && typeof m.profile === 'string' ? m.profile : 'unknown', path));
      } catch { c.error('JOB_MANIFEST_INVALID', path); }
    }
  } catch { c.error('JOB_REGISTRY_UNREADABLE', 'preflight/jobs'); }
  reports.push(c.finish());
  return reports;
}

export function main(args) {
  const [profile = 'all', ...rest] = args;
  const json = rest.includes('--json');
  const positional = rest.filter(x => x !== '--json');
  if (positional.length > 1 || positional.some(x => x.startsWith('--')) || (profile === 'all' && positional.length)) {
    const c = context(process.cwd(), profile); c.error('CLI_USAGE', 'arguments');
    console.log(JSON.stringify(c.finish())); return 1;
  }
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const reports = profile === 'all' ? runAll(root) : [run(root, profile, positional[0])];
  if (json) console.log(JSON.stringify(reports, null, 2));
  else for (const r of reports) {
    console.log(`${r.profile}: ${r.status} | ${r.manifest ?? 'registry'} | validator ${r.validator_version} | AI ${r.ai_review}`);
    for (const type of ['errors', 'warnings', 'doubtful_fields']) for (const x of r[type]) console.log(`  ${type}: ${x.code} (${x.field})`);
    for (const a of r.artifacts) console.log(`  SHA256 ${a.sha256} | ${a.bytes} bytes | ${a.path}`);
    for (const s of r.sources) console.log(`  SOURCE ${s.url} | ${s.captured_at} | ${s.verification}`);
  }
  return reports.some(r => r.status === 'FAIL') ? 1 : 0;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
