const puppeteer = require('puppeteer');
const fs = require('fs');

const SITE_URL = 'https://tarjetaroja.mba/';
const OUTPUT_FILE = 'eventos.json';
const SITE_HOST = new URL(SITE_URL).host;
const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* =========================================================
   UTILIDADES (IGUAL QUE EL SCRAPER ORIGINAL)
========================================================= */

function normalizeTime(timeText) {
  if (!timeText) return null;
  const match = String(timeText).trim().match(/^(\d{1,2}):(\d{2})/);
  return match ? `${match[1].padStart(2, '0')}:${match[2]}` : null;
}

/*
  Igual que el original: se suman 6 horas para obtener UTC.
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

  return new Date(Date.UTC(year, month, day, hour, minute, 0)).toISOString();
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/*
  "Liga MX: Guadalajara vs Necaxa" -> { league: 'Liga MX', match: 'Guadalajara vs Necaxa' }
  Quita la liga si quedara repetida dentro del match.
*/
function splitLeagueMatch(rawTitle) {
  const text = String(rawTitle || '').replace(/\s+/g, ' ').replace(/▶|►|▼/g, '').trim();

  const idx = text.indexOf(':');
  if (idx > -1) {
    const league = text.slice(0, idx).trim();
    let match = text.slice(idx + 1).trim();

    if (league) {
      const re = new RegExp(`^${escapeRegex(league)}\\s*[:\\-–—]?\\s*`, 'i');
      let prev;
      do {
        prev = match;
        match = match.replace(re, '').trim();
      } while (match !== prev && match);
    }

    if (league && match) return { league, match };
  }

  return { league: '', match: text };
}

function cleanChannelName(name, index) {
  if (!name) return `Canal ${index + 1}`;
  const value = String(name).replace(/\s+/g, ' ').replace(/▶|►|▼/g, '').trim();
  return value || `Canal ${index + 1}`;
}

/* =========================================================
   PÁGINA
========================================================= */

async function newPage(browser) {
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

/* =========================================================
   EXTRACTOR DE IFRAME DEL REPRODUCTOR (ignora anuncios)
========================================================= */

const AD_PATTERN =
  /doubleclick|googlesyndication|googleads|adsterra|popads|propeller|exoclick|histats|facebook\.com|twitter\.com|banner|\/ads?[\/\-_.]|adserver|taboola|outbrain/i;

async function getIframeSrc(browser, channelUrl) {
  if (!channelUrl) return null;

  const page = await newPage(browser);
  try {
    await page.goto(channelUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForSelector('iframe', { timeout: 10000 });
    await sleep(1500); // dar tiempo a que el iframe real reemplace al de carga

    const frames = await page.evaluate(() =>
      Array.from(document.querySelectorAll('iframe')).map(f => {
        const r = f.getBoundingClientRect();
        return { src: f.src || f.getAttribute('data-src') || '', area: r.width * r.height };
      })
    );

    await page.close();

    const good = frames
      .filter(f => /^https?:/i.test(f.src) && !AD_PATTERN.test(f.src))
      .sort((a, b) => b.area - a.area);

    return good.length ? good[0].src : channelUrl;
  } catch (error) {
    console.log(`   [!] No se pudo extraer iframe de: ${channelUrl}`);
    await page.close().catch(() => {});
    return channelUrl;
  }
}

/* =========================================================
   SCRAPER PRINCIPAL
========================================================= */

async function scrapeTarjetaRoja() {
  console.log('========================================');
  console.log('Iniciando scraper para tarjetaroja.mba');
  console.log('========================================');

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });

  const page = await newPage(browser);

  // 1) Abrir la página
  let loaded = false;
  for (let attempt = 1; attempt <= 3 && !loaded; attempt++) {
    try {
      console.log(`[PUP] Cargando página (intento ${attempt}/3)...`);
      await page.goto(SITE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
      loaded = true;
    } catch (err) {
      console.log(`   [!] Intento ${attempt} falló: ${err.message}`);
      await sleep(3000 * attempt);
    }
  }
  if (!loaded) throw new Error('No se pudo cargar tarjetaroja.mba');

  // 2) Esperar los eventos y marcar cada fila con data-sx
  await page
    .waitForFunction(() => /\d{2}:\d{2}[\s\S]{0,200}\svs\s/i.test(document.body.innerText), {
      timeout: 30000,
      polling: 1000
    })
    .catch(() => console.log('   [!] No aparecieron eventos en 30s'));
  await sleep(1500);

  console.log('[PUP] Extrayendo eventos del DOM...');

  const rawRows = await page.evaluate(() => {
    const re = /^\d{1,2}:\d{2}\s+.+\svs\s.+/i;
    const norm = el => el.textContent.replace(/\s+/g, ' ').trim();
    const isRow = el => {
      const t = norm(el);
      return t.length < 220 && re.test(t);
    };

    const all = Array.from(document.querySelectorAll('li, tr, div, a, p, span'));
    const rows = all.filter(el => isRow(el) && !Array.from(el.children).some(isRow));

    return rows.map((el, i) => {
      el.setAttribute('data-sx', String(i));
      const text = norm(el);
      const m = text.match(/^(\d{1,2}:\d{2})\s+(.+)$/);
      return { idx: i, timeText: m ? m[1] : '', titleText: m ? m[2] : text };
    });
  });

  console.log(`[PUP] ${rawRows.length} eventos detectados. Abriendo acordeones...`);

  // Cerrar pestañas de publicidad que se abran al hacer clic
  let clicking = false;
  browser.on('targetcreated', async target => {
    if (!clicking || target.type() !== 'page') return;
    try {
      const p = await target.page();
      if (p && p !== page) await p.close();
    } catch (e) {}
  });

  const visibleLinks = () =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll('a[href]'))
        .filter(a => a.getClientRects().length > 0)
        .map(a => ({
          href: a.href,
          text: a.textContent.replace(/\s+/g, ' ').trim()
        }))
    );

  // 3) Para cada evento: clic -> leer canales nuevos que aparecen -> cerrar
  const eventsMap = new Map();
  let debugShown = 0;

  for (const raw of rawRows) {
    const time = normalizeTime(raw.timeText);
    if (!time) continue;

    const { league, match } = splitLeagueMatch(raw.titleText);
    if (!match) continue;

    const key = `${time}|${match.toLowerCase()}`;
    if (!eventsMap.has(key)) {
      eventsMap.set(key, {
        time,
        time_utc: timeMexicoToUTC(time),
        match,
        league,
        flag: '⚽',
        channels: []
      });
    }
    const event = eventsMap.get(key);

    try {
      const handle = await page.$(`[data-sx="${raw.idx}"]`);
      if (!handle) continue;

      const before = new Set((await visibleLinks()).map(l => `${l.href}\t${l.text}`));

      clicking = true;
      await handle.click();
      await sleep(600);
      clicking = false;

      if (!page.url().startsWith(SITE_URL.replace(/\/$/, ''))) {
        console.log(`   [!] La página redirigió a ${page.url()}, volviendo...`);
        await page.goBack().catch(() => {});
        continue;
      }

      const after = await visibleLinks();
      const fresh = after.filter(
        l =>
          !before.has(`${l.href}\t${l.text}`) &&
          /^https?:/i.test(l.href) &&
          l.href.replace(/\/$/, '') !== SITE_URL.replace(/\/$/, '')
      );

      // preferir enlaces del mismo sitio
      const sameHost = fresh.filter(l => {
        try { return new URL(l.href).host === SITE_HOST; } catch (e) { return false; }
      });
      const chosen = sameHost.length ? sameHost : fresh;

      for (const l of chosen) {
        if (!event.channels.find(c => c.originalUrl === l.href)) {
          event.channels.push({ originalUrl: l.href, name: l.text });
        }
      }

      if (chosen.length === 0 && debugShown < 2) {
        debugShown++;
        const html = await page.evaluate(i => {
          const el = document.querySelector(`[data-sx="${i}"]`);
          return el && el.parentElement ? el.parentElement.outerHTML.slice(0, 900) : '';
        }, raw.idx);
        console.log(`   [DEBUG] Sin canales para "${match}". HTML cercano:\n${html}`);
      }

      // cerrar el acordeón
      await handle.click().catch(() => {});
      await sleep(150);
    } catch (err) {
      clicking = false;
      console.log(`   [!] Error con "${match}": ${err.message}`);
    }
  }

  await page.close();

  // 4) Resolver iframes (3 en paralelo, con pausa)
  const cache = new Map();
  const queue = [];
  for (const event of eventsMap.values()) {
    for (const ch of event.channels) queue.push(ch);
  }

  async function worker() {
    while (queue.length) {
      const ch = queue.shift();
      const abs = new URL(ch.originalUrl, SITE_URL).href;
      if (!cache.has(abs)) cache.set(abs, await getIframeSrc(browser, abs));
      ch.resolved = cache.get(abs);
      await sleep(300);
    }
  }
  await Promise.all([worker(), worker(), worker()]);

  const events = [];

  for (const event of eventsMap.values()) {
    const resolvedChannels = [];
    const seenChannels = new Set();

    event.channels.forEach((ch, i) => {
      const finalUrl = ch.resolved;
      if (!finalUrl || seenChannels.has(finalUrl)) return;
      seenChannels.add(finalUrl);
      resolvedChannels.push({ name: cleanChannelName(ch.name, i), url: finalUrl });
    });

    event.channels = resolvedChannels;

    console.log(
      `-- ${event.time || '--:--'} | ${event.league ? event.league + ': ' : ''}${event.match} -> ${event.channels.length} canales`
    );
    events.push(event);
  }

  events.sort((a, b) => String(a.time).localeCompare(String(b.time)));

  const result = {
    actualizado_en: new Date().toISOString(),
    fecha: new Date().toISOString().slice(0, 10),
    fuente: 'tarjetaroja.mba-puppeteer',
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
    `LISTO | tarjetaroja.mba-puppeteer | total:${result.contar} | canales:${result.contar_con_canales}`
  );
  console.log(`Archivo: ${process.cwd()}/${OUTPUT_FILE}`);
}

scrapeTarjetaRoja().catch(error => {
  console.error('[PUP] ERROR FATAL:', error);
  process.exit(1);
});
