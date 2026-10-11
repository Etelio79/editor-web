const puppeteer = require('puppeteer');
const fs = require('fs');

const SITE_URL = 'https://rojadirecta.cash/';
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
  La página muestra la hora original en UTC-6 (Hora del Centro de México).
  Sumamos 6 horas para obtener UTC.
*/
function timeMexicoToUTC(time) {
  if (!time) return null;
  const match = time.match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;

  let hour = Number(match[1]);
  const minute = Number(match[2]);
  hour += 6; // UTC-6 -> UTC

  let dayOffset = 0;
  if (hour >= 24) {
    hour -= 24;
    dayOffset = 1;
  }

  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const day = now.getUTCDate() + dayOffset;

  return new Date(Date.UTC(year, month, day, hour, minute, 0)).toISOString();
}

function splitLeagueMatch(rawTitle, rawLeague) {
  // La liga ya viene separada en el primer <td>, pero por si acaso
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

function cleanChannelName(url, index) {
  if (!url) return `Canal ${index + 1}`;
  // Extraemos el último segmento: /stream/espn3 -> espn3
  const parts = url.split('/').filter(Boolean);
  const last = parts[parts.length - 1];
  return last || `Canal ${index + 1}`;
}

/* =========================================================
   EXTRACTOR DE IFRAME
   Abre la página /stream/... y extrae el src del iframe real
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

async function scrapeRojaDirecta() {
  console.log('========================================');
  console.log('Iniciando scraper para rojadirecta.cash');
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

  await page.waitForSelector('.programacion table', { timeout: 15000 }).catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 3000));

  console.log('[PUP] Extrayendo datos del DOM...');

  const rawEvents = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.programacion table tbody tr'));
    if (rows.length === 0) return [];

    return rows.map(tr => {
      const tds = tr.querySelectorAll('td');
      if (tds.length < 3) return null;

      // Primer td: "Liga:<a href="..."><b>Equipos</b></a>"
      const firstTd = tds[0];
      const link = firstTd.querySelector('a');
      if (!link) return null;

      const href = link.getAttribute('href');
      if (!href) return null;

      // Texto completo del primer td: "Liga:Equipos"
      const fullText = firstTd.textContent.trim();
      // Separamos por el primer ":"
      const colonIdx = fullText.indexOf(':');
      let leagueText = '';
      let matchText = '';
      if (colonIdx > -1) {
        leagueText = fullText.slice(0, colonIdx).trim();
        matchText = fullText.slice(colonIdx + 1).trim();
      } else {
        matchText = fullText;
      }

      // Tercer td: hora
      const timeSpan = tds[2].querySelector('span.t');
      const timeText = timeSpan ? timeSpan.getAttribute('data-rj-original-time') || timeSpan.textContent.trim() : '';

      return {
        leagueText,
        matchText,
        timeText,
        href
      };
    }).filter(Boolean);
  });

  console.log(`[PUP] ${rawEvents.length} filas detectadas. Agrupando eventos...`);

  // Agrupamos por liga + partido
  const grouped = new Map();

  for (const raw of rawEvents) {
    const league = raw.leagueText.trim();
    const match = raw.matchText.trim();
    const key = `${league}|${match}`;

    if (!grouped.has(key)) {
      grouped.set(key, {
        league,
        match,
        time: normalizeTime(raw.timeText),
        channels: [] // { href }
      });
    }

    // Añadimos el canal (puede haber duplicados de URL, los filtramos después)
    grouped.get(key).channels.push({ href: raw.href });
  }

  console.log(`[PUP] ${grouped.size} eventos únicos tras agrupar. Extrayendo URLs finales...`);

  const events = [];

  for (const [key, group] of grouped.entries()) {
    const channels = [];
    const seenUrls = new Set();

    for (let i = 0; i < group.channels.length; i++) {
      const ch = group.channels[i];
      const absoluteUrl = new URL(ch.href, SITE_URL).href;

      // Evitamos duplicados de URL
      if (seenUrls.has(absoluteUrl)) continue;
      seenUrls.add(absoluteUrl);

      const finalUrl = await getIframeSrc(browser, absoluteUrl);
      if (!finalUrl) continue;

      channels.push({
        name: cleanChannelName(absoluteUrl, i),
        url: finalUrl
      });
    }

    console.log(`-- ${group.time || '--:--'} | ${group.league ? group.league + ': ' : ''}${group.match} -> ${channels.length} canales`);

    events.push({
      time: group.time || '',
      time_utc: timeMexicoToUTC(group.time),
      match: group.match,
      league: group.league,
      flag: '⚽',
      channels
    });
  }

  events.sort((a, b) => String(a.time).localeCompare(String(b.time)));

  const result = {
    actualizado_en: new Date().toISOString(),
    fecha: new Date().toISOString().slice(0, 10),
    fuente: 'rojadirecta.cash-puppeteer',
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

  console.log('[PUP] Navegador cerrado');
  console.log(
    `LISTO | rojadirecta.cash-puppeteer | total:${result.contar} | canales:${result.contar_con_canales}`
  );
  console.log(`Archivo: ${process.cwd()}/${OUTPUT_FILE}`);
}

scrapeRojaDirecta().catch(error => {
  console.error('[PUP] ERROR FATAL:', error);
  process.exit(1);
});
