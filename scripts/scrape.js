const puppeteer = require('puppeteer');
const fs = require('fs');

const SITE_URL = process.env.SITE_URL || 'https://tarjetaroja.love/';
const OUTPUT_FILE = 'eventos.json';

/* =========================================================
   UTILIDADES
========================================================= */

function normalizeTime(datetimeAttr) {
  if (!datetimeAttr) return null;
  const match = String(datetimeAttr).match(/^(\d{2}):(\d{2})/);
  return match ? `${match[1]}:${match[2]}` : null;
}

function timeBogotaToUTC(time) {
  if (!time) return null;
  const match = time.match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;

  let hour = Number(match[1]) + 5;
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

function splitLeagueMatch(rawText) {
  const text = String(rawText || '').replace(/\s+/g, ' ').trim();
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
  return String(name).replace(/\s+/g, ' ').trim() || `Canal ${index + 1}`;
}

function decodeChannelHref(href) {
  if (!href) return null;
  let url;
  try {
    url = new URL(href, SITE_URL);
  } catch (e) {
    return href;
  }

  const encoded = url.searchParams.get('r');
  if (!encoded) return url.href;

  try {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    new URL(decoded);
    return decoded;
  } catch (e) {
    return url.href;
  }
}

/* =========================================================
   EXTRACTOR DE IFRAME
   (Maneja el paso 3 de tus imágenes: clic en canal -> nueva página con iframe)
========================================================= */
async function getIframeSrc(browser, channelUrl) {
  if (!channelUrl) return null;
  
  // Si la URL ya parece un enlace directo a un stream o embed, la devolvemos
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
    
    // Esperar a que aparezca el iframe
    await page.waitForSelector('iframe', { timeout: 8000 });
    
    const src = await page.evaluate(() => {
      const iframe = document.querySelector('iframe');
      return iframe ? iframe.src : null;
    });

    await page.close();
    return src || channelUrl;
  } catch (error) {
    console.log(`[!] No se pudo extraer iframe de: ${channelUrl}`);
    await page.close();
    return channelUrl;
  }
}

/* =========================================================
   SCRAPER PRINCIPAL
========================================================= */

async function scrapeTarjetaRoja() {
  console.log('========================================');
  console.log('Iniciando scraper para tarjetaroja.love');
  console.log('========================================');

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });

  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on('request', req => {
    if (['image', 'font', 'media'].includes(req.resourceType())) req.abort();
    else req.continue();
  });

  await page.setUserAgent('Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36');
  await page.setViewport({ width: 390, height: 844, isMobile: true });

  console.log('[PUP] Cargando página...');
  await page.goto(SITE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // AJUSTA ESTOS SELECTORES: Inspecciona la página (F12) y cambia '.event-item', etc., por las clases reales.
  await page.waitForSelector('.event-item, .match-item, li', { timeout: 15000 }).catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 3000));

  console.log('[PUP] Extrayendo datos...');

  const rawEvents = await page.evaluate(() => {
    // AJUSTA ESTOS SELECTORES
    const items = Array.from(document.querySelectorAll('.event-item, .match-item, li'));

    return items.map(li => {
      const timeEl = li.querySelector('time, .time, .hora');
      const datetimeAttr = timeEl ? timeEl.getAttribute('datetime') : null;
      
      const headerCandidates = Array.from(li.querySelectorAll('span, div, h3, h4'));
      let matchText = '';
      for (const span of headerCandidates) {
        const text = (span.textContent || '').trim();
        if (text.length > matchText.length && text.includes('vs')) matchText = text;
      }

      const channelLinks = Array.from(li.querySelectorAll('a'));
      const channels = channelLinks.map(a => ({
        name: (a.textContent || '').trim(),
        href: a.getAttribute('href')
      })).filter(c => c.name && c.href);

      return { datetimeAttr, matchText, channels };
    });
  });

  console.log(`[PUP] ${rawEvents.length} eventos detectados. Procesando...`);

  const events = [];

  for (const raw of rawEvents) {
    const time = normalizeTime(raw.datetimeAttr);
    const { league, match } = splitLeagueMatch(raw.matchText);

    const channels = [];
    const seenChannels = new Set();

    for (let i = 0; i < raw.channels.length; i++) {
      const channel = raw.channels[i];
      
      // 1. Obtener URL (base64 o directa)
      let url = decodeChannelHref(channel.href);
      
      // 2. Si es una página intermedia, extraer iframe (Paso 3 de tus imágenes)
      if (url && !url.includes('.m3u8') && !url.includes('embed') && url.startsWith('http')) {
        // console.log(`   -> Extrayendo iframe para: ${channel.name}...`);
        url = await getIframeSrc(browser, url);
      }

      if (!url || seenChannels.has(url)) continue;
      seenChannels.add(url);
      
      channels.push({
        name: cleanChannelName(channel.name, i),
        url
      });
    }

    console.log(`-- ${time || '--:--'} | ${league ? league + ': ' : ''}${match} -> ${channels.length} canales`);

    events.push({
      time: time || '',
      time_utc: timeBogotaToUTC(time),
      match: match || '',
      league: league || '',
      flag: '⚽',
      channels
    });
  }

  // Ordenar y limpiar duplicados (Formato original)
  events.sort((a, b) => String(a.time).localeCompare(String(b.time)));
  const uniqueEvents = [];
  const seenEvents = new Set();

  for (const event of events) {
    const key = `${event.time}|${event.match}`;
    if (seenEvents.has(key)) continue;
    seenEvents.add(key);
    uniqueEvents.push(event);
  }

  // =========================================================
  // RESULTADO FINAL (Formato original que tenías)
  // =========================================================
  const result = {
    actualizado_en: new Date().toISOString(),
    fecha: new Date().toISOString().slice(0, 10),
    fuente: 'tarjetaroja.love-puppeteer',
    contar: uniqueEvents.length,
    contar_con_canales: uniqueEvents.filter(e => e.channels && e.channels.length > 0).length,
    events: uniqueEvents,
    eventos: uniqueEvents
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(result, null, 2), 'utf8');

  console.log('========================================');
  console.log(`[PUP] Total: ${result.contar}`);
  console.log(`[PUP] Con canales: ${result.contar_con_canales}`);
  console.log('========================================');

  await browser.close();
  console.log(`LISTO | Archivo: ${process.cwd()}/${OUTPUT_FILE}`);
}

scrapeTarjetaRoja().catch(error => {
  console.error('[PUP] ERROR FATAL:', error);
  process.exit(1);
});
