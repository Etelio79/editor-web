const puppeteer = require('puppeteer');
const fs = require('fs');

const SITE_URL = 'https://futbollibremx.mx/';
const OUTPUT_FILE = 'eventos.json';

/* =========================================================
   UTILIDADES
========================================================= */

function normalizeTime(timeText) {
  if (!timeText) return null;
  const match = String(timeText).trim().match(/^(\d{2}):(\d{2})/);
  return match ? `${match[1]}:${match[2]}` : null;
}

/*
  El sitio muestra la hora en UTC-6 (Hora del Centro de México).
  Sumamos 6 horas para obtener UTC.
*/
function timeMexicoToUTC(time) {
  if (!time) return null;

  const match = time.match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;

  let hour = Number(match[1]);
  const minute = Number(match[2]);

  hour += 6; // Convertir de UTC-6 a UTC

  let dayOffset = 0;
  if (hour >= 24) {
    hour -= 24;
    dayOffset = 1;
  }

  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const day = now.getUTCDate() + dayOffset;

  return new Date(
    Date.UTC(year, month, day, hour, minute, 0)
  ).toISOString();
}

function splitLeagueMatch(rawTitle, rawLeague) {
  if (rawLeague && rawLeague.trim() !== '') {
    return { league: rawLeague.trim(), match: rawTitle.trim() };
  }

  const text = String(rawTitle || '').replace(/\s+/g, ' ').trim();
  const separators = [':', '–', '—', ' - '];

  for (const sep of separators) {
    const idx = text.indexOf(sep);
    if (idx > -1) {
      const league = text.slice(0, idx).trim();
      const match = text.slice(idx + sep.length).trim();
      if (league && match && /\bvs\.?\b/i.test(match)) {
        return { league, match };
      }
    }
  }
  return { league: '', match: text };
}

function cleanChannelName(name, index) {
  if (!name) return `Canal ${index + 1}`;
  const value = String(name).replace(/\s+/g, ' ').trim();
  return value || `Canal ${index + 1}`;
}

/* =========================================================
   EXTRACTOR DE IFRAME
   Abre la página /eventos.html?r=... y extrae el src del iframe real
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

    // Esperar el iframe del reproductor
    await page.waitForSelector('iframe', { timeout: 8000 });

    const src = await page.evaluate(() => {
      const iframe = document.querySelector('iframe');
      return iframe ? iframe.src : null;
    });

    await page.close();
    return src || channelUrl;
  } catch (error) {
    console.log(`   [!] No se pudo extraer iframe de: ${channelUrl}`);
    await page.close();
    return channelUrl;
  }
}

/* =========================================================
   SCRAPER
   ========================================================= */

async function scrapeFutbolLibreMX() {
  console.log('========================================');
  console.log('Iniciando scraper para futbollibremx.mx');
  console.log('========================================');

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ]
  });

  const page = await browser.newPage();

  await page.setRequestInterception(true);
  page.on('request', request => {
    const type = request.resourceType();
    if (type === 'image' || type === 'font' || type === 'media') {
      request.abort();
    } else {
      request.continue();
    }
  });

  await page.setUserAgent(
    'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
  );

  await page.setViewport({ width: 390, height: 844, isMobile: true });

  console.log('[PUP] Cargando página...');

  await page.goto(SITE_URL, {
    waitUntil: 'networkidle2',
    timeout: 60000
  });

  console.log('[PUP] Página cargada');

  // Esperar el menú de la agenda
  await page.waitForSelector('#menu-agenda', { timeout: 15000 }).catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 3000));

  console.log('[PUP] Extrayendo datos del DOM...');

  const rawEvents = await page.evaluate(() => {
    const menu = document.querySelector('#menu-agenda');
    if (!menu) return [];

    const items = Array.from(menu.children); // <li> directos

    return items.map(li => {
      // Título y hora
      const mainLink = li.querySelector('a');
      if (!mainLink) return null;

      const timeSpan = mainLink.querySelector('.t');
      const timeText = timeSpan ? timeSpan.textContent.trim() : '';

      // Título: texto del enlace sin la hora
      const clone = mainLink.cloneNode(true);
      if (clone.querySelector('.t')) clone.querySelector('.t').remove();
      const titleText = clone.textContent.trim();

      // Liga: clase del <li> (ej. F1, ENG, ESP, etc.)
      const leagueText = li.className || '';

      // Canales: sublista
      const subUl = li.querySelector('ul');
      const channels = [];
      if (subUl) {
        const subItems = Array.from(subUl.querySelectorAll('li.subitem1'));
        subItems.forEach(subLi => {
          const a = subLi.querySelector('a');
          if (a) {
            const name = a.textContent.replace(/\s*HD\s*$/i, '').trim();
            const href = a.getAttribute('href');
            if (name && href) channels.push({ name, href });
          }
        });
      }

      return { timeText, titleText, leagueText, channels };
    }).filter(e => e && e.titleText);
  });

  console.log(`[PUP] ${rawEvents.length} eventos detectados. Extrayendo URLs finales...`);

  const events = [];

  for (const raw of rawEvents) {
    const time = normalizeTime(raw.timeText);

    const { league, match } = splitLeagueMatch(raw.titleText, raw.leagueText);

    const channels = [];
    const seenChannels = new Set();

    for (let i = 0; i < raw.channels.length; i++) {
      const channel = raw.channels[i];

      const absoluteUrl = new URL(channel.href, SITE_URL).href;
      const finalUrl = await getIframeSrc(browser, absoluteUrl);

      if (!finalUrl || seenChannels.has(finalUrl)) continue;
      seenChannels.add(finalUrl);

      channels.push({
        name: cleanChannelName(channel.name, i),
        url: finalUrl
      });
    }

    console.log(`-- ${time || '--:--'} | ${league ? league + ': ' : ''}${match} -> ${channels.length} canales`);

    events.push({
      time: time || '',
      time_utc: timeMexicoToUTC(time),
      match: match || '',
      league: league || '',
      flag: '⚽',
      channels
    });
  }

  events.sort((a, b) => String(a.time).localeCompare(String(b.time)));

  const uniqueEvents = [];
  const seenEvents = new Set();

  for (const event of events) {
    const key = `${event.time}|${event.match}`;
    if (seenEvents.has(key)) continue;
    seenEvents.add(key);
    uniqueEvents.push(event);
  }

  const result = {
    actualizado_en: new Date().toISOString(),
    fecha: new Date().toISOString().slice(0, 10),
    fuente: 'futbollibremx.mx-puppeteer',
    contar: uniqueEvents.length,
    contar_con_canales: uniqueEvents.filter(
      event => Array.isArray(event.channels) && event.channels.length > 0
    ).length,
    events: uniqueEvents,
    eventos: uniqueEvents
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(result, null, 2), 'utf8');

  console.log('========================================');
  console.log(`[PUP] Total: ${result.contar}`);
  console.log(`[PUP] Con canales: ${result.contar_con_canales}`);
  console.log('========================================');

  await browser.close();

  console.log('[PUP] Navegador cerrado');
  console.log(
    `LISTO | futbollibremx.mx-puppeteer | total:${result.contar} | canales:${result.contar_con_canales}`
  );
  console.log(`Archivo: ${process.cwd()}/${OUTPUT_FILE}`);
}

scrapeFutbolLibreMX().catch(error => {
  console.error('[PUP] ERROR FATAL:', error);
  process.exit(1);
});
