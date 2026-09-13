// 2b.1 — EL INSTRUMENTAL, PROBADO ANTES DE APOYAR NADA EN EL.
//
// POR QUE ESTE FICHERO EXISTE. Lo que se prueba aqui no es el servicio: es la
// herramienta con la que se van a escribir las pruebas de 2b.2. Una herramienta
// de pruebas que se da por buena sin probar es la forma mas cara de tener
// pruebas verdes: todo lo que se construya encima hereda su fallo, y el fallo se
// descubre cuando ya se ha decidido algo a partir de un verde.
//
// LAS ONCE PRUEBAS DE ESTE FICHERO, Y QUE FIJA CADA UNA:
//   I-1      una URL desconocida se RECHAZA y sube el contador de rechazos
//   I-2      y no baja al `fetch` de debajo: el centinela cuenta cero
//   I-3      no basta la ruta — dominio, metodo y cadena de consulta tambien
//   I-3 bis  la lista se congela al instalar y nada de fuera la amplia
//   I-4      los contadores de /verify y /settle van SEPARADOS
//   I-5      tras exito, `globalThis.fetch` vuelve a ser el MISMO objeto
//   I-6      tras excepcion, tambien
//   I-7      instalar un segundo intermediario lanza
//   I-8      dos peticiones se solapan de verdad, atendidas por el mismo objeto
//   I-8 bis  el perro guardian aborta un bloqueo, y hace FALLAR
//   I-C      el centinela SI detectaria una delegacion — el control de que las
//            diez anteriores no se apoyan en un vigilante que no vigila
//
// EL CENTINELA VA DEBAJO DE TODAS, NO SOLO DE UNA. Antes lo instalaba solo I-2, y
// eso dejaba un hueco: en las demas, debajo del intermediario quedaba el `fetch`
// REAL. Si una regresion hiciera que `red.mjs` delegase hacia abajo en vez de
// rechazar, esas pruebas intentarian salir a internet ANTES de fallar — y la
// prueba que existe para detectar la delegacion seria la unica protegida de
// ella. Ahora, antes de cada prueba, se pone un centinela completamente local
// que cuenta y lanza; despues de cada prueba se comprueba que el intermediario
// lo restauro por identidad y que recibio CERO llamadas. Ver `beforeEach` y
// `afterEach` mas abajo.
//
// NINGUNA PETICION DE ESTE FICHERO SALE A LA RED, tampoco en los controles
// negativos: las URL "desconocidas" se rechazan DENTRO del intermediario, que
// nunca delega hacia abajo, y debajo no hay red sino un centinela que lanza. No
// se prueba "sin intermediario" contra ninguna URL que pudiera salir a internet.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  conRed, instalar, desinstalar, hayIntermediario,
  rutasFacilitador, FACILITADOR_DE_PRUEBAS, RedNoPermitida,
} from "./dobles/red.mjs";
import { solapar, barrera, SolapeBloqueado } from "./dobles/solape.mjs";

const VERIFY = FACILITADOR_DE_PRUEBAS + "/verify";
const SETTLE = FACILITADOR_DE_PRUEBAS + "/settle";
const POST = { method: "POST" };

// Respuesta de facilitador de mentira. Forma minima; este fichero no prueba
// pagos, prueba transporte.
const responderOk = async (p) => ({
  ok: true, status: 200,
  json: async () => (p.ruta.endsWith("/verify") ? { isValid: true } : { success: true }),
});

// ---------------------------------------------------------------------------
// EL CENTINELA DE RED, DEBAJO DE TODO.
//
// QUE ES: una funcion que ocupa el sitio de `globalThis.fetch` por debajo del
// intermediario. No sale a ninguna parte, no delega en nada y no conoce ninguna
// URL: cuenta la llamada, la anota y LANZA. Si termina con cero llamadas, es que
// nada de lo que hizo la prueba llego a ese escalon.
//
// QUE NO ES: no es una barrera para la suite. Solo cubre este fichero, y solo
// porque `beforeEach` lo pone antes de cada prueba de aqui.
// ---------------------------------------------------------------------------
function crearCentinela() {
  const c = { llamadas: 0, vistas: [] };
  c.impl = async (entrada, init) => {
    c.llamadas++;
    c.vistas.push(String(entrada && entrada.url ? entrada.url : entrada));
    // Lanza SIEMPRE y de inmediato. No hay rama que salga a la red, ni delegacion
    // a un `fetch` anterior: si esto se ejecuta, la prueba ya ha fallado.
    throw new Error(
      "EL CENTINELA DE RED NO DEBE LLAMARSE — algo delego hacia abajo en vez de " +
      "rechazar: " + String((init && init.method) || "GET") + " " + c.vistas[c.vistas.length - 1]);
  };
  return c;
}

// El `fetch` real del proceso, capturado UNA vez al cargar el modulo. Es lo que
// se restituye siempre al terminar cada prueba.
const FETCH_REAL = globalThis.fetch;
let centinelaActual = null;

beforeEach(() => {
  centinelaActual = crearCentinela();
  globalThis.fetch = centinelaActual.impl;
});

afterEach(() => {
  const c = centinelaActual;
  centinelaActual = null;
  try {
    // Las dos comprobaciones de hermeticidad, para TODAS las pruebas del fichero
    // y no solo para la que se acordo de hacerlas.
    assert.ok(Object.is(globalThis.fetch, c.impl),
      "al terminar, el fetch tiene que ser EXACTAMENTE el centinela que se instalo: " +
      "si no lo es, algun intermediario no restauro lo que habia");
    assert.equal(c.llamadas, 0,
      "el centinela recibio " + c.llamadas + " llamada(s) — algo delego hacia abajo: " +
      JSON.stringify(c.vistas));
  } finally {
    // SIEMPRE, tambien si una de las dos aserciones de arriba falla: dejar el
    // centinela puesto contaminaria el resto del fichero.
    globalThis.fetch = FETCH_REAL;
  }
});

// ---------------------------------------------------------------------------
// I-1
// ---------------------------------------------------------------------------

test("I-1: con el intermediario puesto, una URL desconocida se rechaza y se cuenta", async () => {
  await conRed({ responder: responderOk }, async (red) => {
    assert.equal(red.contadores.rechazos, 0, "de partida, cero");

    await assert.rejects(
      () => fetch("https://desconocido.example/lo-que-sea", POST),
      (e) => {
        assert.ok(e instanceof RedNoPermitida, "rechaza con su propio error, no con uno cualquiera");
        assert.match(e.message, /fuera de la lista permitida/);
        assert.match(e.message, /desconocido\.example/, "y dice CUAL fue");
        return true;
      });

    assert.equal(red.contadores.rechazos, 1, "el rechazo se contabiliza");
    assert.equal(red.contadores.verify, 0, "y no se cuela por ningun otro contador");
    assert.equal(red.contadores.settle, 0);
  });
});

// ---------------------------------------------------------------------------
// I-2 — el centinela, que es lo que convierte "se rechazo" en "no salio"
// ---------------------------------------------------------------------------

test("I-2: el intermediario NO delega hacia abajo — el centinela cuenta cero", async () => {
  // El centinela ya esta puesto por `beforeEach`, justo debajo de donde se va a
  // instalar el intermediario. Es completamente local: no sale a ninguna parte y,
  // si lo llamaran, lanzaria. Que termine en cero es la prueba de que el
  // intermediario contesta o rechaza, pero jamas pasa la peticion al escalon
  // siguiente.
  //
  // ASI SE EVITA EL CONTROL NEGATIVO PELIGROSO: no hace falta probar "sin
  // intermediario" contra una URL que podria salir a internet. El centinela
  // ocupa ese hueco sin tocar la red.
  //
  // UN SOLO MECANISMO. Antes esta prueba montaba su propio centinela; ahora usa
  // el comun, que es el mismo que protege a las otras diez. Las comprobaciones
  // no se reducen: las dos que hacia —cero llamadas y restauracion por
  // identidad— se siguen afirmando AQUI, ademas de en `afterEach`.
  const centinela = centinelaActual;
  const implCentinela = globalThis.fetch;
  assert.ok(Object.is(implCentinela, centinela.impl), "de partida, debajo esta el centinela");

  await conRed({ responder: responderOk }, async (red) => {
    // (a) una desconocida: se rechaza arriba
    await assert.rejects(() => fetch("https://desconocido.example/x", POST), RedNoPermitida);
    // (b) una permitida: la contesta el intermediario, tampoco baja
    const r = await fetch(VERIFY, POST);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { isValid: true });

    assert.equal(red.contadores.rechazos, 1);
    assert.equal(red.contadores.verify, 1);
    assert.equal(centinela.llamadas, 0, "ni siquiera a mitad de la prueba baja nada");
  });

  assert.equal(centinela.llamadas, 0,
    "ni la rechazada ni la permitida llegaron al escalon de abajo: no hubo salida a la red");
  assert.deepEqual(centinela.vistas, [], "y no anoto ninguna peticion");
  assert.ok(Object.is(globalThis.fetch, implCentinela),
    "y al salir se restauro el centinela, que era lo que habia al instalar");
});

// ---------------------------------------------------------------------------
// I-3 — no basta el pathname
// ---------------------------------------------------------------------------

test("I-3: dominio, metodo y cadena de consulta tambien deciden", async () => {
  await conRed({ responder: responderOk }, async (red) => {
    const casos = [
      ["mismo pathname en OTRO dominio", "https://otro.example/settle", POST],
      ["el dominio correcto pero con puerto", "https://facilitador.example:8443/settle", POST],
      ["metodo distinto (GET donde se espera POST)", VERIFY, { method: "GET" }],
      ["metodo distinto (PUT)", SETTLE, { method: "PUT" }],
      ["cadena de consulta inesperada", VERIFY + "?reintento=1", POST],
      ["cadena de consulta con clave sin valor", SETTLE + "?x", POST],
      ["subruta que no esta en la lista", VERIFY + "/extra", POST],
      ["esquema distinto", "http://facilitador.example/verify", POST],
    ];

    for (const [nombre, url, init] of casos)
      await assert.rejects(() => fetch(url, init), RedNoPermitida, nombre + " tiene que rechazarse");

    assert.equal(red.contadores.rechazos, casos.length, "los ocho, contados");
    assert.equal(red.contadores.verify, 0, "ninguno paso por permitido");
    assert.equal(red.contadores.settle, 0);

    // El control, para que la lista de arriba no pase por vacio: las dos que SI
    // estan en la lista se sirven.
    assert.equal((await fetch(VERIFY, POST)).status, 200);
    assert.equal((await fetch(SETTLE, POST)).status, 200);
    assert.equal(red.contadores.verify, 1);
    assert.equal(red.contadores.settle, 1);
    assert.equal(red.contadores.rechazos, casos.length, "y no se rechazo ninguna de mas");

    // LO QUE SI SE ACEPTA, Y POR QUE — conviene dejarlo dicho para que nadie lo
    // lea como un agujero: una `?` sin parametros NO es una cadena de consulta.
    // El estandar de URL la normaliza a vacia, de modo que `/settle?` y
    // `/settle` son la MISMA url, no dos. La comparacion se hace sobre la forma
    // normalizada a proposito: comparar el texto crudo rechazaria peticiones
    // identicas por una diferencia que no existe.
    await fetch(SETTLE + "?", POST);
    assert.equal(red.contadores.settle, 2, "`/settle?` es `/settle`, y se sirve");
    assert.equal(red.contadores.rechazos, casos.length, "sin sumar un rechazo");
  });
});

test("I-3 bis: la lista se congela al instalar y la peticion no puede ampliarla", async () => {
  // Se pasa una lista propia y despues se intenta ensancharla desde fuera, que es
  // la unica via por la que un dato podria llegar a la lista. Tiene que fallar o
  // no tener efecto, y en los dos casos la URL nueva sigue rechazandose.
  const mia = rutasFacilitador();
  await conRed({ permitidas: mia, responder: responderOk }, async (red) => {
    assert.equal(red.permitidas.length, 2);
    assert.ok(Object.isFrozen(red.permitidas), "la lista instalada esta congelada");

    // (a) empujar a la lista instalada
    assert.throws(() => { red.permitidas.push({ metodo: "POST", url: "https://malo.example/settle" }); },
      "no se puede ampliar la lista instalada");
    // (b) ampliar el array ORIGINAL que se paso: ya se copio, no debe afectar
    mia.push({ metodo: "POST", url: "https://malo.example/settle" });

    await assert.rejects(() => fetch("https://malo.example/settle", POST), RedNoPermitida,
      "ninguna de las dos vias ensancha lo que el intermediario acepta");
    assert.equal(red.permitidas.length, 2, "sigue teniendo dos");
  });
});

// ---------------------------------------------------------------------------
// I-4 — contadores separados
// ---------------------------------------------------------------------------

test("I-4: /verify y /settle se cuentan por separado, no en un total mezclado", async () => {
  await conRed({ responder: responderOk }, async (red) => {
    await fetch(VERIFY, POST);
    await fetch(VERIFY, POST);
    await fetch(SETTLE, POST);

    assert.deepEqual(
      { verify: red.contadores.verify, settle: red.contadores.settle, rechazos: red.contadores.rechazos },
      { verify: 2, settle: 1, rechazos: 0 },
      "dos verificaciones y una liquidacion, distinguibles. " +
      "Esto cuenta LLAMADAS a /settle, no liquidaciones ocurridas ni dinero movido.");

    assert.notEqual(red.contadores.verify, red.contadores.settle,
      "si fueran un total mezclado, esto no podria afirmarse");
  });
});

// ---------------------------------------------------------------------------
// I-5 e I-6 — restauracion por IDENTIDAD
// ---------------------------------------------------------------------------

test("I-5: tras un exito, globalThis.fetch vuelve a ser el MISMO objeto", async () => {
  const antes = globalThis.fetch;
  assert.equal(hayIntermediario(), false, "de partida no hay ninguno puesto");

  await conRed({ responder: responderOk }, async () => {
    assert.equal(hayIntermediario(), true);
    assert.ok(!Object.is(globalThis.fetch, antes), "mientras dura, el fetch es otro");
    await fetch(VERIFY, POST);
  });

  assert.ok(Object.is(globalThis.fetch, antes),
    "identidad, no equivalencia: tiene que ser el MISMO objeto, no uno que se le parezca");
  assert.equal(hayIntermediario(), false);
});

test("I-6: tras una excepcion a mitad, el fetch original queda restaurado", async () => {
  const antes = globalThis.fetch;

  await assert.rejects(
    () => conRed({ responder: responderOk }, async () => {
      await fetch(VERIFY, POST);
      throw new Error("la prueba revienta a mitad, a proposito");
    }),
    /revienta a mitad/);

  assert.ok(Object.is(globalThis.fetch, antes), "el `finally` restauro igual");
  assert.equal(hayIntermediario(), false, "y libero el estado del modulo");

  // Y el control: despues de eso se puede volver a instalar. Si la excepcion
  // hubiera dejado el estado sucio, esto lanzaria.
  await conRed({ responder: responderOk }, async (red) => {
    await fetch(SETTLE, POST);
    assert.equal(red.contadores.settle, 1, "con contadores nuevos, no heredados");
    assert.equal(red.contadores.verify, 0);
  });
  assert.ok(Object.is(globalThis.fetch, antes));
});

// ---------------------------------------------------------------------------
// I-7 — nada de envoltorios anidados
// ---------------------------------------------------------------------------

test("I-7: instalar un segundo intermediario lanza, y el primero sigue intacto", async () => {
  const antes = globalThis.fetch;

  await conRed({ responder: responderOk }, async (primero) => {
    const durante = globalThis.fetch;

    await assert.rejects(
      () => conRed({ responder: responderOk }, async () => { throw new Error("no deberia entrar"); }),
      /ya hay un intermediario de red instalado/);

    assert.throws(() => instalar({ responder: responderOk }), /ya hay un intermediario/,
      "tampoco por la via directa");

    assert.ok(Object.is(globalThis.fetch, durante),
      "el intento fallido no ha cambiado el fetch instalado");

    await fetch(VERIFY, POST);
    assert.equal(primero.contadores.verify, 1, "y el primero sigue funcionando y contando");
  });

  assert.ok(Object.is(globalThis.fetch, antes), "al salir, restaurado el de fuera");
  assert.equal(hayIntermediario(), false);

  // `desinstalar` con un objeto que no es el instalado no hace nada y lo dice.
  assert.equal(desinstalar({ anterior: antes }), false);
});

// ---------------------------------------------------------------------------
// I-8 — solapamiento de verdad
// ---------------------------------------------------------------------------

test("I-8: dos peticiones solapadas, atendidas por el MISMO intermediario", async () => {
  const antes = globalThis.fetch;
  const alResponder = [];
  const vistos = new Set();

  await conRed({
    responder: async (p) => {
      // El punto observado: aqui dentro se espera a que llegue la otra. La
      // barrera no se abre hasta que han llegado las dos, asi que ninguna puede
      // responder antes de que ambas esten dentro. Ningun reloj interviene.
      await barreraCompartida.llegar();
      alResponder.push(barreraCompartida.llegados);
      return { ok: true, status: 200, json: async () => ({ success: true, ruta: p.ruta }) };
    },
  }, async (red) => {
    // El MISMO objeto para las dos: se captura aqui y no se reinstala nada.
    vistos.add(globalThis.fetch);

    const resultados = await solapar(2, async (i, b) => {
      barreraCompartida = b;                     // la barrera que usa el responder
      vistos.add(globalThis.fetch);              // lo que ve cada trabajo
      const r = await fetch(SETTLE, POST);
      assert.equal(r.status, 200);
      return (await r.json()).ruta + "#" + i;
    });

    assert.equal(resultados.length, 2);
    assert.deepEqual(resultados.map((s) => s.split("#")[0]), ["/settle", "/settle"]);

    // (a) las DOS llegaron a la barrera antes de que ninguna respondiera
    assert.deepEqual(alResponder, [2, 2],
      "las dos respondieron con la barrera ya completa: se solaparon de verdad, " +
      "y no porque una esperase un tiempo fijo");

    // (b) ninguna vio un fetch ajeno: un solo objeto para todas
    assert.equal(vistos.size, 1, "el intermediario es el MISMO objeto para las dos peticiones");
    assert.ok(Object.is([...vistos][0], red.impl), "y es exactamente el que se instalo");

    // (c) el contador
    assert.equal(red.contadores.settle, 2,
      "settle === 2 CUENTA LLAMADAS a /settle, no liquidaciones ocurridas ni dinero movido");
    assert.equal(red.contadores.verify, 0);
    assert.equal(red.contadores.rechazos, 0);
  });

  assert.ok(Object.is(globalThis.fetch, antes));
});

// La barrera viaja del cuerpo de la prueba al `responder`. Se declara fuera
// porque el `responder` se construye antes de que `solapar` cree la barrera.
let barreraCompartida = barrera(1);

// ---------------------------------------------------------------------------
// I-C — EL CONTROL DEL VIGILANTE
// ---------------------------------------------------------------------------

test("I-C CONTROL: el centinela SI detectaria una delegacion, y lo demuestra sin red", async () => {
  // ---------------------------------------------------------------------
  // POR QUE HACE FALTA. Las diez pruebas anteriores terminan afirmando
  // «el centinela recibio cero llamadas». Esa frase solo vale algo si el
  // centinela fuera capaz de contar cuando SI le llaman. Un vigilante que no
  // vigila tambien termina en cero, y entonces las diez estarian apoyandose en
  // una tautologia — exactamente el defecto que se corrigio en la prueba de la
  // huella de PR-1h.
  //
  // COMO SE DEMUESTRA SIN TOCAR LA RED. Se fabrica aqui mismo la regresion que
  // se teme: una funcion que, en vez de rechazar, PASA la peticion al escalon de
  // abajo. Debajo se pone un centinela NUEVO, propio de esta prueba. No hay
  // ninguna URL de por medio —lo que se pasa es una cadena cualquiera— ni
  // ninguna implementacion de red real: el centinela lanza antes de que exista
  // nada que pudiera salir.
  // ---------------------------------------------------------------------
  const sonda = crearCentinela();
  assert.equal(sonda.llamadas, 0, "de partida, cero");

  // La regresion simulada: delega hacia abajo. Es lo que `red.mjs` NO hace.
  const intermediarioQueDelega = async (entrada, init) => sonda.impl(entrada, init);

  await assert.rejects(
    () => intermediarioQueDelega("peticion-simulada-sin-url", POST),
    (e) => {
      assert.match(e.message, /EL CENTINELA DE RED NO DEBE LLAMARSE/,
        "el centinela lanza, y dice por que");
      assert.match(e.message, /peticion-simulada-sin-url/, "y que le llego");
      return true;
    });

  assert.equal(sonda.llamadas, 1, "LA DELEGACION SE HABRIA VISTO: el contador subio");
  assert.deepEqual(sonda.vistas, ["peticion-simulada-sin-url"], "y quedo anotada");

  // Y una segunda, para que el conteo no sea un booleano disfrazado.
  await assert.rejects(() => intermediarioQueDelega("otra-simulada", POST), /CENTINELA/);
  assert.equal(sonda.llamadas, 2);

  // El centinela de ESTA prueba —el comun, el de `beforeEach`— sigue intacto: la
  // sonda de arriba es un objeto aparte y nunca se instalo en `globalThis`.
  assert.equal(centinelaActual.llamadas, 0,
    "el control no ensucia la hermeticidad que comprueba `afterEach`");
  assert.ok(!Object.is(sonda.impl, centinelaActual.impl), "son dos centinelas distintos");
});

test("I-8 bis: el perro guardian aborta un bloqueo, y hace FALLAR, nunca pasar", async () => {
  // Un solapamiento imposible: se piden DOS participantes y solo llega uno. Sin
  // el plazo, esto colgaria la suite para siempre.
  //
  // EL PLAZO ES INFRAESTRUCTURA DE PRUEBAS: no mide nada del servicio. Aqui se
  // pone corto solo para que esta prueba no tarde; su valor no significa nada
  // sobre latencias reales.
  await assert.rejects(
    () => solapar(2, async (i, b) => { if (i === 0) await b.llegar(); return i; }, { plazoMs: 120 }),
    (e) => {
      assert.ok(e instanceof SolapeBloqueado, "aborta con su propio error");
      assert.match(e.message, /llegaron 1 de 2/, "y dice cuantos habian llegado");
      assert.match(e.message, /infraestructura de pruebas, no una medicion/);
      return true;
    });
});
