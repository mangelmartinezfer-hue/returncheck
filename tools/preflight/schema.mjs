import { object } from './core.mjs';
import { ITEM_CONDITIONS, REASONS } from '../../src/contract.mjs';

export function keys(c, value, allowed, field) {
  if (!c.check(object(value), 'OBJECT_REQUIRED', field)) return false;
  for (const name of Object.keys(value)) c.check(allowed.includes(name), 'UNKNOWN_FIELD', `${field}.${name}`);
  return true;
}
export function manifestSchema(c, m) {
  const common = ['schema_version', 'profile', 'mode'];
  const fields = {
    payment: ['expected', 'body_file', 'body_sha256', 'body_bytes', 'as_of', 'envelope_file', 'replay'],
    ucp: ['records'], corpus: ['records'], artifact: ['purpose', 'files'],
    delivery: ['purpose', 'files', 'package_dir', 'snapshot_file', 'snapshot_sha256', 'expected', 'as_of', 'max_age_hours'],
    metrics: ['runs', 'expected', 'published_file', 'published_fragments'],
  };
  keys(c, m, [...common, ...(fields[m.profile] ?? [])], 'manifest');
  if (m.profile === 'payment' && m.expected) keys(c, m.expected, ['scheme', 'network', 'asset', 'payTo', 'amount', 'endpoint'], 'expected');
  if (m.profile === 'payment' && m.replay) keys(c, m.replay, ['body_file', 'envelope_file', 'endpoint'], 'replay');
  if (Array.isArray(m.files)) m.files.forEach((f, i) => keys(c, f, ['path', 'sha256', 'bytes', 'format'], `files[${i}]`));
}
export function recordSchema(c, r, p) {
  keys(c, r, ['id', 'synthetic', 'split', 'as_of', 'item_condition', 'reason', 'seller', 'marketplace', 'expected', 'source', 'exact_clause', 'claims'], p);
  c.check(ITEM_CONDITIONS.includes(r.item_condition), 'ITEM_CONDITION_INVALID', `${p}.item_condition`);
  c.check(REASONS.includes(r.reason), 'REASON_INVALID', `${p}.reason`);
  if (r.source) keys(c, r.source, ['file', 'sha256', 'url', 'captured_at'], `${p}.source`);
}
export function claimSchema(c, claim, name, p) {
  if (!keys(c, claim, ['value', 'quote'], p)) return;
  c.check(claim.value !== null && ['string', 'number', 'boolean'].includes(typeof claim.value), 'CLAIM_VALUE_INVALID', p);
  if (['days', 'merchant_return_days'].includes(name)) {
    c.check(Number.isSafeInteger(claim.value) && claim.value >= 0, 'CLAIM_DAYS_INVALID', p);
    // Only catch explicit numeric contradictions. This does not prove entailment.
    const numbers = [...String(claim.quote ?? '').matchAll(/\b(\d+)\s+(?:(?:calendar|business)\s+)?days?\b/gi)].map(m => Number(m[1]));
    if (numbers.length) c.check(numbers.includes(claim.value), 'CLAIM_NUMERIC_CONTRADICTION', p);
    else c.doubt('CLAIM_NUMBER_NOT_EXPLICIT', p);
  }
}
