const puppeteer = require('puppeteer');
const fs = require('fs');

const SITE_URL = 'http://rojadirecta.tel/';
const OUTPUT_FILE = 'eventos.json';

/* =========================================================
   UTILIDADES (SIN CAMBIOS)
========================================================= */

function normalizeTime(timeText) {
  if (!timeText) return null;
  const match = String(timeText).trim().match(/^(\d{1,2}):(\d{2})/);
  return match ? `${match[1].padStart(2, '0')}:${match[2]}` : null;
}

function timeMexicoToUTC(time) {
  if (!time) return null;
  const match = time.match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  hour += 6;
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

function splitLeagueMatch(rawTitle) {
  const text = String(rawTitle || '').replace(/\s+/g, ' ').trim();
  
  const parts = text.split(':').map(p => p.trim());
  if (parts.length >= 2) {
    const league = parts[0];
    let match = parts.slice(1).join(': ').trim();
    const leagueRegex = new RegExp(`^${league.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[:\\s-]+`, 'i');
    match = match.replace(leagueRegex, '').trim();
    
    if (league && match) {
      return { league, match };
    }
  }
  
  const separators = ['–', '—', ' - '];
  for (const sep of separators) {
    const idx = text.indexOf(sep);
    if (idx > -1) {
      const league = text.slice(0, idx).trim();
      let match = text.slice(idx + sep.length).trim();
      const leagueRegex = new RegExp(`^${league.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[:\\s-]+`, 'i');
      match = match.replace(leagueRegex, '').trim();
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
   EXTRACTOR DE IFRAME (Aumento de timeout a 15s)
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
    await page.goto(channelUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    
    // Aumentamos a 15 segundos por si el reproductor tarda en cargar
    await page.waitForSelector('iframe', { timeout: 15000 });
    
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
   SCRAPER PRINCIPAL
========================================================= */

async function scrapeRojadirecta() {
  console.log('========================================');
  console.log('Iniciando scraper para rojadirecta.tel');
  console.log('========================================');

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-features=HttpsFirstBalancedModeAutoEnable'
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
  await page.goto(SITE_URL, { waitUntil: 'networkidle2', timeout: 60000 });
  console.log('[PUP] Página cargada');
  
  // Hacer scroll para forzar la carga de todos los eventos si hay "lazy loading"
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await new Promise(resolve => setTimeout(resolve, 3000));

  console.log('[PUP] Extrayendo datos del DOM...');

  // NUEVA LÓGICA: Recorre todos los <a>, sube a su contenedor y busca Hora + "vs"
  const rawRows = await page.evaluate(() => {
    const results = [];
    const links = Array.from(document.querySelectorAll('a'));

    for (const a of links) {
      const href = a.getAttribute('href');
      if (!href || href === '#' || href.startsWith('javascript')) continue;

      let container = a;
      let timeText = '';
      let titleText = '';

      // Subir hasta 5 niveles en el HTML para encontrar la fila entera
      for (let i = 0; i < 5; i++) {
        if (!container) break;
        
        const text = container.textContent.replace(/\s+/g, ' ').trim();
        
        // Verificar si este contenedor tiene la hora y el partido
        if (/\b\d{1,2}:\d{2}\b/.test(text) && (/\bvs\b/i.test(text) || / - /.test(text))) {
          const timeMatch = text.match(/\b\d{1,2}:\d{2}\b/);
          timeText = timeMatch[0];
          // Quitar la hora del texto para que quede "Liga: Equipo vs Equipo"
          titleText = text.replace(timeText, '').trim();
          break;
        }
        container = container.parentElement;
      }

      if (timeText && titleText) {
        // Evitar procesar el mismo enlace dos veces
        if (!results.find(r => r.href === href && r.timeText === timeText)) {
          results.push({ timeText, titleText, href });
        }
      }
    }
    return results;
  });

  console.log(`[PUP] ${rawRows.length} filas detectadas. Agrupando eventos...`);

  // AGRUPACIÓN
  const eventsMap = new Map();

  for (const raw of rawRows) {
    const time = normalizeTime(raw.timeText);
    if (!time) continue;

    const { league, match } = splitLeagueMatch(raw.titleText);
    const key = `${time}|${match}`;

    if (!eventsMap.has(key)) {
      eventsMap.set(key, {
        time: time,
        time_utc: timeMexicoToUTC(time),
        match: match || '',
        league: league || '',
        flag: '⚽',
        channels: []
      });
    }

    const event = eventsMap.get(key);
    const channelSlug = raw.href.split('/').filter(Boolean).pop() || `Canal ${event.channels.length + 1}`;
    
    if (!event.channels.find(c => c.originalUrl === raw.href)) {
      event.channels.push({ originalUrl: raw.href, name: channelSlug });
    }
  }

  const events = [];

  // PROCESAMIENTO DE CANALES E IFRAMES
  for (const event of eventsMap.values()) {
    const resolvedChannels = [];
    const seenChannels = new Set();

    for (let i = 0; i < event.channels.length; i++) {
      const ch = event.channels[i];
      const absoluteUrl = new URL(ch.originalUrl, SITE_URL).href;
      
      const finalUrl = await getIframeSrc(browser, absoluteUrl);

      if (!finalUrl || seenChannels.has(finalUrl)) continue;
      seenChannels.add(finalUrl);

      resolvedChannels.push({
        name: cleanChannelName(ch.name, i),
        url: finalUrl
      });
    }

    event.channels = resolvedChannels;
    console.log(`-- ${event.time || '--:--'} | ${event.league ? event.league + ': ' : ''}${event.match} -> ${event.channels.length} canales`);
    events.push(event);
  }

  events.sort((a, b) => String(a.time).localeCompare(String(b.time)));

  const result = {
    actualizado_en: new Date().toISOString(),
    fecha: new Date().toISOString().slice(0, 10),
    fuente: 'rojadirecta.tel-puppeteer',
    contar: events.length,
    contar_con_canales: events.filter(
      event => Array.isArray(event.channels) && event.channels.length > 0
    ).length,
    events: events,
    eventos: events
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(result, null, 2), 'utf8');

  console.log('========================================');
  console.log(`[PUP] Total: ${result.contar}`);
  console.log(`[PUP] Con canales: ${result.contar_con_canales}`);
  console.log('========================================');

  await browser.close();

  console.log('[PUP] Navegador cerrado');
  console.log(`LISTO | rojadirecta.tel-puppeteer | total:${result.contar} | canales:${result.contar_con_canales}`);
  console.log(`Archivo: ${process.cwd()}/${OUTPUT_FILE}`);
}

scrapeRojadirecta().catch(error => {
  console.error('[PUP] ERROR FATAL:', error);
  process.exit(1);
});
