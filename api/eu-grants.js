/**
 * FinanciApp NTT DATA — /api/eu-grants
 *
 * Estrategia en cascada para sortear los bloqueos de IP cloud:
 *
 *  1. BDNS  → endpoint JSON oficial con headers de navegador
 *  2. EU    → RSS público de Funding & Tenders (sin autenticación)
 *  3. EU    → topic-list.html (fichero estático de la CE)
 *
 * Ambas fuentes bloquean IPs de datacenter con frecuencia.
 * Esta función intenta múltiples técnicas para maximizar la tasa de éxito.
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

  const { source = 'all', status, q, page = '1', size = '50' } = req.query;

  const results = { bdns: [], eu: [], errors: [] };

  // ── 1. BDNS ──────────────────────────────────────────────────────────────
  if (source === 'all' || source === 'bdns') {
    try {
      results.bdns = await fetchBDNS();
    } catch (e) {
      results.errors.push({ source: 'bdns', message: e.message });
    }
  }

  // ── 2. EU Funding & Tenders ───────────────────────────────────────────────
  if (source === 'all' || source === 'eu') {
    try {
      results.eu = await fetchEU();
    } catch (e) {
      results.errors.push({ source: 'eu', message: e.message });
      // Intentar fallback topic-list si RSS también falla
      try {
        results.eu = await fetchEUTopicList();
      } catch (e2) {
        results.errors.push({ source: 'eu-topiclist', message: e2.message });
      }
    }
  }

  // ── Combinar y filtrar ────────────────────────────────────────────────────
  let combined = [...results.bdns, ...results.eu];

  if (status)  combined = combined.filter(g => g.status === status);
  if (q)       { const ql = q.toLowerCase(); combined = combined.filter(g => g.title?.toLowerCase().includes(ql) || g.org?.toLowerCase().includes(ql)); }

  const pageNum  = Math.max(1, parseInt(page) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(size) || 50));
  const total    = combined.length;
  const paginated = combined.slice((pageNum - 1) * pageSize, pageNum * pageSize);

  return res.status(200).json({
    ok: true,
    meta: {
      total,
      bdnsCount: results.bdns.length,
      euCount:   results.eu.length,
      page: pageNum,
      pageSize,
      pages: Math.ceil(total / pageSize),
      errors: results.errors,
      fetchedAt: new Date().toISOString(),
    },
    data: paginated,
  });
};

// ════════════════════════════════════════════════════════════════════════════
// BDNS — infosubvenciones.es
// Endpoint: /bdnstrans/api/convocatorias/busqueda
// ════════════════════════════════════════════════════════════════════════════

const BDNS_BASE = 'https://www.infosubvenciones.es/bdnstrans/api';

// Headers que imitan un navegador real para evitar el bloqueo por UA
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'Referer': 'https://www.infosubvenciones.es/bdnstrans/GE/es/convocatorias',
  'Origin': 'https://www.infosubvenciones.es',
  'Connection': 'keep-alive',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
};

async function fetchBDNS() {
  const PAGE_SIZE = 50;
  const MAX_PAGES = 20; // hasta 1000 convocatorias
  const all = [];
  let page = 0;

  while (page < MAX_PAGES) {
    const url = `${BDNS_BASE}/convocatorias/busqueda?` +
      `page=${page}&pageSize=${PAGE_SIZE}` +
      `&order=fechaRecepcion&direccion=desc` +
      `&vpd=GE`;   // GE = Gobierno central + todas las CCAA

    const res = await fetchWithTimeout(url, {
      headers: BROWSER_HEADERS,
    }, 12000);

    if (!res.ok) throw new Error(`BDNS HTTP ${res.status}`);

    const json = await res.json();

    // La BDNS devuelve { content: [...], totalElements, totalPages, ... }
    const items = json.content || json.convocatorias || json.data || json || [];
    if (!Array.isArray(items) || items.length === 0) break;

    items.forEach(item => {
      try { all.push(normalizeBDNS(item)); } catch {}
    });

    const totalPages = json.totalPages || json.numPaginas || Math.ceil((json.totalElements || 0) / PAGE_SIZE);
    if (page + 1 >= totalPages || items.length < PAGE_SIZE) break;
    page++;
  }

  return all;
}

function normalizeBDNS(item) {
  const id = item.numConv || item.id || item.numeroConvocatoria || String(Math.random());

  const deadlineRaw = item.fechaFin || item.fechaCierre || item.fechaFinPresentacion || null;
  const openRaw     = item.fechaInicio || item.fechaRecepcion || null;

  // Estado: la BDNS usa texto libre en español
  const estadoRaw = (item.estado || item.estadoConv || '').toLowerCase();
  let status = 'closed';
  if (estadoRaw.includes('abierta') || estadoRaw.includes('vigente') || estadoRaw.includes('activa')) status = 'open';
  else if (estadoRaw.includes('prevista') || estadoRaw.includes('próxima') || estadoRaw.includes('futura')) status = 'forthcoming';
  // Si no hay estado pero la fecha fin es futura, asumir abierta
  else if (!estadoRaw && deadlineRaw && new Date(deadlineRaw) > new Date()) status = 'open';

  const title = item.tituloConvocatoria || item.titulo || item.descripcion || 'Sin título';
  const org   = item.nombreOrganismo || item.organismo || item.organoConvocante || 'Administración Pública';

  const amountNum = parseFloat(item.importeTotal || item.presupuesto || 0);

  return {
    id: `bdns-${id}`,
    src: 'bdns',
    title,
    org,
    status,
    amount: amountNum > 0 ? formatAmount(amountNum) : 'Consultar convocatoria',
    amountNum,
    deadline: deadlineRaw ? formatDate(deadlineRaw) : '—',
    deadlineSort: deadlineRaw ? new Date(deadlineRaw).toISOString().slice(0, 10) : '9999-12-31',
    openDate: openRaw ? formatDate(openRaw) : null,
    fondo: inferFondo(item),
    obj: inferObjBDNS(item),
    entity: inferEntityBDNS(item),
    tags: buildTagsBDNS(item),
    url: `https://www.infosubvenciones.es/bdnstrans/GE/es/convocatorias/${id}`,
    identifier: String(id),
    codigoBDNS: String(id),
  };
}

function inferFondo(item) {
  const t = (item.tipoInstrumento || item.instrumentoAyuda || item.tipo || '').toLowerCase();
  if (t.includes('préstamo') || t.includes('prestamo')) return 'prestamo';
  if (t.includes('capital') || t.includes('equity'))    return 'equity';
  if (t.includes('mixto'))                               return 'mixto';
  return 'subvencion';
}

function inferObjBDNS(item) {
  const text = [
    item.tituloConvocatoria, item.descripcion,
    item.finalidad, item.sectorActividad,
    item.objetivos,
  ].filter(Boolean).join(' ').toLowerCase();

  return [
    ['idi',       ['investigación', 'i+d', 'innovación', 'research', 'desarrollo tecnológico']],
    ['digital',   ['digital', 'tecnología', 'informática', 'software', 'ciberseguridad', 'ia ', 'inteligencia artificial']],
    ['sostenib',  ['sostenib', 'medioamb', 'ecológ', 'energía renovable', 'cambio climático', 'circular']],
    ['inversion', ['inversión', 'productiv', 'industria', 'manufactur', 'equipamiento']],
    ['inter',     ['internacionaliz', 'exportación', 'exterior', 'comercio internacional']],
    ['formacion', ['formación', 'empleo', 'formativo', 'capacitación', 'educación', 'becas']],
  ].filter(([, kws]) => kws.some(kw => text.includes(kw))).map(([k]) => k);
}

function inferEntityBDNS(item) {
  const t = (item.tiposBeneficiario || item.beneficiarios || item.destinatarios || '').toLowerCase();
  if (!t) return ['pyme', 'gran', 'startup', 'uni', 'publica', 'ong'];
  const out = [];
  if (t.includes('pyme') || t.includes('pequeña') || t.includes('mediana')) out.push('pyme');
  if (t.includes('gran empresa') || t.includes('grandes empresas'))          out.push('gran');
  if (t.includes('startup') || t.includes('emergente'))                      out.push('startup');
  if (t.includes('universid') || t.includes('investigac'))                   out.push('uni');
  if (t.includes('entidad pública') || t.includes('administración'))         out.push('publica');
  if (t.includes('ong') || t.includes('tercer sector') || t.includes('fundación')) out.push('ong');
  return out.length ? out : ['pyme', 'gran', 'startup', 'uni', 'publica', 'ong'];
}

function buildTagsBDNS(item) {
  const tags = [];
  if (item.sectorActividad)  tags.push(item.sectorActividad);
  if (item.tipoInstrumento)  tags.push(item.tipoInstrumento);
  if (item.finalidad)        tags.push(item.finalidad.slice(0, 40));
  return tags.slice(0, 3);
}

// ════════════════════════════════════════════════════════════════════════════
// EU Funding & Tenders — RSS oficial
// ════════════════════════════════════════════════════════════════════════════

const EU_RSS = 'https://ec.europa.eu/info/funding-tenders/opportunities/data/referenceData/callupdates-rss.xml';

async function fetchEU() {
  const res = await fetchWithTimeout(EU_RSS, {
    headers: {
      'User-Agent': BROWSER_HEADERS['User-Agent'],
      'Accept': 'application/rss+xml, application/xml, text/xml, */*',
      'Accept-Language': 'en,es;q=0.8',
    },
  }, 15000);

  if (!res.ok) throw new Error(`EU RSS HTTP ${res.status}`);
  const xml = await res.text();
  return parseRSS(xml);
}

function parseRSS(xml) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;

  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    const get = tag => {
      const r = new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, 'i');
      const found = r.exec(block);
      return found ? found[1].trim() : '';
    };

    const title    = get('title');
    const link     = get('link');
    const pubDate  = get('pubDate');
    const deadline = get('deadline') || get('ec:deadline') || '';
    const budget   = get('budget')   || get('ec:budget')   || '';
    const status   = get('status')   || get('ec:status')   || 'open';
    const prog     = get('programme') || get('ec:programme') || 'Comisión Europea';

    if (!title) continue;

    const topicId  = (link.split('/').pop() || `eu-${items.length}`).replace(/[?#].*/, '');
    const dlDate   = deadline ? new Date(deadline) : null;
    const normSt   = status.toLowerCase().includes('open') ? 'open'
                   : status.toLowerCase().includes('forth') ? 'forthcoming'
                   : 'closed';

    items.push({
      id: `eu-${topicId}`,
      src: 'eu',
      title,
      org: prog,
      status: normSt,
      amount: budget ? formatAmount(parseFloat(budget) || budget) : 'Consultar convocatoria',
      amountNum: parseFloat(budget) || 0,
      deadline: dlDate && !isNaN(dlDate) ? formatDate(dlDate) : '—',
      deadlineSort: dlDate && !isNaN(dlDate) ? dlDate.toISOString().slice(0, 10) : '9999-12-31',
      openDate: pubDate ? formatDate(new Date(pubDate)) : null,
      fondo: 'subvencion',
      obj: [],
      entity: ['pyme', 'gran', 'startup', 'uni', 'publica', 'ong'],
      tags: [prog],
      url: link || 'https://ec.europa.eu/info/funding-tenders/opportunities/portal/',
      identifier: topicId,
    });
  }

  if (!items.length) throw new Error('EU RSS: sin items en el XML');
  return items;
}

// ════════════════════════════════════════════════════════════════════════════
// EU Fallback — topic-list.html (fichero estático de la CE)
// Contiene un enlace a un JSON con todos los tópicos
// ════════════════════════════════════════════════════════════════════════════

const EU_TOPIC_LIST = 'https://ec.europa.eu/info/funding-tenders/opportunities/data/topic-list.html';

async function fetchEUTopicList() {
  const res = await fetchWithTimeout(EU_TOPIC_LIST, {
    headers: { 'User-Agent': BROWSER_HEADERS['User-Agent'] },
  }, 15000);

  if (!res.ok) throw new Error(`EU topic-list HTTP ${res.status}`);
  const html = await res.text();

  // El HTML contiene un <a href="...topic-list.json"> o similar
  const jsonMatch = html.match(/href="([^"]*topic[^"]*\.json[^"]*)"/i)
    || html.match(/href="([^"]*\.json)"/i);

  if (!jsonMatch) throw new Error('EU topic-list: no se encontró enlace JSON');

  const jsonUrl = jsonMatch[1].startsWith('http')
    ? jsonMatch[1]
    : `https://ec.europa.eu${jsonMatch[1]}`;

  const jRes = await fetchWithTimeout(jsonUrl, {
    headers: { 'User-Agent': BROWSER_HEADERS['User-Agent'] },
  }, 20000);

  if (!jRes.ok) throw new Error(`EU topic JSON HTTP ${jRes.status}`);
  const json = await jRes.json();

  const topics = Array.isArray(json) ? json : (json.topics || json.data || json.results || []);

  return topics.map(t => {
    const id = t.identifier || t.id || t.topicId || '';
    const deadline = t.deadlineDate || t.deadline || t.endDate || null;
    const dlDate   = deadline ? new Date(deadline) : null;
    const statusRaw = (t.status || t.submissionStatus || '').toLowerCase();

    return {
      id: `eu-${id}`,
      src: 'eu',
      title: t.title || t.topicTitle || id,
      org: t.programmeName || t.programme || 'Comisión Europea',
      status: statusRaw.includes('open') ? 'open'
            : statusRaw.includes('forth') ? 'forthcoming'
            : 'closed',
      amount: t.budget ? formatAmount(t.budget) : 'Consultar convocatoria',
      amountNum: parseFloat(t.budget) || 0,
      deadline: dlDate && !isNaN(dlDate) ? formatDate(dlDate) : '—',
      deadlineSort: dlDate && !isNaN(dlDate) ? dlDate.toISOString().slice(0, 10) : '9999-12-31',
      openDate: t.startDate ? formatDate(new Date(t.startDate)) : null,
      fondo: 'subvencion',
      obj: [],
      entity: ['pyme', 'gran', 'startup', 'uni', 'publica', 'ong'],
      tags: [t.programmeAcronym || t.programme || 'EU'].filter(Boolean),
      url: `https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/opportunities/topic-details/${id.toLowerCase()}`,
      identifier: id,
    };
  }).filter(t => t.title);
}

// ════════════════════════════════════════════════════════════════════════════
// Utilidades
// ════════════════════════════════════════════════════════════════════════════

function fetchWithTimeout(url, options, ms = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

function formatDate(val) {
  if (!val) return '—';
  const d = val instanceof Date ? val : new Date(val);
  if (isNaN(d.getTime())) return String(val).slice(0, 10);
  return d.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function formatAmount(val) {
  const n = typeof val === 'string' ? parseFloat(val.replace(/[^\d.]/g, '')) : val;
  if (!n || isNaN(n)) return typeof val === 'string' ? val : 'Consultar convocatoria';
  if (n >= 1e9) return `hasta ${(n / 1e9).toFixed(0).replace('.', ',')} B €`;
  if (n >= 1e6) return `hasta ${(n / 1e6).toFixed(0).replace('.', ',')} M €`;
  if (n >= 1e3) return `hasta ${(n / 1e3).toFixed(0).replace('.', ',')} k €`;
  return `hasta ${n.toLocaleString('es-ES')} €`;
}
