// PR-1c — IDENTIDAD DE DESPLIEGUE: QUE EL SERVICIO NO PUEDA MENTIR SOBRE SI MISMO.
//
// EL AGUJERO QUE ESTO CIERRA. La version del codigo era una cadena literal en
// `util.mjs`. Una cadena literal solo dice la verdad si alguien se acuerda de
// cambiarla, y no se acordo: el commit de W57 (9a6d4e7) no la toco, asi que
// durante seis dias `/discovery.json` anuncio un build que no era el suyo. Y no
// habia forma de saberlo desde fuera.
//
// LO QUE VIGILAN ESTAS PRUEBAS, en este orden:
//   1. que las dos rutas publicas sirvan los CINCO campos, con esta forma exacta;
//   2. que `commit` y `tree_clean` salgan de git de verdad, no de una constante;
//   3. que el generador NO ensucie el arbol, que es de lo que depende que
//      `tree_clean` no se desmienta a si mismo;
//   4. que cuando no hay git —un tarball, un repositorio sin commits— los campos
//      salgan como DESCONOCIDOS, nunca como falsos ni como algo plausible;
//   5. que el sello se genere SIEMPRE. El lector lo importa de forma estatica, a
//      cambio de que no quede ningun `await` de nivel superior que pueda no
//      arrancar en workerd; el precio es que sin sello no carga, y quien lo evita
//      son los cuatro ganchos que esta prueba vigila.
//
// LO QUE ESTAS PRUEBAS NO HACEN, A PROPOSITO: fijar el VALOR de `build`. Fijarlo
// obligaria a editarlo a mano en cada commit, que es exactamente el fallo humano
// que PR-1c viene a eliminar. Se comprueba su FORMA.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, appendFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import worker from "../src/index.mjs";
import { BUILD } from "../src/util.mjs";
import { deploymentInfo, BUILD_INFO } from "../src/build-info.mjs";
import * as lector from "../src/build-info.mjs";
// Las reglas se importan de SU casa, no del lector: el lector las reexporta por
// comodidad, pero viven aparte para que el generador pueda usarlas sin arrastrar
// el sello que el mismo tiene que escribir.
import { derivarBuild, arbolLimpio } from "../src/build-reglas.mjs";

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GENERADOR = join(RAIZ, "tools", "build-info.mjs");

const ENV = { PUBLIC_BASE_URL: "https://rc.example" };
const get = (path, env = ENV, headers = {}) =>
  worker.fetch(new Request("https://rc.example" + path, { headers }), env);

// Los cinco, con estos nombres y en este orden. Esta lista ES el contrato.
const CINCO = ["version_id", "commit", "tree_clean", "built_at", "build"];

// `build` se comprueba por FORMA, nunca por valor: fecha del commit + 7 del sha,
// o el "unknown" honesto de quien no ha generado el sello.
const RE_BUILD = /^(\d{4}-\d{2}-\d{2}-[0-9a-f]{7}|unknown)$/;

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
}
function hayGit() {
  try { git(["--version"], RAIZ); return true; } catch { return false; }
}
function generar(cwd) {
  execFileSync(process.execPath, [GENERADOR, cwd], {
    cwd: RAIZ, encoding: "utf-8", env: { ...process.env, RC_BUILD_INFO_SILENCIO: "1" },
  });
}
// Cada lectura con una consulta distinta: Node cachea los modulos por URL
// completa, y aqui el mismo fichero cambia entre lecturas a proposito.
let n = 0;
const leerSello = async (dir) =>
  (await import(pathToFileURL(join(dir, "src", "build-info.generated.mjs")).href + `?v=${++n}`)).default;

// ---------------------------------------------------------------------------
// 1. Las dos rutas publicas, y la forma congelada
// ---------------------------------------------------------------------------

test("PR-1c: /discovery.json sirve deployment con los cinco campos exactos", async () => {
  const j = await (await get("/discovery.json")).json();
  assert.ok(j.deployment, "el bloque existe");
  assert.deepEqual(Object.keys(j.deployment), CINCO,
    "cinco campos, estos nombres, este orden: un manifiesto que cambia de forma no se puede citar");
});

test("PR-1c: / por negociacion de contenido sirve el MISMO bloque", async () => {
  const raiz = await (await get("/", ENV, { accept: "application/json" })).json();
  const desc = await (await get("/discovery.json")).json();
  assert.deepEqual(Object.keys(raiz.deployment), CINCO);
  assert.deepEqual(raiz.deployment, desc.deployment, "las dos rutas cuentan lo mismo o no sirve de nada");
});

test("PR-1c: / sin accept JSON sigue sirviendo la portada", async () => {
  const r = await get("/");
  assert.match(r.headers.get("content-type") || "", /text\/html/, "no se ha roto la pagina de nadie");
});

test("PR-1c: `build` se comprueba por forma, NUNCA por valor", async () => {
  const j = await (await get("/discovery.json")).json();
  assert.match(j.deployment.build, RE_BUILD);
  assert.equal(j.build, j.deployment.build, "el campo de siempre y el nuevo son el mismo dato");
  assert.equal(BUILD, j.deployment.build, "y `BUILD` de util.mjs tambien: una sola fuente, no tres");
});

// ---------------------------------------------------------------------------
// 2. Que salga de git de verdad
// ---------------------------------------------------------------------------

test("PR-1c: `commit` coincide con git rev-parse HEAD", (t) => {
  if (!hayGit()) return t.skip("sin git en esta maquina: se salta, no se da por buena");
  assert.equal(BUILD_INFO && BUILD_INFO.commit, git(["rev-parse", "HEAD"], RAIZ).trim());
});

test("PR-1c: el arbol limpio es el arbol limpio, y no saberlo no es decir que no", () => {
  assert.equal(arbolLimpio(""), true);
  assert.equal(arbolLimpio(" M src/util.mjs\n"), false, "un fichero RASTREADO modificado ensucia");
  assert.equal(arbolLimpio("?? suelto.md\n"), false, "y uno SIN RASTREAR tambien: puede acabar dentro del artefacto");
  assert.equal(arbolLimpio(null), null, "sin salida de git no se sabe, y no saber no es `false`");
});

test("PR-1c: la cadena de build se deriva, y se niega a inventarsela", () => {
  assert.equal(derivarBuild("ade438f43020a8095646e1cb25bfec5de17770d3", "2026-09-09"), "2026-09-09-ade438f");
  assert.equal(derivarBuild(null, "2026-09-09"), "unknown");
  assert.equal(derivarBuild("ade438f4302", null), "unknown");
  assert.equal(derivarBuild("no-es-un-sha", "2026-09-09"), "unknown");
  assert.equal(derivarBuild("ade438f4302", "ayer"), "unknown");
});

// ---------------------------------------------------------------------------
// 3. version_id: de donde sale, y el nombre de campo que casi se cuela
// ---------------------------------------------------------------------------

test("PR-1c: version_id sale de CF_VERSION_METADATA.id", () => {
  const d = deploymentInfo({ CF_VERSION_METADATA: { id: "abc-123", tag: "v7", timestamp: "2026-09-10T00:00:00Z" } });
  assert.equal(d.version_id, "abc-123");
});

test("PR-1c: se lee `.id`, NO `.versionId`", () => {
  // El ejemplo de la documentacion de Cloudflare desestructura `{ id: versionId }`.
  // Copiar el nombre de la variable en vez del del campo daria `undefined` para
  // siempre y en silencio. Esta prueba fija el campo bueno.
  const d = deploymentInfo({ CF_VERSION_METADATA: { versionId: "no-es-este" } });
  assert.equal(d.version_id, null, "un binding que no trae `.id` es un binding del que no sabemos nada");
});

test("PR-1c: sin binding, version_id es null (y asi sera hasta el proximo despliegue)", () => {
  assert.equal(deploymentInfo({}).version_id, null);
  assert.equal(deploymentInfo(undefined).version_id, null);
});

// ---------------------------------------------------------------------------
// 4. Sin git: el sello existe, pero no sabe nada. Y hay que decirlo.
// ---------------------------------------------------------------------------

test("PR-1c: con el sello a nulos, los cinco campos salen DESCONOCIDOS y ninguno es falso", () => {
  // Este es el caso REAL de un tarball o de un repositorio sin commits: el
  // generador escribe el sello igualmente, con los campos a `null`.
  const d = deploymentInfo({}, { commit: null, commit_date: null, tree_clean: null, built_at: null });
  assert.deepEqual(Object.keys(d), CINCO, "la forma no se encoge por no saber");
  assert.equal(d.version_id, null);
  assert.equal(d.commit, null);
  assert.equal(d.built_at, null);
  assert.equal(d.build, "unknown");
  assert.equal(d.tree_clean, null);
  assert.notEqual(d.tree_clean, false, "`false` afirma que el arbol estaba sucio, y eso no se sabe");
});

test("PR-1c: sin git, el generador escribe el sello con nulos en vez de inventarselos", async (t) => {
  if (!hayGit()) return t.skip("sin git en esta maquina: se salta, no se da por buena");
  const dir = mkdtempSync(join(tmpdir(), "rc-sin-git-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Un directorio que NO es un repositorio. Si el temporal del sistema colgara de
  // uno, git lo encontraria subiendo y esto no probaria nada: se comprueba.
  try {
    git(["rev-parse", "--show-toplevel"], dir);
    return t.skip("el directorio temporal cuelga de un repositorio: no se puede probar aqui");
  } catch { /* bien: no hay repositorio, que es lo que hace falta */ }

  generar(dir);
  const sello = await leerSello(dir);
  assert.equal(sello.commit, null, "no hay commit que leer, y se dice");
  assert.equal(sello.commit_date, null);
  assert.equal(sello.tree_clean, null, "y no saber si el arbol estaba limpio no es decir que no lo estaba");
  assert.match(sello.built_at, /^\d{4}-\d{2}-\d{2}T/, "lo unico que si se sabe es cuando se genero");
  assert.equal(derivarBuild(sello.commit, sello.commit_date), "unknown");
});

// ---------------------------------------------------------------------------
// 5. El sello se genera SIEMPRE, que es de lo que depende todo lo anterior
// ---------------------------------------------------------------------------

test("PR-1c: los cuatro caminos que cargan el modulo generan el sello antes", () => {
  // El lector importa el sello de forma ESTATICA: sin `await` de nivel superior
  // no queda nada que pueda no arrancar en workerd, pero a cambio la ausencia del
  // sello deja de degradar y pasa a fallar. Que no falte es responsabilidad de
  // estos cuatro ganchos, y por eso se vigilan aqui: si alguien quita uno, el
  // fallo aparece en esta prueba y no en la maquina de un tercero.
  const pkg = JSON.parse(readFileSync(join(RAIZ, "package.json"), "utf-8"));
  for (const gancho of ["postinstall", "pretest", "predeploy"])
    assert.match(pkg.scripts[gancho] || "", /tools\/build-info\.mjs/,
      `\`${gancho}\` tiene que generar el sello`);

  const toml = readFileSync(join(RAIZ, "wrangler.toml"), "utf-8");
  assert.match(toml, /\[build\][\s\S]*?command\s*=\s*"node tools\/build-info\.mjs"/,
    "el [build] de wrangler cubre `dev` y `deploy` aunque alguien se salte npm");
});

test("PR-1c: las reglas viven aparte, y el lector reexporta LAS MISMAS", () => {
  // Si algun dia alguien las duplica en el lector, esto lo caza: el generador
  // importa las de `build-reglas.mjs` y no puede importar las del lector sin
  // crear un bloqueo mutuo en un clon nuevo.
  assert.equal(lector.arbolLimpio, arbolLimpio, "la misma funcion, no una copia que se le parece");
  assert.equal(lector.derivarBuild, derivarBuild);
  const generador = readFileSync(join(RAIZ, "tools", "build-info.mjs"), "utf-8");
  assert.match(generador, /from "\.\.\/src\/build-reglas\.mjs"/,
    "el generador NO puede importar del lector: dependeria del fichero que el mismo escribe");
});

// ---------------------------------------------------------------------------
// 6. El generador, de punta a punta, contra un repositorio de usar y tirar
// ---------------------------------------------------------------------------

test("PR-1c: el generador lee git de verdad, y ve un fichero rastreado modificado", async (t) => {
  if (!hayGit()) return t.skip("sin git en esta maquina: se salta, no se da por buena");

  const dir = mkdtempSync(join(tmpdir(), "rc-repo-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  git(["init", "-q"], dir);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "cosa.mjs"), "export const x = 1;\n");
  // El mismo .gitignore que el repositorio de verdad: sin el, el propio sello
  // ensuciaria el arbol y no se estaria midiendo lo que se cree.
  writeFileSync(join(dir, ".gitignore"), "src/build-info.generated.mjs\n");
  git(["add", "."], dir);
  git(["-c", "user.email=p@ejemplo", "-c", "user.name=Pruebas", "-c", "commit.gpgsign=false",
       "commit", "-q", "-m", "inicial"], dir);

  // (a) Arbol limpio.
  generar(dir);
  const limpio = await leerSello(dir);
  assert.equal(limpio.commit, git(["rev-parse", "HEAD"], dir).trim(), "el commit es el de ESE repositorio");
  assert.equal(limpio.commit_date, git(["show", "-s", "--format=%cs", "HEAD"], dir).trim(),
    "la fecha es la DEL COMMIT, no la de hoy: si no, el mismo commit daria cadenas distintas");
  assert.equal(limpio.tree_clean, true);

  // (b) Y el generador no ha ensuciado nada al escribir.
  assert.equal(git(["status", "--porcelain"], dir), "",
    "generar el sello deja el arbol como estaba, o `tree_clean` se desmiente a si mismo");

  // (c) Un fichero RASTREADO modificado.
  appendFileSync(join(dir, "src", "cosa.mjs"), "export const y = 2;\n");
  generar(dir);
  const sucio = await leerSello(dir);
  assert.equal(sucio.tree_clean, false, "el arbol esta sucio y el sello lo dice");
  assert.equal(sucio.commit, limpio.commit, "el commit no ha cambiado: son cosas distintas");
});

test("PR-1c: el generador no ensucia el arbol de ESTE repositorio", () => {
  if (!hayGit()) return;
  // No se exige que el arbol este limpio —lo normal es estar trabajando en el—,
  // se exige que generar no lo CAMBIE. Si alguien borra la linea del .gitignore,
  // aparece `src/build-info.generated.mjs` y esta prueba se pone roja.
  const antes = git(["status", "--porcelain"], RAIZ);
  generar(RAIZ);
  const despues = git(["status", "--porcelain"], RAIZ);
  assert.equal(despues, antes, "el sello no puede aparecer en el status: esta ignorado a proposito");
});
