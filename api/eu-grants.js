/**
 * FinanciApp NTT DATA — /api/eu-grants
 *
 * Fuentes:
 *  - EU: API SEDIA oficial (api.tech.ec.europa.eu) — autenticación por apiKey=SEDIA
 *  - BDNS: infosubvenciones.es — endpoint público JSON, solo abiertas/próximas
 *
 * Basado en la especificación SEDIA proporcionada por el equipo de desarrollo.
 */

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    return res.status(200).end();
  }
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=600');

  const {
    source = 'all',
    status,
    q,
    lang     = 'es',
    page     = '1',
    size     = '50',
    pageSize = size,         // alias
    updatedSince,
  } = req.query;

  const [bdnsResult, euResult] = await Promise.allSettled([
    source === 'eu'   ? Promise.resolve([]) : fetchBDNS(),
    source === 'bdns' ? Promise.resolve([]) : fetchEU({ lang, q, updatedSince }),
  ]);

  const bdns   = bdnsResult.status === 'fulfilled' ? bdnsResult.value : [];
  const eu     = euResult.status   === 'fulfilled' ? euResult.value   : [];
  const errors = [];
  if (bdnsResult.status === 'rejected') errors.push({ source: 'bdns', message: bdnsResult.reason?.message });
  if (euResult.status   === 'rejected') errors.push({ source: 'eu',   message: euResult.reason?.message });

  // Ordenar: abiertas primero, luego próximas, luego cerradas; por fecha cierre asc
  const ORDER = { open: 0, forthcoming: 1, closed: 2 };
  let combined = [...bdns, ...eu].sort((a, b) => {
    const sd = (ORDER[a.status] ?? 2) - (ORDER[b.status] ?? 2);
    return sd !== 0 ? sd : (a.deadlineSort || '9999').localeCompare(b.deadlineSort || '9999');
  });

  if (status) combined = combined.filter(g => g.status === status);
  if (q && source !== 'eu') {
    // Si source incluye BDNS, filtramos también BDNS localmente
    // (EU ya filtra en el servidor via SEDIA)
    const ql = q.toLowerCase();
    combined = combined.filter(g =>
      g.src === 'eu' ||
      g.title?.toLowerCase().includes(ql) ||
      g.org?.toLowerCase().includes(ql)
    );
  }

  const pageNum  = Math.max(1, parseInt(page) || 1);
  const pageSz   = Math.min(100, parseInt(pageSize) || 50);
  const total    = combined.length;

  return res.status(200).json({
    ok: true,
    meta: {
      total,
      bdnsCount: bdns.length,
      euCount:   eu.length,
      page:      pageNum,
      pageSize:  pageSz,
      pages:     Math.ceil(total / pageSz),
      errors,
      fetchedAt: new Date().toISOString(),
    },
    data: combined.slice((pageNum - 1) * pageSz, pageNum * pageSz),
  });
};

// ════════════════════════════════════════════════════════════════════════════
//  EU — API SEDIA oficial
//  POST https://api.tech.ec.europa.eu/search-api/prod/rest/search
//  Autenticación: apiKey=SEDIA (pública, sin registro)
//  Formato body: multipart/form-data con partes JSON (query, languages, sort)
// ════════════════════════════════════════════════════════════════════════════

const SEDIA_URL      = 'https://api.tech.ec.europa.eu/search-api/prod/rest/search';
const SEDIA_API_KEY  = 'SEDIA';
const SEDIA_PAGE_MAX = 100;

// Códigos de tipo de convocatoria
const TYPE_LABELS = {
  '0': 'Licitación',
  '1': 'Subvención',
  '2': 'Convocatoria de propuestas',
  '8': 'Financiación en cascada',
};

// Códigos de estado SEDIA → estado normalizado FinanciApp
const STATUS_MAP = {
  '31094501': 'forthcoming', // Forthcoming
  '31094502': 'open',        // Open for submission
  '31094503': 'closed',      // Closed
};

const STATUS_LABELS = {
  '31094501': 'Próxima apertura',
  '31094502': 'Abierta',
  '31094503': 'Cerrada',
};

/**
 * Construye el cuerpo multipart/form-data que espera la API SEDIA.
 * Cada parte es un JSON independiente con su propio Content-Type.
 */
function buildSediaBody(query, languages, sort) {
  const boundary = `----sedia-${Math.random().toString(16).slice(2)}`;
  const parts = { query, languages, sort };
  let body = '';

  for (const [name, value] of Object.entries(parts)) {
    body += `--${boundary}\r\n`;
    body += `Content-Disposition: form-data; name="${name}"; filename="blob"\r\n`;
    body += `Content-Type: application/json\r\n\r\n`;
    body += `${JSON.stringify(value)}\r\n`;
  }
  body += `--${boundary}--\r\n`;

  return { boundary, body };
}

/**
 * Llama a SEDIA paginando hasta obtener todos los resultados.
 * Por defecto trae todos los tipos y todos los estados.
 */
async function fetchEU({ lang = 'es', q, updatedSince, typeCodes, statusCodes } = {}) {
  const allItems  = [];
  let pageNumber  = 1;
  let totalPages  = 1;

  const tCodes = typeCodes  || ['0', '1', '2', '8'];
  const sCodes = statusCodes || ['31094501', '31094502', '31094503'];

  // Filtro base
  const must = [
    { terms: { type:   tCodes } },
    { terms: { status: sCodes } },
  ];
  if (updatedSince) {
    must.push({ range: { updateDate: { gte: updatedSince } } });
  }

  const query = { bool: { must } };
  const sort  = { field: 'updateDate', order: 'DESC' };

  do {
    const params = new URLSearchParams({
      apiKey:     SEDIA_API_KEY,
      text:       q || '*',
      pageSize:   String(SEDIA_PAGE_MAX),
      pageNumber: String(pageNumber),
      language:   lang,
    });

    const { boundary, body } = buildSediaBody(query, [lang], sort);

    const res = await timedFetch(`${SEDIA_URL}?${params}`, {
      method:  'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
    }, 20000);

    if (!res.ok) throw new Error(`SEDIA HTTP ${res.status}`);

    const data = await res.json();

    const total      = data.totalResults ?? 0;
    const returnedSz = data.pageSize     ?? SEDIA_PAGE_MAX;
    totalPages = Math.ceil(total / returnedSz);

    (data.results || []).forEach(raw => {
      try { allItems.push(normSEDIA(raw)); } catch {}
    });

    pageNumber++;
  } while (pageNumber <= totalPages && pageNumber <= 50); // máx. 5 000 resultados

  return allItems;
}

/** Normaliza un resultado SEDIA al formato FinanciApp */
function normSEDIA(raw) {
  const md        = raw.metadata ?? {};
  const first     = arr => Array.isArray(arr) && arr.length ? arr[0] : null;

  const typeCode   = first(md.type);
  const statusCode = first(md.status);
  const status     = STATUS_MAP[statusCode] || 'closed';

  const title = first(md.title)
    || first(md.callTitle)
    || raw.summary
    || raw.content
    || 'Sin título';

  const url = first(md.url)
    || first(md.esST_URL)
    || raw.url
    || 'https://ec.europa.eu/info/funding-tenders/opportunities/portal/';

  const dlRaw  = first(md.deadlineDate) || first(md.closingDate);
  const opRaw  = first(md.startDate);
  const dlDate = dlRaw ? new Date(dlRaw) : null;

  const budgetRaw = first(md.budgetTopicAction) || first(md.budget) || null;
  const amountNum = budgetRaw ? parseFloat(budgetRaw) || 0 : 0;

  const identifier = first(md.identifier) || raw.reference || `eu-${Math.random().toString(16).slice(2)}`;

  return {
    id:           `eu-${identifier}`,
    src:          'eu',
    title,
    org:          first(md.programmeName) || first(md.programme) || 'Comisión Europea',
    programme:    first(md.programmeAcronym) || first(md.programme) || '',
    typeCode,
    typeLabel:    typeCode ? (TYPE_LABELS[typeCode] || 'Otro') : 'Otro',
    statusCode,
    statusLabel:  STATUS_LABELS[statusCode] || 'Desconocido',
    status,
    amount:       amountNum > 0 ? fmtAmt(amountNum) : 'Consultar convocatoria',
    amountNum,
    deadline:     dlDate && !isNaN(dlDate) ? fmtDate(dlDate) : '—',
    deadlineSort: dlDate && !isNaN(dlDate) ? dlDate.toISOString().slice(0, 10) : '9999-12-31',
    openDate:     opRaw ? fmtDate(new Date(opRaw)) : null,
    updatedAt:    first(md.updateDate) || first(md.es_SortDate) || null,
    fondo:        typeCode === '0' ? 'licitacion' : 'subvencion',
    obj:          [],
    entity:       ['pyme','gran','startup','uni','publica','ong'],
    tags:         [first(md.programmeAcronym), first(md.typeOfAction)].filter(Boolean),
    url,
    identifier,
    callCode:     first(md.callIdentifier) || first(md.identifier) || null,
    summary:      raw.summary || null,
  };
}

// ════════════════════════════════════════════════════════════════════════════
//  BDNS — infosubvenciones.es
//  Solo abiertas y próximas, filtradas desde el origen
// ════════════════════════════════════════════════════════════════════════════

const BDNS_HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
  'Accept':          'application/json',
  'Accept-Language': 'es-ES,es;q=0.9',
  'Referer':         'https://www.infosubvenciones.es/bdnstrans/GE/es/convocatorias',
  'Origin':          'https://www.infosubvenciones.es',
};

async function fetchBDNS() {
  const [abiertas, previstas] = await Promise.all([
    fetchBDNSByStatus('abierta'),
    fetchBDNSByStatus('prevista'),
  ]);
  return [...abiertas, ...previstas];
}

async function fetchBDNSByStatus(estado) {
  const PAGE_SIZE = 50;
  const MAX_PAGES = 10;
  const all = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    const url =
      `https://www.infosubvenciones.es/bdnstrans/api/convocatorias/busqueda` +
      `?page=${page}&pageSize=${PAGE_SIZE}` +
      `&order=fechaRecepcion&direccion=desc` +
      `&vpd=GE&estado=${encodeURIComponent(estado)}`;

    const res = await timedFetch(url, { headers: BDNS_HEADERS }, 15000);
    if (!res.ok) throw new Error(`BDNS HTTP ${res.status} (${estado})`);

    const json  = await res.json();
    const items = json.content || [];
    const totalPages = json.totalPages || 1;

    items.forEach(item => { try { all.push(normBDNS(item, estado)); } catch {} });
    if (page + 1 >= totalPages || items.length < PAGE_SIZE) break;
  }
  return all;
}

function normBDNS(item, estadoFiltro) {
  const id     = item.numeroConvocatoria || String(item.id || Math.random());
  const now    = Date.now();
  const dlRaw  = item.fechaFinPresentacionSolicitudes || item.fechaFin || item.fechaCierre || null;
  const opRaw  = item.fechaInicioSolicitudes || item.fechaInicio || item.fechaRecepcion || null;

  const stRaw  = (item.estado || estadoFiltro || '').toLowerCase();
  let status   = 'closed';
  if (stRaw.includes('abierta') || stRaw.includes('vigente'))        status = 'open';
  else if (stRaw.includes('prevista') || stRaw.includes('próxima'))  status = 'forthcoming';
  else if (dlRaw && new Date(dlRaw).getTime() > now)                 status = opRaw && new Date(opRaw).getTime() > now ? 'forthcoming' : 'open';

  const amountNum = parseFloat(item.importeTotal || item.presupuesto || 0) || 0;

  return {
    id:           `bdns-${id}`,
    src:          'bdns',
    title:        item.descripcion || item.tituloConvocatoria || 'Sin título',
    org:          item.nombreOrgano || item.nombreOrganismo || item.organoConvocante || 'Administración Pública',
    status,
    amount:       amountNum > 0 ? fmtAmt(amountNum) : 'Consultar convocatoria',
    amountNum,
    deadline:     dlRaw  ? fmtDate(dlRaw)  : '—',
    deadlineSort: dlRaw  ? new Date(dlRaw).toISOString().slice(0, 10) : '9999-12-31',
    openDate:     opRaw  ? fmtDate(opRaw)  : null,
    fondo:        inferFondo(item),
    obj:          inferObjBDNS(item),
    entity:       inferEntityBDNS(item),
    tags:         [item.sectorActividad, item.tipoInstrumento].filter(Boolean).slice(0, 2),
    url:          `https://www.infosubvenciones.es/bdnstrans/GE/es/convocatorias/${id}`,
    identifier:   String(id),
    codigoBDNS:   String(id),
  };
}

function inferFondo(item) {
  const t = (item.tipoInstrumento || '').toLowerCase();
  if (t.includes('préstamo') || t.includes('prestamo')) return 'prestamo';
  if (t.includes('capital')  || t.includes('equity'))   return 'equity';
  if (t.includes('mixto'))                               return 'mixto';
  return 'subvencion';
}

function inferObjBDNS(item) {
  const txt = [item.descripcion, item.finalidad, item.sectorActividad].filter(Boolean).join(' ').toLowerCase();
  return [
    ['idi',       ['investigaci','i+d','innovaci','tecnológ','desarrollo tecnol']],
    ['digital',   ['digital','informátic','software','cibersegur','inteligencia artif']],
    ['sostenib',  ['sostenib','medioamb','ecológ','energía renovable','climát','circular']],
    ['inversion', ['inversi','productiv','industria','manufactur','equipamiento']],
    ['inter',     ['internacionaliz','exportaci','exterior']],
    ['formacion', ['formaci','empleo','capacitaci','educaci','beca']],
  ].filter(([, kws]) => kws.some(kw => txt.includes(kw))).map(([k]) => k);
}

function inferEntityBDNS(item) {
  const t = (item.tiposBeneficiario || item.beneficiarios || '').toLowerCase();
  if (!t) return ['pyme','gran','startup','uni','publica','ong'];
  const out = [];
  if (t.includes('pyme') || t.includes('pequeña') || t.includes('mediana')) out.push('pyme');
  if (t.includes('gran empresa'))                                            out.push('gran');
  if (t.includes('startup') || t.includes('emergente'))                     out.push('startup');
  if (t.includes('universid') || t.includes('investigac'))                  out.push('uni');
  if (t.includes('entidad pública') || t.includes('administraci'))          out.push('publica');
  if (t.includes('ong') || t.includes('tercer sector') || t.includes('fundaci')) out.push('ong');
  return out.length ? out : ['pyme','gran','startup','uni','publica','ong'];
}

// ── Utilidades ────────────────────────────────────────────────────────────────
function timedFetch(url, options, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...options, signal: ctrl.signal }).finally(() => clearTimeout(t));
}

function fmtDate(val) {
  const d = val instanceof Date ? val : new Date(val);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function fmtAmt(val) {
  const n = typeof val === 'string' ? parseFloat(val.replace(/[^\d.]/g, '')) : Number(val);
  if (!n || isNaN(n)) return 'Consultar convocatoria';
  if (n >= 1e9) return `hasta ${(n / 1e9).toFixed(0)} B €`;
  if (n >= 1e6) return `hasta ${(n / 1e6).toFixed(0)} M €`;
  if (n >= 1e3) return `hasta ${(n / 1e3).toFixed(0)} k €`;
  return `hasta ${n.toLocaleString('es-ES')} €`;
}
