import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROTECTION = {
  required_status_checks: { strict: true, contexts: ['validate'] },
  enforce_admins: true,
  required_pull_request_reviews: { required_approving_review_count: 0, dismiss_stale_reviews: true },
  restrictions: null,
};
export function protectionIssues(p) {
  const issues = [];
  if (p?.required_status_checks?.strict !== true) issues.push('STRICT_CHECKS_REQUIRED');
  const names = [...(p?.required_status_checks?.contexts ?? []), ...(p?.required_status_checks?.checks ?? []).map(x => x.context)];
  if (!names.includes('validate')) issues.push('VALIDATE_CHECK_NOT_REQUIRED');
  if (p?.enforce_admins?.enabled !== true) issues.push('ADMIN_BYPASS_ENABLED');
  if (!p?.required_pull_request_reviews) issues.push('PULL_REQUEST_NOT_REQUIRED');
  return issues;
}
export async function auditProtection(fetcher = fetch, token = process.env.GITHUB_TOKEN) {
  const headers = { accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await fetcher('https://api.github.com/repos/mangelmartinezfer-hue/returncheck/branches/main/protection', { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15000), headers });
  if (!r.ok) return { status: 'FAIL', verified: false, errors: [{ code: 'PROTECTION_UNVERIFIED', http_status: r.status }] };
  const errors = protectionIssues(await r.json()).map(code => ({ code }));
  return { status: errors.length ? 'FAIL' : 'PASS', verified: true, errors };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === '--proposal' && process.argv.length === 3) console.log(JSON.stringify(PROTECTION, null, 2));
    else if (process.argv.length === 2) { const r = await auditProtection(); console.log(JSON.stringify(r, null, 2)); process.exitCode = r.status === 'PASS' ? 0 : 1; }
    else throw new Error('USAGE');
  } catch { console.error('PROTECTION_UNVERIFIED: no se ha cambiado ninguna configuración.'); process.exitCode = 1; }
}
