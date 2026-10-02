import { clausePositiveButUnverifiedForOpenedItem, conditionExclusionClause } from './text.mjs';

// Recover only an explicit, adjacent generic opened-products alternative.
// Do not reuse a different category's terms, interpret "opened" as "used",
// or let the model's fees/conditions from the rejected branch survive.
export function recoverOpenedBranch(ai, req, text) {
  const rejected = ai.evidence?.exact_clause;
  if (req.item_condition !== 'opened' || !['YES', 'YES_WITH_CONDITIONS'].includes(ai.verdict) ||
      !rejected || !ai.policy || !clausePositiveButUnverifiedForOpenedItem(rejected, 'opened') ||
      conditionExclusionClause(text, 'opened')) return false;
  const normalize = s => s.replace(/\s+/gu, ' ').trim();
  const clause = normalize(rejected), page = normalize(text);
  // A full generic sentence is required, not a cropped numeric fragment.
  if (!/\bnew and unopened products within \d+ days\b/i.test(clause) || !/[.!?]$/.test(clause)) return false;
  const first = page.indexOf(clause);
  if (first < 0 || page.indexOf(clause, first + 1) >= 0) return false;
  const next = page.slice(first + clause.length).trimStart();
  const match = next.match(/^You may also return open(?:ed)? products within (\d{1,3}) days, with your proof of purchase, for a full refund\./i);
  if (!match || Number(match[1]) < 1) return false;
  ai.evidence = { ...ai.evidence, clause_id: null, exact_clause: match[0] };
  ai.policy = { return_category: 'FiniteReturnWindow', merchant_return_days: Number(match[1]),
    window_basis: null, return_country: req.buyer_country, applicable_countries: [],
    return_method: [], return_fees: null, restocking_fee: null, refund_type: 'FullRefund',
    item_conditions_accepted: [], required_condition: null, exceptions: [] };
  ai.verdict = 'YES_WITH_CONDITIONS';
  ai.answer_human = `Yes, with conditions — the opened-product clause allows returns within ${match[1]} days with proof of purchase.`;
  ai.reason = 'The explicit adjacent opened-product clause applies; the temporal anchor is not stated.';
  return true;
}
