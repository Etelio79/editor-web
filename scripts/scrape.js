const puppeteer = require('puppeteer-core');
const fs        = require('fs');
const path      = require('path');
const https     = require('https');

/* ══════════════════════════════════════════════════════════════
   FETCH HELPER
══════════════════════════════════════════════════════════════ */
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ══════════════════════════════════════════════════════════════
   SCRAPING PRINCIPAL
   
   LÓGICA (3 niveles de profundidad):
   
   Nivel 1 — futbollibre.ec (lista principal)
     → extrae eventos con sus links internos
   
   Nivel 2 — futbollibre.ec/partido/xxx/ (página de detalle)
     → extrae el <iframe src="..."> que ES el embed
     → PARA AQUÍ: no entrar al iframe
   
   Lo que se guarda en eventos.json:
   {
     "channels": [
       { "name": "ESPN HD", "href": "https://tvtvhd.com/embed/?ch=espn1" }
     ]
   }
   
   El token IP se genera cuando el USUARIO abre ese embed
   desde su dispositivo → el interceptor del APK lo captura
══════════════════════════════════════════════════════════════ */
async function scrapeFutbolLibre() {
  const execPath = process.env.PUPPETEER_EXEC || '/usr/bin/chromium-browser';
  console.log(`[PUP] Chrome: ${execPath}`);

  const browser = await puppeteer.launch({
    executablePath: execPath,
    headless: 'new',
    args: [
      '--no-sandbox', '--disable-setuid-sandbox',
      '--disable-dev-shm-usage', '--disable-gpu',
      '--no-first-run', '--no-zygote', '--single-process'
    ]
  });

  try {
    /* ── NIVEL 1: Lista principal ──────────────────────────── */
    const mainPage = await browser.newPage();
    await mainPage.setRequestInterception(true);
    mainPage.on('request', req => {
      if (['image','font','stylesheet','media'].includes(req.resourceType())) req.abort();
      else req.continue();
    });
    await mainPage.setUserAgent(
      'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36'
    );
    await mainPage.setViewport({ width: 390, height: 844 });

    console.log('[PUP] Cargando futbollibre.ec ...');
    await mainPage.goto('https://futbollibre.ec', {
      waitUntil: 'networkidle2', timeout: 60000
    });

    try {
      await mainPage.waitForFunction(
        () => document.body.innerText.match(/\d{1,2}:\d{2}/),
        { timeout: 20000 }
      );
    } catch(e) { console.warn('[PUP] Horas no detectadas'); }

    /* Extraer eventos con sus links a páginas de detalle */
    const rawEvents = await mainPage.evaluate(() => {
      const results = [];
      const seen    = new Set();
      const timeRx  = /^\d{1,2}:\d{2}$/;
      const BASE     = 'https://futbollibre.ec';

      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
      const timeNodes = [];
      let node;
      while ((node = walker.nextNode())) {
        if (timeRx.test(node.textContent.trim())) timeNodes.push(node);
      }

      timeNodes.forEach(timeNode => {
        const time = timeNode.textContent.trim();
        let container = timeNode.parentElement;

        for (let i = 0; i < 6; i++) {
          if (!container) break;
          const hasLinks = container.querySelectorAll('a[href]').length > 0;
          const hasText  = Array.from(container.querySelectorAll('*'))
            .some(el => el.children.length === 0 && el.textContent.trim().length > 5 && !timeRx.test(el.textContent));
          if (hasLinks || hasText) break;
          container = container.parentElement;
        }
        if (!container) return;

        // Título del partido
        const allText = Array.from(container.querySelectorAll('*'))
          .filter(el => el.children.length === 0)
          .map(el => el.textContent.trim())
          .filter(t => t.length > 5 && !timeRx.test(t));
        const matchTitle = allText[0] || '';
        if (!matchTitle || matchTitle.length < 4) return;

        let league = '', match = matchTitle;
        if (matchTitle.includes(':')) {
          const pts = matchTitle.split(':');
          league = pts[0].trim();
          match  = pts.slice(1).join(':').trim() || matchTitle;
        }

        // Recopilar TODOS los links del contenedor
        // Incluye links de futbollibre.ec (páginas de detalle) y externos
        const links = [];
        container.querySelectorAll('a[href]').forEach(a => {
          const href = a.href || '';
          const name = a.textContent.replace(/[►▶•\-\s]+/g, ' ').trim() || 'Ver';
          if (
            href.startsWith('http') &&
            !href.includes('javascript') &&
            href !== BASE + '/' &&
            href !== BASE
          ) {
            links.push({ name, href });
          }
        });

        const key = `${time}|${match}`;
        if (seen.has(key)) return;
        seen.add(key);

        results.push({ time, match, league, flag: '⚽', _links: links });
      });

      return results;
    });

    console.log(`[PUP] Eventos encontrados: ${rawEvents.length}`);
    await mainPage.close();

    /* ── NIVEL 2: Páginas de detalle → extraer iframe src ──── */
    console.log('[PUP] Resolviendo iframes de detalle...');
    const events = await resolveDetailPages(browser, rawEvents);

    return events;

  } finally {
    await browser.close();
  }
}

/* ── Visita páginas de detalle y extrae SOLO el iframe src ── */
async function resolveDetailPages(browser, rawEvents) {
  const CONCURRENCY = 4;
  const MAX_EVENTS  = 40; // limitar para no tardar demasiado
  const result      = [];

  // Separar eventos que ya tienen links externos (embeds directos)
  // vs los que solo tienen links internos de futbollibre.ec
  for (const ev of rawEvents) {
    const external = (ev._links || []).filter(l => !l.href.includes('futbollibre.ec'));
    const internal = (ev._links || []).filter(l =>  l.href.includes('futbollibre.ec'));

    if (external.length > 0) {
      // Ya son embeds directos → usarlos tal cual
      result.push({
        time    : ev.time,
        match   : ev.match,
        league  : ev.league,
        flag    : ev.flag,
        channels: external
      });
    } else {
      // Links internos → necesita visitar la página de detalle
      result.push({ ...ev, channels: [], _needsDetail: internal });
    }
  }

  // Procesar los que necesitan página de detalle
  const needDetail = result.filter(ev => ev._needsDetail?.length > 0).slice(0, MAX_EVENTS);
  console.log(`[PUP] Eventos que necesitan detalle: ${needDetail.length}`);

  for (let i = 0; i < needDetail.length; i += CONCURRENCY) {
    const batch = needDetail.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(ev => fetchDetailPage(browser, ev)));
    console.log(`[PUP] Detalle: ${Math.min(i + CONCURRENCY, needDetail.length)}/${needDetail.length}`);
    if (i + CONCURRENCY < needDetail.length) await sleep(1000);
  }

  // Limpiar campos internos
  result.forEach(ev => { delete ev._links; delete ev._needsDetail; });

  return result;
}

/* Abre la página de detalle y extrae SOLO los iframe src */
async function fetchDetailPage(browser, ev) {
  const detailLinks = ev._needsDetail || [];
  if (!detailLinks.length) return;

  for (const link of detailLinks.slice(0, 2)) {
    try {
      const page = await browser.newPage();
      await page.setRequestInterception(true);
      page.on('request', req => {
        if (['image','font','stylesheet','media'].includes(req.resourceType())) req.abort();
        else req.continue();
      });
      await page.setUserAgent(
        'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36'
      );

      await page.goto(link.href, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await sleep(1500); // esperar JS dinámico

      /* Extraer iframes y links externos de la página de detalle
         ──────────────────────────────────────────────────────────
         IMPORTANTE: solo guardamos el src del iframe, NO lo cargamos.
         El token IP se generará cuando el USUARIO lo cargue desde su celular.
      */
      const found = await page.evaluate(() => {
        const channels = [];
        const seen     = new Set();

        const addCh = (name, href) => {
          if (!href || seen.has(href)) return;
          if (!href.startsWith('http')) return;
          if (href.includes('google') || href.includes('facebook') ||
              href.includes('twitter') || href.includes('ads')) return;
          seen.add(href);
          channels.push({ name: name || 'Ver partido', href });
        };

        // 1. Iframes directos (el embed del partido)
        document.querySelectorAll('iframe[src]').forEach(iframe => {
          const src = iframe.src || iframe.getAttribute('src') || '';
          const id  = iframe.id || iframe.getAttribute('data-id') || '';
          addCh(`Canal ${channels.length + 1}`, src);
        });

        // 2. Links externos que no sean de futbollibre.ec
        document.querySelectorAll('a[href]').forEach(a => {
          const href = a.href || '';
          const name = a.textContent.replace(/[►▶•\-\s]+/g,' ').trim();
          if (
            !href.includes('futbollibre') &&
            !href.includes('javascript') &&
            href.startsWith('http')
          ) {
            addCh(name || 'Ver partido', href);
          }
        });

        // 3. Buscar iframes en atributos data- (algunos sitios usan lazy loading)
        document.querySelectorAll('[data-src], [data-lazy-src]').forEach(el => {
          const src = el.getAttribute('data-src') || el.getAttribute('data-lazy-src') || '';
          if (src.startsWith('http')) addCh('Canal lazy', src);
        });

        return channels;
      });

      if (found.length > 0) {
        ev.channels = found;
        console.log(`[PUP] "${ev.match}" → ${found.length} canal(es): ${found[0].href.slice(0,60)}...`);
      }

      await page.close();
      if (ev.channels.length > 0) break; // encontró canales, no necesita más links

    } catch(e) {
      console.warn(`[PUP] Error detalle "${ev.match}": ${e.message}`);
    }
  }
}

/* ══════════════════════════════════════════════════════════════
   MAIN
══════════════════════════════════════════════════════════════ */
async function main() {
  console.log(`[${new Date().toISOString()}] === SportStream Scraper v3 (solo embeds) ===`);
  let events = [], source = 'none';

  // Intento 1: Scraping con detalle de páginas
  try {
    events = await scrapeFutbolLibre();
    if (events.length > 0) source = 'futbollibre-embed';
  } catch(e) {
    console.warn(`[PUP] FALLÓ: ${e.message}`);
  }

  // Intento 2: Railway API fallback
  if (events.length === 0) {
    try {
      const apiUrl = process.env.API_URL || 'https://sportstream-api-production.up.railway.app';
      const data = await fetchJson(apiUrl + '/eventos');
      if (data.events?.length || data.eventos?.length) {
        events = data.events || data.eventos;
        source = 'railway-fallback';
      }
    } catch(e) {
      console.warn(`[API] FALLÓ: ${e.message}`);
    }
  }

  // Ordenar por hora
  events.sort((a, b) => {
    const m = t => { const [h,mm]=(t||'0:0').split(':').map(Number); return h*60+(mm||0); };
    return m(a.time) - m(b.time);
  });

  const conCanales = events.filter(e => (e.channels||[]).length > 0).length;

  const output = {
    actualizado_en : new Date().toISOString(),
    fecha          : new Date().toLocaleDateString('es-ES',{weekday:'long',day:'numeric',month:'long'}),
    fuente         : source,
    contar         : events.length,
    contar_con_canales: conCanales,
    eventos        : events,
    events         : events   // alias para compatibilidad con el frontend
  };

  fs.writeFileSync(
    path.join(process.cwd(), 'eventos.json'),
    JSON.stringify(output, null, 2),
    'utf-8'
  );

  console.log(`✅ LISTO | fuente: ${source} | total: ${events.length} | con canales: ${conCanales}`);
  if (events.length === 0) process.exit(1);
}

main().catch(e => { console.error('ERROR FATAL:', e); process.exit(1); });
