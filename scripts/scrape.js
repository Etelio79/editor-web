const puppeteer = require('puppeteer');
const fs = require('fs');

const SITE_URL = 'http://rojadirecta.tel/';
const OUTPUT_FILE = 'eventos.json';
const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

/* =========================================================
   UTILIDADES
========================================================= */

function normalizeTime(timeText) {
  if (!timeText) return null;
  const match = String(timeText).trim().match(/(\d{2}):(\d{2})/);
  return match ? `${match[1]}:${match[2]}` : null;
}

/*
  OFFSET_HORAS: horas que hay que SUMAR a la hora del sitio para tener UTC.
  Si el sitio muestra hora de Colombia (UTC-5) pon 5.
  Si muestra hora de México centro (UTC-6) pon 6.
*/
const OFFSET_HORAS = 5;

function timeToUTC(time) {
  if (!time) return null;
  const match = time.match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;

  let hour = Number(match[1]) + OFFSET_HORAS;
  const minute = Number(match[2]);

  let dayOffset = 0;
  if (hour >= 24) {
    hour -= 24;
    dayOffset = 1;
  }

  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + dayOffset, hour, minute, 0)
  ).toISOString();
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/*
  Devuelve { league, match } SIN repetir la liga dentro del match.
  Quita el prefijo de liga las veces que haga falta
  (ej. "Liga MX: Liga MX: Guadalajara vs Necaxa" -> "Guadalajara vs Necaxa").
*/
function cleanLeagueMatch(leagueRaw, matchRaw) {
  let league = String(leagueRaw || '').replace(/\s+/g, ' ').replace(/[:\-–—\s]+$/, '').trim();
  let match = String(matchRaw || '').replace(/\s+/g, ' ').trim();

  // Si no vino la liga por separado, intentar sacarla del texto "Liga: Equipo vs Equipo"
  if (!league) {
    const idx = match.indexOf(':');
    if (idx > -1) {
      league = match.slice(0, idx).trim();
      match = match.slice(idx + 1).trim();
    }
  }

  // Quitar la liga repetida al inicio del match, en bucle
  if (league) {
    const re = new RegExp(`^${escapeRegex(league)}\\s*[:\\-–—]?\\s*`, 'i');
    let prev;
    do {
      prev = match;
      match = match.replace(re, '').trim();
    } while (match !== prev && match);
  }

  return { league, match };
}

function cleanChannelName(name, index) {
  if (!name) return `Canal ${index + 1}`;
  const value = String(name).replace(/\s+/g, ' ').trim();
  return value || `Canal ${index + 1}`;
}

/* =========================================================
   CARGA CON REINTENTOS (evita el timeout de networkidle2)
========================================================= */

async function preparePage(browser) {
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on('request', req => {
    if (['image', 'font', 'media'].includes(req.resourceType())) req.abort();
    else req.continue();
  });
  await page.setUserAgent(MOBILE_UA);
  await page.setViewport({ width: 390, height: 844, isMobile: true });
  return page;
}

async function loadMainPage(browser) {
  // Intento 1-3: navegación normal, pero SIN esperar a que la red quede quieta
  for (let attempt = 1; attempt <= 3; attempt++) {
    const page = await preparePage(browser);
    try {
      console.log(`[PUP] Cargando página (intento ${attempt}/3)...`);
      await page.goto(SITE_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForSelector('a', { timeout: 15000 });
      await new Promise(r => setTimeout(r, 3000));
      return page;
    } catch (err) {
      console.log(`   [!] Intento ${attempt} falló: ${err.message}`);
      await page.close().catch(() => {});
      await new Promise(r => setTimeout(r, 3000 * attempt));
    }
  }

  // Plan B: bajar el HTML con fetch y pasarlo a puppeteer
  console.log('[PUP] Plan B: descargando HTML con fetch...');
  const res = await fetch(SITE_URL, { headers: { 'User-Agent': MOBILE_UA } });
  if (!res.ok) throw new Error(`fetch devolvió HTTP ${res.status}`);
  const html = await res.text();
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'domcontentloaded' });
  return page;
}

/* =========================================================
   EXTRACTOR DE IFRAME
========================================================= */
async function getIframeSrc(browser, channelUrl) {
  if (!channelUrl) return null;

  const page = await browser.newPage();
  try {
    await page.setRequestInterception(true);
    page.on('request', req => {
      if (['image', 'font', 'media'].includes(req.resourceType())) req.abort();
      else req.continue();
    });

    await page.goto(channelUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForSelector('iframe', { timeout: 8000 });

    const src = await page.evaluate(() => {
      const iframe = document.querySelector('iframe');
      return iframe ? iframe.src : null;
    });

    await page.close();
    return src || channelUrl;
  } catch (error) {
    console.log(`   [!] No se pudo extraer iframe de: ${channelUrl}`);
    await page.close().catch(() => {});
    return channelUrl;
  }
}

/* =========================================================
   SCRAPER PRINCIPAL
========================================================= */

async function scrapeRojadirecta() {
  console.log('========================================');
  console.log('Iniciando scraper para rojadirecta.tel');
  console.log('========================================');

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });

  const page = await loadMainPage(browser);
  console.log('[PUP] Página cargada, extrayendo datos del DOM...');

  const rawRows = await page.evaluate(() => {
    const results = [];
    const links = Array.from(document.querySelectorAll('a'));

    for (const a of links) {
      const fullText = a.textContent.trim();
      if (!fullText || !/\bvs\b|\sv\s| - /i.test(fullText)) continue;

      const href = a.getAttribute('href');
      if (!href) continue;

      // En el sitio la liga va en texto normal y los equipos en negrita
      const bold = a.querySelector('b, strong');
      let matchText = bold ? bold.textContent : fullText;
      let leagueText = '';
      if (bold) {
        leagueText = fullText.replace(bold.textContent, '');
      }

      const container = a.closest('tr') || a.closest('li') || a.parentElement;
      let timeText = '';
      if (container) {
        const m = container.textContent.match(/\b(\d{2}:\d{2})\b/);
        if (m) timeText = m[1];
      }

      if (timeText) {
        results.push({ timeText, leagueText, matchText, fullText, href });
      }
    }
    return results;
  });

  console.log(`[PUP] ${rawRows.length} filas detectadas. Agrupando eventos...`);

  const eventsMap = new Map();

  for (const raw of rawRows) {
    const time = normalizeTime(raw.timeText);
    if (!time) continue;

    const { league, match } = cleanLeagueMatch(
      raw.leagueText,
      raw.leagueText ? raw.matchText : raw.fullText
    );
    if (!match) continue;

    const key = `${time}|${match.toLowerCase()}`;

    if (!eventsMap.has(key)) {
      eventsMap.set(key, {
        time,
        time_utc: timeToUTC(time),
        league,          // solo el nombre de la liga
        match,           // solo los equipos
        flag: '⚽',
        channels: []
      });
    }

    const event = eventsMap.get(key);
    const channelSlug =
      raw.href.split('/').filter(Boolean).pop() || `Canal ${event.channels.length + 1}`;

    if (!event.channels.find(c => c.originalUrl === raw.href)) {
      event.channels.push({ originalUrl: raw.href, name: channelSlug });
    }
  }

  const events = [];

  for (const event of eventsMap.values()) {
    const resolvedChannels = [];
    const seenChannels = new Set();

    for (let i = 0; i < event.channels.length; i++) {
      const ch = event.channels[i];
      const absoluteUrl = new URL(ch.originalUrl, SITE_URL).href;
      const finalUrl = await getIframeSrc(browser, absoluteUrl);

      if (!finalUrl || seenChannels.has(finalUrl)) continue;
      seenChannels.add(finalUrl);

      resolvedChannels.push({ name: cleanChannelName(ch.name, i), url: finalUrl });
    }

    event.channels = resolvedChannels;
    console.log(
      `-- ${event.time} | ${event.league ? event.league + ' | ' : ''}${event.match} -> ${event.channels.length} canales`
    );
    events.push(event);
  }

  events.sort((a, b) => String(a.time).localeCompare(String(b.time)));

  const result = {
    actualizado_en: new Date().toISOString(),
    fecha: new Date().toISOString().slice(0, 10),
    fuente: 'rojadirecta.tel-puppeteer',
    contar: events.length,
    contar_con_canales: events.filter(e => Array.isArray(e.channels) && e.channels.length > 0).length,
    events,
    eventos: events
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(result, null, 2), 'utf8');

  console.log('========================================');
  console.log(`[PUP] Total: ${result.contar}`);
  console.log(`[PUP] Con canales: ${result.contar_con_canales}`);
  console.log('========================================');

  await browser.close();
  console.log(`LISTO | rojadirecta.tel-puppeteer | total:${result.contar} | canales:${result.contar_con_canales}`);
}

scrapeRojadirecta().catch(error => {
  console.error('[PUP] ERROR FATAL:', error);
  process.exit(1);
});
