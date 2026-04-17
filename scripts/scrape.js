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
      if (enc === 'gzip')    { const z = require('zlib'); stream = res.pipe(z.createGunzip()); }
      else if (enc === 'br') { const z = require('zlib'); stream = res.pipe(z.createBrotliDecompress()); }
      stream.on('data', c => chunks.push(c));
      stream.on('end',  () => resolve(Buffer.concat(chunks).toString('utf-8')));
      stream.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(25000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function parseEventos(html) {
  const events = [];
  const seen   = new Set();

  // Buscar todos los pares hora + contenido
  const timeRx  = /(\d{1,2}:\d{2})/g;
  const linkRx  = /href="(https?:\/\/[^"]+)"[^>]*>\s*([^<]{2,60})\s*<\/a>/g;

  // Partir el HTML en bloques por cada hora encontrada
  const parts = html.split(/(?=\b\d{1,2}:\d{2}\b)/);

  for (const part of parts) {
    const tm = part.match(/^(\d{1,2}:\d{2})/);
    if (!tm) continue;
    const time = tm[1];

    // Extraer texto legible del bloque (sin tags)
    const text = part.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

    // Buscar nombre del partido: texto largo entre la hora y los primeros links
    const nameMatch = text.match(/^\d{1,2}:\d{2}\s+(.{5,120?}?)(?:\s+(?:ESPN|FOX|TNT|DAZN|DSport|Movistar|Win|Sky|Star|Canal|https?)|$)/);
    const rawTitle  = nameMatch ? nameMatch[1].trim() : '';
    if (!rawTitle || rawTitle.length < 4) continue;

    // Separar liga y partido
    let league = '', matchTitle = rawTitle;
    if (rawTitle.includes(':')) {
      const pts  = rawTitle.split(':');
      league     = pts[0].trim();
      matchTitle = pts.slice(1).join(':').trim() || rawTitle;
    }

    // Extraer canales del bloque
    const channels = [];
    let lm;
    linkRx.lastIndex = 0;
    while ((lm = linkRx.exec(part)) !== null) {
      const href = lm[1];
      const name = lm[2].replace(/[►▶•\-]/g, '').trim();
      if (name && href && !href.includes('futbollibre') && !href.includes('javascript')) {
        channels.push({ name, href });
      }
    }

    const key = `${time}|${matchTitle}`;
    if (seen.has(key)) continue;
    seen.add(key);

    events.push({ time, match: matchTitle, league, flag: '⚽', channels });
  }

  return events;
}

async function main() {
  console.log('[' + new Date().toISOString() + '] Scraping futbollibre.ec...');
  let events = [], source = 'none';

  // Intento 1: futbollibre.ec directo
  try {
    const html = await fetchUrl('https://futbollibre.ec');
    if (html.length > 2000 && html.includes(':')) {
      events = parseEventos(html);
      source  = 'futbollibre';
      console.log('futbollibre OK - eventos:', events.length);
    } else {
      throw new Error('HTML inválido o Cloudflare challenge');
    }
  } catch(e) {
    console.warn('futbollibre falló:', e.message);

    // Intento 2: API Railway
    try {
      const apiUrl = process.env.API_URL || 'https://sportstream-api-production.up.railway.app';
      const res    = await fetchUrl(apiUrl + '/eventos');
      const data   = JSON.parse(res);
      if (data.events?.length) {
        events = data.events;
        source  = 'railway';
        console.log('Railway OK - eventos:', events.length);
      }
    } catch(e2) {
      console.warn('Railway falló:', e2.message);
    }
  }

  // Ordenar por hora
  events.sort((a, b) => {
    const m = t => { const [h,mm]=(t||'0:0').split(':').map(Number); return h*60+(mm||0); };
    return m(a.time) - m(b.time);
  });

  const output = {
    updated_at : new Date().toISOString(),
    date       : new Date().toLocaleDateString('es-ES', {weekday:'long',day:'numeric',month:'long'}),
    source,
    count      : events.length,
    events
  };

  fs.writeFileSync(
    path.join(process.cwd(), 'eventos.json'),
    JSON.stringify(output, null, 2),
    'utf-8'
  );

  console.log('✅ eventos.json guardado | fuente:', source, '| total:', events.length);
}

main().catch(e => { console.error('ERROR:', e); process.exit(1); });
