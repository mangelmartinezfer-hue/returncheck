// Extracción de datos estructurados schema.org (JSON-LD) del HTML.
// Muchas tiendas incrustan MerchantReturnPolicy (el mismo esquema de Google) en
// <script type="application/ld+json">. Si está, tenemos datos FUNDAMENTADOS sin que
// el modelo adivine, y la cita es verificable (el JSON está literal en la página).
// Módulo PURO (sin dependencias de Cloudflare) -> testeable en Node.

// Saca y parsea todos los bloques ld+json del HTML. Tolerante a bloques rotos.
export function extractLdBlocks(html) {
  const out = [];
  if (!html) return out;
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1].trim().replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "");
    try { out.push(JSON.parse(raw)); }
    catch { /* bloque inválido: lo ignoramos, no reventamos */ }
  }
  return out;
}

// Recorre en profundidad cualquier objeto/array anidado (incluye @graph).
function* walk(node) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) { for (const x of node) yield* walk(x); return; }
  yield node;
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (v && typeof v === "object") yield* walk(v);
  }
}

function typeOf(node) {
  const t = node["@type"];
  if (!t) return [];
  return Array.isArray(t) ? t.map(String) : [String(t)];
}

// Normaliza un valor schema.org que puede venir como "https://schema.org/X" o "X".
function bare(v) {
  if (v == null) return null;
  const s = String(v);
  const i = s.lastIndexOf("/");
  return i >= 0 ? s.slice(i + 1) : s;
}

function catFrom(node) {
  const c = bare(node.returnPolicyCategory);
  if (!c) return null;
  if (/FiniteReturnWindow/i.test(c)) return "FiniteReturnWindow";
  if (/NotPermitted/i.test(c)) return "NotPermitted";
  if (/UnlimitedWindow/i.test(c)) return "UnlimitedWindow";
  return null;
}

// Busca la primera MerchantReturnPolicy utilizable en el JSON-LD.
// Devuelve { policy, raw } o null. `raw` es un fragmento LITERAL para la evidencia.
export function findReturnPolicy(blocks) {
  for (const b of blocks) {
    for (const node of walk(b)) {
      const types = typeOf(node);
      const looksLikeMRP = types.includes("MerchantReturnPolicy") || node.returnPolicyCategory != null;
      if (!looksLikeMRP) continue;
      const category = catFrom(node);
      if (!category) continue;

      const daysRaw = node.merchantReturnDays;
      const days = (daysRaw != null && !Number.isNaN(Number(daysRaw))) ? Number(daysRaw) : null;

      const applicable = []
        .concat(node.applicableCountry || [])
        .map((x) => (typeof x === "string" ? x : (x && (x.identifier || x.name)) || ""))
        .filter(Boolean);

      const policy = {
        return_category: category,
        merchant_return_days: days,
        return_country: bare(node.returnPolicyCountry) || (applicable[0] || null),
        applicable_countries: applicable,
        return_method: [].concat(node.returnMethod || []).map(bare).filter(Boolean),
        return_fees: bare(node.returnFees),
        refund_type: bare(node.refundType),
        restocking_fee: node.restockingFee != null ? node.restockingFee : null,
      };

      // Fragmento LITERAL para la evidencia (debe existir tal cual en el HTML crudo).
      const parts = [`"returnPolicyCategory"`];
      const rawCat = node.returnPolicyCategory != null ? `"returnPolicyCategory":${JSON.stringify(node.returnPolicyCategory)}` : null;
      const rawDays = days != null ? `"merchantReturnDays":${JSON.stringify(node.merchantReturnDays)}` : null;

      return { policy, rawCategory: rawCat, rawDays, rawType: parts[0] };
    }
  }
  return null;
}

// Mapea la categoría a un veredicto del contrato.
export function verdictFromCategory(category) {
  if (category === "NotPermitted") return "NO";
  return "YES_WITH_CONDITIONS"; // Finite o Unlimited: devolvible con condiciones/ventana
}
