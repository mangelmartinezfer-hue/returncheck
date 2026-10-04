import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { runAll } from './runner.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = join(root, '.preflight-results');
mkdirSync(output, { recursive: true });
const reports = runAll(root);
writeFileSync(join(output, 'report.json'), JSON.stringify(reports, null, 2) + '\n');
// Run regression tests even if a profile fails, giving the reviewer both results.
const tests = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'test/*.test.mjs'], { cwd: root, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, timeout: 300000 });
writeFileSync(join(output, 'tests.tap'), (tests.stdout ?? '') + (tests.stderr ?? ''));
const failed = reports.some(r => r.status === 'FAIL') || tests.status !== 0;
const summary = [
  '# ReturnCheck — control de calidad', '',
  `Resultado: **${failed ? 'FAIL' : 'PASS'}**`, '',
  ...reports.map((r, i) => `- ${['payment', 'ucp', 'corpus', 'artifact', 'registry'].includes(r.profile) ? r.profile : 'perfil inválido'} (control ${i + 1}): ${r.status}; ${r.errors.length} errores, ${r.warnings.length} advertencias, ${r.doubtful_fields.length} campos dudosos.`),
  `- Tests completos: ${tests.status === 0 ? 'PASS' : 'FAIL (consultar tests.tap)'}.`,
  '- Revisión de IA: PENDING. PASS no autoriza fusionar, desplegar o pagar.', '',
  'Detalles locales: .preflight-results/report.json y tests.tap.', '',
].join('\n');
writeFileSync(join(output, 'summary.md'), summary);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
console.log(summary);
console.log((tests.stdout ?? '').split(/\r?\n/).filter(s => /^# (tests|pass|fail|skipped|duration_ms) /.test(s)).join('\n'));
process.exitCode = failed ? 1 : 0;
