const puppeteer = require('puppeteer');
const fs = require('fs');

const SITE_URL =
  process.env.SITE_URL || 'https://rojadirectatvplus.net/agenda';

const OUTPUT_FILE = 'eventos.json';

/* =========================================================
   UTILIDADES
========================================================= */

function normalizeTime(datetimeAttr) {
  if (!datetimeAttr) return null;

  const match = String(datetimeAttr).match(/^(\d{2}):(\d{2})/);
  if (!match) return null;

  return `${match[1]}:${match[2]}`;
}

/*
  RojaDirecta muestra horarios en hora de Colombia (UTC-5),
  igual que futbollibres. Si el horario mostrado no corresponde,
  ajusta el offset aquí.
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

/*
  El texto del evento viene como "Copa Chile: O'Higgins vs Deportes
  Santa Cruz" (separador ":") pero también hay casos como
  "NFL – Green Bay Packers vs. Atlanta Falcons" (separador "–").
  Probamos varios separadores y solo los aceptamos si lo que queda
  después realmente parece un partido ("vs").
*/
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

  const value = String(name).replace(/\s+/g, ' ').trim();

  return value || `Canal ${index + 1}`;
}

/*
  El href de cada canal es:
    /embed/eventos.html?r=<base64>
  y el parámetro "r" en base64 decodifica directo a la URL real
  del stream. No hace falta navegar a ninguna parte.
*/
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
    new URL(decoded); // valida que el resultado sea una URL real
    return decoded;
  } catch (e) {
    console.log(`[PUP] No se pudo decodificar base64 de: ${href}`);
    return url.href;
  }
}

/* =========================================================
   SCRAPER
========================================================= */

async function scrapeRojaDirecta() {
  console.log('========================================');
  console.log('Iniciando scraper');
  console.log(`URL: ${SITE_URL}`);
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
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });

  console.log('[PUP] Página cargada');

  await new Promise(resolve => setTimeout(resolve, 2500));

  await page.waitForSelector('#menu', { timeout: 30000 });

  try {
    await page.waitForFunction(
      () => document.querySelectorAll('#menu li.toggle-submenu').length > 0,
      { timeout: 10000 }
    );
  } catch (e) {
    console.log('[PUP] No aparecieron eventos dentro del tiempo esperado');
  }

  /*
    -----------------------------------------------------------
    Todo el contenido (evento + canales) ya está en el DOM desde
    que carga la página, así que lo leemos en un solo evaluate,
    sin necesidad de clicks ni navegación.
    -----------------------------------------------------------
  */
  const rawEvents = await page.evaluate(() => {
    const items = Array.from(
      document.querySelectorAll('#menu > li.toggle-submenu')
    );

    return items.map(li => {
      const timeEl = li.querySelector('time');
      const datetimeAttr = timeEl ? timeEl.getAttribute('datetime') : null;

      // El <span> con el texto del partido está en el primer div,
      // junto al <time> y la bandera. Tomamos el span de mayor
      // longitud de texto dentro de ese primer bloque para no
      // depender de un orden exacto de hijos.
      const headerCandidates = Array.from(
        li.querySelectorAll(':scope > div span')
      );

      let matchText = '';
      for (const span of headerCandidates) {
        const text = (span.textContent || '').trim();
        if (text.length > matchText.length) {
          matchText = text;
        }
      }

      const channelLinks = Array.from(
        li.querySelectorAll('a.submenu-item[href]')
      );

      const channels = channelLinks.map(a => {
        const span = a.querySelector('span');
        return {
          name: span ? span.textContent.trim() : '',
          href: a.getAttribute('href')
        };
      });

      return { datetimeAttr, matchText, channels };
    });
  });

  console.log(`[PUP] ${rawEvents.length} eventos detectados`);

  const events = [];

  for (const raw of rawEvents) {
    const time = normalizeTime(raw.datetimeAttr);
    const { league, match } = splitLeagueMatch(raw.matchText);

    const channels = [];
    const seenChannels = new Set();

    raw.channels.forEach((channel, index) => {
      const url = decodeChannelHref(channel.href);
      if (!url || seenChannels.has(url)) return;

      seenChannels.add(url);
      channels.push({
        name: cleanChannelName(channel.name, index),
        url
      });
    });

    console.log(
      `-- ${time || '--:--'} | ${league ? league + ': ' : ''}${match} -> ${channels.length} canales`
    );

    events.push({
      time: time || '',
      time_utc: timeBogotaToUTC(time),
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
    fuente: 'rojadirecta-puppeteer',
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
    `LISTO | rojadirecta-puppeteer | total:${result.contar} | canales:${result.contar_con_canales}`
  );
  console.log(`Archivo: ${process.cwd()}/${OUTPUT_FILE}`);
}

scrapeRojaDirecta().catch(error => {
  console.error('[PUP] ERROR FATAL:', error);
  process.exit(1);
});
