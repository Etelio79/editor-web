const puppeteer = require('puppeteer-core');
const fs        = require('fs');
const path      = require('path');
const https     = require('https');

/* ── Fetch simple (para Railway API fallback) ── */
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'SportStreamBot/1.0' }
    }, res => {
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ── Scraping con Puppeteer ── */
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
      const type = req.resourceType();
      if (['image','font','stylesheet','media'].includes(type)) req.abort();
      else req.continue();
    });

    await page.setUserAgent(
      'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
    );
    await page.setViewport({ width: 390, height: 844 });

    console.log('[PUP] Navegando a futbollibre.ec ...');
    await page.goto('https://futbollibre.ec', { waitUntil: 'networkidle2', timeout: 45000 });

    try {
      await page.waitForFunction(
        () => document.body.innerText.match(/\d{1,2}:\d{2}/),
        { timeout: 15000 }
      );
      console.log('[PUP] Horas detectadas en la pagina');
    } catch(e) {
      console.warn('[PUP] No se detectaron horas...');
    }

    // PASO 1: Extraer eventos (sin canales todavia)
    const events = await page.evaluate(() => {
      const results = [];
      const seen    = new Set();
      const timeRx  = /^\d{1,2}:\d{2}$/;

      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
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
          const texts = Array.from(container.querySelectorAll('*'))
            .filter(el => el.children.length === 0 && el.textContent.trim().length > 5 && !timeRx.test(el.textContent.trim()));
          if (texts.length > 0) break;
          container = container.parentElement;
        }
        if (!container) return;

        const allText = Array.from(container.querySelectorAll('*'))
          .filter(el => el.children.length === 0)
          .map(el => el.textContent.trim())
          .filter(t => t.length > 5 && !timeRx.test(t));

        const matchTitle = allText[0] || '';
        if (!matchTitle) return;

        let league = '', match = matchTitle;
        if (matchTitle.includes(':')) {
          const pts = matchTitle.split(':');
          league    = pts[0].trim();
          match     = pts.slice(1).join(':').trim() || matchTitle;
        }

        const key = `${time}|${match}`;
        if (seen.has(key) || match.length < 4) return;
        seen.add(key);

        results.push({
          time, match, league, flag: '\u26bd', channels: [],
          _ct: container.textContent.trim().slice(0, 50)
        });
      });

      return results;
    });

    console.log(`[PUP] Eventos extraidos: ${events.length}`);

    // PASO 2: Clic en cada evento -> capturar canales del modal
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];

      // Links de embed ANTES del clic
      const before = new Set(await page.evaluate(() =>
        Array.from(document.querySelectorAll('a[href*="futbollibre.ec/embed"]')).map(a => a.href)
      ));

      // Clic usando scrollIntoView + click()
      const clicked = await page.evaluate((time, ct) => {
        const timeRx = /^\d{1,2}:\d{2}$/;
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
        let node;
        while ((node = walker.nextNode())) {
          if (node.textContent.trim() !== time) continue;
          let el = node.parentElement;
          for (let j = 0; j < 6; j++) {
            if (!el) break;
            if (el.textContent.trim().slice(0, 50) === ct) {
              el.scrollIntoView({ behavior: 'instant', block: 'center' });
              el.click();
              return true;
            }
            el = el.parentElement;
          }
        }
        return false;
      }, ev.time, ev._ct);

      if (!clicked) { delete ev._ct; continue; }

      // Polling hasta 4s esperando canales nuevos
      let newCh = [];
      for (let t = 0; t < 8; t++) {
        await sleep(500);
        newCh = await page.evaluate((beforeArr) => {
          const beforeSet = new Set(beforeArr);
          const channels  = [];
          const seen2     = new Set();
          document.querySelectorAll('a[href*="futbollibre.ec/embed/eventos.html"]').forEach(a => {
            const href = a.href || '';
            if (!href.includes('?r=') || beforeSet.has(href) || seen2.has(href)) return;
            seen2.add(href);
            const name = a.textContent?.replace(/[\u25b6\u25ba\u2022\-\s]+/g, ' ').trim() || `Canal ${channels.length + 1}`;
            channels.push({ name, href });
          });
          return channels;
        }, [...before]);
        if (newCh.length > 0) break;
      }

      ev.channels = newCh;
      delete ev._ct;

      if (newCh.length > 0) {
        console.log(`OK ${ev.time} | ${ev.match} -> ${newCh.length} canales`);
        newCh.forEach(c => console.log(`   ${c.name}: ${c.href.slice(0,80)}`));
      } else {
        console.log(`-- ${ev.time} | ${ev.match} -> sin canales`);
      }

      // Cerrar modal
      await page.keyboard.press('Escape');
      await sleep(400);

      // Si no cerro, buscar boton X
      const stillOpen = await page.evaluate(() =>
        document.querySelectorAll('a[href*="futbollibre.ec/embed"]').length > 0
      );
      if (stillOpen) {
        await page.evaluate(() => {
          document.querySelector('[class*="close"],[class*="cerrar"]')?.click();
        });
        await sleep(300);
      }
    }

    const withCh = events.filter(e => e.channels.length > 0).length;
    console.log(`[PUP] Con canales: ${withCh}/${events.length}`);
    if (events.length > 0) console.log('[PUP] Muestra:', JSON.stringify(events.slice(0,2)));

    return events;

  } finally {
    await browser.close();
  }
}

/* ── Main ── */
async function main() {
  console.log(`[${new Date().toISOString()}] === SportStream Scraper ===`);
  let events = [], source = 'none';

  // Intento 1: Puppeteer → futbollibre.ec
  try {
    events = await scrapeFutbolLibre();
    if (events.length > 0) source = 'futbollibre-puppeteer';
  } catch(e) {
    console.warn(`[PUP] FALLÓ: ${e.message}`);
  }

  // Intento 2: Railway API fallback
  if (events.length === 0) {
    try {
      const apiUrl = process.env.API_URL || 'https://sportstream-api-production.up.railway.app';
      console.log(`[API] Intentando ${apiUrl}/eventos ...`);
      const data = await fetchJson(apiUrl + '/eventos');
      if (data.events?.length) {
        events = data.events;
        source  = 'railway';
        console.log(`[API] OK - ${events.length} eventos`);
      }
    } catch(e2) {
      console.warn(`[API] FALLÓ: ${e2.message}`);
    }
  }

  // Ordenar por hora
  events.sort((a, b) => {
    const m = t => { if(!t) return 9999; const [h,mm]=(t||'0:0').split(':').map(Number); return h*60+(mm||0); };
    return m(a.time) - m(b.time);
  });

  const output = {
    updated_at : new Date().toISOString(),
    date       : new Date().toLocaleDateString('es-ES', { weekday:'long', day:'numeric', month:'long' }),
    source,
    count      : events.length,
    events
  };

  fs.writeFileSync(
    path.join(process.cwd(), 'eventos.json'),
    JSON.stringify(output, null, 2),
    'utf-8'
  );

  console.log(`✅ LISTO | fuente: ${source} | total: ${events.length}`);
  if (events.length === 0) {
    console.warn('⚠️ 0 eventos guardados');
  }
}

main().catch(e => { console.error('ERROR FATAL:', e); process.exit(1); });
