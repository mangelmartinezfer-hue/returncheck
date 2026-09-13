// ---------------------------------------------------------------------------
// 2b.1 — EL INTERMEDIARIO DE RED: UN SOLO SITIO POR DONDE SALE UNA PETICION.
//
// QUE PROBLEMA ATACA. Las pruebas que necesitan un facilitador falso sustituyen
// `globalThis.fetch` por una funcion que contesta a todo lo que le llegue. Eso
// tiene dos agujeros: una URL equivocada —otro dominio, otra ruta, otro metodo—
// recibe la misma respuesta buena que la correcta, asi que un fallo de
// direccionamiento sale VERDE; y lo que no cubra el doble sale de verdad a
// internet sin que nadie se entere. Este modulo cierra los dos: solo contesta a
// lo que este en una lista declarada de antemano, y lo demas lo RECHAZA
// lanzando, sin llegar a intentar salir.
//
// ESTO NO ES UNA BARRERA DE RED PARA TODA LA SUITE. PROTEGE UNICAMENTE LAS
// PRUEBAS QUE INSTALEN EXPRESAMENTE EL INTERMEDIARIO. LOS 31 FICHEROS EXISTENTES
// SIGUEN SIN BARRERA, Y ESO ES DEUDA SEPARADA, NO ALGO QUE ESTE MODULO RESUELVA.
//
// LOS CONTADORES MIDEN LLAMADAS, NUNCA COBROS NI SETTLEMENTS OCURRIDOS. Que
// `contadores.settle` valga 2 significa que se invoco dos veces a `/settle`; no
// significa que se hayan liquidado dos pagos, ni que se haya movido un centimo.
// Quien quiera afirmar algo sobre dinero tendra que mirar otra cosa, y no la
// tiene aqui.
//
// LO QUE ESTE MODULO NO HACE, a proposito:
//   · no delega NUNCA en el `fetch` de debajo. Una peticion permitida la
//     contesta `responder`; una no permitida se rechaza. No hay tercer camino,
//     asi que no existe forma de que una prueba con el intermediario puesto
//     alcance la red de verdad;
//   · no toca D1, ni la cadena, ni firmas. Es transporte y nada mas.
// ---------------------------------------------------------------------------

/** El facilitador de mentira al que apuntan las pruebas. No existe. */
export const FACILITADOR_DE_PRUEBAS = "https://facilitador.example";

/**
 * La lista permitida por defecto: las DOS rutas del facilitador, cada una con su
 * metodo. Se devuelve una copia nueva en cada llamada para que nadie pueda
 * quedarse con la referencia y ampliarla despues.
 */
export function rutasFacilitador(base = FACILITADOR_DE_PRUEBAS) {
  return [
    { metodo: "POST", url: base + "/verify" },
    { metodo: "POST", url: base + "/settle" },
  ];
}

/** El error con el que se rechaza. Tiene nombre propio para poder afirmarlo. */
export class RedNoPermitida extends Error {
  constructor(mensaje) {
    super(mensaje);
    this.name = "RedNoPermitida";
  }
}

// Estado de modulo: como mucho UN intermediario instalado a la vez.
let instalado = null;

/**
 * Descompone lo que se le pasa a `fetch` en las cuatro cosas que se comparan.
 *
 * Admite cadena, URL y Request porque los tres llegan en este proyecto:
 * `facilitador.mjs` llama con cadena + init, y el codigo de captura de paginas
 * tambien. Si algun dia llegara un Request, se lee de el y no se adivina.
 */
function describir(entrada, init) {
  let crudo, metodo;
  if (entrada && typeof entrada === "object" && typeof entrada.url === "string") {
    crudo = entrada.url;                                  // Request
    metodo = (init && init.method) || entrada.method || "GET";
  } else {
    crudo = String(entrada);
    metodo = (init && init.method) || "GET";
  }
  let u;
  try { u = new URL(crudo); }
  catch (_) { return { valida: false, crudo, metodo: String(metodo).toUpperCase() }; }
  return {
    valida: true,
    crudo,
    metodo: String(metodo).toUpperCase(),
    origen: u.origin,
    ruta: u.pathname,
    consulta: u.search,        // "" cuando no hay cadena de consulta
    url: u.origin + u.pathname + u.search,
  };
}

/**
 * Normaliza una entrada de la lista al mismo formato que `describir`, para que
 * la comparacion sea entre iguales y no entre una cadena y un objeto.
 */
function normalizarPermitida(e, i) {
  if (!e || typeof e !== "object" || typeof e.url !== "string")
    throw new Error(`entrada ${i} de la lista permitida: falta \`url\``);
  const u = new URL(e.url);
  return Object.freeze({
    metodo: String(e.metodo || "GET").toUpperCase(),
    origen: u.origin,
    ruta: u.pathname,
    consulta: u.search,
    url: u.origin + u.pathname + u.search,
  });
}

/**
 * Instala el intermediario. Devuelve el objeto que la prueba observa.
 *
 * LANZA SI YA HAY UNO INSTALADO. No se envuelve un intermediario dentro de otro:
 * anidarlos haria que los contadores de uno midieran una parte del trafico y los
 * del otro la otra, y que la restauracion dependiera del orden de salida. Es
 * mejor fallar y que se vea.
 *
 * LA LISTA SE CONGELA AQUI. Se copia, se normaliza y se congela en el momento de
 * instalar. Nada de lo que llegue despues por una peticion —cabeceras, cuerpo,
 * cadena de consulta, lo que sea— puede ampliarla: el manejador solo lee.
 */
export function instalar({ permitidas = rutasFacilitador(), responder = responderVacio } = {}) {
  if (instalado)
    throw new Error("ya hay un intermediario de red instalado: no se anidan envoltorios");

  const lista = Object.freeze(permitidas.map(normalizarPermitida));
  const contadores = { verify: 0, settle: 0, rechazos: 0 };
  const anterior = globalThis.fetch;

  const impl = async (entrada, init) => {
    const p = describir(entrada, init);

    const permitida = p.valida && lista.find((e) =>
      e.metodo === p.metodo && e.origen === p.origen && e.ruta === p.ruta && e.consulta === p.consulta);

    if (!permitida) {
      contadores.rechazos++;
      throw new RedNoPermitida(
        `peticion fuera de la lista permitida: ${p.metodo} ${p.crudo}` +
        (p.valida ? "" : " (no es una URL absoluta)"));
    }

    // Los DOS contadores que la lista por defecto distingue. Un total mezclado no
    // permitiria decir "se verifico dos veces y se liquido una", que es
    // exactamente la clase de cosa que se quiere poder afirmar.
    if (p.ruta.endsWith("/verify")) contadores.verify++;
    else if (p.ruta.endsWith("/settle")) contadores.settle++;

    return await responder(p);
  };

  const intermediario = { contadores, permitidas: lista, anterior, impl };
  instalado = intermediario;
  globalThis.fetch = impl;
  return intermediario;
}

/** Restaura el `fetch` que habia, por IDENTIDAD, y libera el estado de modulo. */
export function desinstalar(intermediario) {
  if (!intermediario || instalado !== intermediario) return false;
  globalThis.fetch = intermediario.anterior;
  instalado = null;
  return true;
}

/**
 * Instala, ejecuta y RESTAURA SIEMPRE, tambien cuando `fn` lanza.
 *
 * `instalar` va FUERA del `try` a proposito: si ya hay uno puesto y esta llamada
 * falla, no se ejecuta este `finally` y el intermediario de fuera se queda
 * intacto. Lo contrario —instalar dentro del try— haria que un segundo `conRed`
 * fallido desinstalara el primero al salir.
 */
export async function conRed(opciones, fn) {
  const intermediario = instalar(opciones || {});
  try {
    return await fn(intermediario);
  } finally {
    desinstalar(intermediario);
  }
}

/** ¿Hay uno puesto? Solo para que las pruebas puedan afirmarlo. */
export function hayIntermediario() { return instalado !== null; }

/**
 * Respuesta por defecto: 200 con cuerpo vacio. A proposito no sabe nada de
 * pagos. Quien necesite una respuesta con contenido la pasa en `responder`; asi
 * este modulo se queda siendo transporte y no adquiere semantica de dinero.
 */
async function responderVacio(_peticion) {
  return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
}
