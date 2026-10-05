import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from './core.mjs';

export const PUBLIC_CAPTURE_URLS = [
  'https://returncheck.m-angelmartinez-fer.workers.dev/.well-known/x402',
  'https://returncheck.m-angelmartinez-fer.workers.dev/openapi.json',
];
export async function capture(url, fetcher = fetch, now = () => new Date().toISOString()) {
  if (!PUBLIC_CAPTURE_URLS.includes(url)) throw new Error('URL_NOT_ALLOWED');
  const r = await fetcher(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15000), headers: { accept: 'application/json' } });
  if (r.status !== 200 || (r.url && r.url !== url)) throw new Error('CAPTURE_NOT_VERIFIED');
  const chunks = []; let total = 0;
  for await (const chunk of r.body) { total += chunk.length; if (total > 2 * 1024 * 1024) throw new Error('CAPTURE_TOO_LARGE'); chunks.push(chunk); }
  const bytes = Buffer.concat(chunks); JSON.parse(bytes.toString('utf8'));
  return { bytes, metadata: { schema_version: 1, url, status: r.status, captured_at: now(), body_sha256: sha256(bytes) } };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4 || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(process.argv[3])) throw new Error('USAGE');
    const result = await capture(process.argv[2]);
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const dir = `_local/captures/${process.argv[3]}`;
    mkdirSync(resolve(root, '_local/captures'), { recursive: true });
    mkdirSync(resolve(root, dir)); // Never overwrite a prior capture.
    const body_file = `${dir}/body.json`;
    writeFileSync(resolve(root, body_file), result.bytes, { flag: 'wx' });
    writeFileSync(resolve(root, dir, 'snapshot.json'), JSON.stringify({ ...result.metadata, body_file }, null, 2) + '\n', { flag: 'wx' });
    console.log(`Captura guardada: ${dir}/snapshot.json. No se han enviado pagos ni solicitudes de inferencia.`);
  } catch { console.error('CAPTURE_UNVERIFIED: URL no permitida, captura existente, red o respuesta inválida. No equivale a una diferencia de producción.'); process.exitCode = 1; }
}
