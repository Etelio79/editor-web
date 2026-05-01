const puppeteer = require('puppeteer-core');
const fs        = require('fs');
const path      = require('path');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// URL del sitio - cambiar aquí si vuelve a moverse el dominio
const SITE_URL = process.env.SITE_URL || 'https://futbollibreplus.pe';

// Convierte "19:00" (hora Colombia, UTC-5) a ISO UTC
// CORREGIDO: usaba h+5 directo en Date.UTC lo cual daba overflow para horas > 18
function timeColombiaToUTC(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  const now = new Date();
  // Obtener fecha actual en Bogotá (UTC-5)
  const fechaBogota = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(now); // "2025-05-01"
  // Construir ISO con offset Colombia -05:00 y dejar que Date lo convierta a UTC
  const hh = String(h).padStart(2, '0');
  const mm = String(m).padStart(2, '0');
  return new Date(`${fechaBogota}T${hh}:${mm}:00-05:00`).toISOString();
}


/**
 * Decodifica la URL real desde un enlace embed de futbollibre.
 * Entrada:  https://futbollibreplus.pe/embed/eventos.html?r=aHR0cHM6Ly90dnR2...
 * Salida:   https://tvtvhd.com/canales.php?stream=espn
 */
function decodeEmbedUrl(href) {
  try {
    const url = new URL(href);
    const r = url.searchParams.get('r');
    if (!r) return href;
    const decoded = Buffer.from(r, 'base64').toString('utf-8');
    new URL(decoded); // valida que sea URL real
    return decoded;
  } catch {
    return href;
  }
}

async function scrapeFutbolLibre() {
  // CORREGIDO: era /usr/bin/chromium-browser — en Ubuntu 24 el binario es /usr/bin/chromium
  const execPath = process.env.PUPPETEER_EXEC || '/usr/bin/chromium';
  console.log(`[PUP] Usando Chrome: ${execPath}`);
  console.log(`[PUP] URL: ${SITE_URL}`);

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

    console.log('[PUP] Cargando página...');
    await page.goto(SITE_URL, { waitUntil: 'networkidle2', timeout: 45000 });

    // Esperar horas con reintentos + scroll para activar lazy-loading
    let horasDetectadas = false;
    for (let intento = 1; intento <= 3; intento++) {
      try {
        await page.waitForFunction(
          () => document.body.innerText.match(/\d{1,2}:\d{2}/),
          { timeout: 8000 }
        );
        horasDetectadas = true;
        console.log(`[PUP] Horas detectadas (intento ${intento})`);
        break;
      } catch {
        console.warn(`[PUP] Sin horas (intento ${intento}/3), scrolleando...`);
        await page.evaluate(async () => {
          for (let y = 0; y < document.body.scrollHeight; y += 300) {
            window.scrollTo(0, y);
            await new Promise(r => setTimeout(r, 150));
          }
          window.scrollTo(0, 0);
        });
        await sleep(1500);
      }
    }

    if (!horasDetectadas) {
      const horaColombia = new Date(Date.now() - 5 * 3600_000).getUTCHours();
      if (horaColombia < 8) {
        console.log(`[PUP] Son las ${horaColombia}h Colombia — normal que no haya eventos aún.`);
      } else {
        console.warn('[PUP] Sin horas en horario activo — posible cambio en la web.');
      }
      return [];
    }

    await sleep(1000);

    // Contar nodos de hora
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

    // Iterar cada evento por índice
    for (let idx = 0; idx < eventCount; idx++) {

      // ── PASO A: localizar el evento por su hora, marcarlo y hacer click ──
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

        // Marcamos el padre del nodo de hora con un ID único
        const timeEl = node.parentElement;
        timeEl.setAttribute('data-time-marker', `evt-${index}`);

        // Subir hasta el contenedor que tenga texto del partido
        let container = timeEl;
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

        return { time, match, league, eventIdx: index };
      }, idx);

      if (!result || !result.match || result.match.length < 4) continue;

      // ── PASO B: esperar a que aparezcan los canales del evento ──
      let rawChannels = [];
      for (let t = 0; t < 15; t++) {
        await sleep(400);

        rawChannels = await page.evaluate((eventIdx) => {
          const timeRx = /^\d{1,2}:\d{2}$/;

          const isVisible = (el) => {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return rect.width > 0 && rect.height > 0
              && style.display !== 'none'
              && style.visibility !== 'hidden'
              && style.opacity !== '0';
          };

          const isEmbed = (href) => {
            if (!href || !href.includes('?r=')) return false;
            if (!href.includes('/embed/eventos.html')) return false;
            try {
              return new URL(href).hostname.includes('futbollibre');
            } catch { return false; }
          };

          const timeEl = document.querySelector(`[data-time-marker="evt-${eventIdx}"]`);
          if (!timeEl) return [];

          let bestAncestor = null;
          let ancestor = timeEl.parentElement;

          for (let level = 0; level < 10 && ancestor; level++) {
            const links = Array.from(ancestor.querySelectorAll('a[href]'))
              .filter(a => isEmbed(a.href) && isVisible(a));

            if (links.length > 0) {
              const allTimes = [];
              const walker = document.createTreeWalker(ancestor, NodeFilter.SHOW_TEXT, null);
              let n;
              while ((n = walker.nextNode())) {
                if (timeRx.test(n.textContent.trim())) {
                  allTimes.push(n.parentElement);
                }
              }

              if (allTimes.length === 1 && allTimes[0] === timeEl) {
                bestAncestor = ancestor;
                break;
              }

              if (allTimes.length > 1) {
                break;
              }

              bestAncestor = ancestor;
            }
            ancestor = ancestor.parentElement;
          }

          if (!bestAncestor) return [];

          const results = [];
          const seen = new Set();

          bestAncestor.querySelectorAll('a[href]').forEach(a => {
            const href = a.href || '';
            if (!isEmbed(href)) return;
            if (seen.has(href)) return;
            if (!isVisible(a)) return;

            seen.add(href);
            const name = a.textContent?.replace(/[▶►•\-\s]+/g, ' ').trim()
                      || `Canal ${results.length + 1}`;
            results.push({ name, href });
          });

          return results;
        }, result.eventIdx);

        if (rawChannels.length > 0) break;
      }

      // Limpiar marcador del evento actual
      await page.evaluate((eventIdx) => {
        const el = document.querySelector(`[data-time-marker="evt-${eventIdx}"]`);
        if (el) el.removeAttribute('data-time-marker');
      }, result.eventIdx);

      // Decodificar Base64 → URL real
      const channels = rawChannels.map(ch => ({
        name: ch.name,
        href: decodeEmbedUrl(ch.href),
      }));

      events.push({
        time     : result.time,
        time_utc : timeColombiaToUTC(result.time),
        match    : result.match,
        league   : result.league,
        flag     : '⚽',
        channels
      });

      if (channels.length > 0) {
        console.log(`OK ${result.time} | ${result.match} -> ${channels.length} canales`);
        channels.forEach(c => console.log(`   ${c.name}: ${c.href}`));
      } else {
        console.log(`-- ${result.time} | ${result.match} -> sin canales`);
      }

      // Cerrar acordeón/modal antes del siguiente evento
      await page.keyboard.press('Escape');
      await sleep(200);
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

  // MEJORADO: retry hasta 3 veces si el scrape falla
  for (let intento = 1; intento <= 3; intento++) {
    try {
      events = await scrapeFutbolLibre();
      if (events.length > 0) {
        source = 'futbollibre-titiritero';
        break;
      }
      console.warn(`[MAIN] Intento ${intento}: 0 eventos, reintentando...`);
    } catch(e) {
      console.warn(`[MAIN] Intento ${intento} FALLO: ${e.message}`);
      if (intento < 3) await new Promise(r => setTimeout(r, 5000));
    }
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
}

main().catch(e => { console.error('ERROR FATAL:', e); process.exit(1); });
