const puppeteer = require('puppeteer-core');
const fs        = require('fs');
const path      = require('path');
const https     = require('https');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Convierte "19:00" (hora Colombia, UTC-5) a ISO UTC
// Ejemplo: "19:00" → "2026-04-19T00:00:00.000Z"
function timeColombiaToUTC(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  const now = new Date();
  // Tomamos la fecha de HOY en Colombia (UTC-5)
  // Para saber qué fecha es en Colombia, restamos 5h al UTC actual
  const bogotaOffset = 5 * 60 * 60 * 1000; // UTC-5 en ms
  const nowBogota = new Date(now.getTime() - bogotaOffset);
  const utc = new Date(Date.UTC(
    nowBogota.getUTCFullYear(),
    nowBogota.getUTCMonth(),
    nowBogota.getUTCDate(),
    h + 5,  // convertir hora Colombia → UTC sumando 5h
    m
  ));
  return utc.toISOString();
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'SportStreamBot/1.0' }
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch(e) { reject(new Error('JSON invalido')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

async function scrapeFutbolLibre() {
  const execPath = process.env.PUPPETEER_EXEC || '/usr/bin/chromium-browser';
  console.log(`[PUP] Usando Chrome: ${execPath}`);

  const browser = await puppeteer.launch({
    executablePath: execPath,
    headless: 'new',
    args: [
      '--no-sandbox','--disable-setuid-sandbox',
      '--disable-dev-shm-usage','--disable-gpu',
      '--no-first-run','--no-zygote','--single-process',
    ]
  });

  try {
    const page = await browser.newPage();

    // NO bloquear CSS — el modal puede depender de estilos para mostrarse
    await page.setRequestInterception(true);
    page.on('request', req => {
      const type = req.resourceType();
      if (['image','font','media'].includes(type)) req.abort();
      else req.continue();
    });

    await page.setUserAgent(
      'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
    );
    await page.setViewport({ width: 390, height: 844 });

    console.log('[PUP] Cargando futbollibre.ec...');
    await page.goto('https://futbollibre.ec', { waitUntil: 'networkidle2', timeout: 45000 });

    try {
      await page.waitForFunction(
        () => document.body.innerText.match(/\d{1,2}:\d{2}/),
        { timeout: 15000 }
      );
      console.log('[PUP] Horas detectadas');
    } catch(e) { console.warn('[PUP] Sin horas'); }

    await sleep(1000);

    // PASO 1: contar cuantos nodos de hora hay
    const eventCount = await page.evaluate(() => {
      const timeRx = /^\d{1,2}:\d{2}$/;
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
      let node, count = 0;
      while ((node = walker.nextNode())) {
        if (timeRx.test(node.textContent.trim())) count++;
      }
      return count;
    });

    console.log(`[PUP] ${eventCount} eventos detectados`);

    const events = [];

    // PASO 2: clic en cada evento por indice y leer canales visibles
    for (let idx = 0; idx < eventCount; idx++) {

      const result = await page.evaluate(async (index) => {
        const timeRx = /^\d{1,2}:\d{2}$/;
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
        let node, count = 0;

        while ((node = walker.nextNode())) {
          if (!timeRx.test(node.textContent.trim())) continue;
          if (count === index) break;
          count++;
        }
        if (!node) return null;

        const time = node.textContent.trim();

        let container = node.parentElement;
        for (let i = 0; i < 6; i++) {
          if (!container) break;
          const texts = Array.from(container.querySelectorAll('*'))
            .filter(el => el.children.length === 0
              && el.textContent.trim().length > 5
              && !timeRx.test(el.textContent.trim()));
          if (texts.length > 0) break;
          container = container.parentElement;
        }
        if (!container) return null;

        const allText = Array.from(container.querySelectorAll('*'))
          .filter(el => el.children.length === 0)
          .map(el => el.textContent.trim())
          .filter(t => t.length > 4 && !timeRx.test(t));

        let matchTitle = allText[0] || '';
        if (!matchTitle || matchTitle.length < 4) return null;

        let league = '', match = matchTitle;
        if (matchTitle.includes(':') && matchTitle.split(':')[1].trim().length > 3) {
          league = matchTitle.split(':')[0].trim();
          match  = matchTitle.split(':').slice(1).join(':').trim();
        }

        container.scrollIntoView({ behavior: 'instant', block: 'center' });
        container.click();

        return { time, match, league };
      }, idx);

      if (!result || !result.match || result.match.length < 4) continue;

      // Esperar modal y buscar links VISIBLES
      let channels = [];
      for (let t = 0; t < 10; t++) {
        await sleep(400);
        channels = await page.evaluate(() => {
          const results = [];
          const seen    = new Set();

          document.querySelectorAll('a[href]').forEach(a => {
            const href = a.href || '';
            if (!href.includes('futbollibre.ec/embed/eventos.html')) return;
            if (!href.includes('?r=')) return;
            if (seen.has(href)) return;

            // Solo links visibles en pantalla ahora
            const rect = a.getBoundingClientRect();
            const style = window.getComputedStyle(a);
            const isVisible = rect.width > 0 && rect.height > 0
              && style.display !== 'none'
              && style.visibility !== 'hidden'
              && style.opacity !== '0';

            if (!isVisible) return;

            seen.add(href);
            const name = a.textContent?.replace(/[▶►•\-\s]+/g, ' ').trim()
                      || `Canal ${results.length + 1}`;
            results.push({ name, href });
          });

          return results;
        });

        if (channels.length > 0) break;
      }

      events.push({
        time     : result.time,           // "19:00" — hora Colombia, se mantiene para compatibilidad
        time_utc : timeColombiaToUTC(result.time), // ISO UTC — el frontend lo convierte a hora local
        match    : result.match,
        league   : result.league,
        flag     : '⚽',
        channels
      });

      if (channels.length > 0) {
        console.log(`OK ${result.time} | ${result.match} -> ${channels.length} canales`);
        channels.forEach(c => console.log(`   ${c.name}: ${c.href.slice(0, 80)}`));
      } else {
        console.log(`-- ${result.time} | ${result.match} -> sin canales`);
      }

      // Cerrar modal
      await page.keyboard.press('Escape');
      await sleep(300);
      await page.evaluate(() => {
        const sels = ['[class*="close"]','[class*="cerrar"]','[aria-label*="lose"]'];
        for (const s of sels) {
          const b = document.querySelector(s);
          if (b && b.getBoundingClientRect().width > 0) { b.click(); return; }
        }
      });
      await sleep(200);
    }

    const withCh = events.filter(e => e.channels.length > 0).length;
    console.log(`\n[PUP] Total: ${events.length} | Con canales: ${withCh}`);
    return events;

  } finally {
    await browser.close();
  }
}

async function main() {
  console.log(`[${new Date().toISOString()}] === SportStream Scraper ===`);
  let events = [], source = 'none';

  try {
    events = await scrapeFutbolLibre();
    if (events.length > 0) source = 'futbollibre-titiritero';
  } catch(e) {
    console.warn(`[PUP] FALLO: ${e.message}`);
  }

  if (events.length === 0) {
    try {
      const apiUrl = process.env.API_URL || 'https://sportstream-api-production.up.railway.app';
      const data = await fetchJson(apiUrl + '/eventos');
      if (data.events?.length) { events = data.events; source = 'railway'; }
    } catch(e) { console.warn(`[API] FALLO: ${e.message}`); }
  }

  events.sort((a, b) => {
    const m = t => { const [h,mm]=(t||'0:0').split(':').map(Number); return h*60+(mm||0); };
    return m(a.time) - m(b.time);
  });

  const seen = new Set();
  events = events.filter(ev => {
    const key = `${ev.time}|${ev.match}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const withCh = events.filter(e => (e.channels||[]).length > 0).length;

  const output = {
    actualizado_en     : new Date().toISOString(),
    // fecha en hora Colombia para referencia del servidor
    fecha              : new Date().toLocaleDateString('es-ES', {
                           weekday: 'long', day: 'numeric', month: 'long',
                           timeZone: 'America/Bogota'
                         }),
    fuente             : source,
    contar             : events.length,
    contar_con_canales : withCh,
    events,
    eventos            : events
  };

  fs.writeFileSync(
    path.join(process.cwd(), 'eventos.json'),
    JSON.stringify(output, null, 2),
    'utf-8'
  );

  console.log(`LISTO | ${source} | total:${events.length} | canales:${withCh}`);
  if (events.length === 0) process.exit(1);
}

main().catch(e => { console.error('ERROR FATAL:', e); process.exit(1); });
