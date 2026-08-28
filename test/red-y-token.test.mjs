// LA RED Y EL TOKEN TIENEN QUE IR JUNTOS. Esta prueba lee wrangler.toml.
//
// POR QUÉ EXISTE. Al pasar a mainnet el 28 de agosto de 2026 casi se cuela un
// fallo que no habría dado ningún error: el nombre del token que va al dominio
// EIP-712 NO es el mismo en las dos redes.
//
//     Base Sepolia  ->  name() = "USDC"
//     Base mainnet  ->  name() = "USD Coin"
//
// Con el nombre equivocado, la firma del comprador no valida y NINGÚN pago entra.
// Falla cerrado: no se pierde dinero, pero no se cobra nada y no hay nada en los
// registros que lo explique. Un negocio muerto y en silencio.
//
// Cambiar la red sin cambiar el token, o el token sin cambiar el nombre, deja de
// ser posible sin que esta prueba se ponga roja.
//
// LAS CONSTANTES DE ABAJO NO SE PONEN DE MEMORIA. Proceden de:
//   - Documentación oficial de Circle, leída el 28 ago 2026:
//     developers.circle.com/stablecoins/usdc-contract-addresses
//   - Confirmadas contra las propias cadenas el mismo día, llamando a name(),
//     symbol(), decimals() y version() de cada contrato.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { RED } from "../src/x402.mjs";

const USDC = {
  [RED.BASE_SEPOLIA]: { direccion: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", nombre: "USDC" },
  [RED.BASE_MAINNET]: { direccion: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", nombre: "USD Coin" },
};

// La cartera de usar y tirar que se usó para ensayar el cobro. NUNCA puede ser la
// dirección de cobro: no es una cuenta del negocio y quedó dicho que jamás recibe
// fondos reales.
const CARTERA_DE_PRUEBAS = "0x42D284924013525f45F5e2aC801338E89476B0b1";

function vars() {
  const t = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  const v = {};
  for (const linea of t.split(/\r?\n/)) {
    const m = linea.match(/^\s*([A-Z0-9_]+)\s*=\s*"([^"]*)"/);
    if (m) v[m[1]] = m[2];
  }
  return v;
}

test("la red configurada es una de las dos que conocemos", () => {
  const v = vars();
  assert.ok(USDC[v.X402_NETWORK], "X402_NETWORK desconocida: " + v.X402_NETWORK);
});

test("EL TOKEN CORRESPONDE A LA RED — exacto, con sus mayúsculas", () => {
  const v = vars();
  assert.equal(v.X402_ASSET, USDC[v.X402_NETWORK].direccion,
    "el contrato de USDC no es el de esta red");
});

test("EL NOMBRE DEL DOMINIO EIP-712 CORRESPONDE A LA RED", () => {
  // El que casi se cuela. En mainnet es "USD Coin", no "USDC".
  const v = vars();
  assert.equal(v.X402_ASSET_NAME, USDC[v.X402_NETWORK].nombre,
    'el nombre EIP-712 no es el del token en esta red: con este valor NINGUN pago validaria');
});

test("la versión del dominio EIP-712 es la leída del contrato", () => {
  assert.equal(vars().X402_ASSET_VERSION, "2");
});

test("la dirección de cobro NO es la cartera de pruebas", () => {
  const v = vars();
  assert.notEqual(v.X402_PAY_TO.toLowerCase(), CARTERA_DE_PRUEBAS.toLowerCase(),
    "la cartera de usar y tirar no puede recibir dinero real");
  assert.match(v.X402_PAY_TO, /^0x[0-9a-fA-F]{40}$/, "no parece una direccion");
});

test("si se cobra en mainnet, x402 tiene que estar encendido y con facilitador", () => {
  const v = vars();
  if (v.X402_NETWORK !== RED.BASE_MAINNET) return;
  assert.equal(v.X402_ENABLED, "true");
  assert.match(v.X402_FACILITATOR || "", /^https:\/\//,
    "sin facilitador no se puede comprobar que un pago es real");
});
