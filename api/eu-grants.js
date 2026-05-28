/**
 * FinanciApp NTT DATA
 * Vercel Serverless Function: /api/eu-grants
 *
 * Actúa como proxy inteligente del portal Funding & Tenders de la Comisión Europea.
 * Resuelve el bloqueo CORS, normaliza los datos y aplica caché de 1 hora.
 *
 * Endpoints del portal de la CE consumidos:
 *   - Búsqueda de tópicos:  POST https://api.tech.ec.europa.eu/search-api/prod/rest/search
 *   - Topic list estático:  https://ec.europa.eu/info/funding-tenders/opportunities/data/topic-list.html
 *   - RSS actualizaciones:  https://ec.europa.eu/info/funding-tenders/opportunities/data/referenceData/callupdates-rss.xml
 *
 * Uso desde el frontend:
 *   GET /api/eu-grants                     → todas las convocatorias
 *   GET /api/eu-grants?status=open         → solo abiertas
 *   GET /api/eu-grants?status=forthcoming  → próximas
 *   GET /api/eu-grants?status=closed       → cerradas
 *   GET /api/eu-grants?programme=HORIZON   → filtrar por programa
 *   GET /api/eu-grants?q=digitalisation    → búsqueda por texto
 *   GET /api/eu-grants?page=2&size=50      → paginación (máx. 100/página)
 */

// ── Caché en memoria (se resetea con cada cold start de la función) ──────────
const cache = { data: null, timestamp: 0 };
const CACHE_TTL = 60 * 60 * 1000; // 1 hora en ms

// ── Endpoint interno del portal de la CE (reverse-engineered del portal) ─────
const EU_SEARCH_URL =
  "https://api.tech.ec.europa.eu/search-api/prod/rest/search";

// ── Mapeo de estados CE → estado normalizado FinanciApp ──────────────────────
const STATUS_MAP = {
  "31094503": "open",        // OPEN
  "31094501": "forthcoming", // FORTHCOMING
  "31094504": "closed",      // CLOSED
  "31094502": "forthcoming", // UPCOMING (alias)
};

// ── Mapeo de programas a nombres legibles ─────────────────────────────────────
const PROGRAMME_MAP = {
  HORIZON:    "Horizon Europe",
  EIC:        "EIC — European Innovation Council",
  LIFE:       "Programa LIFE",
  CEF:        "MCE — Mecanismo Conectar Europa",
  ERASMUSPLUS:"Erasmus+",
  COSME:      "COSME",
  EUSF:       "Fondo de Solidaridad de la UE",
  INTERREG:   "Interreg",
  ERDF:       "Fondo FEDER",
  ESF:        "FSE+",
  EMFAF:      "FEMPA",
  AMIF:       "Fondo de Asilo y Migración",
  ISF:        "Fondo de Seguridad Interior",
  SMP:        "Mercado Único — SMP",
  DIGITAL:    "Europa Digital",
  EURATOM:    "Euratom",
};

/**
 * Construye el payload para la API de búsqueda del portal de la CE.
 * La API acepta un query DSL tipo Elasticsearch simplificado.
 */
function buildSearchPayload(page = 1, size = 50) {
  return {
    query: "*",
    filters: [
      {
        name: "type",
        values: ["topic"], // solo tópicos (convocatorias de propuestas)
      },
    ],
    page: { number: page, size },
    sortBy: "startDate",
    sortOrder: "DESC",
    language: "es,en", // castellano preferido, inglés como fallback
  };
}

/**
 * Normaliza un registro raw de la CE al formato FinanciApp.
 */
function normalizeGrant(raw) {
  // El campo metadata puede venir como objeto o como array de pares
  const meta = raw.metadata || {};

  const statusCode = meta.status?.[0] || meta.submissionStatus?.[0] || "";
  const status = STATUS_MAP[statusCode] || "closed";

  const programme =
    meta.programmeName?.[0] ||
    meta.programmePeriod?.[0] ||
    meta.programme?.[0] ||
    "Comisión Europea";

  const programmeFull =
    PROGRAMME_MAP[meta.programmeAcronym?.[0]] ||
    meta.programmeName?.[0] ||
    programme;

  // Fechas: la CE devuelve timestamps Unix en ms o strings ISO
  const deadlineRaw =
    meta.deadlineDate?.[0] ||
    meta.submissionDeadlineDate?.[0] ||
    meta.endDate?.[0] ||
    null;

  const deadline = deadlineRaw
    ? formatDate(deadlineRaw)
    : "Sin fecha definida";

  const deadlineSort = deadlineRaw
    ? new Date(
        typeof deadlineRaw === "number" ? deadlineRaw : deadlineRaw
      )
        .toISOString()
        .slice(0, 10)
    : "9999-12-31";

  const openDate =
    meta.startDate?.[0] || meta.openingDate?.[0] || null;

  // Importe: la CE no siempre lo expone por tópico, viene a nivel de call
  const budgetRaw =
    meta.budgetTopicAction?.[0] ||
    meta.budget?.[0] ||
    meta.budgetOverview?.[0] ||
    null;

  const amount = budgetRaw
    ? formatBudget(budgetRaw)
    : "Consultar convocatoria";

  const title =
    meta.title?.[0] ||
    raw.title ||
    raw.id ||
    "Sin título";

  const callTitle =
    meta.callTitle?.[0] || meta.parentCallTitle?.[0] || "";

  const topicId = raw.id || meta.identifier?.[0] || "";

  return {
    id: topicId,
    src: "eu",
    title: title,
    callTitle: callTitle,
    org: programmeFull,
    programme: meta.programmeAcronym?.[0] || programme,
    status,
    amount,
    amountRaw: budgetRaw,
    deadline,
    deadlineSort,
    openDate: openDate ? formatDate(openDate) : null,
    tags: buildTags(meta, status),
    obj: inferObjectives(meta),
    entity: inferEntities(meta),
    fondo: "subvencion", // F&T es siempre subvención/grant salvo excepciones
    url: `https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/opportunities/topic-details/${topicId.toLowerCase()}`,
    identifier: topicId,
    actions: meta.typeOfAction || [],
    keywords: meta.tags || meta.keywords || [],
    raw: undefined, // no exponer datos crudos al cliente
  };
}

/** Formatea timestamp o ISO a DD/MM/AAAA */
function formatDate(val) {
  if (!val) return "—";
  const d = new Date(typeof val === "number" ? val : val);
  if (isNaN(d.getTime())) return String(val).slice(0, 10);
  return d.toLocaleDateString("es-ES", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

/** Formatea presupuesto numérico o string */
function formatBudget(val) {
  if (!val) return "Consultar convocatoria";
  const num = typeof val === "string" ? parseFloat(val.replace(/[^0-9.]/g, "")) : val;
  if (isNaN(num) || num === 0) return String(val);
  if (num >= 1_000_000_000) return `hasta ${(num / 1e9).toFixed(0)} B €`;
  if (num >= 1_000_000)     return `hasta ${(num / 1e6).toFixed(0)} M €`;
  if (num >= 1_000)         return `hasta ${(num / 1e3).toFixed(0)} k €`;
  return `hasta ${num.toLocaleString("es-ES")} €`;
}

/** Construye array de tags legibles */
function buildTags(meta, status) {
  const tags = [];
  if (meta.programmeAcronym?.[0]) tags.push(meta.programmeAcronym[0]);
  if (meta.typeOfAction?.[0])     tags.push(meta.typeOfAction[0]);
  return tags.slice(0, 4);
}

/** Infiere objetivos FinanciApp a partir de keywords/tags de la CE */
function inferObjectives(meta) {
  const text = [
    ...(meta.tags || []),
    ...(meta.keywords || []),
    ...(meta.title || []),
    ...(meta.callTitle || []),
  ]
    .join(" ")
    .toLowerCase();

  const map = [
    ["idi",       ["research", "innovation", "r&i", "rti", "rdi", "i+d", "investigación"]],
    ["digital",   ["digital", "ai", "artificial intelligence", "data", "cloud", "cyber", "tech"]],
    ["sostenib",  ["green", "climate", "environment", "biodiversity", "energy", "circular", "sostenib"]],
    ["inversion", ["investment", "capital", "sme", "pyme", "enterprise", "business"]],
    ["inter",     ["international", "cooperation", "mobility", "exchange", "consortium"]],
    ["formacion", ["education", "training", "skills", "learning", "erasmus", "formación"]],
  ];

  return map
    .filter(([, keywords]) => keywords.some((kw) => text.includes(kw)))
    .map(([key]) => key);
}

/** Infiere tipos de entidad elegibles */
function inferEntities(meta) {
  const text = [
    ...(meta.tags || []),
    ...(meta.typeOfAction || []),
    ...(meta.title || []),
  ]
    .join(" ")
    .toLowerCase();

  const entities = [];
  if (text.includes("sme") || text.includes("pyme") || text.includes("small")) entities.push("pyme");
  if (text.includes("startup") || text.includes("eic")) entities.push("startup");
  if (text.includes("large") || text.includes("corporate"))  entities.push("gran");
  if (text.includes("university") || text.includes("research") || text.includes("rti")) entities.push("uni");
  if (text.includes("public") || text.includes("authority")) entities.push("publica");
  if (text.includes("ngo") || text.includes("civil society")) entities.push("ong");

  // Si no se pudo inferir nada, asumir que aplica a todos
  return entities.length > 0 ? entities : ["pyme", "gran", "startup", "uni", "publica", "ong"];
}

/**
 * Obtiene TODOS los tópicos del portal paginando hasta agotar resultados.
 * La CE devuelve máximo 50 registros por página.
 */
async function fetchAllTopics() {
  const PAGE_SIZE = 50;
  let page = 1;
  let total = null;
  const allTopics = [];

  do {
    const payload = buildSearchPayload(page, PAGE_SIZE);

    const response = await fetch(EU_SEARCH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "Accept-Language": "es,en;q=0.9",
        Origin: "https://ec.europa.eu",
        Referer:
          "https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/opportunities/topic-search",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(
        `CE API error ${response.status}: ${response.statusText}`
      );
    }

    const json = await response.json();

    // La respuesta puede venir en distintos formatos según la versión de la API
    const hits =
      json.results ||
      json.hits?.hits ||
      json.data ||
      json.topics ||
      [];

    if (total === null) {
      total =
        json.total ||
        json.hits?.total?.value ||
        json.totalCount ||
        hits.length;
    }

    if (!hits.length) break;

    hits.forEach((hit) => {
      // Los datos pueden estar en _source o directamente en el objeto
      const raw = hit._source || hit;
      try {
        allTopics.push(normalizeGrant(raw));
      } catch {
        // Ignorar registros malformados
      }
    });

    page++;
  } while (allTopics.length < total && page <= 100); // máx. 100 páginas = 5000 tópicos

  return allTopics;
}

/**
 * Fallback: obtiene el feed RSS de actualizaciones de la CE y lo parsea.
 * Se usa si la API de búsqueda no responde.
 */
async function fetchRSSFallback() {
  const RSS_URL =
    "https://ec.europa.eu/info/funding-tenders/opportunities/data/referenceData/callupdates-rss.xml";

  const response = await fetch(RSS_URL, {
    headers: { Accept: "application/rss+xml,application/xml,text/xml" },
  });

  if (!response.ok) throw new Error("RSS unavailable");

  const xml = await response.text();

  // Parser RSS manual (Node no tiene DOMParser nativo en edge runtime)
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;

  while ((match = itemRegex.exec(xml)) !== null) {
    const item = match[1];
    const get = (tag) => {
      const m = item.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
      return m ? (m[1] || m[2] || "").trim() : "";
    };

    const title    = get("title");
    const link     = get("link");
    const pubDate  = get("pubDate");
    const deadline = get("ec:deadline") || get("deadline");
    const budget   = get("ec:budget")   || get("budget");
    const status   = get("ec:status")   || get("status") || "open";
    const programme= get("ec:programme") || get("programme") || "Comisión Europea";

    if (!title) continue;

    const topicId = link.split("/").pop() || `rss-${items.length}`;

    items.push({
      id: topicId,
      src: "eu",
      title,
      callTitle: "",
      org: programme,
      programme,
      status: status.toLowerCase().includes("open") ? "open"
            : status.toLowerCase().includes("forth") ? "forthcoming"
            : "closed",
      amount: budget ? formatBudget(budget) : "Consultar convocatoria",
      amountRaw: budget,
      deadline: deadline ? formatDate(new Date(deadline)) : "—",
      deadlineSort: deadline
        ? new Date(deadline).toISOString().slice(0, 10)
        : "9999-12-31",
      openDate: pubDate ? formatDate(new Date(pubDate)) : null,
      tags: [programme],
      obj: [],
      entity: ["pyme", "gran", "startup", "uni", "publica", "ong"],
      fondo: "subvencion",
      url: link || "https://ec.europa.eu/info/funding-tenders/opportunities/portal/",
      identifier: topicId,
      actions: [],
      keywords: [],
    });
  }

  return items;
}

// ── Handler principal ─────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // Solo GET
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Headers CORS — permite llamadas desde cualquier origen (ajustar en prod)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=600");

  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    // ── 1. Obtener datos (de caché o frescos) ─────────────────────────────────
    const now = Date.now();
    let grants;

    if (cache.data && now - cache.timestamp < CACHE_TTL) {
      grants = cache.data;
    } else {
      try {
        grants = await fetchAllTopics();
      } catch (apiError) {
        console.warn("Primary API failed, trying RSS fallback:", apiError.message);
        try {
          grants = await fetchRSSFallback();
        } catch (rssError) {
          console.error("Both sources failed:", rssError.message);
          return res.status(502).json({
            error: "No se pudieron obtener datos de la Comisión Europea",
            detail: rssError.message,
          });
        }
      }

      // Actualizar caché
      cache.data = grants;
      cache.timestamp = now;
    }

    // ── 2. Filtros por query params ───────────────────────────────────────────
    const { status, programme, q, page = "1", size = "50" } = req.query;

    let filtered = [...grants];

    if (status) {
      filtered = filtered.filter((g) => g.status === status.toLowerCase());
    }

    if (programme) {
      const prog = programme.toUpperCase();
      filtered = filtered.filter(
        (g) =>
          g.programme?.toUpperCase().includes(prog) ||
          g.org?.toUpperCase().includes(prog)
      );
    }

    if (q) {
      const query = q.toLowerCase();
      filtered = filtered.filter(
        (g) =>
          g.title?.toLowerCase().includes(query) ||
          g.org?.toLowerCase().includes(query) ||
          g.callTitle?.toLowerCase().includes(query) ||
          g.tags?.some((t) => t.toLowerCase().includes(query)) ||
          g.keywords?.some((k) => k.toLowerCase().includes(query))
      );
    }

    // ── 3. Paginación ─────────────────────────────────────────────────────────
    const pageNum  = Math.max(1, parseInt(page) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(size) || 50));
    const total    = filtered.length;
    const pages    = Math.ceil(total / pageSize);
    const start    = (pageNum - 1) * pageSize;
    const paginated = filtered.slice(start, start + pageSize);

    // ── 4. Respuesta ──────────────────────────────────────────────────────────
    return res.status(200).json({
      ok: true,
      meta: {
        total,
        page: pageNum,
        pageSize,
        pages,
        cached: cache.timestamp === now ? false : true,
        cachedAt: new Date(cache.timestamp).toISOString(),
        source: "EU Funding & Tenders Portal",
        sourceUrl: "https://ec.europa.eu/info/funding-tenders/opportunities/portal/",
      },
      data: paginated,
    });
  } catch (err) {
    console.error("[eu-grants] Unhandled error:", err);
    return res.status(500).json({
      error: "Error interno del servidor",
      detail: process.env.NODE_ENV === "development" ? err.message : undefined,
    });
  }
}
