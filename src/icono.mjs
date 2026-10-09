// Icono del servicio. Existe por una razón concreta: los directorios de x402
// (x402scan, entre otros) leen /favicon.ico de la raíz de la API para mostrar la
// ficha. Sin él, ReturnCheck aparece sin icono entre servicios que sí lo tienen.
//
// Es la misma marca que ya usa la landing (brandMark en landing.mjs): cubo con
// el sello verde de verificación. No se inventa identidad nueva.
//
// Se sirven dos formatos a propósito:
//   /favicon.svg  — vectorial, el que usan los navegadores modernos.
//   /favicon.ico  — PNG de 32x32 incrustado en base64, porque los rastreadores
//                   piden esa ruta literal y no todos aceptan SVG ahí.
// No hay fichero binario en el repositorio ni paso de build: el Worker sirve
// estos bytes tal cual.

export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48" role="img" aria-label="ReturnCheck">
  <rect width="48" height="48" rx="10" fill="#061127"/>
  <g transform="translate(2.4 2.4) scale(0.9)">
    <path d="M9 15.5 24 7l15 8.5v17L24 41 9 32.5z" fill="#e9f2ff" stroke="#79a9ff" stroke-width="2"/>
    <path d="M9 15.5 24 24l15-8.5M24 24v17" fill="none" stroke="#3478f6" stroke-width="2.4" stroke-linejoin="round"/>
    <path d="M13 11.5 24 17l11-5.5" fill="none" stroke="#8bb5ff" stroke-width="2" stroke-linecap="round"/>
    <circle cx="34" cy="33" r="10" fill="#22b36b" stroke="#08152f" stroke-width="2"/>
    <path d="m29.5 33 3 3 6-7" fill="none" stroke="white" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
  </g>
</svg>`;

// PNG 32x32 del mismo dibujo, 1527 bytes.
const FAVICON_PNG_B64 =
  "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";

const FAVICON_PNG = Uint8Array.from(atob(FAVICON_PNG_B64), (c) => c.charCodeAt(0));

const CACHE = "public, max-age=86400";

export function faviconIco() {
  return new Response(FAVICON_PNG, {
    headers: {
      "content-type": "image/png",
      "cache-control": CACHE,
      "access-control-allow-origin": "*",
    },
  });
}

export function faviconSvg() {
  return new Response(FAVICON_SVG, {
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": CACHE,
      "access-control-allow-origin": "*",
    },
  });
}
