// ---------------------------------------------------------------------------
// ¿ERROR AL CARGAR ESTE FICHERO, "Cannot find module build-info.generated.mjs"?
//
//      EJECUTA:  npm run build-info
//
// No falta código: falta el sello de esta construcción, que no se versiona.
// Se genera solo en `npm install`, `npm test`, `wrangler dev` y `wrangler
// deploy`; solo llegas aquí si has invocado node a pelo antes de instalar nada,
// o si lo has borrado a mano. La orden de arriba lo arregla en un segundo.
// ---------------------------------------------------------------------------
//
// PR-1c — IDENTIDAD DE DESPLIEGUE. EL LECTOR.
//
// QUE PREGUNTA CONTESTA. "El servicio que me acaba de responder, ¿que codigo
// exacto era?". Hasta hoy la respuesta era una cadena escrita a mano que podia
// llevar dias sin actualizarse, y de hecho los llevaba: el commit de W57
// (9a6d4e7) no la toco, y durante seis dias este servicio anuncio un build que
// no era el suyo. Sin forma de saberlo desde fuera.
//
// LOS CINCO CAMPOS, Y DE DONDE SALE CADA UNO:
//   version_id  — del binding CF_VERSION_METADATA, en tiempo de EJECUCION. Es lo
//                 unico que Cloudflare sabe y nosotros no: que version concreta
//                 esta atendiendo. No hay construccion de por medio, luego no hay
//                 circularidad posible.
//   commit      — de `git rev-parse HEAD`, en tiempo de generacion.
//   tree_clean  — de `git status --porcelain`, en tiempo de generacion.
//   built_at    — el instante de la generacion.
//   build       — DERIVADO de los dos primeros. Deja de escribirse a mano.
//
// LA FORMA ESTA CONGELADA. Estos cinco campos, con estos nombres y en este
// orden. Si algun dia entra `bundle_sha256` (PR-3), se anade; los cinco no
// cambian ni desaparecen. Un manifiesto que cambia de forma no se puede citar, y
// que se pueda citar es justo para lo que existe.
//
// POR QUE EL IMPORT ES ESTATICO, y no un `import()` dentro de un `try`.
// Un import dinamico obliga a un `await` de nivel superior, y eso mete en el
// arranque del worker una construccion que nadie ha podido ver correr: el
// binding [browser] impide `wrangler dev --local` en este proyecto, asi que solo
// se puede comprobar que EMPAQUETA, no que ARRANQUE. La ausencia del sello se
// resuelve donde de verdad se resuelve —generandolo siempre, en los cuatro
// caminos— y asi no queda nada que pueda no arrancar.
//
// EL PRECIO, ASUMIDO: sin sello esto no carga, en vez de degradar a
// "desconocido". Es lo correcto. Fallar ruidosamente al construir es mejor que
// servir un manifiesto que dice `"build": "unknown"` como si fuera un estado
// normal — que es justo la clase de mentira comoda que PR-1c viene a eliminar.
// Por eso el aviso de arriba del todo: es lo primero que se lee al abrir el
// fichero que el error de Node senala.
// ---------------------------------------------------------------------------
import SELLO from "./build-info.generated.mjs";
import { arbolLimpio, derivarBuild } from "./build-reglas.mjs";

// Se reexportan para que quien lea el sello tenga tambien las reglas con las que
// se escribio, sin tener que saber que viven en otro fichero.
export { arbolLimpio, derivarBuild };

export const BUILD_INFO = SELLO;

export const BUILD = derivarBuild(SELLO.commit, SELLO.commit_date);

// El bloque que sirven `/` y `/discovery.json`.
//
// LOS CAMPOS SE COMPRUEBAN UNO A UNO, y no es paranoia: cuando el generador
// corre donde no hay git —un tarball, un repositorio sin commits— el sello
// EXISTE pero sus campos son `null`. Es un camino real, y en el hay que decir
// "no lo se" campo a campo.
//
// DESCONOCIDO ES `null`, NO `false`. `tree_clean: false` es una afirmacion —"el
// arbol estaba sucio"— y sin datos no la podemos hacer. La unica excepcion es
// `build`, que sale `"unknown"` porque es una cadena que ya viaja a la columna
// `build` de answer_log y a tres rutas mas; cambiarle el tipo romperia sitios
// ajenos a esto.
//
// `sello` se puede pasar para probar esos casos sin tener que quedarse sin git.
export function deploymentInfo(env, sello = SELLO) {
  // El binding expone `id`, `tag` y `timestamp`. El ejemplo de la documentacion
  // de Cloudflare los desestructura a `versionId`/`versionTag`, y de ahi sale la
  // confusion: escribir `.versionId` aqui daria `undefined` en silencio para
  // siempre. Se lee `.id`, y hay una prueba que fija ese nombre.
  const meta = env && env.CF_VERSION_METADATA;
  return {
    version_id: meta && typeof meta.id === "string" ? meta.id : null,
    commit: sello && typeof sello.commit === "string" ? sello.commit : null,
    tree_clean: sello && typeof sello.tree_clean === "boolean" ? sello.tree_clean : null,
    built_at: sello && typeof sello.built_at === "string" ? sello.built_at : null,
    build: derivarBuild(sello && sello.commit, sello && sello.commit_date),
  };
}
