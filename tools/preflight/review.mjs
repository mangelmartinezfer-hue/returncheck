import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { context, sha256, nonempty, object, date } from './core.mjs';
import { keys } from './schema.mjs';

// Include both validators and the runtime modules they inspect. Normalize code
// line endings only; input hashes continue to refer to their exact bytes.
export function validatorDigest() {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const files = ['tools/preflight', 'src'].flatMap(dir => readdirSync(join(root, dir)).filter(f => f.endsWith('.mjs')).sort().map(f => `${dir}/${f}`));
  return sha256(JSON.stringify(files.map(p => [p, sha256(readFileSync(join(root, p), 'utf8').replace(/\r\n/g, '\n'))])));
}
export function reviewBinding(report) {
  return sha256(JSON.stringify({
    validator: validatorDigest(), profile: report.profile, manifest: report.manifest,
    artifacts: [...new Map(report.artifacts.map(a => [a.path, a])).values()].sort((a, b) => a.path < b.path ? -1 : 1),
    errors: report.errors, warnings: report.warnings, doubts: report.doubtful_fields,
  }));
}
export function findings(report) {
  return [...new Set([...report.warnings, ...report.doubtful_fields].map(x => `${x.code}:${x.field}`))].sort();
}
export function reviewPath(manifest) {
  if (!/^preflight\/jobs\/.+\.json$/.test(manifest)) throw new Error('REGISTERED_JOB_REQUIRED');
  return manifest.replace('preflight/jobs/', 'preflight/reviews/');
}
export function reviewDraft(report) {
  return { schema_version: 1, manifest: report.manifest, binding: reviewBinding(report), reviewer: '', reviewed_at: '', verdict: 'UNRESOLVED', rationale: '', resolutions: findings(report).map(key => ({ key, decision: 'UNRESOLVED', reason: '' })) };
}
export function applyReview(root, report) {
  report.technical_status = report.status;
  report.review_status = 'PENDING'; report.ready_for_delivery = false;
  if (report.status !== 'PASS') return report;
  const c = context(root, 'review');
  try {
    const path = reviewPath(report.manifest), r = c.json(path);
    if (keys(c, r, ['schema_version', 'manifest', 'binding', 'reviewer', 'reviewed_at', 'verdict', 'rationale', 'resolutions'], 'review')) {
      c.check(r.schema_version === 1 && r.manifest === report.manifest, 'REVIEW_MANIFEST_MISMATCH', path);
      c.check(r.binding === reviewBinding(report), 'REVIEW_STALE', path);
      c.check(nonempty(r.reviewer) && date(r.reviewed_at) && nonempty(r.rationale), 'REVIEW_DETAILS_REQUIRED', path);
      c.check(r.verdict === 'APPROVE', 'REVIEW_NOT_APPROVED', path);
      const rows = Array.isArray(r.resolutions) ? r.resolutions : [];
      c.check(Array.isArray(r.resolutions), 'REVIEW_RESOLUTIONS_REQUIRED', path);
      const expected = findings(report), seen = new Set();
      for (const row of rows) {
        if (!keys(c, row, ['key', 'decision', 'reason'], 'resolution')) continue;
        c.check(expected.includes(row.key) && !seen.has(row.key) && ['VERIFIED', 'ACCEPTED_LIMITATION'].includes(row.decision) && nonempty(row.reason), 'REVIEW_UNRESOLVED', path);
        seen.add(row.key);
      }
      c.check(expected.every(key => seen.has(key)), 'REVIEW_FINDINGS_MISSING', path);
    }
  } catch { c.error('REVIEW_REQUIRED_OR_INVALID', report.manifest); }
  report.errors.push(...c.report.errors);
  report.review_status = c.report.errors.length ? 'UNRESOLVED' : 'APPROVED';
  report.ai_review = report.review_status;
  report.status = c.report.errors.length ? 'FAIL' : 'PASS';
  report.ready_for_delivery = report.status === 'PASS';
  return report;
}
