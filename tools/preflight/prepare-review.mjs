import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { context } from './core.mjs';
import { run } from './runner.mjs';
import { reviewDraft, reviewPath } from './review.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
try {
  if (process.argv.length !== 3) throw new Error('USAGE');
  const manifest = process.argv[2];
  // Reject traversal before creating output directories.
  if (!/^preflight\/jobs\/(?:[a-z0-9][a-z0-9-]*\/)*[a-z0-9][a-z0-9-]*\.json$/.test(manifest)) throw new Error('PATH');
  const m = context(root, 'review').json(manifest), report = run(root, m.profile, manifest);
  if (report.status !== 'PASS') throw new Error('TECHNICAL_FAIL');
  const output = resolve(root, reviewPath(manifest)); mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(reviewDraft(report), null, 2) + '\n', { flag: 'wx' });
  console.log(`Borrador UNRESOLVED: ${reviewPath(manifest)}. Requiere revisión real; no se aprueba automáticamente.`);
} catch {
  console.error('No se pudo preparar la revisión: comprueba ruta, PASS técnico y que no exista ya. npm run review:prepare -- preflight/jobs/nombre.json');
  process.exitCode = 1;
}
