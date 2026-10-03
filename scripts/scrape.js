const puppeteer = require('puppeteer');
const fs = require('fs');

const SITE_URL =
  process.env.SITE_URL || 'https://tarjetaroja.mba/';

const OUTPUT_FILE = 'eventos.json';

/* =========================================================
   UTILIDADES
========================================================= */

function normalizeTime(timeText, datetimeAttr) {
  // Usamos el atributo datetime si existe (es más limpio), si no, el texto visible
  if (datetimeAttr) {
    const match = String(datetimeAttr).match(/^(\d{2}):(\d{2})/);
    if (match) return `${match[1]}:${match[2]}`;
  }
  if (timeText) {
    const match = String(timeText).trim().match(/^(\d{2}):(\d{2})/);
    if (match) return `${match[1]}:${match[2]}`;
  }
  return null;
}

/*
  Se asume que la hora extraída ya está en hora de Colombia (UTC-5).
  Sumamos 5 horas para obtener UTC.
*/
function timeBogotaToUTC(time) {
  if (!time) return null;

  const match = time.match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;

  let hour = Number(match[1]);
  const minute = Number(match[2]);

  hour += 5;

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
  // Si la web ya nos da la liga por separado, la usamos directamente
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
   Abre la página /ver/... y extrae el src del iframe real
========================================================= */
async function getIframeSrc(browser, channelUrl) {
  if (!channelUrl) return null;
  
  if (channelUrl.includes('.m3u8') || channelUrl.includes('.mp4') || channelUrl.includes('embed')) {
    return channelUrl;
  }

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
    await page.close();
    return channelUrl; 
  }
}

/* =========================================================
   SCRAPER
   ========================================================= */

async function scrapeTarjetaRoja() {
  console.log('========================================');
  console.log('Iniciando scraper para tarjetaroja.love');
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

  await page.waitForSelector('.tr-event', { timeout: 15000 }).catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 3000));

  console.log('[PUP] Extrayendo datos del DOM...');

  const rawEvents = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('.tr-event'));
    
    if (items.length === 0) return [];

    return items.map(li => {
      const timeEl = li.querySelector('.tr-event-time');
      const timeText = timeEl ? timeEl.innerText.trim() : '';
      // Extraemos el texto visible de la hora (que debería ser la hora local del navegador)
      const datetimeAttr = timeEl ? timeEl.innerText.trim() : null;

      const titleEl = li.querySelector('.tr-event-title');
      let matchText = '';
      if (titleEl) {
        const clone = titleEl.cloneNode(true);
        const competitionSpan = clone.querySelector('.tr-event-competition');
        if (competitionSpan) competitionSpan.remove();
        matchText = clone.innerText.trim();
      }

      const leagueEl = li.querySelector('.tr-event-competition');
      const leagueText = leagueEl ? leagueEl.innerText.trim() : '';

      const channelLinks = Array.from(li.querySelectorAll('a.tr-event-channel'));
      const channels = channelLinks.map(a => ({
        name: (a.innerText || '').trim(),
        href: a.getAttribute('href')
      })).filter(c => c.name && c.href);

      return { timeText, datetimeAttr, matchText, leagueText, channels };
    }).filter(e => e.matchText);
  });

  console.log(`[PUP] ${rawEvents.length} eventos detectados. Extrayendo URLs finales...`);

  const events = [];

  for (const raw of rawEvents) {
    // Usamos la hora tal cual viene (sin restar 7 horas)
    const time = normalizeTime(raw.timeText, raw.datetimeAttr);

    const { league, match } = splitLeagueMatch(raw.matchText, raw.leagueText);

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
      time_utc: timeBogotaToUTC(time), // Convierte a UTC correctamente (hora + 5)
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
    fuente: 'tarjetaroja.love-puppeteer',
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
    `LISTO | tarjetaroja.love-puppeteer | total:${result.contar} | canales:${result.contar_con_canales}`
  );
  console.log(`Archivo: ${process.cwd()}/${OUTPUT_FILE}`);
}

scrapeTarjetaRoja().catch(error => {
  console.error('[PUP] ERROR FATAL:', error);
  process.exit(1);
});
