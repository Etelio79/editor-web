const puppeteer = require('puppeteer-core');
const fs        = require('fs');
const path      = require('path');
const https     = require('https');

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

async function scrapeFutbolLibre() {
  const execPath = process.env.PUPPETEER_EXEC || '/usr/bin/chromium-browser';
  console.log('[PUP] Chrome:', execPath);

  const browser = await puppeteer.launch({
    executablePath: execPath,
    headless: 'new',
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
           '--disable-gpu','--no-first-run','--no-zygote','--single-process']
  });

  try {
    const page = await browser.newPage();

    // Bloquear solo imágenes y media para ir más rápido (mantener JS y XHR)
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

    console.log('[PUP] Navegando a futbollibre.ec ...');
    await page.goto('https://futbollibre.ec', {
      waitUntil: 'networkidle2', timeout: 45000
    });

    // Esperar a que aparezcan las horas
    await page.waitForFunction(
      () => document.body.innerText.match(/\d{1,2}:\d{2}/),
      { timeout: 15000 }
    ).catch(() => console.warn('[PUP] Timeout esperando horas'));

    console.log('[PUP] Página cargada, extrayendo eventos...');

    // ── Paso 1: extraer todos los eventos con sus elementos clickeables ──
    const eventElements = await page.evaluate(() => {
      const timeRx  = /^\d{1,2}:\d{2}$/;
      const results = [];
      const seen    = new Set();

      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
      const timeNodes = [];
      let node;
      while ((node = walker.nextNode())) {
        if (timeRx.test(node.textContent.trim())) timeNodes.push(node);
      }

      timeNodes.forEach((timeNode, idx) => {
        const time = timeNode.textContent.trim();
        let container = timeNode.parentElement;
        for (let i = 0; i < 6; i++) {
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

        // Canales ya visibles (si los hay)
        const channels = [];
        container.querySelectorAll('a[href]').forEach(a => {
          const name = a.textContent.replace(/[►▶•\-]/g,'').trim();
          const href = a.href;
          if (name && href && href.startsWith('http') && !href.includes('futbollibre'))
            channels.push({ name, href });
        });

        // Selector para hacer clic y expandir
        container.dataset.evIdx = String(idx);
        const key = `${time}|${match}`;
        if (seen.has(key)) return;
        seen.add(key);

        results.push({ time, match, league, flag:'⚽', channels, _idx: idx });
      });

      return results;
    });

    console.log(`[PUP] ${eventElements.length} eventos encontrados`);

    // ── Paso 2: para eventos sin canales, hacer clic para expandirlos ──
    const noChannels = eventElements.filter(ev => ev.channels.length === 0);
    console.log(`[PUP] ${noChannels.length} eventos sin canales, expandiendo...`);

    const events = [...eventElements];

    for (let i = 0; i < Math.min(noChannels.length, 60); i++) {
      const ev = noChannels[i];
      try {
        // Buscar el elemento del evento por su texto de hora+nombre
        const clicked = await page.evaluate((time, match) => {
          const timeRx = /^\d{1,2}:\d{2}$/;
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
          let node;
          while ((node = walker.nextNode())) {
            if (node.textContent.trim() === time) {
              let container = node.parentElement;
              for (let j = 0; j < 8; j++) {
                if (!container) break;
                const texts = Array.from(container.querySelectorAll('*'))
                  .filter(el => el.children.length === 0)
                  .map(el => el.textContent.trim());
                if (texts.some(t => t.includes(match.substring(0, 15)))) {
                  container.click();
                  return true;
                }
                container = container.parentElement;
              }
            }
          }
          return false;
        }, ev.time, ev.match);

        if (clicked) {
          // Esperar a que aparezcan los links
          await page.waitForFunction(
            (time) => {
              const timeRx = /^\d{1,2}:\d{2}$/;
              const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
              let node;
              while ((node = walker.nextNode())) {
                if (node.textContent.trim() === time) {
                  let c = node.parentElement;
                  for (let j=0;j<8;j++){
                    if (!c) break;
                    const links = c.querySelectorAll('a[href*="futbollibre"],[href*="embed"]');
                    if (links.length > 0) return true;
                    c = c.parentElement;
                  }
                }
              }
              return false;
            },
            { timeout: 3000 },
            ev.time
          ).catch(() => {});

          // Extraer los canales del evento expandido
          const channels = await page.evaluate((time, match) => {
            const timeRx = /^\d{1,2}:\d{2}$/;
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
            let node;
            while ((node = walker.nextNode())) {
              if (node.textContent.trim() === time) {
                let c = node.parentElement;
                for (let j = 0; j < 10; j++) {
                  if (!c) break;
                  const links = c.querySelectorAll('a[href]');
                  if (links.length > 0) {
                    const result = [];
                    links.forEach(a => {
                      const name = a.textContent.replace(/[►▶•\-]/g,'').trim();
                      const href = a.href;
                      if (name && href && href.startsWith('http'))
                        result.push({ name, href });
                    });
                    if (result.length > 0) return result;
                  }
                  c = c.parentElement;
                }
              }
            }
            return [];
          }, ev.time, ev.match);

          // Actualizar el evento con los canales encontrados
          const evInList = events.find(e => e.time === ev.time && e.match === ev.match);
          if (evInList && channels.length > 0) {
            evInList.channels = channels;
            console.log(`  ✅ ${ev.time} ${ev.match.substring(0,30)} → ${channels.length} canales`);
          }
        }
      } catch(clickErr) {
        // ignorar errores individuales de click
      }

      // Pequeña pausa para no sobrecargar
      await new Promise(r => setTimeout(r, 300));
    }

    // Limpiar campo interno _idx
    events.forEach(ev => delete ev._idx);

    const withChannels = events.filter(e => e.channels.length > 0).length;
    console.log(`[PUP] Total: ${events.length} eventos, ${withChannels} con canales`);

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
    if (events.length > 0) source = 'futbollibre';
  } catch(e) {
    console.warn('[PUP] FALLÓ:', e.message);
  }

  if (events.length === 0) {
    try {
      const apiUrl = process.env.API_URL || 'https://sportstream-api-production.up.railway.app';
      const data   = await fetchJson(apiUrl + '/eventos');
      if (data.events?.length) { events = data.events; source = 'railway'; }
    } catch(e) { console.warn('[API] FALLÓ:', e.message); }
  }

  events.sort((a,b) => {
    const m = t => { if(!t) return 9999; const [h,mm]=(t||'0:0').split(':').map(Number); return h*60+(mm||0); };
    return m(a.time)-m(b.time);
  });

  const output = {
    updated_at : new Date().toISOString(),
    date       : new Date().toLocaleDateString('es-ES',{weekday:'long',day:'numeric',month:'long'}),
    source,
    count      : events.length,
    events
  };

  fs.writeFileSync(
    path.join(process.cwd(),'eventos.json'),
    JSON.stringify(output, null, 2),
    'utf-8'
  );

  const withCh = events.filter(e=>e.channels.length>0).length;
  console.log(`✅ LISTO | fuente: ${source} | eventos: ${events.length} | con canales: ${withCh}`);
}

main().catch(e => { console.error('ERROR FATAL:', e); process.exit(1); });
