import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function newJob(root, profile, name) {
  if (!['payment', 'ucp', 'corpus', 'artifact'].includes(profile) || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(name ?? '')) throw new Error('Use: npm run work:new -- payment|ucp|corpus|artifact nombre-con-guiones');
  const m = { schema_version: 1, profile, mode: profile === 'payment' ? 'package' : 'intake' };
  if (profile === 'artifact') Object.assign(m, { purpose: 'Completar el objetivo y los archivos antes de validar.', files: [] });
  else if (profile === 'payment') Object.assign(m, { expected: {}, body_file: '', body_sha256: '', body_bytes: 0, as_of: '', envelope_file: '', replay: {} });
  else m.records = [];
  mkdirSync(resolve(root, 'preflight/jobs'), { recursive: true });
  const path = `preflight/jobs/${name}.json`;
  writeFileSync(resolve(root, path), JSON.stringify(m, null, 2) + '\n', { flag: 'wx' });
  return path;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4) throw new Error('Use: npm run work:new -- payment|ucp|corpus|artifact nombre-con-guiones');
    console.log(`Registrado: ${newJob(fileURLToPath(new URL('../../', import.meta.url)), ...process.argv.slice(2))}. Completar datos; fallará hasta estar listo.`);
  } catch (e) { console.error(e.code === 'EEXIST' ? 'El trabajo ya existe; no se ha sobrescrito.' : 'No se pudo crear. Use: npm run work:new -- payment|ucp|corpus|artifact nombre-con-guiones'); process.exitCode = 1; }
}
