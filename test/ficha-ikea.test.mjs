// La ficha de IKEA afirma cosas sobre un comercio ajeno. Estas pruebas existen
// para que ninguna de esas afirmaciones dependa de la memoria de nadie ni de un
// comentario: cada cláusula publicada tiene que aparecer LITERALMENTE en una
// captura conservada en el repositorio, y cada captura lleva su fecha en el
// nombre. Si alguien edita una cita para que suene mejor, esto se pone rojo.
//
// Las dos capturas del 9-oct-2026 son las dos páginas públicas de IKEA US: la
// corta, que es la que el corpus del 28-ago tenía, y la política completa, que no
// tenía. Que sean dos ficheros distintos es precisamente el hallazgo.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ficha from "../cards/rc-card-ikea-365-or-180.mjs";

const corta = readFileSync(
  new URL("./fixtures/ikea-how-to-return-2026-10-09.txt", import.meta.url),
  "utf8",
);
const completa = readFileSync(
  new URL("./fixtures/ikea-return-policy-2026-10-09.txt", import.meta.url),
  "utf8",
);

// La cláusula que el corpus capturó el 28-ago-2026, pegada aquí tal cual para que
// la comparación sea con un literal y no con una descripción de él.
const CLAUSULA_28AGO =
  "IKEA offers a 365-day return policy for unopened products. You may also return open products within 180 days, with your proof of purchase, for a full refund.";

test("ficha IKEA: cada cláusula publicada está literal en la captura del 9-oct", () => {
  for (const o of ficha.outcomes) {
    assert.ok(
      completa.includes(o.clause),
      `la cláusula de ${o.days} días no aparece literal en la política completa: ${o.clause}`,
    );
  }
});

test("ficha IKEA: cada exclusión publicada está literal en la captura del 9-oct", () => {
  for (const d of ficha.denials) {
    assert.ok(
      completa.includes(d.clause),
      `la exclusión no aparece literal en la política completa: ${d.clause}`,
    );
  }
});

// La afirmación «seis semanas sin cambiar» deja de ser un comentario y pasa a ser
// algo que falla si deja de ser verdad.
test("ficha IKEA: la cláusula del 28-ago sigue viva, palabra por palabra, el 9-oct", () => {
  assert.ok(corta.includes(CLAUSULA_28AGO));
});

// El otro hallazgo: IKEA publica la política en dos páginas de distinta
// completitud, y la corta deja fuera lo que más condiciona una devolución.
test("ficha IKEA: la página corta no contiene las exclusiones de la completa", () => {
  for (const d of ficha.denials) {
    if (d.scope === "channel") continue; // esta sí sale en las dos
    assert.ok(!corta.includes(d.clause), `la página corta sí contiene: ${d.clause}`);
  }
  assert.ok(!corta.includes("Mattress purchases may be exchanged"));
});

// basis null no es un hueco: es la conclusión. Si alguna de las dos capturas
// llegara a decir desde qué evento corre el plazo, esta prueba obliga a revisarlo.
test("ficha IKEA: ninguna captura dice desde qué evento corre el plazo", () => {
  const anclas = [
    /within \d+ days (?:of|from) (?:delivery|purchase|receipt|shipment)/i,
    /\d+ days from the (?:delivery|purchase|invoice|order) date/i,
  ];
  for (const texto of [corta, completa]) {
    for (const re of anclas) assert.ok(!re.test(texto), `ancla temporal inesperada: ${re}`);
  }
  for (const o of ficha.outcomes) assert.equal(o.basis, null);
});
