import { createHash } from 'node:crypto';

export function referenceDate(args) {
  const i = args.indexOf('--as-of'), value = i >= 0 ? args[i + 1] : undefined;
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw new Error('Se requiere --as-of YYYY-MM-DD válido para fijar el experimento.');
  return value;
}
export function responseFingerprint(r) {
  const p = r.policy ?? {};
  return JSON.stringify([r.verdict, p.merchant_return_days ?? null, p.window_basis ?? null, p.deadline_date ?? null, p.return_category ?? null, createHash('sha256').update(r.evidence?.exact_clause ?? '').digest('hex')]);
}
