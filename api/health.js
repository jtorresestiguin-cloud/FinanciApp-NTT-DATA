/**
 * FinanciApp NTT DATA — /api/health
 *
 * Diagnóstico de conectividad desde Vercel hacia BDNS y EU.
 * Visitar en el navegador para ver qué fuentes responden:
 *   https://financiapp-wvx2.vercel.app/api/health
 */

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  const SOURCES = [
    {
      name: 'BDNS — búsqueda convocatorias',
      url: 'https://www.infosubvenciones.es/bdnstrans/api/convocatorias/busqueda?page=0&pageSize=1&vpd=GE',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Referer': 'https://www.infosubvenciones.es/bdnstrans/GE/es/convocatorias',
        'Origin': 'https://www.infosubvenciones.es',
      },
    },
    {
      name: 'EU — RSS convocatorias',
      url: 'https://ec.europa.eu/info/funding-tenders/opportunities/data/referenceData/callupdates-rss.xml',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/rss+xml, application/xml, text/xml',
      },
    },
    {
      name: 'EU — topic-list HTML',
      url: 'https://ec.europa.eu/info/funding-tenders/opportunities/data/topic-list.html',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
      },
    },
  ];

  const results = await Promise.all(
    SOURCES.map(async src => {
      const t0 = Date.now();
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10000);
        const r = await fetch(src.url, { headers: src.headers, signal: controller.signal });
        clearTimeout(timer);
        const text = await r.text();
        return {
          name: src.name,
          url: src.url,
          status: r.status,
          ok: r.ok,
          contentType: r.headers.get('content-type') || '—',
          bodyPreview: text.slice(0, 120).replace(/\s+/g, ' '),
          ms: Date.now() - t0,
        };
      } catch (e) {
        return {
          name: src.name,
          url: src.url,
          status: null,
          ok: false,
          error: e.message,
          ms: Date.now() - t0,
        };
      }
    })
  );

  const allOk = results.every(r => r.ok);

  return res.status(allOk ? 200 : 207).json({
    ok: allOk,
    checkedAt: new Date().toISOString(),
    region: process.env.VERCEL_REGION || 'unknown',
    results,
    diagnosis: results.map(r => {
      if (r.ok)    return `✅ ${r.name} → HTTP ${r.status} en ${r.ms}ms`;
      if (r.error?.includes('abort')) return `⏱ ${r.name} → TIMEOUT (${r.ms}ms) — IP de Vercel probablemente bloqueada`;
      return `❌ ${r.name} → ${r.error || `HTTP ${r.status}`}`;
    }),
  });
};
