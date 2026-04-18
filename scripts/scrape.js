
const puppeteer = require('puppeteer-core');
const fs        = require('fs');
const path      = require('path');
const https     = require('https');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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

    await page.setRequestInterception(true);
    page.on('request', req => {
      if (['image','font','stylesheet','media'].includes(req.resourceType())) req.abort();
      else req.continue();
    });

    await page.setUserAgent(
      'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
    );
    await page.setViewport({ width: 390, height: 844 });

    console.log('[PUP] Navegando a futbollibre.ec ...');
    await page.goto('https://futbollibre.ec', {
      waitUntil: 'networkidle2',
      timeout: 60000
    });

    try {
      await page.waitForFunction(
        () => document.body.innerText.match(/\d{1,2}:\d{2}/),
        { timeout: 20000 }
      );
      console.log('[PUP] Horas detectadas en la página ✅');
    } catch(e) {
      console.warn('[PUP] No se detectaron horas');
    }

    // ── PASO 1: Extraer lista de eventos (código original que funciona) ──
    const events = await page.evaluate(() => {
      const results = [];
      const seen    = new Set();
      const timeRx  = /^\d{1,2}:\d{2}$/;

      const walker = document.createTreeWalker(
        document.body, NodeFilter.SHOW_TEXT, null
      );

      const timeNodes = [];
      let node;
      while ((node = walker.nextNode())) {
        if (timeRx.test(node.textContent.trim())) timeNodes.push(node);
      }

      console.log('Nodos de hora:', timeNodes.length);

      timeNodes.forEach(timeNode => {
        const time = timeNode.textContent.trim();
        let container = timeNode.parentElement;

        for (let i = 0; i < 5; i++) {
          if (!container) break;
          if (container.querySelectorAll('a[href]').length > 0) break;
          container = container.parentElement;
        }
        if (!container) return;

        const allText = Array.from(container.querySelectorAll('*'))
          .filter(el => el.children.length === 0)
          .map(el => el.textContent.trim())
          .filter(t => t.length > 5 && !timeRx.test(t));

        const matchTitle = allText[0] || '';
        if (!matchTitle || matchTitle.length < 4) return;

        let league = '', match = matchTitle;
        if (matchTitle.includes(':')) {
          const pts = matchTitle.split(':');
          league = pts[0].trim();
          match  = pts.slice(1).join(':').trim() || matchTitle;
        }

        const key = `${time}|${match}`;
        if (seen.has(key) || match.length < 4) return;
        seen.add(key);

        results.push({ time, match, league, flag: '⚽', channels: [] });
      });

      return results;
    });

    console.log(`[PUP] Eventos extraídos: ${events.length}`);

    // ── PASO 2: Clic en cada evento → capturar canales del MODAL ────────
    // Necesitamos hacer scroll para ver todos los eventos y
    // capturar SOLO los canales que aparecen en el modal específico

    // Scroll completo para que todos los eventos estén en el DOM
    await page.evaluate(async () => {
      await new Promise(resolve => {
        const distance = 300;
        let scrolled = 0;
        const timer = setInterval(() => {
          window.scrollBy(0, distance);
          scrolled += distance;
          if (scrolled >= document.body.scrollHeight) {
            clearInterval(timer);
            window.scrollTo(0, 0);
            resolve();
          }
        }, 100);
      });
    });
    await sleep(1500);

    // Función para obtener los canales del modal actualmente abierto
    // SOLO lee dentro del modal, no en toda la página
    const getModalChannels = async () => {
      return await page.evaluate(() => {
        const channels = [];
        const seen     = new Set();

        // Buscar el modal/popup que está VISIBLE ahora
        // Probar varios selectores comunes
        const modalSelectors = [
          // Por clase con "canal" o "channel"
          '[class*="canal"],[class*="channel"]',
          // Por clase con "modal" o "popup"
          '[class*="modal"][style*="display: block"]',
          '[class*="modal"][style*="display:block"]',
          '[class*="popup"]:not([style*="display: none"])',
          // Por atributo open
          '[open]',
          // Overlay visible
          '[class*="overlay"][style*="display: block"]',
        ];

        let modalEl = null;
        for (const sel of modalSelectors) {
          const candidates = document.querySelectorAll(sel);
          for (const el of candidates) {
            if (el.offsetWidth > 0 && el.offsetHeight > 0) {
              // Verificar que tiene links de embed dentro
              const links = el.querySelectorAll('a[href*="futbollibre.ec/embed"]');
              if (links.length > 0) {
                modalEl = el;
                break;
              }
            }
          }
          if (modalEl) break;
        }

        // Si no encontramos un modal específico, buscar en toda la página
        // los links que son de canal (solo los que aparecieron recientemente)
        const searchRoot = modalEl || document;

        searchRoot.querySelectorAll('a[href]').forEach(a => {
          const href = a.href || '';
          // ✅ Solo el formato exacto de futbollibre embed
          if (
            href.includes('futbollibre.ec/embed/eventos.html') &&
            href.includes('?r=') &&
            !seen.has(href)
          ) {
            seen.add(href);
            const rawName = a.textContent?.replace(/[▶►▷\s]+/g, ' ').trim() || '';
            const name    = rawName.length > 1 ? rawName : `Canal ${channels.length + 1}`;
            channels.push({ name, href });
          }
        });

        return { channels, foundModal: !!modalEl };
      });
    };

    // Procesar eventos de a uno
    // Usamos índice para hacer clic en el elemento correcto
    let successCount = 0;

    for (let evIdx = 0; evIdx < events.length; evIdx++) {
      const ev = events[evIdx];

      // Limpiar embed links visibles ANTES del clic (baseline)
      const beforeLinks = await page.evaluate(() =>
        Array.from(document.querySelectorAll('a[href*="futbollibre.ec/embed"]'))
          .map(a => a.href)
      );
      const beforeSet = new Set(beforeLinks);

      // Encontrar y clicar el elemento del evento usando su texto
      const clicked = await page.evaluate((evTime, evMatch) => {
        const timeRx = /^\d{1,2}:\d{2}$/;
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
        let node;

        while ((node = walker.nextNode())) {
          if (node.textContent.trim() !== evTime) continue;

          // Encontrar el contenedor correcto
          let container = node.parentElement;
          for (let i = 0; i < 5; i++) {
            if (!container) break;
            const txt = container.textContent.trim();
            if (txt.includes(evMatch.slice(0, 10))) {
              // Scroll al elemento y hacer clic
              container.scrollIntoView({ behavior: 'instant', block: 'center' });
              container.click();
              return true;
            }
            container = container.parentElement;
          }
        }
        return false;
      }, ev.time, ev.match);

      if (!clicked) continue;
      await sleep(1200);

      // Obtener canales del modal
      const { channels: modalCh, foundModal } = await getModalChannels();

      // Filtrar: solo los que son NUEVOS (no estaban antes del clic)
      const newChannels = modalCh.filter(c => !beforeSet.has(c.href));

      if (newChannels.length > 0) {
        ev.channels = newChannels;
        successCount++;
        console.log(`[PUP] ✅ "${ev.match}" → ${newChannels.length} canales (modal:${foundModal})`);
        newChannels.forEach(c => console.log(`   → ${c.name}: ${c.href.slice(0, 80)}`));
      }

      // Cerrar modal y esperar que desaparezca
      await page.keyboard.press('Escape');
      await sleep(400);

      // Verificar que el modal se cerró (los links deben desaparecer)
      const afterClose = await page.evaluate(() =>
        document.querySelectorAll('a[href*="futbollibre.ec/embed"]').length
      );
      if (afterClose > 0) {
        // Modal no se cerró con Escape, intentar clic en el botón X
        await page.evaluate(() => {
          const closeBtn = document.querySelector(
            '[class*="close"],[class*="cerrar"],[aria-label="close"],[aria-label="cerrar"]'
          );
          if (closeBtn) closeBtn.click();
        });
        await sleep(300);
      }
    }

    console.log(`\n[PUP] Eventos con canales: ${successCount}/${events.length}`);
    return events;

  } finally {
    await browser.close();
  }
}

/* ── Fallback: Railway API ─────────────────────────────────── */
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers:{'User-Agent':'SportStreamBot/1.0'} }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch(e) { reject(new Error('JSON inválido')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

/* ══════════════════════════════════════════════════════════════
   MAIN
══════════════════════════════════════════════════════════════ */
async function main() {
  console.log(`[${new Date().toISOString()}] === SportStream Scraper v9 ===`);
  let events = [], source = 'none';

  try {
    events = await scrapeFutbolLibre();
    if (events.length > 0) source = 'futbollibre-v9';
  } catch(e) {
    console.warn(`[PUP] FALLÓ: ${e.message}`);
  }

  // Fallback
  if (events.length === 0 && process.env.API_URL) {
    try {
      const data = await fetchJson(process.env.API_URL + '/eventos');
      const list = data.events || data.eventos || [];
      if (list.length > 0) { events = list; source = 'railway'; }
    } catch(e) { console.warn(`[API] ${e.message}`); }
  }

  events.sort((a, b) => {
    const m = t => { const [h,mm]=(t||'0:0').split(':').map(Number); return h*60+(mm||0); };
    return m(a.time) - m(b.time);
  });

  const withCh = events.filter(e => (e.channels||[]).length > 0).length;

  console.log(`\n✅ LISTO | ${source} | total:${events.length} | con canales:${withCh}`);
  console.log('\nPrimeros eventos:');
  events.slice(0, 5).forEach(ev => {
    console.log(`  ${ev.time} | ${ev.match} | canales:${(ev.channels||[]).length}`);
  });

  const output = {
    actualizado_en     : new Date().toISOString(),
    fecha              : new Date().toLocaleDateString('es-ES',{weekday:'long',day:'numeric',month:'long'}),
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

  if (events.length === 0) process.exit(1);
}

main().catch(e => { console.error('ERROR FATAL:', e); process.exit(1); });
