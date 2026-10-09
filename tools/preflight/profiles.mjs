import { object, nonempty, date, url, sha256, publicVars } from './core.mjs';
import { retoDePago } from '../../src/x402.mjs';
import { PAYMENT_INSTRUCTIONS } from '../../src/payment-discovery.mjs';
import { EVAL_CASES } from '../../src/eval-cases.mjs';
import { HOLDOUT_CASES } from '../../src/holdout-cases.mjs';
import { recordSchema, claimSchema } from './schema.mjs';
import { metrics } from './metrics.mjs';
import { compareDelivery } from './delivery.mjs';

const verdicts = ['YES', 'YES_WITH_CONDITIONS', 'NO', 'UNKNOWN'];
const identifier = /^[a-zA-Z0-9_-]{16,128}$/;
const terms = ['scheme', 'network', 'asset', 'payTo', 'amount'];
function paymentTerms(c, actual, expected, field) {
  for (const key of terms) c.check(nonempty(expected?.[key]) && actual?.[key] === expected[key], 'PAYMENT_TERMS', `${field}.${key}`);
}
export function payment(c, m) {
  const expected = m.expected;
  if (!c.check(object(expected), 'EXPECTED_REQUIRED', 'expected')) return;
  c.check(url(expected.endpoint), 'ENDPOINT_INVALID', 'expected.endpoint');
  c.check(expected.scheme === 'exact' && /^eip155:[1-9][0-9]*$/.test(expected.network ?? ''), 'EXPECTED_SCHEME_NETWORK', 'expected');
  for (const field of ['asset', 'payTo']) c.check(typeof expected[field] === 'string' && /^0x[a-fA-F0-9]{40}$/.test(expected[field]), 'EXPECTED_ADDRESS_INVALID', `expected.${field}`);
  c.check(typeof expected.amount === 'string' && /^[1-9][0-9]*$/.test(expected.amount), 'EXPECTED_AMOUNT_INVALID', 'expected.amount');
  if (m.mode === 'repository') {
    const env = publicVars(c.bytes('wrangler.toml').toString('utf8'));
    c.bytes('src/x402.mjs'); c.bytes('src/payment-discovery.mjs');
    c.check(env.X402_ENABLED === 'true', 'PAYMENT_DISABLED', 'X402_ENABLED');
    const challenge = retoDePago(env);
    paymentTerms(c, challenge?.accepts?.[0], expected, 'challenge');
    c.check(challenge?.resource?.url === expected.endpoint, 'ENDPOINT_MISMATCH', 'challenge.resource.url');
    c.check(challenge?.x402Version === 2, 'X402_VERSION', 'challenge.x402Version');
    c.check(env.X402_ASSET_NAME === 'USD Coin' && env.X402_ASSET_VERSION === '2', 'TOKEN_DOMAIN', 'wrangler.toml');
    c.check(PAYMENT_INSTRUCTIONS.identifier_path === 'extensions["payment-identifier"].info.id' && PAYMENT_INSTRUCTIONS.identifier_pattern === identifier.source, 'IDENTIFIER_CONTRACT', 'PAYMENT_INSTRUCTIONS');
    c.check(challenge?.extensions?.['payment-identifier']?.info?.required === true, 'IDENTIFIER_DISCOVERY', 'challenge.extensions');
    c.warn('OFFLINE_CONFIG_NOT_LIVE_PRODUCTION', 'wrangler.toml');
    c.doubt('NO_SIGNED_PACKAGE_OR_REPLAY_CHECKED', 'payment');
    return;
  }
  if (!c.check(m.mode === 'package', 'MODE_INVALID', 'mode')) return;
  const body = c.bytes(m.body_file, m.body_sha256);
  c.check(typeof m.body_sha256 === 'string', 'HASH_REQUIRED', 'body_sha256');
  c.check(Number.isSafeInteger(m.body_bytes) && body.length === m.body_bytes, 'SIZE_MISMATCH', 'body_bytes');
  const parsed = JSON.parse(body.toString('utf8'));
  c.check(date(m.as_of) && parsed.as_of === m.as_of, 'AS_OF_MISMATCH', 'as_of');
  const envelope = c.json(m.envelope_file);
  const envelopeKeys = object(envelope) ? Object.keys(envelope).sort() : [];
  const canonicalEnvelopeKeys = ['accepted', 'extensions', 'payload', 'x402Version'];
  c.check(
    envelopeKeys.length === canonicalEnvelopeKeys.length &&
      envelopeKeys.every((key, i) => key === canonicalEnvelopeKeys[i]),
    'PAYMENT_ENVELOPE_SHAPE',
    'envelope'
  );
  paymentTerms(c, envelope.accepted, expected, 'accepted');
  const acceptedKeys = object(envelope.accepted) ? Object.keys(envelope.accepted).sort() : [];
  const canonicalAcceptedKeys = ['amount', 'asset', 'extra', 'maxTimeoutSeconds', 'network', 'payTo', 'scheme'];
  c.check(
    acceptedKeys.length === canonicalAcceptedKeys.length &&
      acceptedKeys.every((key, i) => key === canonicalAcceptedKeys[i]),
    'PAYMENT_ACCEPTED_SHAPE',
    'accepted'
  );
  c.check(
    Number.isSafeInteger(envelope.accepted?.maxTimeoutSeconds) && envelope.accepted.maxTimeoutSeconds > 0,
    'PAYMENT_ACCEPTED_TIMEOUT',
    'accepted.maxTimeoutSeconds'
  );
  c.check(
    object(envelope.accepted?.extra) &&
      nonempty(envelope.accepted.extra.name) &&
      nonempty(envelope.accepted.extra.version),
    'PAYMENT_ACCEPTED_EXTRA',
    'accepted.extra'
  );
  c.check(envelope.x402Version === 2, 'X402_VERSION', 'x402Version');
  const extensionKeys = object(envelope.extensions) ? Object.keys(envelope.extensions) : [];
  c.check(
    extensionKeys.length === 1 && extensionKeys[0] === 'payment-identifier',
    'PAYMENT_CLIENT_EXTENSIONS',
    'extensions'
  );
  const id = envelope.extensions?.['payment-identifier']?.info?.id;
  c.check(typeof id === 'string' && identifier.test(id), 'IDENTIFIER_INVALID', 'extensions.payment-identifier.info.id');
  const legacy = envelope.payload?.extensions?.['payment-identifier'];
  if (legacy !== undefined) c.check(legacy === id, 'IDENTIFIER_CONFLICT', 'payload.extensions.payment-identifier');
  c.check(nonempty(envelope.payload?.signature), 'SIGNATURE_MISSING', 'payload.signature');
  c.check(nonempty(envelope.payload?.authorization?.nonce), 'NONCE_MISSING', 'payload.authorization.nonce');
  if (object(m.replay)) {
    const replayBody = c.bytes(m.replay.body_file), replayEnvelope = c.bytes(m.replay.envelope_file);
    c.check(body.equals(replayBody), 'REPLAY_BODY_CHANGED', 'replay.body_file');
    c.check(c.bytes(m.envelope_file).equals(replayEnvelope), 'REPLAY_ENVELOPE_CHANGED', 'replay.envelope_file');
    c.check(m.replay.endpoint === expected.endpoint, 'REPLAY_ENDPOINT_CHANGED', 'replay.endpoint');
  } else c.error('REPLAY_REQUIRED', 'replay');
  c.warn('SIGNATURE_AND_SETTLEMENT_NOT_VERIFIED', 'envelope');
  c.doubt('EXPECTED_TERMS_REQUIRE_INDEPENDENT_REVIEW', 'expected');
}

export function evidence(c, m) {
  if (!c.check(m.mode === 'intake', 'MODE_INVALID', 'mode')) return;
  if (!c.check(Array.isArray(m.records) && m.records.length > 0, 'RECORDS_REQUIRED', 'records')) return;
  const ids = new Set(), fingerprints = new Map(), policySplits = new Map();
  m.records.forEach((r, i) => {
    const p = `records[${i}]`;
    if (!c.check(object(r), 'RECORD_INVALID', p)) return;
    recordSchema(c, r, p);
    c.check(nonempty(r.id) && !ids.has(r.id), 'ID_MISSING_OR_DUPLICATE', `${p}.id`); ids.add(r.id);
    c.check(typeof r.synthetic === 'boolean', 'SYNTHETIC_REQUIRED', `${p}.synthetic`);
    c.check(['development', 'holdout', 'catalog'].includes(r.split), 'SPLIT_INVALID', `${p}.split`);
    c.check(date(r.as_of), 'DATE_INVALID', `${p}.as_of`);
    for (const f of ['item_condition', 'reason', 'seller', 'marketplace', 'expected']) c.check(nonempty(r[f]), 'FIELD_REQUIRED', `${p}.${f}`);
    c.check(verdicts.includes(r.expected), 'EXPECTED_INVALID', `${p}.expected`);
    if (!c.check(object(r.source), 'SOURCE_REQUIRED', `${p}.source`)) return;
    c.check(url(r.source.url), 'SOURCE_URL_INVALID', `${p}.source.url`);
    if (r.synthetic === false && url(r.source.url)) c.check(!/(^|\.)(example|test|invalid|localhost)$|(^|\.)example\.(com|org|net)$/.test(new URL(r.source.url).hostname), 'SYNTHETIC_SOURCE_MARKED_REAL', `${p}.synthetic`);
    c.check(date(r.source.captured_at) && r.source.captured_at <= r.as_of, 'CAPTURE_DATE_INVALID', `${p}.source.captured_at`);
    c.check(/^[a-f0-9]{64}$/.test(r.source.sha256 ?? ''), 'HASH_REQUIRED', `${p}.source.sha256`);
    const content = c.bytes(r.source.file, r.source.sha256).toString('utf8');
    const policyKey = sha256(content.replace(/\s+/g, ' ').trim().toLowerCase());
    if (policySplits.has(policyKey) && policySplits.get(policyKey) !== r.split && [policySplits.get(policyKey), r.split].includes('holdout')) c.error('HOLDOUT_LEAKAGE', p);
    policySplits.set(policyKey, r.split);
    c.check(nonempty(r.exact_clause) && content.includes(r.exact_clause), 'CLAUSE_NOT_LITERAL', `${p}.exact_clause`);
    c.report.sources.push({ record: i, url: url(r.source.url) ? r.source.url : null, captured_at: date(r.source.captured_at) ? r.source.captured_at : null, verification: 'LOCAL_SNAPSHOT_ONLY' });
    if (r.synthetic === true) c.warn('SYNTHETIC_RECORD', p);
    else {
      c.warn('SOURCE_NOT_FETCHED', `${p}.source.url`);
      c.doubt('SOURCE_AUTHENTICITY_AND_APPLICABILITY', `${p}.source`);
    }
    const fingerprint = sha256(JSON.stringify([r.source.sha256, r.exact_clause, r.item_condition, r.reason, r.seller, r.marketplace, r.as_of]));
    if (fingerprints.has(fingerprint)) c.error(fingerprints.get(fingerprint) !== r.split ? 'HOLDOUT_LEAKAGE' : 'DUPLICATE_CASE', p);
    fingerprints.set(fingerprint, r.split);
    if (m.profile === 'corpus' && r.split !== 'holdout') {
      const normalize = text => text.replace(/\s+/g, ' ').trim().toLowerCase();
      c.check(!HOLDOUT_CASES.some(h => normalize(content) === normalize(h.page_text) || normalize(r.exact_clause ?? '') === normalize(h.page_text)), 'EXISTING_HOLDOUT_LEAKAGE', p);
    }
    if (!c.check(object(r.claims), 'CLAIMS_REQUIRED', `${p}.claims`)) return;
    c.check(Object.keys(r.claims).length > 0, 'CLAIMS_EMPTY', `${p}.claims`);
    for (const [field, claim] of Object.entries(r.claims)) {
      claimSchema(c, claim, field, `${p}.claims.${field}`);
      if (!object(claim) || !Object.hasOwn(claim, 'value') || !nonempty(claim.quote) || !content.includes(claim.quote)) c.error('CLAIM_UNSUPPORTED', `${p}.claims.${field}`);
      c.doubt('CLAIM_ENTAILMENT_REQUIRES_REVIEW', `${p}.claims.${field}`);
    }
    c.doubt('EXPECTED_VERDICT_REQUIRES_REVIEW', `${p}.expected`);
  });
}

export function corpus(c, m) {
  if (m.mode !== 'repository') return evidence(c, m);
  const seen = new Set(), texts = new Map();
  for (const [split, cases, path] of [['development', EVAL_CASES, 'src/eval-cases.mjs'], ['holdout', HOLDOUT_CASES, 'src/holdout-cases.mjs']]) {
    c.bytes(path);
    c.check(cases.length > 0, 'BANK_EMPTY', path);
    for (const r of cases) {
      const p = `${path}:${r.id}`;
      c.check(nonempty(r.id) && !seen.has(r.id), 'ID_MISSING_OR_DUPLICATE', p); seen.add(r.id);
      c.check(nonempty(r.page_text) && object(r.request) && verdicts.includes(r.expected?.verdict), 'CASE_INVALID', p);
      c.check(nonempty(r.note), 'RATIONALE_REQUIRED', p);
      if (split === 'holdout') c.check(date(r.request?.as_of), 'DATE_INVALID', p);
      else if (!date(r.request?.as_of)) c.warn('LEGACY_AS_OF_MISSING', p);
      const key = sha256((r.page_text ?? '').replace(/\s+/g, ' ').trim().toLowerCase());
      if (texts.has(key)) c.error(texts.get(key) === split ? 'DUPLICATE_POLICY' : 'HOLDOUT_LEAKAGE', p);
      texts.set(key, split);
    }
  }
  c.warn('LEGACY_BANKS_NOT_REAL_SOURCE_CORPUS', 'src/*-cases.mjs');
  c.doubt('LEGACY_PROVENANCE_NOT_VALIDATED', 'src/*-cases.mjs');
}
export function artifact(c, m) {
  c.check(m.mode === 'intake', 'MODE_INVALID', 'mode');
  c.check(nonempty(m.purpose), 'PURPOSE_REQUIRED', 'purpose');
  if (!c.check(Array.isArray(m.files) && m.files.length > 0, 'FILES_REQUIRED', 'files')) return;
  const seen = new Set();
  for (const [i, f] of m.files.entries()) {
    const p = `files[${i}]`;
    if (!c.check(object(f), 'FILE_INVALID', p)) continue;
    c.check(nonempty(f.path) && !seen.has(f.path), 'FILE_MISSING_OR_DUPLICATE', `${p}.path`); seen.add(f.path);
    c.check(typeof f.sha256 === 'string' && /^[a-f0-9]{64}$/.test(f.sha256), 'HASH_REQUIRED', `${p}.sha256`);
    const bytes = c.bytes(f.path, f.sha256);
    c.check(Number.isSafeInteger(f.bytes) && f.bytes > 0 && bytes.length === f.bytes, 'SIZE_MISMATCH', `${p}.bytes`);
    c.check(['json', 'text', 'binary'].includes(f.format), 'FORMAT_INVALID', `${p}.format`);
    if (f.format === 'json') JSON.parse(bytes.toString('utf8'));
  }
  c.warn('INTEGRITY_ONLY_NOT_DOMAIN_VALIDATION', 'files');
  c.doubt('CONTENT_AND_NEW_DOMAIN_RULES_REQUIRE_REVIEW', 'files');
}
export function delivery(c, m) { artifact(c, m); compareDelivery(c, m, c.root); }
export const profiles = { payment, ucp: evidence, corpus, artifact, delivery, metrics };
