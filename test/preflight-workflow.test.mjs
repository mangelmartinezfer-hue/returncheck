import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newJob } from '../tools/preflight/new-job.mjs';
import { run, runAll, registeredJobs } from '../tools/preflight/runner.mjs';
import { sha256 } from '../tools/preflight/core.mjs';

function sandbox(t) {
  const root = mkdtempSync(join(tmpdir(), 'returncheck-jobs-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'preflight/jobs'), { recursive: true });
  const write = (p, v) => writeFileSync(join(root, p), typeof v === 'string' ? v : JSON.stringify(v));
  const data = '{"version":1}'; write('input.json', data);
  const m = { schema_version: 1, profile: 'artifact', mode: 'intake', purpose: 'New integration payload', files: [{ path: 'input.json', sha256: sha256(data), bytes: Buffer.byteLength(data), format: 'json' }] };
  return { root, write, m };
}
test('new jobs are discovered recursively, in stable order, without editing config', t => {
  const f = sandbox(t); mkdirSync(join(f.root, 'preflight/jobs/sub'));
  f.write('preflight/jobs/sub/b.json', f.m); f.write('preflight/jobs/a.json', f.m);
  assert.deepEqual(registeredJobs(f.root), ['preflight/jobs/a.json', 'preflight/jobs/sub/b.json']);
  const jobs = runAll(f.root).filter(r => r.profile === 'artifact');
  assert.equal(jobs.length, 2); assert.ok(jobs.every(r => r.status === 'PASS'));
  assert.ok(jobs.every(r => r.warnings.some(w => w.code === 'INTEGRITY_ONLY_NOT_DOMAIN_VALIDATION')));
});
test('corrupt and unknown job manifests fail instead of being silently skipped', t => {
  const f = sandbox(t); f.write('preflight/jobs/broken.json', '{');
  f.write('preflight/jobs/unknown.json', { ...f.m, profile: 'future' });
  const r = runAll(f.root);
  assert.ok(r.some(r => r.errors.some(e => e.code === 'JOB_MANIFEST_INVALID')));
  assert.ok(r.some(r => r.errors.some(e => e.code === 'UNKNOWN_PROFILE')));
});
test('registry rejects misplaced data files', t => {
  const f = sandbox(t); f.write('preflight/jobs/unregistered.txt', 'work');
  assert.ok(runAll(f.root).some(r => r.errors.some(e => e.code === 'JOB_REGISTRY_UNREADABLE')));
});
test('new-job templates fail until completed and never overwrite existing work', t => {
  const f = sandbox(t);
  for (const profile of ['payment', 'ucp', 'corpus', 'artifact']) {
    const path = newJob(f.root, profile, profile + '-new');
    assert.equal(run(f.root, profile, path).status, 'FAIL');
    const before = readFileSync(join(f.root, path), 'utf8');
    assert.throws(() => newJob(f.root, profile, profile + '-new'));
    assert.equal(readFileSync(join(f.root, path), 'utf8'), before);
  }
  assert.throws(() => newJob(f.root, 'unknown', 'name'));
  assert.throws(() => newJob(f.root, 'ucp', '../outside'));
});
for (const [name, mutate, code] of [
  ['hash', m => { m.files[0].sha256 = '0'.repeat(64); }, 'HASH_MISMATCH'],
  ['size', m => { m.files[0].bytes++; }, 'SIZE_MISMATCH'],
  ['format', m => { m.files[0].format = 'unknown'; }, 'FORMAT_INVALID'],
  ['empty files', m => { m.files = []; }, 'FILES_REQUIRED'],
  ['purpose', m => { m.purpose = ''; }, 'PURPOSE_REQUIRED'],
  ['duplicate', m => { m.files.push(m.files[0]); }, 'FILE_MISSING_OR_DUPLICATE'],
]) test(`registered artifact rejects ${name}`, t => {
  const f = sandbox(t); mutate(f.m); f.write('preflight/jobs/job.json', f.m);
  const r = runAll(f.root).find(r => r.profile === 'artifact');
  assert.equal(r.status, 'FAIL'); assert.ok(r.errors.some(e => e.code === code));
});
test('artifact checks JSON syntax even when byte hash is correct', t => {
  const f = sandbox(t), data = '{broken'; f.write('input.json', data);
  Object.assign(f.m.files[0], { sha256: sha256(data), bytes: Buffer.byteLength(data) });
  f.write('preflight/jobs/job.json', f.m);
  assert.equal(run(f.root, 'artifact', 'preflight/jobs/job.json').status, 'FAIL');
});
