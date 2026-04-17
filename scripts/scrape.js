const https = require('https');
const fs    = require('fs');
const path  = require('path');

function fetchUrl(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Demasiados redirects'));
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,*/*;q=0.9',
        'Accept-Language': 'es-ES,es;q=0.9',
        'Cache-Control': 'no-cache',
        'Upgrade-Insecure-Requests': '1',
      }
    };
    const req = https.get(url, options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location, redirects + 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
      const chunks = [];
      const enc = res.headers['content-encoding'];
      let stream = res;
      try {
        if (enc === 'gzip')    { const z = require('zlib'); stream = res.pipe(z.createGunzip()); }
        else if (enc === 'br') { const z = require('zlib'); stream = res.pipe(z.createBrotliDecompress()); }
        else if (enc === 'deflate') { const z = require('zlib'); stream = res.pipe(z.createInflate()); }
      } catch(ze) { /* usar stream sin comprimir */ }
      stream.on('data', c => chunks.push(c));
      stream.on('end',  () => resolve(Buffer.concat(chunks).toString('utf-8')));
      stream.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

/* ── Parser principal: busca patrones de hora + título + links en el HTML ── */
function parseEventos(html) {
  const events = [];
  const seen   = new Set();

  // ── Estrategia 1: filas de tabla <tr> con hora ──────────────────────────
  const trRx = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let trMatch;
  while ((trMatch = trRx.exec(html)) !== null) {
    const row  = trMatch[1];
    const text = row.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

    const timeM = text.match(/\b(\d{1,2}:\d{2})\b/);
    if (!timeM) continue;
    const time = timeM[1];

    // Título: texto largo que no sea solo la hora
    const parts = text.split(timeM[0]).join('').trim();
    if (parts.length < 4) continue;

    // Limpiar el título — quitar nombres de canales conocidos del final
    const rawTitle = parts
      .replace(/\b(ESPN|FOX|TNT|DAZN|DSport|Movistar|Win|Sky|Star\+?|Canal|HBO|MAX|Watch|Ver)\b.*/i, '')
      .replace(/[►▶•→]+.*/, '')
      .trim();
    if (!rawTitle || rawTitle.length < 4) continue;

    let league = '', matchTitle = rawTitle;
    if (rawTitle.includes(':')) {
      const pts  = rawTitle.split(':');
      league     = pts[0].trim();
      matchTitle = pts.slice(1).join(':').trim() || rawTitle;
    }

    // Canales: links dentro de esta fila
    const channels = [];
    const lRx = /href="(https?:\/\/[^"]+)"[^>]*>\s*([^<]{2,60}?)\s*</gi;
    let lm;
    lRx.lastIndex = 0;
    while ((lm = lRx.exec(row)) !== null) {
      const href = lm[1];
      const name = lm[2].replace(/[►▶•]/g,'').trim();
      if (name && href && !href.includes('futbollibre') && !href.includes('javascript')) {
        channels.push({ name, href });
      }
    }

    const key = `${time}|${matchTitle}`;
    if (seen.has(key) || matchTitle.length < 4) continue;
    seen.add(key);
    events.push({ time, match: matchTitle, league, flag: '⚽', channels });
  }

  // ── Estrategia 2: divs/li con clase que contenga "event" o "partido" ────
  if (events.length === 0) {
    const divRx = /<(?:div|li|article)[^>]*class="[^"]*(?:event|partido|match|fixture|game)[^"]*"[^>]*>([\s\S]*?)<\/(?:div|li|article)>/gi;
    let dm;
    while ((dm = divRx.exec(html)) !== null) {
      const block = dm[1];
      const text  = block.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      const timeM = text.match(/\b(\d{1,2}:\d{2})\b/);
      if (!timeM) continue;

      const rawTitle = text.replace(timeM[0], '').trim().split(/\b(ESPN|FOX|TNT)/i)[0].trim();
      if (!rawTitle || rawTitle.length < 4) continue;

      let league = '', matchTitle = rawTitle;
      if (rawTitle.includes(':')) {
        const pts = rawTitle.split(':');
        league    = pts[0].trim();
        matchTitle = pts.slice(1).join(':').trim() || rawTitle;
      }

      const key = `${timeM[1]}|${matchTitle}`;
      if (seen.has(key)) continue;
      seen.add(key);
      events.push({ time: timeM[1], match: matchTitle, league, flag: '⚽', channels: [] });
    }
  }

  // ── Estrategia 3: patrón libre hora + texto entre tags ──────────────────
  if (events.length === 0) {
    const raw = html.replace(/<script[\s\S]*?<\/script>/gi, '')
                    .replace(/<style[\s\S]*?<\/style>/gi, '');
    const lineRx = /\b(\d{1,2}:\d{2})\b\s*[^<\n]{0,10}([A-ZÁÉÍÓÚÑ][^<\n]{8,120})/g;
    let lm;
    while ((lm = lineRx.exec(raw)) !== null) {
      const time     = lm[1];
      const rawTitle = lm[2].replace(/<[^>]*/g,'').trim();
      if (!rawTitle || rawTitle.length < 5) continue;

      let league = '', matchTitle = rawTitle;
      if (rawTitle.includes(':')) {
        const pts = rawTitle.split(':');
        league    = pts[0].trim();
        matchTitle = pts.slice(1).join(':').trim() || rawTitle;
      }

      const key = `${time}|${matchTitle}`;
      if (seen.has(key)) continue;
      seen.add(key);
      events.push({ time, match: matchTitle, league, flag: '⚽', channels: [] });
    }
  }

  return events;
}

async function main() {
  console.log(`[${new Date().toISOString()}] === Iniciando scraper ===`);
  let events = [], source = 'none', htmlSample = '';

  // ── Intento 1: futbollibre.ec ─────────────────────────────────────────
  try {
    const html = await fetchUrl('https://futbollibre.ec');
    htmlSample  = html.substring(0, 2000); // para debug
    console.log(`[FL] Chars recibidos: ${html.length}`);
    console.log(`[FL] Primeros 500 chars:\n${html.substring(0,500)}`);
    console.log(`[FL] ¿Tiene <tr>? ${html.includes('<tr')}`);
    console.log(`[FL] ¿Tiene patrones de hora? ${/\d{1,2}:\d{2}/.test(html)}`);
    console.log(`[FL] ¿Tiene Cloudflare? ${html.toLowerCase().includes('cloudflare') || html.includes('cf-browser-verification')}`);

    if (html.length > 1000 && !html.includes('cf-browser-verification') && !html.includes('Just a moment')) {
      events = parseEventos(html);
      source  = 'futbollibre';
      console.log(`[FL] Eventos parseados: ${events.length}`);
      if (events.length > 0) console.log('[FL] Primeros 3:', JSON.stringify(events.slice(0,3)));
    } else {
      throw new Error('Cloudflare challenge detectado o HTML inválido');
    }
  } catch(e) {
    console.warn(`[FL] FALLÓ: ${e.message}`);
  }

  // ── Intento 2: Railway API ───────────────────────────────────────────
  if (events.length === 0) {
    try {
      const apiUrl = process.env.API_URL || 'https://sportstream-api-production.up.railway.app';
      console.log(`[API] Intentando ${apiUrl}/eventos ...`);
      const res  = await fetchUrl(apiUrl + '/eventos');
      const data = JSON.parse(res);
      if (data.events?.length) {
        events = data.events;
        source  = 'railway';
        console.log(`[API] OK - ${events.length} eventos`);
      } else {
        console.warn('[API] Sin eventos en respuesta');
      }
    } catch(e2) {
      console.warn(`[API] FALLÓ: ${e2.message}`);
    }
  }

  // ── Ordenar por hora ─────────────────────────────────────────────────
  events.sort((a, b) => {
    const m = t => { if(!t) return 9999; const [h,mm]=(t||'0:0').split(':').map(Number); return h*60+(mm||0); };
    return m(a.time) - m(b.time);
  });

  const output = {
    updated_at : new Date().toISOString(),
    date       : new Date().toLocaleDateString('es-ES', { weekday:'long', day:'numeric', month:'long' }),
    source,
    count      : events.length,
    events,
    _debug     : { html_sample: htmlSample.substring(0, 300) }
  };

  fs.writeFileSync(
    path.join(process.cwd(), 'eventos.json'),
    JSON.stringify(output, null, 2),
    'utf-8'
  );

  console.log(`✅ LISTO | fuente: ${source} | total: ${events.length}`);
  if (events.length === 0) {
    console.log('⚠️ 0 eventos - revisar logs de [FL] arriba para diagnóstico');
    process.exit(0); // no falla el Action, solo avisa
  }
}

main().catch(e => { console.error('ERROR FATAL:', e); process.exit(1); });
