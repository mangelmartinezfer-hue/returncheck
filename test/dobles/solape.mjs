// ---------------------------------------------------------------------------
// 2b.1 — SOLAPAMIENTO DETERMINISTA.
//
// QUE PROBLEMA ATACA. Una prueba de concurrencia escrita con esperas por reloj
// —«duermo 50 ms y para entonces las dos ya habran entrado»— no prueba el
// solapamiento: prueba que la maquina iba a la velocidad que el autor supuso.
// En una maquina cargada se cruza sola y sale verde sin haberse solapado nada, y
// en otra falla sin que haya cambiado el codigo. Es la peor clase de prueba:
// contesta que si, y no por el motivo que dice.
//
// AQUI NO DECIDE NINGUN RELOJ. La sincronizacion la hace una BARRERA: cada
// trabajo avisa cuando llega al punto observado y se queda esperando; la barrera
// se abre SOLO cuando han llegado todos. Si uno no llega, nadie sigue — y eso es
// exactamente lo que se quiere: que «se solaparon» sea una consecuencia de la
// forma del codigo y no de una coincidencia de tiempos.
//
// EL PERRO GUARDIAN, Y QUE NO ES. Hay un plazo maximo, y tiene UNA sola funcion:
// abortar una prueba bloqueada para que no cuelgue la suite indefinidamente. SU
// DURACION ES INFRAESTRUCTURA DE PRUEBAS, NO UNA PROPIEDAD DEL SERVICIO NI UNA
// MEDICION DEL SISTEMA. No dice cuanto tarda nada, no es un presupuesto de
// latencia y no se debe citar como si midiera algo. Si salta, LA PRUEBA FALLA
// POR BLOQUEO; nunca la deja pasar.
// ---------------------------------------------------------------------------

/**
 * Una barrera para `n` participantes.
 *
 * `llegar()` anota la llegada y espera. La promesa se abre cuando el ultimo
 * llega, de modo que NINGUNO continua antes que los demas. Sin temporizadores.
 */
export function barrera(n) {
  if (!Number.isInteger(n) || n < 1) throw new Error("la barrera necesita un numero de participantes >= 1");
  let llegados = 0;
  let abrir;
  const abierta = new Promise((resolver) => { abrir = resolver; });
  return {
    get participantes() { return n; },
    get llegados() { return llegados; },
    get abierta() { return llegados >= n; },
    async llegar() {
      llegados++;
      if (llegados >= n) abrir();
      await abierta;
      return llegados;
    },
  };
}

/** El error con el que se aborta un solapamiento bloqueado. Nombre propio. */
export class SolapeBloqueado extends Error {
  constructor(mensaje) {
    super(mensaje);
    this.name = "SolapeBloqueado";
  }
}

// Plazo maximo por defecto. INFRAESTRUCTURA: ver la cabecera. Se elige holgado a
// proposito — no se busca ajustarlo, se busca que no salte nunca salvo bloqueo.
const PLAZO_POR_DEFECTO_MS = 5000;

/**
 * Lanza `n` trabajos a la vez con `Promise.all` y les da una barrera comun.
 *
 * `hacer(i, b)` recibe el indice y la barrera. Lo normal es que llame a
 * `await b.llegar()` en el punto que se quiere solapar.
 *
 * EL INTERMEDIARIO NO SE TOCA AQUI. Esta funcion no instala ni desinstala nada:
 * recibe el escenario ya montado y solo coordina. Es lo que garantiza que los
 * `n` trabajos hablen con EL MISMO objeto y que no se reinstale a mitad.
 *
 * Devuelve el array de resultados de `Promise.all`. Si se agota el plazo, RECHAZA
 * con `SolapeBloqueado`: la prueba falla por bloqueo, que es lo unico que ese
 * plazo puede significar.
 */
export async function solapar(n, hacer, { plazoMs = PLAZO_POR_DEFECTO_MS } = {}) {
  const b = barrera(n);
  const trabajos = Promise.all(
    Array.from({ length: n }, (_, i) => Promise.resolve().then(() => hacer(i, b))));

  let temporizador;
  const perro = new Promise((_, rechazar) => {
    temporizador = setTimeout(() => rechazar(new SolapeBloqueado(
      `el solapamiento de ${n} no termino en ${plazoMs} ms: llegaron ${b.llegados} de ${n} a la barrera. ` +
      "Este plazo es infraestructura de pruebas, no una medicion del sistema.")), plazoMs);
  });

  try {
    return await Promise.race([trabajos, perro]);
  } finally {
    clearTimeout(temporizador);
    // Si gano el perro, `trabajos` sigue vivo y su rechazo quedaria sin
    // manejar; se recoge aqui para que el proceso no muera por otra cosa
    // distinta de la que fallo.
    trabajos.catch(() => {});
  }
}

/** La barrera, por si una prueba quiere coordinar a mano sin `solapar`. */
export { barrera as crearBarrera };
