import { object, nonempty, date, sha256 } from './core.mjs';
import { keys } from './schema.mjs';
import { HOLDOUT_CASES } from '../../src/holdout-cases.mjs';
import { clauseInText } from '../../src/text.mjs';

export function summarizeRun(c, data, field, bank = HOLDOUT_CASES) {
  if (!c.check(object(data) && Array.isArray(data.results) && data.results.length === bank.length, 'METRIC_CASES_INCOMPLETE', field)) return null;
  const known = new Map(bank.map(r => [r.id, r])), seen = new Set();
  let correct = 0, determinate = 0, detCorrect = 0, unsafe = 0, misses = 0, hallucinations = 0;
  for (const r of data.results) {
    const expected = known.get(r.id);
    if (!c.check(!!expected && !seen.has(r.id), 'METRIC_CASE_ID', field)) continue;
    seen.add(r.id);
    c.check(r.expected === expected.expected.verdict, 'METRIC_LABEL_CHANGED', field);
    c.check(['YES', 'YES_WITH_CONDITIONS', 'NO', 'UNKNOWN', 'ERROR'].includes(r.got), 'METRIC_VERDICT_INVALID', field);
    const ok = r.got === expected.expected.verdict, det = !['UNKNOWN', 'ERROR'].includes(r.got);
    const hall = det && (!nonempty(r.cited_clause) || !clauseInText(r.cited_clause, expected.page_text));
    correct += Number(ok); determinate += Number(det); detCorrect += Number(ok && det);
    unsafe += Number(!ok && r.got !== 'UNKNOWN'); misses += Number(!ok && r.got === 'UNKNOWN'); hallucinations += Number(hall);
    c.check(r.correct === ok && r.determinate === det && r.hallucination === hall, 'METRIC_ROW_INCONSISTENT', field);
  }
  const n = bank.length, pct = (a, b) => b ? Math.round(a / b * 1000) / 10 : 0;
  const result = { cases: n, accuracy_pct: pct(correct, n), coverage_pct: pct(determinate, n), precision_determinate_pct: pct(detCorrect, determinate), coverage_ceiling_pct: pct(bank.filter(r => r.expected.verdict !== 'UNKNOWN').length, n), unsafe_errors: unsafe, safe_misses: misses, hallucinations };
  for (const [key, value] of Object.entries(result)) c.check(data[key] === value, 'METRIC_SUMMARY_MISMATCH', `${field}.${key}`);
  return result;
}
export function metrics(c, m) {
  c.check(m.mode === 'repository', 'MODE_INVALID', 'mode');
  if (!c.check(Array.isArray(m.runs) && m.runs.length > 0 && object(m.expected), 'METRIC_INPUT_REQUIRED', 'runs')) return;
  keys(c, m.expected, ['runs', 'cases', 'date', 'model', 'build', 'accuracy_pct', 'coverage_pct', 'precision_determinate_pct', 'coverage_ceiling_pct', 'unsafe_errors', 'safe_misses', 'hallucinations'], 'expected');
  c.bytes('src/holdout-cases.mjs'); c.bytes('src/text.mjs');
  c.check(m.expected.runs === m.runs.length && new Set(m.runs).size === m.runs.length, 'METRIC_RUNS_MISMATCH', 'runs');
  c.check(date(m.expected.date) && nonempty(m.expected.model) && nonempty(m.expected.build), 'METRIC_IDENTITY_REQUIRED', 'expected');
  const fingerprints = new Map();
  for (const path of m.runs) {
    const data = c.json(path), computed = summarizeRun(c, data, path);
    for (const key of ['date', 'model', 'build']) c.check(data[key] === m.expected[key], 'METRIC_IDENTITY_MISMATCH', `${path}.${key}`);
    if (!computed) continue;
    for (const [key, value] of Object.entries(computed)) c.check(m.expected[key] === value, 'METRIC_EXPECTATION_MISMATCH', `${path}.${key}`);
    for (const r of data.results) {
      const variants = fingerprints.get(r.id) ?? new Set();
      variants.add(sha256(JSON.stringify([r.got, r.got_days, r.got_basis, r.got_deadline, r.cited_clause]))); fingerprints.set(r.id, variants);
    }
  }
  c.report.measurements = { calls: m.runs.length * HOLDOUT_CASES.length, unstable_cases: [...fingerprints.values()].filter(v => v.size > 1).length, date: m.expected.date, model: m.expected.model, build: m.expected.build };
  if (m.published_file) {
    const text = c.bytes(m.published_file).toString('utf8');
    c.check(Array.isArray(m.published_fragments) && m.published_fragments.length > 0, 'PUBLISHED_FRAGMENTS_REQUIRED', 'published_fragments');
    for (const fragment of m.published_fragments ?? []) {
      if (!c.check(nonempty(fragment) && /\{[a-z_]+\}/.test(fragment), 'PUBLISHED_TEMPLATE_INVALID', 'published_fragments')) continue;
      const rendered = fragment.replace(/\{([a-z_]+)\}/g, (_, key) => { c.check(Object.hasOwn(m.expected, key), 'PUBLISHED_KEY_UNKNOWN', key); return String(m.expected[key]); });
      c.check(text.includes(rendered), 'PUBLISHED_METRIC_MISMATCH', 'published_fragments');
    }
  }
  c.warn('HISTORICAL_EVALUATION_NOT_CURRENT_MODEL', 'runs');
  c.doubt('PUBLISHED_CLAIMS_SCOPE_REQUIRES_REVIEW', 'published_file');
}
