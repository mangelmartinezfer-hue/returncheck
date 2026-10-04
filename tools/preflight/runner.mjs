import { context, object } from './core.mjs';
import { profiles } from './profiles.mjs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export function run(root, profile, manifest = `preflight/${profile}.json`) {
  const c = context(root, profile);
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

export function main(args) {
  const [profile = 'all', ...rest] = args;
  const json = rest.includes('--json');
  const positional = rest.filter(x => x !== '--json');
  if (positional.length > 1 || positional.some(x => x.startsWith('--')) || (profile === 'all' && positional.length)) {
    const c = context(process.cwd(), profile); c.error('CLI_USAGE', 'arguments');
    console.log(JSON.stringify(c.finish())); return 1;
  }
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const reports = (profile === 'all' ? Object.keys(profiles) : [profile]).map(p => run(root, p, positional[0]));
  if (json) console.log(JSON.stringify(reports, null, 2));
  else for (const r of reports) {
    console.log(`${r.profile}: ${r.status} | validator ${r.validator_version} | AI ${r.ai_review}`);
    for (const type of ['errors', 'warnings', 'doubtful_fields']) for (const x of r[type]) console.log(`  ${type}: ${x.code} (${x.field})`);
    for (const a of r.artifacts) console.log(`  SHA256 ${a.sha256} | ${a.bytes} bytes | ${a.path}`);
    for (const s of r.sources) console.log(`  SOURCE ${s.url} | ${s.captured_at} | ${s.verification}`);
  }
  return reports.some(r => r.status === 'FAIL') ? 1 : 0;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
