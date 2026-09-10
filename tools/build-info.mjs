#!/usr/bin/env node
// ---------------------------------------------------------------------------
// PR-1c — EL GENERADOR DE LA IDENTIDAD DE DESPLIEGUE.
//
// POR QUE EXISTE. Hasta hoy la version del codigo era una cadena escrita a mano
// en `util.mjs`, y una cadena escrita a mano solo dice la verdad si alguien se
// acuerda de cambiarla. No se acordo: el commit de W57 (9a6d4e7) no la toco, y
// durante seis dias el servicio anuncio un build que no era el suyo. Una prueba
// que obligase a acordarse habria perpetuado el mismo fallo humano con un paso
// mas. Asi que la cadena deja de escribirse y pasa a leerse de git.
//
// QUE ESCRIBE. Datos CRUDOS, no derivados: el commit, su fecha, si el arbol
// estaba limpio y cuando se genero. La cadena `build` se deriva al LEER
// (`derivarBuild` en src/build-info.mjs), para que solo haya un sitio donde se
// decide su forma.
//
// DONDE ESCRIBE. `src/build-info.generated.mjs`, que esta en .gitignore. Es la
// condicion de la que depende todo lo demas: si el artefacto se versionara,
// generarlo ensuciaria el arbol y `tree_clean` se desmentiria a si mismo en el
// mismo acto de medirlo.
//
// NUNCA FALLA. Se ejecuta desde `pretest` y desde `[build]` de wrangler: si
// reventara por no encontrar git, dejaria sin correr las pruebas y sin construir
// el proyecto. Cuando algo no se puede averiguar se escribe `null`, que es la
// verdad, y el lector lo traduce a "desconocido". Nunca se inventa un valor.
// ---------------------------------------------------------------------------
import { execFileSync } from "node:child_process";
import { writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
// La regla de "arbol limpio", en el mismo codigo que examinan las pruebas y que
// corre en el lector. Escribirla dos veces seria tener dos reglas que se parecen.
//
// SE IMPORTA DE `build-reglas.mjs` Y NO DE `build-info.mjs`, Y NO ES UN DETALLE:
// el lector importa el sello de forma estatica, asi que importarlo desde aqui
// haria que el generador dependiera del fichero que el mismo tiene que escribir.
// En un clon nuevo eso es un bloqueo mutuo. `build-reglas.mjs` no importa nada.
import { arbolLimpio } from "../src/build-reglas.mjs";

// El repositorio sobre el que se informa. Por defecto, este. Se puede pasar otro
// como argumento: es lo que permite probar el generador de punta a punta contra
// un repositorio de usar y tirar, sin tocar el de verdad.
const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(process.argv[2] || join(AQUI, ".."));
const DESTINO = join(RAIZ, "src", "build-info.generated.mjs");

function git(...args) {
  try {
    return execFileSync("git", args, {
      cwd: RAIZ,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],   // el stderr de git no es nuestro
    });
  } catch {
    return null;                             // sin git, sin repositorio, o repositorio sin commits
  }
}

const commit = git("rev-parse", "HEAD");
// %cs es la fecha del COMMIT en YYYY-MM-DD. Deliberadamente NO la fecha de hoy:
// con la de hoy, el mismo commit produce cadenas distintas segun cuando se
// construya, y `build` deja de ser reproducible entre pasadas.
const commitDate = git("show", "-s", "--format=%cs", "HEAD");
// `--porcelain` a secas, SIN `-uno`: un fichero sin rastrear cuenta como arbol
// sucio. Puede acabar dentro del artefacto igual que uno modificado, y ademas
// con `-uno` un artefacto al que se le olvidara el .gitignore se volveria
// invisible justo para la comprobacion que existe para atraparlo.
const porcelain = git("status", "--porcelain");

const datos = {
  commit: commit ? commit.trim() : null,
  commit_date: commitDate ? commitDate.trim() : null,
  tree_clean: arbolLimpio(porcelain),
  built_at: new Date().toISOString(),
};

const contenido = `// GENERADO POR tools/build-info.mjs — NO EDITAR, NO VERSIONAR.
// Se reescribe en cada \`npm test\`, \`wrangler dev\` y \`wrangler deploy\`.
export default ${JSON.stringify(datos, null, 2)};
`;

mkdirSync(dirname(DESTINO), { recursive: true });
// Se escribe y se renombra, no se escribe encima: las pruebas corren en paralelo
// y un lector no puede encontrarse este fichero a medio escribir.
const temporal = DESTINO + ".tmp";
writeFileSync(temporal, contenido, "utf-8");
renameSync(temporal, DESTINO);

if (process.env.RC_BUILD_INFO_SILENCIO !== "1") {
  const q = (v) => (v === null ? "desconocido" : v);
  console.log(`build-info: commit ${q(datos.commit)} · fecha ${q(datos.commit_date)} · arbol_limpio ${q(datos.tree_clean)}`);
}
