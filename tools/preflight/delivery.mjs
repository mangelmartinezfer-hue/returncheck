import { readdirSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { object, nonempty, url } from './core.mjs';
import { keys } from './schema.mjs';

export function pointer(value, path) {
  if (path === '') return value;
  if (!/^\/(?:[^~]|~[01])*$/.test(path)) throw new Error('JSON_POINTER_INVALID');
  for (const key of path.slice(1).split('/').map(s => s.replace(/~1/g, '/').replace(/~0/g, '~'))) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) throw new Error('JSON_POINTER_MISSING');
    value = value[key];
  }
  return value;
}
export function inventory(root, dir) {
  if (!nonempty(dir) || isAbsolute(dir)) throw new Error('DIRECTORY_INVALID');
  const base = realpathSync(root), full = realpathSync(resolve(base, dir)), rel = relative(base, full);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('DIRECTORY_OUTSIDE_ROOT');
  const files = [];
  function visit(at) {
    for (const e of readdirSync(at, { withFileTypes: true })) {
      if (e.isSymbolicLink()) throw new Error('PACKAGE_SYMLINK');
      const p = resolve(at, e.name);
      if (e.isDirectory()) visit(p); else files.push(relative(base, p).replace(/\\/g, '/'));
    }
  }
  visit(full); return files.sort();
}
export function compareDelivery(c, m, root) {
  const actual = inventory(root, m.package_dir), declared = m.files.map(f => f.path).sort();
  c.check(JSON.stringify(actual) === JSON.stringify(declared), 'PACKAGE_INVENTORY_MISMATCH', 'files');
  c.check(typeof m.snapshot_sha256 === 'string' && /^[a-f0-9]{64}$/.test(m.snapshot_sha256), 'HASH_REQUIRED', 'snapshot_sha256');
  const snapshot = JSON.parse(c.bytes(m.snapshot_file, m.snapshot_sha256).toString('utf8'));
  if (!keys(c, snapshot, ['schema_version', 'url', 'status', 'captured_at', 'body_file', 'body_sha256'], 'snapshot')) return;
  c.check(snapshot.schema_version === 1 && snapshot.status === 200, 'SNAPSHOT_INVALID', 'snapshot');
  const stamp = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s;
  const age = Date.parse(m.as_of) - Date.parse(snapshot.captured_at);
  c.check(stamp(m.as_of) && stamp(snapshot.captured_at) && Number.isInteger(m.max_age_hours) && m.max_age_hours > 0 && m.max_age_hours <= 168 && age >= 0 && age <= m.max_age_hours * 3600000, 'SNAPSHOT_STALE_OR_DATE_INVALID', 'snapshot.captured_at');
  if (!keys(c, m.expected, ['url', 'fields'], 'expected')) return;
  c.check(url(snapshot.url) && snapshot.url === m.expected.url && /^https:\/\//.test(snapshot.url), 'SNAPSHOT_URL_MISMATCH', 'snapshot.url');
  c.check(/^[a-f0-9]{64}$/.test(snapshot.body_sha256 ?? ''), 'HASH_REQUIRED', 'snapshot.body_sha256');
  const body = JSON.parse(c.bytes(snapshot.body_file, snapshot.body_sha256).toString('utf8'));
  if (!c.check(object(m.expected.fields) && Object.keys(m.expected.fields).length > 0, 'EXPECTED_FIELDS_REQUIRED', 'expected.fields')) return;
  for (const [path, value] of Object.entries(m.expected.fields)) {
    c.check(value === null || ['string', 'number', 'boolean'].includes(typeof value), 'EXPECTED_SCALAR_REQUIRED', path);
    try { c.check(Object.is(pointer(body, path), value), 'LIVE_VALUE_MISMATCH', path); } catch { c.error('LIVE_FIELD_MISSING', path); }
  }
  c.report.sources.push({ url: url(snapshot.url) ? snapshot.url : null, captured_at: stamp(snapshot.captured_at) ? snapshot.captured_at : null, verification: 'CAPTURED_SNAPSHOT_ONLY' });
  c.doubt('SNAPSHOT_AUTHENTICITY_AND_EXPECTATIONS_REQUIRE_REVIEW', 'snapshot');
  c.warn('FRESHNESS_RELATIVE_TO_DECLARED_AS_OF', 'as_of');
}
