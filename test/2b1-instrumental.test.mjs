// 2b.1 — EL INSTRUMENTAL, PROBADO ANTES DE APOYAR NADA EN EL.
//
// POR QUE ESTE FICHERO EXISTE. Lo que se prueba aqui no es el servicio: es la
// herramienta con la que se van a escribir las pruebas de 2b.2. Una herramienta
// de pruebas que se da por buena sin probar es la forma mas cara de tener
// pruebas verdes: todo lo que se construya encima hereda su fallo, y el fallo se
// descubre cuando ya se ha decidido algo a partir de un verde.
//
// LAS OCHO, Y QUE FIJA CADA UNA:
//   I-1  una URL desconocida se RECHAZA y sube el contador de rechazos
//   I-2  y no baja al `fetch` de debajo: un centinela local cuenta cero
//   I-3  no basta la ruta — dominio, metodo y cadena de consulta tambien
//   I-4  los contadores de /verify y /settle van SEPARADOS
//   I-5  tras exito, `globalThis.fetch` vuelve a ser el MISMO objeto
//   I-6  tras excepcion, tambien
//   I-7  instalar un segundo intermediario lanza
//   I-8  dos peticiones se solapan de verdad, atendidas por el mismo objeto
//
// NINGUNA PETICION DE ESTE FICHERO SALE A LA RED, tampoco en los controles
// negativos: las URL "desconocidas" se rechazan DENTRO del intermediario, que
// nunca delega hacia abajo, y en I-2 hay ademas un centinela local que lo
// demuestra contando cero. No se prueba "sin intermediario" contra ninguna URL
// que pudiera salir a internet.
import { test } from "node:test";
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

test("I-2: el intermediario NO delega hacia abajo — un centinela local cuenta cero", async () => {
  // El centinela sustituye a `fetch` ANTES de instalar el intermediario, asi que
  // queda justo debajo. Es completamente local: no sale a ninguna parte, y si lo
  // llamaran, lanzaria. Que termine en cero es la prueba de que el intermediario
  // contesta o rechaza, pero jamas pasa la peticion al siguiente escalon.
  //
  // ASI SE EVITA EL CONTROL NEGATIVO PELIGROSO: no hace falta probar "sin
  // intermediario" contra una URL que podria salir a internet. El centinela
  // ocupa ese hueco sin tocar la red.
  const real = globalThis.fetch;
  const centinela = { llamadas: 0 };
  const implCentinela = async (...args) => {
    centinela.llamadas++;
    throw new Error("EL CENTINELA NO DEBERIA LLAMARSE NUNCA: " + String(args[0]));
  };
  globalThis.fetch = implCentinela;

  try {
    await conRed({ responder: responderOk }, async (red) => {
      // (a) una desconocida: se rechaza arriba
      await assert.rejects(() => fetch("https://desconocido.example/x", POST), RedNoPermitida);
      // (b) una permitida: la contesta el intermediario, tampoco baja
      const r = await fetch(VERIFY, POST);
      assert.equal(r.status, 200);
      assert.deepEqual(await r.json(), { isValid: true });

      assert.equal(red.contadores.rechazos, 1);
      assert.equal(red.contadores.verify, 1);
    });

    assert.equal(centinela.llamadas, 0,
      "ni la rechazada ni la permitida llegaron al escalon de abajo: no hubo salida a la red");
    assert.ok(Object.is(globalThis.fetch, implCentinela),
      "y al salir se restauro el centinela, que era lo que habia al instalar");
  } finally {
    globalThis.fetch = real;
  }
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
