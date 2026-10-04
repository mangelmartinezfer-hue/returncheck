import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { run } from '../tools/preflight/runner.mjs';
import { sha256, publicVars, date } from '../tools/preflight/core.mjs';
import { HOLDOUT_CASES } from '../src/holdout-cases.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
function fixture(t, profile = 'payment') {
  const dir = mkdtempSync(join(tmpdir(), 'returncheck-preflight-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const write = (path, data) => writeFileSync(join(dir, path), typeof data === 'string' ? data : JSON.stringify(data));
  const body = '{"as_of":"2026-10-02"}';
  const expected = { scheme: 'exact', network: 'eip155:8453', asset: '0x' + '1'.repeat(40), payTo: '0x' + '2'.repeat(40), amount: '20000', endpoint: 'https://example.com/v1/check' };
  const envelope = { x402Version: 2, accepted: { ...expected }, resource: { url: expected.endpoint }, extensions: { 'payment-identifier': { info: { id: 'payment_123456789' } } }, payload: { signature: 'DO_NOT_PRINT_SECRET', authorization: { nonce: 'nonce' } } };
  const source = 'Opened items may be returned within 30 days.';
  const record = { id: 'case-1', synthetic: true, split: 'development', as_of: '2026-10-02', item_condition: 'opened', reason: 'changed_mind', seller: 'Example', marketplace: 'none', expected: 'YES_WITH_CONDITIONS', exact_clause: source, source: { file: 'source.txt', sha256: sha256(source), url: 'https://example.com/policy', captured_at: '2026-10-01' }, claims: { days: { value: 30, quote: source } } };
  const m = profile === 'payment' ? { schema_version: 1, profile, mode: 'package', expected, body_file: 'body.json', body_sha256: sha256(body), body_bytes: Buffer.byteLength(body), as_of: '2026-10-02', envelope_file: 'envelope.json', replay: { body_file: 'replay-body.json', envelope_file: 'replay-envelope.json', endpoint: expected.endpoint } } : { schema_version: 1, profile, mode: 'intake', records: [record] };
  write('body.json', body); write('replay-body.json', body); write('envelope.json', envelope); write('replay-envelope.json', envelope); write('source.txt', source);
  return { m, envelope, write, check() { write('manifest.json', m); return run(dir, profile, 'manifest.json'); } };
}
test('repository profiles pass deterministically and disclose review limits', () => {
  for (const p of ['payment', 'ucp', 'corpus']) {
    const a = run(root, p); assert.equal(a.status, 'PASS', JSON.stringify(a.errors)); assert.deepEqual(a, run(root, p));
    assert.equal(a.ai_review, 'PENDING'); assert.ok(a.artifacts.length); assert.ok(a.warnings.length); assert.ok(a.doubtful_fields.length);
  }
});
test('valid payment preserves exact bytes and does not disclose signature', t => {
  const f = fixture(t), r = f.check(); assert.equal(r.status, 'PASS'); assert.ok(!JSON.stringify(r).includes('DO_NOT_PRINT_SECRET'));
});
const paymentFailures = [
  ['invalid agreed amount', f => { f.m.expected.amount = '2e4'; f.envelope.accepted.amount = '2e4'; }, 'EXPECTED_AMOUNT_INVALID'],
  ['invalid agreed address', f => { f.m.expected.payTo = 'bad'; f.envelope.accepted.payTo = 'bad'; }, 'EXPECTED_ADDRESS_INVALID'],
  ['body hash', f => { f.m.body_sha256 = '0'.repeat(64); }, 'HASH_MISMATCH'],
  ['hash absent', f => { delete f.m.body_sha256; }, 'HASH_REQUIRED'],
  ['size', f => { f.m.body_bytes++; }, 'SIZE_MISMATCH'],
  ['date', f => { f.m.as_of = '2026-02-30'; }, 'AS_OF_MISMATCH'],
  ['amount type', f => { f.envelope.accepted.amount = 20000; }, 'PAYMENT_TERMS'],
  ['recipient', f => { f.envelope.accepted.payTo = 'wrong'; }, 'PAYMENT_TERMS'],
  ['network', f => { f.envelope.accepted.network = 'base'; }, 'PAYMENT_TERMS'],
  ['asset', f => { f.envelope.accepted.asset = 'wrong'; }, 'PAYMENT_TERMS'],
  ['endpoint', f => { f.envelope.resource.url = 'https://wrong.example'; }, 'ENDPOINT_MISMATCH'],
  ['id path', f => { delete f.envelope.extensions; }, 'IDENTIFIER_INVALID'],
  ['id regex', f => { f.envelope.extensions['payment-identifier'].info.id = 'too-short'; }, 'IDENTIFIER_INVALID'],
  ['legacy conflict', f => { f.envelope.payload.extensions = { 'payment-identifier': 'different' }; }, 'IDENTIFIER_CONFLICT'],
  ['nonce missing', f => { delete f.envelope.payload.authorization; }, 'NONCE_MISSING'],
  ['signature missing', f => { delete f.envelope.payload.signature; }, 'SIGNATURE_MISSING'],
  ['replay missing', f => { delete f.m.replay; }, 'REPLAY_REQUIRED'],
  ['replay bytes', f => { f.write('replay-body.json', '{ "as_of":"2026-10-02"}'); }, 'REPLAY_BODY_CHANGED'],
  ['replay signature', f => { f.write('replay-envelope.json', { ...f.envelope, payload: { signature: 'changed' } }); }, 'REPLAY_ENVELOPE_CHANGED'],
  ['replay endpoint', f => { f.m.replay.endpoint += '/changed'; }, 'REPLAY_ENDPOINT_CHANGED'],
  ['outside root', f => { f.m.body_file = '../outside.json'; }, 'INPUT_UNREADABLE_OR_INVALID'],
  ['malformed JSON', f => { f.write('body.json', '{'); }, 'INPUT_UNREADABLE_OR_INVALID'],
];
for (const [name, mutate, code] of paymentFailures) test(`payment rejects ${name}`, t => {
  const f = fixture(t); mutate(f); f.write('envelope.json', f.envelope);
  const r = f.check(); assert.equal(r.status, 'FAIL'); assert.ok(r.errors.some(e => e.code === code), JSON.stringify(r.errors));
});
test('payment identifier length boundaries', t => {
  const f = fixture(t);
  for (const [size, ok] of [[15, false], [16, true], [128, true], [129, false]]) {
    f.envelope.extensions['payment-identifier'].info.id = 'a'.repeat(size);
    f.write('envelope.json', f.envelope); f.write('replay-envelope.json', f.envelope);
    assert.equal(f.check().status, ok ? 'PASS' : 'FAIL');
  }
});
for (const profile of ['ucp', 'corpus']) {
  test(`${profile} valid intake`, t => assert.equal(fixture(t, profile).check().status, 'PASS'));
  for (const [name, mutate, code] of [
    ['empty', m => { m.records = []; }, 'RECORDS_REQUIRED'],
    ['mode', m => { m.mode = 'typo'; }, 'MODE_INVALID'],
    ['synthetic unspecified', m => { delete m.records[0].synthetic; }, 'SYNTHETIC_REQUIRED'],
    ['synthetic labelled real', m => { m.records[0].synthetic = false; }, 'SYNTHETIC_SOURCE_MARKED_REAL'],
    ['provenance', m => { delete m.records[0].source; }, 'SOURCE_REQUIRED'],
    ['source hash', m => { m.records[0].source.sha256 = '0'.repeat(64); }, 'HASH_MISMATCH'],
    ['URL credentials', m => { m.records[0].source.url = 'https://user:DO_NOT_PRINT_SECRET@example.com'; }, 'SOURCE_URL_INVALID'],
    ['future capture', m => { m.records[0].source.captured_at = '2026-10-03'; }, 'CAPTURE_DATE_INVALID'],
    ['invented clause', m => { m.records[0].exact_clause = 'Returns forever'; }, 'CLAUSE_NOT_LITERAL'],
    ['unsupported claim', m => { m.records[0].claims.days.quote = 'Returns forever'; }, 'CLAIM_UNSUPPORTED'],
    ['empty claims', m => { m.records[0].claims = {}; }, 'CLAIMS_EMPTY'],
    ['missing seller', m => { delete m.records[0].seller; }, 'FIELD_REQUIRED'],
    ['duplicate', m => { m.records.push(structuredClone(m.records[0])); }, 'ID_MISSING_OR_DUPLICATE'],
    ['holdout leakage', m => { const r = structuredClone(m.records[0]); r.id = 'other'; r.split = 'holdout'; m.records.push(r); }, 'HOLDOUT_LEAKAGE'],
    ['holdout with different condition', m => { const r = structuredClone(m.records[0]); r.id = 'other'; r.split = 'holdout'; r.item_condition = 'unopened'; m.records.push(r); }, 'HOLDOUT_LEAKAGE'],
  ]) test(`${profile} rejects ${name}`, t => {
    const f = fixture(t, profile); mutate(f.m); const r = f.check(); assert.equal(r.status, 'FAIL'); assert.ok(r.errors.some(e => e.code === code), JSON.stringify(r.errors)); assert.ok(!JSON.stringify(r).includes('DO_NOT_PRINT_SECRET'));
  });
}
test('corpus intake rejects material from existing holdout', t => {
  const f = fixture(t, 'corpus'), text = HOLDOUT_CASES[0].page_text;
  f.write('source.txt', text); Object.assign(f.m.records[0], { exact_clause: text, claims: { verdict: { value: 'YES', quote: text } } }); f.m.records[0].source.sha256 = sha256(text);
  assert.ok(f.check().errors.some(e => e.code === 'EXISTING_HOLDOUT_LEAKAGE'));
});
test('public vars reject duplicates and unsupported values; ignore other sections', () => {
  assert.throws(() => publicVars('[vars]\nX="a"\nX="b"'));
  assert.throws(() => publicVars('[vars]\nX=123'));
  assert.deepEqual(publicVars('[vars]\nX="a"\n[env.preview.vars]\nX="b"'), { X: 'a' });
  assert.equal(date('2026-02-30'), false); assert.equal(date('2028-02-29'), true);
});
test('CLI exit codes and machine-readable failure format', () => {
  for (const [args, expected] of [[['all', '--json'], 0], [['unknown', '--json'], 1], [['payment', 'missing.json', '--json'], 1], [['all', 'unexpected.json'], 1]]) {
    const p = spawnSync(process.execPath, ['tools/preflight/runner.mjs', ...args], { cwd: root, encoding: 'utf8' });
    assert.equal(p.status, expected, p.stderr); assert.doesNotThrow(() => JSON.parse(p.stdout));
  }
});
