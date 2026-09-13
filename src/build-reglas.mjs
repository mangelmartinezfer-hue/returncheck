// ---------------------------------------------------------------------------
// PR-1c — LAS DOS REGLAS DEL SELLO DE DESPLIEGUE, Y NADA MAS.
//
// POR QUE ESTE FICHERO EXISTE APARTE. Lo usan los dos extremos: el generador
// (`tools/build-info.mjs`), que produce el sello, y el lector
// (`src/build-info.mjs`), que lo sirve. El lector importa el sello de forma
// ESTATICA, asi que si las reglas vivieran alli, el generador acabaria
// importando el fichero que el mismo tiene que escribir: en un clon nuevo eso es
// un bloqueo mutuo — el generador no arranca porque falta el sello, y el sello
// falta porque el generador no arranca.
//
// Aqui no se importa nada. A proposito: es la condicion para que este modulo
// pueda cargarse antes de que exista ningun sello.
//
// Y estan JUNTAS y en un solo sitio para que la regla que examinan las pruebas
// sea literalmente la que corre en los dos extremos. Escritas dos veces serian
// dos reglas que se parecen.
// ---------------------------------------------------------------------------

// ¿Estaba limpio el arbol de trabajo? Se le pasa la salida cruda de
// `git status --porcelain`.
//
// `--porcelain` a secas, SIN `-uno`: un fichero sin rastrear cuenta como arbol
// sucio. Puede acabar dentro del artefacto igual que uno modificado, y ademas con
// `-uno` un artefacto al que se le olvidara el .gitignore se volveria invisible
// justo para la comprobacion que existe para atraparlo.
//
// LO QUE ESTO NO PUEDE VER, Y CONVIENE NO OLVIDARLO: los ficheros IGNORADOS. La
// salida de `git status --porcelain` no los incluye —para eso haria falta
// `--ignored`—, asi que un fichero que case con .gitignore puede aparecer,
// cambiar o desaparecer y esta funcion seguira devolviendo `true`. No es un
// descuido de `-uno`: es invisible con `-uno` y sin el. Por eso `tree_clean`
// habla del estado de los ficheros RASTREADOS y no del artefacto desplegado.
//
// `null` cuando no hay salida de git que interpretar. No saber si el arbol estaba
// limpio NO es lo mismo que saber que estaba sucio, y `false` seria afirmar lo
// segundo.
export function arbolLimpio(porcelain) {
  if (typeof porcelain !== "string") return null;
  return porcelain.trim() === "";
}

// La cadena de build: fecha DEL COMMIT + los siete primeros del sha.
//
// La fecha es la del commit y no la de la construccion a proposito: con la de
// hoy, el mismo commit produciria cadenas distintas segun cuando se construyera,
// y `build` dejaria de ser reproducible entre pasadas.
//
// Sin los dos datos no hay cadena que derivar, y entonces se dice que no se sabe.
// Nunca se rellena el hueco con algo plausible.
export function derivarBuild(commit, fecha) {
  if (typeof commit !== "string" || typeof fecha !== "string") return "unknown";
  if (!/^[0-9a-f]{7,}$/.test(commit) || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return "unknown";
  return `${fecha}-${commit.slice(0, 7)}`;
}
