const puppeteer = require('puppeteer-core');
const fs        = require('fs');
const path      = require('path');
const https     = require('https');

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers:{'User-Agent':'SportStreamBot/1.0'} }, res => {
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
   LANZAR BROWSER
══════════════════════════════════════════════════════════════ */
function launchBrowser() {
  const execPath = process.env.PUPPETEER_EXEC || '/usr/bin/chromium-browser';
  return puppeteer.launch({
    executablePath: execPath,
    headless: 'new',
    args: [
      '--no-sandbox','--disable-setuid-sandbox',
      '--disable-dev-shm-usage','--disable-gpu',
      '--no-first-run','--no-zygote','--single-process',
      '--disable-blink-features=AutomationControlled', // evitar detección de bot
    ]
  });
}

/* ══════════════════════════════════════════════════════════════
   PASO 1: Obtener lista de eventos desde la página principal
   Solo extrae: time, match, league + URL de la página de detalle
══════════════════════════════════════════════════════════════ */
async function getEventList(browser) {
  const page = await browser.newPage();

  // Interceptar respuestas JSON de la API interna del sitio
  const apiData = [];
  page.on('response', async res => {
    const ct  = res.headers()['content-type'] || '';
    const url = res.url();
    if (ct.includes('json') && (url.includes('/api') || url.includes('schedule') || url.includes('match') || url.includes('event'))) {
      try {
        const json = await res.json();
        apiData.push({ url, json });
        console.log(`[API intercept] ${url}`);
      } catch(e) {}
    }
  });

  await page.setRequestInterception(true);
  page.on('request', req => {
    if (['image','font','stylesheet','media'].includes(req.resourceType())) req.abort();
    else req.continue();
  });

  await page.setUserAgent('Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36');
  await page.setViewport({ width: 390, height: 844 });

  console.log('[PASO1] Cargando página principal...');
  await page.goto('https://futbollibre.ec', { waitUntil:'networkidle2', timeout:60000 });

  // Intentar usar los datos de la API interna si los capturamos
  for (const { url, json } of apiData) {
    const list = Array.isArray(json) ? json : (json.data || json.matches || json.events || []);
    if (list.length > 0) {
      console.log(`[PASO1] API interna capturada (${list.length} items): ${url}`);
      await page.close();
      return normalizeApiEvents(list);
    }
  }

  // Fallback: scraping DOM de la lista principal
  try {
    await page.waitForFunction(() => document.body.innerText.match(/\d{1,2}:\d{2}/), { timeout:20000 });
  } catch(e) { console.warn('[PASO1] Horas no detectadas'); }

  const events = await page.evaluate(() => {
    const results = [];
    const seen    = new Set();
    const timeRx  = /^\d{1,2}:\d{2}$/;
    const BASE    = location.origin;

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    const timeNodes = [];
    let node;
    while ((node = walker.nextNode())) {
      if (timeRx.test(node.textContent.trim())) timeNodes.push(node);
    }

    timeNodes.forEach(timeNode => {
      const eventTime = timeNode.textContent.trim();
      let container = timeNode.parentElement;
      for (let i = 0; i < 8; i++) {
        if (!container) break;
        const links = container.querySelectorAll('a[href]');
        const texts = Array.from(container.querySelectorAll('*')).filter(el =>
          el.children.length === 0 && el.textContent.trim().length > 6 && !timeRx.test(el.textContent)
        );
        if (links.length > 0 || texts.length > 0) break;
        container = container.parentElement;
      }
      if (!container) return;

      // Texto del partido
      const textEls = Array.from(container.querySelectorAll('*'))
        .filter(el => el.children.length === 0 && el.textContent.trim().length > 5 && !timeRx.test(el.textContent));
      const rawTitle = textEls[0]?.textContent?.trim() || '';
      if (!rawTitle || rawTitle.length < 4) return;

      let league = '', matchName = rawTitle;
      if (rawTitle.includes(':')) {
        const pts = rawTitle.split(':');
        league    = pts[0].trim();
        matchName = pts.slice(1).join(':').trim() || rawTitle;
      }

      // Buscar link de detalle
      const detailLink = Array.from(container.querySelectorAll('a[href]'))
        .find(a => a.href && a.href.includes(location.hostname) && a.href !== BASE + '/');

      const key = `${eventTime}|${matchName}`;
      if (seen.has(key)) return;
      seen.add(key);

      results.push({
        time    : eventTime,
        match   : matchName,
        league  : league,
        flag    : '⚽',
        channels: [],
        _detailUrl: detailLink?.href || ''
      });
    });

    return results;
  });

  console.log(`[PASO1] ${events.length} eventos encontrados`);
  await page.close();
  return events;
}

/* ══════════════════════════════════════════════════════════════
   PASO 2: Visitar página de detalle de cada evento
   CLICK en cada botón de canal → esperar iframe → capturar src

   futbollibre.ec funciona así:
   - La página de detalle muestra botones de canales (ej: "ESPN HD")
   - Al hacer CLIC en un botón, aparece un iframe con el embed
   - Ese iframe src ES la URL que necesitamos
══════════════════════════════════════════════════════════════ */
async function getChannelsFromDetailPage(browser, ev) {
  if (!ev._detailUrl) return [];

  const page = await browser.newPage();
  const channels = [];

  // Interceptar TODAS las peticiones para capturar:
  // 1. URLs de iframes que se cargan dinámicamente
  // 2. Peticiones a APIs de canales
  const capturedUrls = new Set();

  page.on('response', async res => {
    const url = res.url();
    const ct  = res.headers()['content-type'] || '';
    // Capturar respuestas JSON que puedan contener URLs de embeds
    if (ct.includes('json')) {
      try {
        const json = await res.json();
        const str  = JSON.stringify(json);
        // Buscar URLs de embeds o streams en el JSON
        const embedRx = /https?:\/\/[^\s"'\\]+(?:embed|player|watch|stream)[^\s"'\\]*/gi;
        let m;
        while ((m = embedRx.exec(str)) !== null) {
          const u = m[0].replace(/\\u002F/g,'/');
          if (!u.includes('google') && !u.includes('facebook')) capturedUrls.add(u);
        }
      } catch(e) {}
    }
  });

  await page.setRequestInterception(true);
  page.on('request', req => {
    const url  = req.url();
    const type = req.resourceType();
    // Dejar pasar scripts (necesarios para la funcionalidad de los botones)
    if (['image','font','stylesheet','media'].includes(type)) req.abort();
    else req.continue();
  });

  await page.setUserAgent('Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36');

  try {
    console.log(`[PASO2] "${ev.match}" → ${ev._detailUrl}`);
    await page.goto(ev._detailUrl, { waitUntil:'networkidle2', timeout:25000 });
    await sleep(2000);

    // ── Buscar botones de canal en el DOM ────────────────────────
    // Varios patrones comunes de futbollibre.ec:
    // <button class="canal-btn" data-url="...">ESPN HD</button>
    // <a class="channel" data-embed="...">Canal 1</a>
    // <div class="opcion-canal" onclick="...">Fox Sports</div>
    const channelSelectors = [
      'button[data-url]', 'button[data-embed]', 'button[data-src]',
      'a[data-url]', 'a[data-embed]', 'a[data-src]',
      '[class*="canal"],[class*="channel"],[class*="opcion"],[class*="option"]',
      '[onclick*="embed"],[onclick*="player"],[onclick*="canal"]',
      'li[data-id]', '.btn-canal', '.canal-item',
    ];

    // Verificar cuántos botones de canal hay
    const btnCount = await page.evaluate((selectors) => {
      for (const sel of selectors) {
        const els = document.querySelectorAll(sel);
        if (els.length > 0) return { count: els.length, selector: sel };
      }
      return { count: 0, selector: null };
    }, channelSelectors);

    console.log(`[PASO2]   Botones encontrados: ${btnCount.count} (${btnCount.selector})`);

    if (btnCount.count > 0) {
      // Hacer clic en cada botón y capturar el iframe resultante
      const foundChannels = await clickChannelButtons(page, btnCount.selector, ev.match);
      channels.push(...foundChannels);
    }

    // Si no hubo botones, buscar iframes estáticos
    if (channels.length === 0) {
      const staticIframes = await page.evaluate(() => {
        const iframes = [];
        document.querySelectorAll('iframe[src]').forEach(f => {
          const src = f.src || f.getAttribute('src') || '';
          if (src.startsWith('http') && !src.includes('google') && !src.includes('ads')) {
            iframes.push(src);
          }
        });
        // También data-src (lazy loaded)
        document.querySelectorAll('[data-src],[data-lazy]').forEach(f => {
          const src = f.getAttribute('data-src') || f.getAttribute('data-lazy') || '';
          if (src.startsWith('http')) iframes.push(src);
        });
        return iframes;
      });

      staticIframes.forEach((src, i) => {
        channels.push({ name: `Canal ${i+1}`, href: src });
      });
    }

    // Agregar URLs capturadas de respuestas JSON
    capturedUrls.forEach(url => {
      if (!channels.some(c => c.href === url)) {
        channels.push({ name: 'Canal (auto)', href: url });
      }
    });

  } catch(e) {
    console.warn(`[PASO2] Error "${ev.match}": ${e.message}`);
  } finally {
    await page.close();
  }

  if (channels.length > 0) {
    console.log(`[PASO2]   ✅ "${ev.match}" → ${channels.length} canal(es)`);
  }
  return channels;
}

/* ── Hace clic en cada botón de canal y captura el iframe ─── */
async function clickChannelButtons(page, selector, matchName) {
  const channels = [];

  // Obtener info de todos los botones
  const buttons = await page.evaluate((sel) => {
    return Array.from(document.querySelectorAll(sel)).slice(0, 6).map((el, i) => ({
      index : i,
      text  : el.textContent?.replace(/[^\w\s]/g,'').trim() || `Canal ${i+1}`,
      dataUrl   : el.getAttribute('data-url') || el.getAttribute('data-embed') ||
                  el.getAttribute('data-src')  || el.getAttribute('data-iframe') || '',
      onclick   : el.getAttribute('onclick') || '',
      href      : el.tagName === 'A' ? el.href : '',
    }));
  }, selector);

  console.log(`[CLICK]   ${buttons.length} botones para "${matchName}"`);

  for (const btn of buttons) {
    // Si el botón ya tiene la URL en un atributo data-, usarla directamente
    if (btn.dataUrl && btn.dataUrl.startsWith('http')) {
      console.log(`[CLICK]     data-url encontrada: ${btn.dataUrl.slice(0,60)}`);
      channels.push({ name: btn.text || `Canal ${btn.index+1}`, href: btn.dataUrl });
      continue;
    }

    // Si tiene onclick con URL
    if (btn.onclick && btn.onclick.includes('http')) {
      const m = btn.onclick.match(/https?:\/\/[^'")\s]+/);
      if (m) {
        channels.push({ name: btn.text || `Canal ${btn.index+1}`, href: m[0] });
        continue;
      }
    }

    // Hacer clic y esperar cambio de iframe
    try {
      const iframeBefore = await page.evaluate(() => {
        const f = document.querySelector('iframe[src]');
        return f ? f.src : '';
      });

      // Clic en el botón n-ésimo
      await page.evaluate((sel, idx) => {
        const el = document.querySelectorAll(sel)[idx];
        if (el) el.click();
      }, selector, btn.index);

      // Esperar a que aparezca un iframe nuevo o cambie el src
      let iframeAfter = '';
      for (let t = 0; t < 6; t++) {
        await sleep(800);
        iframeAfter = await page.evaluate((prevSrc) => {
          const iframes = document.querySelectorAll('iframe[src]');
          for (const f of iframes) {
            if (f.src && f.src !== prevSrc && f.src.startsWith('http') && !f.src.includes('ads')) {
              return f.src;
            }
          }
          return '';
        }, iframeBefore);
        if (iframeAfter) break;
      }

      if (iframeAfter && iframeAfter !== iframeBefore) {
        console.log(`[CLICK]     Clic → iframe: ${iframeAfter.slice(0,60)}`);
        channels.push({ name: btn.text || `Canal ${btn.index+1}`, href: iframeAfter });
      }

    } catch(e) {
      console.warn(`[CLICK]     Error en clic ${btn.index}: ${e.message}`);
    }
  }

  return channels;
}

/* ── Normalizar eventos de API interna ──────────────────────── */
function normalizeApiEvents(list) {
  return list.map(item => {
    const channels = [];
    const rawCh = item.channels || item.canales || item.links || [];
    rawCh.forEach(ch => {
      if (typeof ch === 'string') channels.push({ name:'Canal', href:ch });
      else channels.push({ name:ch.name||ch.nombre||'Canal', href:ch.url||ch.href||ch.embed||ch.link||'' });
    });
    return {
      time    : item.time     || item.tiempo    || item.hora   || '00:00',
      match   : item.match    || item.partido   || item.titulo || item.name  || '',
      league  : item.league   || item.liga      || item.torneo || '',
      flag    : '⚽',
      channels: channels.filter(c => c.href.startsWith('http'))
    };
  }).filter(ev => ev.match.length > 2);
}

/* ══════════════════════════════════════════════════════════════
   MAIN
══════════════════════════════════════════════════════════════ */
async function main() {
  console.log(`[${new Date().toISOString()}] === SportStream Scraper v4 ===`);
  let events = [], source = 'none';

  // ── Intento principal: scraping con clics ───────────────────
  try {
    const browser = await launchBrowser();

    try {
      // Paso 1: lista de eventos
      events = await getEventList(browser);

      if (events.length > 0) {
        // Paso 2: canales por clic en páginas de detalle
        const CONCURRENCY = 3;
        const WITH_DETAIL  = events.filter(e => e._detailUrl);
        console.log(`\n[PASO2] Procesando ${WITH_DETAIL.length} eventos con detalle...\n`);

        for (let i = 0; i < WITH_DETAIL.length; i += CONCURRENCY) {
          const batch = WITH_DETAIL.slice(i, i + CONCURRENCY);
          const results = await Promise.all(
            batch.map(ev => getChannelsFromDetailPage(browser, ev))
          );
          batch.forEach((ev, j) => { ev.channels = results[j]; });
          if (i + CONCURRENCY < WITH_DETAIL.length) await sleep(2000);
        }

        source = 'futbollibre-v4';
      }
    } finally {
      await browser.close();
    }
  } catch(e) {
    console.warn(`[PUP] FALLÓ: ${e.message}`);
  }

  // ── Fallback: Railway API ───────────────────────────────────
  if (events.length === 0) {
    try {
      const apiUrl = process.env.API_URL || 'https://sportstream-api-production.up.railway.app';
      const data = await fetchJson(apiUrl + '/eventos');
      const list = data.events || data.eventos || [];
      if (list.length > 0) { events = list; source = 'railway'; }
    } catch(e) { console.warn(`[API] FALLÓ: ${e.message}`); }
  }

  // ── Limpiar campos internos y normalizar ────────────────────
  events = events.map(ev => {
    // Normalizar: aceptar TANTO campo en inglés COMO en español
    // Así el frontend funciona sin importar cuál usa el scraper
    const time     = ev.time     || ev.tiempo    || '00:00';
    const match    = ev.match    || ev.fósforo   || ev.partido  || ev.titulo || '';
    const league   = ev.league   || ev.liga      || ev.torneo   || '';
    const flag     = ev.flag     || ev.bandera   || '⚽';
    const channels = (ev.channels || ev.canales  || []).filter(c => c && c.href);

    return { time, match, league, flag, channels };
  }).filter(ev => ev.match.length > 2);

  // Ordenar por hora
  events.sort((a, b) => {
    const m = t => { const [h,mm]=(t||'0:0').split(':').map(Number); return h*60+(mm||0); };
    return m(a.time) - m(b.time);
  });

  const conCanales = events.filter(e => e.channels.length > 0).length;

  // Reporte detallado en consola
  console.log('\n════ RESUMEN ════');
  events.slice(0,5).forEach(ev => {
    console.log(`  ${ev.time} | ${ev.match} | canales: ${ev.channels.length}`);
    ev.channels.forEach(c => console.log(`    → ${c.name}: ${c.href.slice(0,70)}`));
  });
  console.log('════════════════');

  const output = {
    actualizado_en     : new Date().toISOString(),
    fecha              : new Date().toLocaleDateString('es-ES',{weekday:'long',day:'numeric',month:'long'}),
    fuente             : source,
    contar             : events.length,
    contar_con_canales : conCanales,
    events,          // campo en inglés (para el frontend)
    eventos: events  // campo en español (alias)
  };

  fs.writeFileSync(
    path.join(process.cwd(), 'eventos.json'),
    JSON.stringify(output, null, 2),
    'utf-8'
  );

  console.log(`\n✅ LISTO | fuente:${source} | total:${events.length} | con canales:${conCanales}`);
  if (events.length === 0) process.exit(1);
}

main().catch(e => { console.error('ERROR FATAL:', e); process.exit(1); });
