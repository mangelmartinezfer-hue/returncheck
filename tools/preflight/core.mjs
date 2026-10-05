import { readFileSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
export const nonempty = v => typeof v === 'string' && v.trim().length > 0;
export const date = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
export function url(v) {
  try { const u = new URL(v); return typeof v === 'string' && ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password; } catch { return false; }
}
export function context(root, profile) {
  const report = { schema_version: 1, validator_version: '1.2.0', profile, status: 'PASS', errors: [], warnings: [], artifacts: [], sources: [], doubtful_fields: [], ai_review: 'PENDING' };
  const issue = (list, code, field) => report[list].push({ code, field });
  const c = {
    root,
    report,
    error: (code, field) => issue('errors', code, field),
    warn: (code, field) => issue('warnings', code, field),
    doubt: (code, field) => issue('doubtful_fields', code, field),
    check(ok, code, field) { if (!ok) c.error(code, field); return !!ok; },
    bytes(path, expected) {
      if (!nonempty(path) || isAbsolute(path)) throw new Error('PATH_INVALID');
      const base = realpathSync(root), target = realpathSync(resolve(base, path));
      const rel = relative(base, target);
      if (rel === '..' || rel.startsWith('..\\') || rel.startsWith('../') || isAbsolute(rel)) throw new Error('PATH_OUTSIDE_ROOT');
      const bytes = readFileSync(target), hash = sha256(bytes);
      report.artifacts.push({ path, bytes: bytes.length, sha256: hash });
      if (expected !== undefined) c.check(/^[a-f0-9]{64}$/.test(expected) && hash === expected, 'HASH_MISMATCH', path);
      return bytes;
    },
    json(path) { return JSON.parse(c.bytes(path).toString('utf8')); },
    finish() { report.status = report.errors.length ? 'FAIL' : 'PASS'; return report; },
  };
  return c;
}

// Strict enough for the repository's public [vars] strings. Unsupported syntax
// fails closed instead of silently selecting an environment or duplicate key.
export function publicVars(text) {
  let active = false; const result = {};
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (s.startsWith('[')) { active = s === '[vars]'; continue; }
    if (!active || !s || s.startsWith('#')) continue;
    const m = s.match(/^([A-Z][A-Z0-9_]*)\s*=\s*("(?:[^"\\]|\\.)*")\s*(?:#.*)?$/);
    if (!m || Object.hasOwn(result, m[1])) throw new Error('VARS_FORMAT');
    result[m[1]] = JSON.parse(m[2]);
  }
  return result;
}
