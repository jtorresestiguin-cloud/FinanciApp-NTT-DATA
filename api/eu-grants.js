/**
 * FinanciApp NTT DATA — /api/eu-grants
 * BDNS + EU Funding & Tenders, ejecución en paralelo con timeouts ajustados.
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

  // Ejecutar ambas fuentes en paralelo; cada una tiene su propio timeout
  const [bdnsResult, euResult] = await Promise.allSettled([
    source === 'eu'  ? Promise.resolve([]) : fetchBDNS(),
    source === 'bdns'? Promise.resolve([]) : fetchEU(),
  ]);

  const bdns   = bdnsResult.status  === 'fulfilled' ? bdnsResult.value  : [];
  const eu     = euResult.status    === 'fulfilled' ? euResult.value    : [];
  const errors = [];
  if (bdnsResult.status === 'rejected') errors.push({ source: 'bdns', message: bdnsResult.reason?.message });
  if (euResult.status   === 'rejected') errors.push({ source: 'eu',   message: euResult.reason?.message });

  let combined = [...bdns, ...eu];

  // Ordenar por fecha cierre ascendente (más próximas primero)
  combined.sort((a, b) => (a.deadlineSort || '9999').localeCompare(b.deadlineSort || '9999'));

  if (status) combined = combined.filter(g => g.status === status);
  if (q) {
    const ql = q.toLowerCase();
    combined = combined.filter(g =>
      g.title?.toLowerCase().includes(ql) ||
      g.org?.toLowerCase().includes(ql)
    );
  }

  const pageNum  = Math.max(1, parseInt(page)  || 1);
  const pageSize = Math.min(100, parseInt(size) || 50);
  const total    = combined.length;

  return res.status(200).json({
    ok: true,
    meta: {
      total,
      bdnsCount: bdns.length,
      euCount:   eu.length,
      page:      pageNum,
      pageSize,
      pages:     Math.ceil(total / pageSize),
      errors,
      fetchedAt: new Date().toISOString(),
    },
    data: combined.slice((pageNum - 1) * pageSize, pageNum * pageSize),
  });
};

// ── Cabeceras que imitan Chrome para evitar bloqueos ─────────────────────────
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function timedFetch(url, options, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...options, signal: ctrl.signal }).finally(() => clearTimeout(t));
}

// ════════════════════════════════════════════════════════════════════════════
//  BDNS — infosubvenciones.es
//  Responde en ~2s → timeout 15s holgado
// ════════════════════════════════════════════════════════════════════════════
async function fetchBDNS() {
  const PAGE_SIZE = 50;
  const MAX_PAGES = 20; // hasta 1 000 convocatorias por llamada
  const all = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    const url =
      `https://www.infosubvenciones.es/bdnstrans/api/convocatorias/busqueda` +
      `?page=${page}&pageSize=${PAGE_SIZE}` +
      `&order=fechaRecepcion&direccion=desc&vpd=GE`;

    const res = await timedFetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json',
        'Accept-Language': 'es-ES,es;q=0.9',
        'Referer': 'https://www.infosubvenciones.es/bdnstrans/GE/es/convocatorias',
        'Origin':  'https://www.infosubvenciones.es',
      },
    }, 15000);

    if (!res.ok) throw new Error(`BDNS HTTP ${res.status}`);
    const json = await res.json();

    const items      = json.content || [];
    const totalPages = json.totalPages || 1;

    items.forEach(item => {
      try { all.push(normBDNS(item)); } catch {}
    });

    if (page + 1 >= totalPages || items.length < PAGE_SIZE) break;
  }

  return all;
}

function normBDNS(item) {
  const id  = item.numeroConvocatoria || item.id || String(Math.random());
  const dlRaw = item.fechaFinPresentacionSolicitudes
    || item.fechaFin
    || item.fechaCierre
    || null;
  const opRaw = item.fechaInicioSolicitudes || item.fechaRecepcion || null;

  // Estado: calcular por fechas si no viene explícito
  let status = 'closed';
  const now = Date.now();
  if (dlRaw && new Date(dlRaw).getTime() > now) {
    status = opRaw && new Date(opRaw).getTime() > now ? 'forthcoming' : 'open';
  }
  // Sobrescribir si viene campo explícito
  const st = (item.estado || '').toLowerCase();
  if (st.includes('abierta') || st.includes('vigente'))   status = 'open';
  if (st.includes('prevista') || st.includes('próxima'))  status = 'forthcoming';
  if (st.includes('cerrada') || st.includes('resuelta'))  status = 'closed';

  const amountNum = parseFloat(item.importeTotal || item.presupuesto || 0) || 0;

  return {
    id:           `bdns-${id}`,
    src:          'bdns',
    title:        item.descripcion || item.tituloConvocatoria || 'Sin título',
    org:          item.nombreOrganismo || item.organoConvocante || 'Administración Pública',
    status,
    amount:       amountNum > 0 ? fmtAmt(amountNum) : 'Consultar convocatoria',
    amountNum,
    deadline:     dlRaw ? fmtDate(dlRaw) : '—',
    deadlineSort: dlRaw ? new Date(dlRaw).toISOString().slice(0, 10) : '9999-12-31',
    openDate:     opRaw ? fmtDate(opRaw) : null,
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
  const t = (item.tipoInstrumento || item.instrumentoAyuda || '').toLowerCase();
  if (t.includes('préstamo') || t.includes('prestamo')) return 'prestamo';
  if (t.includes('capital')  || t.includes('equity'))   return 'equity';
  if (t.includes('mixto'))                               return 'mixto';
  return 'subvencion';
}

function inferObjBDNS(item) {
  const txt = [item.descripcion, item.finalidad, item.sectorActividad]
    .filter(Boolean).join(' ').toLowerCase();
  return [
    ['idi',       ['investigaci', 'i+d', 'innovaci', 'tecnológ', 'desarrollo tecnol']],
    ['digital',   ['digital', 'informátic', 'software', 'cibersegur', 'inteligencia artif']],
    ['sostenib',  ['sostenib', 'medioamb', 'ecológ', 'energía renovable', 'climát', 'circular']],
    ['inversion', ['inversi', 'productiv', 'industria', 'manufactur', 'equipamiento']],
    ['inter',     ['internacionaliz', 'exportaci', 'exterior']],
    ['formacion', ['formaci', 'empleo', 'capacitaci', 'educaci', 'beca']],
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

// ════════════════════════════════════════════════════════════════════════════
//  EU Funding & Tenders
//  El RSS tarda ~32s → usamos topic-list.html primero (responde en <1s)
//  y el RSS como fallback con timeout generoso de 40s
// ════════════════════════════════════════════════════════════════════════════
async function fetchEU() {
  // Intentar primero topic-list (rápido)
  try {
    return await fetchEUTopicList();
  } catch (e1) {
    // Fallback al RSS (lento pero robusto)
    try {
      return await fetchEURSS();
    } catch (e2) {
      throw new Error(`topic-list: ${e1.message} | RSS: ${e2.message}`);
    }
  }
}

// ── topic-list.html → JSON ────────────────────────────────────────────────
async function fetchEUTopicList() {
  const html = await timedFetch(
    'https://ec.europa.eu/info/funding-tenders/opportunities/data/topic-list.html',
    { headers: { 'User-Agent': UA } },
    10000
  ).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); });

  // Buscar el enlace al JSON dentro del HTML
  const match = html.match(/href="([^"]*(?:topic[^"]*\.json|\.json)[^"]*)"/i);
  if (!match) throw new Error('No se encontró enlace JSON en topic-list.html');

  const jsonUrl = match[1].startsWith('http')
    ? match[1]
    : `https://ec.europa.eu${match[1]}`;

  const json = await timedFetch(jsonUrl, { headers: { 'User-Agent': UA } }, 20000)
    .then(r => { if (!r.ok) throw new Error(`JSON HTTP ${r.status}`); return r.json(); });

  const topics = Array.isArray(json) ? json : (json.topics || json.data || []);
  if (!topics.length) throw new Error('topic-list JSON vacío');

  return topics.map(t => normEUTopic(t)).filter(t => t.title);
}

function normEUTopic(t) {
  const id  = t.identifier || t.id || t.topicId || '';
  const dlRaw = t.deadlineDate || t.deadline || t.endDate || null;
  const dlDate = dlRaw ? new Date(dlRaw) : null;
  const stRaw  = (t.status || t.submissionStatus || '').toLowerCase();
  const status = stRaw.includes('open')  ? 'open'
               : stRaw.includes('forth') ? 'forthcoming'
               : 'closed';

  return {
    id:           `eu-${id}`,
    src:          'eu',
    title:        t.title || t.topicTitle || id,
    org:          t.programmeName || t.programme || 'Comisión Europea',
    status,
    amount:       t.budget ? fmtAmt(t.budget) : 'Consultar convocatoria',
    amountNum:    parseFloat(t.budget) || 0,
    deadline:     dlDate && !isNaN(dlDate) ? fmtDate(dlDate) : '—',
    deadlineSort: dlDate && !isNaN(dlDate) ? dlDate.toISOString().slice(0, 10) : '9999-12-31',
    openDate:     t.startDate ? fmtDate(new Date(t.startDate)) : null,
    fondo:        'subvencion',
    obj:          [],
    entity:       ['pyme','gran','startup','uni','publica','ong'],
    tags:         [t.programmeAcronym || t.programme].filter(Boolean),
    url:          `https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/opportunities/topic-details/${id.toLowerCase()}`,
    identifier:   id,
  };
}

// ── RSS (fallback, timeout 40s) ───────────────────────────────────────────
async function fetchEURSS() {
  const xml = await timedFetch(
    'https://ec.europa.eu/info/funding-tenders/opportunities/data/referenceData/callupdates-rss.xml',
    { headers: { 'User-Agent': UA, 'Accept': 'application/rss+xml,application/xml,text/xml' } },
    40000   // 40s — el RSS real tarda ~32s desde Vercel iad1
  ).then(r => { if (!r.ok) throw new Error(`RSS HTTP ${r.status}`); return r.text(); });

  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;

  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    const get = tag => {
      const r = new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, 'i');
      const f = r.exec(block);
      return f ? f[1].trim() : '';
    };

    const title    = get('title');
    const link     = get('link');
    const pubDate  = get('pubDate');
    const deadline = get('deadline') || get('ec:deadline') || '';
    const budget   = get('budget')   || get('ec:budget')   || '';
    const status   = get('status')   || get('ec:status')   || '';
    const prog     = get('programme') || get('ec:programme') || 'Comisión Europea';

    if (!title) continue;

    const topicId = (link.split('/').pop() || `eu-rss-${items.length}`).replace(/[?#].*/, '');
    const dlDate  = deadline ? new Date(deadline) : null;
    const normSt  = status.toLowerCase().includes('open')  ? 'open'
                  : status.toLowerCase().includes('forth') ? 'forthcoming'
                  : 'closed';

    items.push({
      id:           `eu-${topicId}`,
      src:          'eu',
      title,
      org:          prog,
      status:       normSt,
      amount:       budget ? fmtAmt(parseFloat(budget) || budget) : 'Consultar convocatoria',
      amountNum:    parseFloat(budget) || 0,
      deadline:     dlDate && !isNaN(dlDate) ? fmtDate(dlDate) : '—',
      deadlineSort: dlDate && !isNaN(dlDate) ? dlDate.toISOString().slice(0, 10) : '9999-12-31',
      openDate:     pubDate ? fmtDate(new Date(pubDate)) : null,
      fondo:        'subvencion',
      obj:          [],
      entity:       ['pyme','gran','startup','uni','publica','ong'],
      tags:         [prog],
      url:          link || 'https://ec.europa.eu/info/funding-tenders/opportunities/portal/',
      identifier:   topicId,
    });
  }

  if (!items.length) throw new Error('EU RSS: sin items en el XML');
  return items;
}

// ── Utilidades ────────────────────────────────────────────────────────────
function fmtDate(val) {
  const d = val instanceof Date ? val : new Date(val);
  if (isNaN(d.getTime())) return String(val).slice(0, 10);
  return d.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function fmtAmt(val) {
  const n = typeof val === 'string' ? parseFloat(val.replace(/[^\d.]/g, '')) : Number(val);
  if (!n || isNaN(n)) return typeof val === 'string' ? val : 'Consultar convocatoria';
  if (n >= 1e9) return `hasta ${(n / 1e9).toFixed(0)} B €`;
  if (n >= 1e6) return `hasta ${(n / 1e6).toFixed(0)} M €`;
  if (n >= 1e3) return `hasta ${(n / 1e3).toFixed(0)} k €`;
  return `hasta ${n.toLocaleString('es-ES')} €`;
}
