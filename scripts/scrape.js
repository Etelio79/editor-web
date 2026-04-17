const puppeteer = require('puppeteer-core');
const fs        = require('fs');
const path      = require('path');
const https     = require('https');

/* ── Fetch simple (para Railway API fallback) ── */
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'SportStreamBot/1.0' }
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch(e) { reject(new Error('JSON inválido')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

/* ── Scraping con Puppeteer ── */
async function scrapeFutbolLibre() {
  const execPath = process.env.PUPPETEER_EXEC || '/usr/bin/chromium-browser';
  console.log(`[PUP] Usando Chrome: ${execPath}`);

  const browser = await puppeteer.launch({
    executablePath: execPath,
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
    ]
  });

  try {
    const page = await browser.newPage();

    // Bloquear imágenes, fuentes y CSS para ir más rápido
    await page.setRequestInterception(true);
    page.on('request', req => {
      const type = req.resourceType();
      if (['image','font','stylesheet','media'].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.setUserAgent(
      'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
    );
    await page.setViewport({ width: 390, height: 844 });

    console.log('[PUP] Navegando a futbollibre.ec ...');
    await page.goto('https://futbollibre.ec', {
      waitUntil: 'networkidle2',
      timeout: 45000
    });

    // Esperar a que aparezcan elementos con hora
    try {
      await page.waitForFunction(
        () => document.body.innerText.match(/\d{1,2}:\d{2}/),
        { timeout: 15000 }
      );
      console.log('[PUP] Horas detectadas en la página ✅');
    } catch(e) {
      console.warn('[PUP] No se detectaron horas, intentando parsear de todas formas...');
    }

    // Extraer eventos desde el DOM
    const events = await page.evaluate(() => {
      const results = [];
      const seen    = new Set();
      const timeRx  = /^\d{1,2}:\d{2}$/;

      // Buscar todos los nodos de texto que sean solo una hora
      const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT,
        null
      );

      const timeNodes = [];
      let node;
      while ((node = walker.nextNode())) {
        if (timeRx.test(node.textContent.trim())) {
          timeNodes.push(node);
        }
      }

      console.log('Nodos de hora encontrados:', timeNodes.length);

      timeNodes.forEach(timeNode => {
        const time = timeNode.textContent.trim();
        // Subir hasta encontrar el contenedor del evento
        let container = timeNode.parentElement;
        for (let i = 0; i < 5; i++) {
          if (!container) break;
          // Si tiene links de canales, este es el contenedor
          if (container.querySelectorAll('a[href]').length > 0) break;
          container = container.parentElement;
        }
        if (!container) return;

        // Texto del partido — buscar el elemento más largo que no sea solo la hora
        const allText = Array.from(container.querySelectorAll('*'))
          .filter(el => el.children.length === 0)
          .map(el => el.textContent.trim())
          .filter(t => t.length > 5 && !timeRx.test(t));

        const matchTitle = allText[0] || '';
        if (!matchTitle) return;

        // Separar liga y partido
        let league = '', match = matchTitle;
        if (matchTitle.includes(':')) {
          const pts = matchTitle.split(':');
          league    = pts[0].trim();
          match     = pts.slice(1).join(':').trim() || matchTitle;
        }

        // Canales
        const channels = [];
        container.querySelectorAll('a[href]').forEach(a => {
          const name = a.textContent.replace(/[►▶•\-]/g, '').trim();
          const href = a.href;
          if (name && href && !href.includes('javascript') &&
              (href.startsWith('http')) && !href.includes('futbollibre')) {
            channels.push({ name, href });
          }
        });

        const key = `${time}|${match}`;
        if (seen.has(key) || match.length < 4) return;
        seen.add(key);

        results.push({ time, match, league, flag: '⚽', channels });
      });

      return results;
    });

    console.log(`[PUP] Eventos extraídos: ${events.length}`);
    if (events.length > 0) {
      console.log('[PUP] Muestra:', JSON.stringify(events.slice(0, 2)));
    }

    return events;

  } finally {
    await browser.close();
  }
}

/* ── Main ── */
async function main() {
  console.log(`[${new Date().toISOString()}] === SportStream Scraper ===`);
  let events = [], source = 'none';

  // Intento 1: Puppeteer → futbollibre.ec
  try {
    events = await scrapeFutbolLibre();
    if (events.length > 0) source = 'futbollibre-puppeteer';
  } catch(e) {
    console.warn(`[PUP] FALLÓ: ${e.message}`);
  }

  // Intento 2: Railway API fallback
  if (events.length === 0) {
    try {
      const apiUrl = process.env.API_URL || 'https://sportstream-api-production.up.railway.app';
      console.log(`[API] Intentando ${apiUrl}/eventos ...`);
      const data = await fetchJson(apiUrl + '/eventos');
      if (data.events?.length) {
        events = data.events;
        source  = 'railway';
        console.log(`[API] OK - ${events.length} eventos`);
      }
    } catch(e2) {
      console.warn(`[API] FALLÓ: ${e2.message}`);
    }
  }

  // Ordenar por hora
  events.sort((a, b) => {
    const m = t => { if(!t) return 9999; const [h,mm]=(t||'0:0').split(':').map(Number); return h*60+(mm||0); };
    return m(a.time) - m(b.time);
  });

  const output = {
    updated_at : new Date().toISOString(),
    date       : new Date().toLocaleDateString('es-ES', { weekday:'long', day:'numeric', month:'long' }),
    source,
    count      : events.length,
    events
  };

  fs.writeFileSync(
    path.join(process.cwd(), 'eventos.json'),
    JSON.stringify(output, null, 2),
    'utf-8'
  );

  console.log(`✅ LISTO | fuente: ${source} | total: ${events.length}`);
  if (events.length === 0) {
    console.warn('⚠️ 0 eventos guardados');
  }
}

main().catch(e => { console.error('ERROR FATAL:', e); process.exit(1); });
