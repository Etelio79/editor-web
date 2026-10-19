const puppeteer = require('puppeteer');
const fs = require('fs');

const SITE_URL = 'http://rojadirecta.tel/';
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
  La página guarda la hora original en UTC-5 (hora de Colombia/Perú/Ecuador).
  Sumamos 5 horas para obtener UTC.
*/
function timeOriginalToUTC(time) {
  if (!time) return null;
  const match = time.match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;

  let hour = Number(match[1]);
  const minute = Number(match[2]);
  hour += 3; // UTC-3 -> UTC

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
  const parts = url.split('/').filter(Boolean);
  const last = parts[parts.length - 1];
  return last || `Canal ${index + 1}`;
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

  // Forzamos zona horaria UTC para que el navegador no altere nada
  await page.emulateTimezone('UTC');

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

      const firstTd = tds[0];
      const link = firstTd.querySelector('a');
      if (!link) return null;

      const href = link.getAttribute('href');
      if (!href) return null;

      const fullText = firstTd.textContent.trim();
      const colonIdx = fullText.indexOf(':');
      let leagueText = '';
      let matchText = '';
      if (colonIdx > -1) {
        leagueText = fullText.slice(0, colonIdx).trim();
        matchText = fullText.slice(colonIdx + 1).trim();
      } else {
        matchText = fullText;
      }

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
        channels: []
      });
    }

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

      if (seenUrls.has(absoluteUrl)) continue;
      seenUrls.add(absoluteUrl);

      const finalUrl = await getIframeSrc(browser, absoluteUrl);
      if (!finalUrl) continue;

      channels.push({
        name: cleanChannelName(absoluteUrl, i),
        url: finalUrl
      });
    }

    // ─── CAMBIO CLAVE ──────────────────────────────────────
    // Calculamos el ISO en UTC y extraemos HH:MM para el campo "time".
    // Así la app (que interpreta "time" como UTC) mostrará la hora
    // local correcta de cada usuario, sin tocar la app.
    const isoUTC = timeOriginalToUTC(group.time);

    let timeUTC_HHMM = '';
    if (isoUTC) {
      const d = new Date(isoUTC);
      timeUTC_HHMM =
        d.getUTCHours().toString().padStart(2, '0') + ':' +
        d.getUTCMinutes().toString().padStart(2, '0');
    }
    // ───────────────────────────────────────────────────────

    console.log(`-- ${timeUTC_HHMM || '--:--'} UTC | ${group.league ? group.league + ': ' : ''}${group.match} -> ${channels.length} canales`);

    events.push({
      time: timeUTC_HHMM,        // ← HH:MM en UTC (antes venía en hora del sitio)
      time_utc: isoUTC,          // ← ISO completo en UTC (igual que antes)
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
