import { context, sha256 } from './core.mjs';

const norm = s => s.replace(/\s+/g, ' ').trim().toLowerCase();
export function crossLots(root, manifests) {
  const c = context(root, 'cross-lots'), ids = new Set(), cases = new Set(), policies = new Map();
  for (const path of manifests) {
    try {
      const m = c.json(path);
      if (!['ucp', 'corpus'].includes(m.profile) || m.mode !== 'intake' || !Array.isArray(m.records)) continue;
      for (const [i, r] of m.records.entries()) {
        const field = `${path}:records[${i}]`;
        const text = norm(c.bytes(r.source.file, r.source.sha256).toString('utf8'));
        const policy = sha256(text);
        const identity = sha256(JSON.stringify([policy, norm(r.exact_clause), r.item_condition, r.reason, r.seller, r.marketplace, r.as_of]));
        c.check(!ids.has(r.id), 'CROSS_LOT_DUPLICATE_ID', field); ids.add(r.id);
        c.check(!cases.has(identity), 'CROSS_LOT_DUPLICATE_CASE', field); cases.add(identity);
        const splits = policies.get(policy) ?? new Set(); splits.add(r.split); policies.set(policy, splits);
        c.check(!(splits.has('holdout') && splits.size > 1), 'CROSS_LOT_HOLDOUT_LEAKAGE', field);
      }
    } catch { c.error('CROSS_LOT_INPUT_INVALID', path); }
  }
  return c.finish();
}
