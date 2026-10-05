import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { context, sha256 } from '../tools/preflight/core.mjs';
import { run, runAll } from '../tools/preflight/runner.mjs';
import { applyReview, reviewDraft, reviewPath } from '../tools/preflight/review.mjs';
import { crossLots } from '../tools/preflight/cross-lots.mjs';
import { coverage, changedPaths, orphanedInputs, inventoryCoverage } from '../tools/preflight/coverage.mjs';
import { ITEM_CONDITIONS, REASONS, validateRequest } from '../src/contract.mjs';
import { capture, PUBLIC_CAPTURE_URLS } from '../tools/preflight/capture.mjs';
import { summarizeRun } from '../tools/preflight/metrics.mjs';
import { pointer } from '../tools/preflight/delivery.mjs';
import { auditProtection, protectionIssues } from '../tools/preflight/governance.mjs';
import { referenceDate, responseFingerprint } from '../tools/variance-input.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'rc-hardening-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (p, v) => { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), typeof v === 'string' ? v : JSON.stringify(v)); };
  const text = 'Opened items may be returned within 30 days.';
  write('inputs/policy.txt', text);
  const record = { id: 'case-a', synthetic: true, split: 'development', as_of: '2026-10-04', item_condition: 'opened', reason: 'changed_mind', seller: 'Example', marketplace: 'none', expected: 'YES_WITH_CONDITIONS', source: { file: 'inputs/policy.txt', sha256: sha256(text), url: 'https://example.com/policy', captured_at: '2026-10-01' }, exact_clause: text, claims: { days: { value: 30, quote: text } } };
  const m = { schema_version: 1, profile: 'corpus', mode: 'intake', records: [record] };
  const path = 'preflight/jobs/example.json';
  return { root, write, text, record, m, path, technical() { write(path, m); return run(root, m.profile, path); } };
}
function approve(f, report) {
  const r = reviewDraft(report);
  Object.assign(r, { reviewer: 'test-reviewer', reviewed_at: '2026-10-04', verdict: 'APPROVE', rationale: 'Synthetic test of review binding, not a real approval.' });
  for (const row of r.resolutions) Object.assign(row, { decision: 'ACCEPTED_LIMITATION', reason: 'Synthetic fixture explicitly reviewed.' });
  f.write(reviewPath(f.path), r); return r;
}
test('intake follows the live contract enums, including future additions', t => {
  const f = fixture(t);
  for (const [field, values] of [['item_condition', ITEM_CONDITIONS], ['reason', REASONS]]) {
    // A temporary addition proves the validator imports the contract rather than
    // maintaining an identical copy. Always restore shared state in this process.
    values.push('__future_contract_value__');
    try {
      for (const value of values) {
        f.record[field] = value;
        assert.equal(validateRequest({ product_url: 'https://example.com/item', buyer_country: 'US', [field]: value }).ok, true);
        assert.equal(f.technical().status, 'PASS', `${field}: ${value}`);
      }
    } finally { values.pop(); f.record[field] = values[0]; }
  }
});
test('inventory blocks undeclared committed work even outside the current diff', () => {
  const c = context(repo, 'coverage');
  inventoryCoverage(c, ['cards/old.mjs', 'cards/new.mjs', 'cards/declared.mjs'], new Set(['cards/old.mjs']), new Set(['cards/declared.mjs']));
  assert.deepEqual(c.report.errors.map(e => e.code), ['UNREGISTERED_WORK']);
  assert.deepEqual(c.report.warnings.map(e => e.code), ['LEGACY_UNREGISTERED_WORK']);
  assert.equal(c.report.inventory_files.length, 3);
});
test('registering or removing historical work reduces visible debt', () => {
  const c = context(repo, 'coverage');
  inventoryCoverage(c, ['cards/old.mjs'], new Set(['cards/old.mjs', 'cards/deleted.mjs']), new Set(['cards/old.mjs']));
  assert.equal(c.report.warnings.length, 0);
  assert.equal(c.finish().status, 'PASS');
});
for (const [name, edit, code] of [
  ['invalid condition', f => f.record.item_condition = 'NOT_A_CONDITION', 'ITEM_CONDITION_INVALID'],
  ['invalid reason', f => f.record.reason = 'anything', 'REASON_INVALID'],
  ['unknown record field', f => f.record.unreviewed_promise = 'unlimited', 'UNKNOWN_FIELD'],
  ['unknown source field', f => f.record.source.unchecked = true, 'UNKNOWN_FIELD'],
  ['unknown manifest field', f => f.m.trusted = true, 'UNKNOWN_FIELD'],
  ['unknown claim field', f => f.record.claims.days.approved = true, 'UNKNOWN_FIELD'],
  ['contradictory days', f => f.record.claims.days.value = 999, 'CLAIM_NUMERIC_CONTRADICTION'],
  ['wrong day type', f => f.record.claims.days.value = '30', 'CLAIM_DAYS_INVALID'],
  ['negative days', f => f.record.claims.days.value = -1, 'CLAIM_DAYS_INVALID'],
  ['null claim', f => f.record.claims.days.value = null, 'CLAIM_VALUE_INVALID'],
]) test(`strict intake rejects ${name}`, t => {
  const f = fixture(t); edit(f); const r = f.technical(); assert.equal(r.status, 'FAIL'); assert.ok(r.errors.some(e => e.code === code));
});
test('valid technical result is not a reviewed delivery', t => {
  const f = fixture(t), r = f.technical(); assert.equal(r.status, 'PASS'); assert.equal(r.ready_for_delivery, false);
  const gated = applyReview(f.root, r); assert.equal(gated.status, 'FAIL'); assert.equal(gated.technical_status, 'PASS');
});
test('review approves only exact inputs, and default draft never approves', t => {
  const f = fixture(t), r = f.technical(); f.write(reviewPath(f.path), reviewDraft(r));
  assert.equal(applyReview(f.root, structuredClone(r)).status, 'FAIL');
  approve(f, r); const good = applyReview(f.root, structuredClone(r));
  assert.equal(good.status, 'PASS'); assert.equal(good.ready_for_delivery, true);
  f.record.seller = 'Changed seller'; const changed = f.technical();
  assert.ok(applyReview(f.root, changed).errors.some(e => e.code === 'REVIEW_STALE'));
});
for (const [name, edit, code] of [
  ['binding', r => r.binding = '0'.repeat(64), 'REVIEW_STALE'],
  ['manifest', r => r.manifest = 'other', 'REVIEW_MANIFEST_MISMATCH'],
  ['unresolved finding', r => r.resolutions[0].decision = 'UNRESOLVED', 'REVIEW_UNRESOLVED'],
  ['missing finding', r => r.resolutions.pop(), 'REVIEW_FINDINGS_MISSING'],
  ['duplicated finding', r => r.resolutions.push(r.resolutions[0]), 'REVIEW_UNRESOLVED'],
  ['reviewer absent', r => r.reviewer = '', 'REVIEW_DETAILS_REQUIRED'],
  ['invalid date', r => r.reviewed_at = '2026-02-30', 'REVIEW_DETAILS_REQUIRED'],
  ['verdict rejected', r => r.verdict = 'CHANGES_REQUIRED', 'REVIEW_NOT_APPROVED'],
]) test(`review rejects ${name}`, t => {
  const f = fixture(t), technical = f.technical(), r = approve(f, technical); edit(r); f.write(reviewPath(f.path), r);
  assert.ok(applyReview(f.root, technical).errors.some(e => e.code === code));
});
test('changing source bytes invalidates review even after updating expected hash', t => {
  const f = fixture(t); approve(f, f.technical());
  f.write('inputs/policy.txt', f.text + ' New restrictions.'); f.record.source.sha256 = sha256(f.text + ' New restrictions.');
  assert.ok(applyReview(f.root, f.technical()).errors.some(e => e.code === 'REVIEW_STALE'));
});
test('cross-lot duplicate and holdout leakage cannot hide in separate manifests', t => {
  const f = fixture(t); f.technical(); const second = structuredClone(f.m); second.records[0].id = 'case-b'; second.records[0].split = 'holdout';
  f.write('preflight/jobs/second.json', second);
  const r = crossLots(f.root, [f.path, 'preflight/jobs/second.json']);
  assert.ok(r.errors.some(e => e.code === 'CROSS_LOT_DUPLICATE_CASE'));
  assert.ok(r.errors.some(e => e.code === 'CROSS_LOT_HOLDOUT_LEAKAGE'));
});
test('same policy with distinct legitimate cases in same split is preserved', t => {
  const f = fixture(t); f.technical(); const second = structuredClone(f.m); second.records[0].id = 'case-b'; second.records[0].item_condition = 'unopened';
  f.write('preflight/jobs/second.json', second);
  assert.equal(crossLots(f.root, [f.path, 'preflight/jobs/second.json']).status, 'PASS');
});
test('coverage detects unregistered work and permits declared inputs', t => {
  const f = fixture(t), r = f.technical();
  assert.equal(coverage(f.root, [r], ['inputs/policy.txt', 'src/engine.mjs', 'docs/guide.md']).status, 'PASS');
  assert.equal(coverage(f.root, [r], ['catalog/new.json']).status, 'FAIL');
  assert.equal(coverage(f.root, [r], ['preflight/reviews/orphan.json']).status, 'FAIL');
});
test('git coverage sees committed, staged, unstaged and untracked changes', t => {
  const f = fixture(t);
  const git = (...args) => execFileSync('git', args, { cwd: f.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com');
  f.write('tracked.txt', 'old'); git('add', '.'); git('commit', '-m', 'baseline'); const base = git('rev-parse', 'HEAD');
  f.write('committed.json', '{}'); git('add', 'committed.json'); git('commit', '-m', 'new input');
  f.write('staged.json', '{}'); git('add', 'staged.json'); f.write('tracked.txt', 'changed'); f.write('untracked.json', '{}');
  const changed = changedPaths(f.root, base);
  for (const p of ['committed.json', 'staged.json', 'tracked.txt', 'untracked.json']) assert.ok(changed.includes(p));
  assert.throws(() => changedPaths(f.root, '--help'));
});
test('deleting a manifest cannot silently retire inputs that remain in Git', t => {
  const f = fixture(t); f.technical();
  const git = (...args) => execFileSync('git', args, { cwd: f.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com'); git('add', '.'); git('commit', '-m', 'registered input');
  const base = git('rev-parse', 'HEAD'); unlinkSync(join(f.root, f.path));
  assert.deepEqual(orphanedInputs(f.root, new Set(), base), ['inputs/policy.txt']);
  assert.deepEqual(orphanedInputs(f.root, new Set(['inputs/policy.txt']), base), []);
});

function deliveryFixture(t) {
  const f = fixture(t); f.write('package/readme.txt', 'final'); f.write('capture/body.json', '{"payTo":"recipient","amount":"20000"}');
  const snapshot = { schema_version: 1, url: PUBLIC_CAPTURE_URLS[0], status: 200, captured_at: '2026-10-04T12:00:00.000Z', body_file: 'capture/body.json', body_sha256: sha256('{"payTo":"recipient","amount":"20000"}') };
  f.m = { schema_version: 1, profile: 'delivery', mode: 'intake', purpose: 'Final delivery', package_dir: 'package', files: [{ path: 'package/readme.txt', sha256: sha256('final'), bytes: 5, format: 'text' }], snapshot_file: 'capture/snapshot.json', snapshot_sha256: '', expected: { url: snapshot.url, fields: { '/payTo': 'recipient', '/amount': '20000' } }, as_of: '2026-10-04T13:00:00.000Z', max_age_hours: 24 };
  f.check = () => { const text = JSON.stringify(snapshot); f.write('capture/snapshot.json', text); f.m.snapshot_sha256 = sha256(text); f.write(f.path, f.m); return run(f.root, 'delivery', f.path); };
  f.snapshot = snapshot; return f;
}
test('delivery checks exact package and captured terms without network', t => { assert.equal(deliveryFixture(t).check().status, 'PASS'); });
for (const [name, edit, code] of [
  ['extra package file', f => f.write('package/extra.txt', 'unexpected'), 'PACKAGE_INVENTORY_MISMATCH'],
  ['stale capture', f => f.m.as_of = '2026-10-06T13:00:00.000Z', 'SNAPSHOT_STALE_OR_DATE_INVALID'],
  ['future capture', f => f.snapshot.captured_at = '2026-10-06T13:00:00.000Z', 'SNAPSHOT_STALE_OR_DATE_INVALID'],
  ['wrong recipient', f => f.m.expected.fields['/payTo'] = 'wrong', 'LIVE_VALUE_MISMATCH'],
  ['missing field', f => f.m.expected.fields['/build'] = 'expected-build', 'LIVE_FIELD_MISSING'],
  ['HTTP failure', f => f.snapshot.status = 503, 'SNAPSHOT_INVALID'],
  ['body hash', f => f.snapshot.body_sha256 = '0'.repeat(64), 'HASH_MISMATCH'],
  ['changed URL', f => f.snapshot.url += '/other', 'SNAPSHOT_URL_MISMATCH'],
]) test(`delivery rejects ${name}`, t => {
  const f = deliveryFixture(t); edit(f); const r = f.check(); assert.equal(r.status, 'FAIL'); assert.ok(r.errors.some(e => e.code === code), JSON.stringify(r.errors));
});
test('JSON pointers require own fields and support escaped keys', () => {
  assert.equal(pointer({ 'a/b': { '~': 1 } }, '/a~1b/~0'), 1);
  assert.throws(() => pointer({}, '/toString')); assert.throws(() => pointer({}, '/~2'));
});
test('capture only uses public allowlisted GET with no redirects or credentials', async () => {
  const result = await capture(PUBLIC_CAPTURE_URLS[0], async (url, options) => {
    assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error'); assert.equal(options.headers.authorization, undefined);
    return new Response('{"amount":"20000"}', { status: 200 });
  }, () => '2026-10-04T12:00:00.000Z');
  assert.equal(result.metadata.body_sha256, sha256(result.bytes));
  await assert.rejects(capture('http://127.0.0.1/', () => { throw new Error('must not call'); }));
  await assert.rejects(capture(PUBLIC_CAPTURE_URLS[0], async () => new Response('bad', { status: 503 })));
  await assert.rejects(capture(PUBLIC_CAPTURE_URLS[0], async () => new Response('not json')));
});
test('metrics recompute from rows, not reported totals or edited labels', () => {
  const original = JSON.parse(readFileSync(join(repo, 'evaluaciones/2026-08-31-w47-holdout-pase1.json'), 'utf8'));
  const c = context(repo, 'metrics'), result = summarizeRun(c, original, 'run'); assert.equal(c.finish().status, 'PASS'); assert.equal(result.coverage_pct, 72);
  for (const mutate of [d => d.coverage_pct = 100, d => d.results[0].expected = 'NO', d => d.results[0].cited_clause = 'invented evidence', d => d.results[0].correct = false, d => d.results[1].id = d.results[0].id, d => d.results.pop()]) {
    const changed = structuredClone(original); mutate(changed); const bad = context(repo, 'metrics'); summarizeRun(bad, changed, 'run'); assert.equal(bad.finish().status, 'FAIL');
  }
});
test('protection audit fails closed on unavailable permissions and missing rules', async () => {
  assert.equal((await auditProtection(async () => new Response('', { status: 403 }), undefined)).status, 'FAIL');
  assert.ok(protectionIssues({}).length > 0);
  assert.deepEqual(protectionIssues({ required_status_checks: { strict: true, contexts: ['validate'] }, enforce_admins: { enabled: true }, required_pull_request_reviews: {} }), []);
});
test('variance needs a fixed date and distinguishes differences after character 70', () => {
  assert.throws(() => referenceDate([])); assert.throws(() => referenceDate(['--as-of', '2026-02-30']));
  assert.equal(referenceDate(['--as-of', '2026-08-20']), '2026-08-20');
  assert.notEqual(responseFingerprint({ evidence: { exact_clause: 'x'.repeat(70) + 'A' } }), responseFingerprint({ evidence: { exact_clause: 'x'.repeat(70) + 'B' } }));
});
