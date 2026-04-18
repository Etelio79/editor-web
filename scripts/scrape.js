const puppeteer = require('puppeteer-core');
const fs        = require('fs');
const path      = require('path');

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
    await page.setRequestInterception(true);
    page.on('request', req => {
      if (['image','font','media'].includes(req.resourceType())) req.abort();
      else req.continue();
    });
    await page.setUserAgent(
      'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
    );
    await page.setViewport({ width: 390, height: 844 });

    console.log('[PUP] Navegando a futbollibre.ec...');
    await page.goto('https://futbollibre.ec', { waitUntil:'networkidle2', timeout:45000 });

    await page.waitForFunction(
      () => document.body.innerText.match(/\d{1,2}:\d{2}/),
      { timeout:15000 }
    ).catch(() => console.warn('[PUP] Timeout esperando horas'));

    // Esperar un poco más para que carguen los links de canales
    await new Promise(r => setTimeout(r, 2000));

    console.log('[PUP] Extrayendo eventos y canales...');

    const events = await page.evaluate(() => {
      const timeRx  = /^\d{1,2}:\d{2}$/;
      const results = [];
      const seen    = new Set();

      // Buscar todos los nodos de texto que sean una hora HH:MM
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
      const timeNodes = [];
      let node;
      while ((node = walker.nextNode())) {
        if (timeRx.test(node.textContent.trim())) timeNodes.push(node);
      }

      console.log('Nodos de hora encontrados:', timeNodes.length);

      timeNodes.forEach(timeNode => {
        const time = timeNode.textContent.trim();

        // Subir hasta encontrar el contenedor del evento
        // Subimos hasta 8 niveles buscando el contenedor que tiene el título Y los canales
        let container = timeNode.parentElement;
        for (let i = 0; i < 8; i++) {
          if (!container) break;
          // El contenedor correcto tiene links de embed/eventos
          if (container.querySelectorAll('a[href*="embed/eventos"]').length > 0) break;
          container = container.parentElement;
        }
        if (!container) return;

        // Título: primer texto largo que no sea la hora
        const allText = Array.from(container.querySelectorAll('*'))
          .filter(el => el.children.length === 0)
          .map(el => el.textContent.trim())
          .filter(t => t.length > 5 && !timeRx.test(t) && !t.includes('►') && !t.includes('▶'));
        const matchTitle = allText[0] || '';
        if (!matchTitle || matchTitle.length < 4) return;

        // Separar liga y partido
        let league = '', match = matchTitle;
        if (matchTitle.includes(':')) {
          const pts = matchTitle.split(':');
          league = pts[0].trim();
          match  = pts.slice(1).join(':').trim() || matchTitle;
        }

        // ✅ CLAVE: buscar SOLO links de embed/eventos (los canales reales)
        const channels = [];
        container.querySelectorAll('a[href*="embed/eventos"]').forEach(a => {
          const name = a.textContent.replace(/[►▶•\-\s]+/g,' ').trim();
          const href = a.href;
          if (name && href) channels.push({ name, href });
        });

        const key = `${time}|${match}`;
        if (seen.has(key)) return;
        seen.add(key);
        results.push({ time, match, league, flag:'⚽', channels });
      });

      return results;
    });

    console.log(`[PUP] ${events.length} eventos extraídos`);
    const withCh = events.filter(e => e.channels.length > 0).length;
    const totalCh = events.reduce((s,e) => s + e.channels.length, 0);
    console.log(`[PUP] Con canales: ${withCh} | Total canales: ${totalCh}`);

    if (events.length > 0) {
      console.log('[PUP] Muestra:');
      events.filter(e => e.channels.length > 0).slice(0, 3).forEach(ev => {
        console.log(`  ${ev.time} ${ev.match} → ${ev.channels.length} canales`);
        ev.channels.slice(0, 2).forEach(ch => console.log(`    - ${ch.name}: ${ch.href.substring(0,60)}`));
      });
    }

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
    console.error('[PUP] FALLÓ:', e.message);
  }

  // Ordenar por hora
  events.sort((a,b) => {
    const m = t => { if(!t) return 9999; const [h,mm]=(t||'0:0').split(':').map(Number); return h*60+(mm||0); };
    return m(a.time) - m(b.time);
  });

  const output = {
    updated_at : new Date().toISOString(),
    date       : new Date().toLocaleDateString('es-ES', {weekday:'long', day:'numeric', month:'long'}),
    source,
    count      : events.length,
    events
  };

  fs.writeFileSync(
    path.join(process.cwd(), 'eventos.json'),
    JSON.stringify(output, null, 2),
    'utf-8'
  );

  const withCh = events.filter(e => e.channels.length > 0).length;
  console.log(`✅ LISTO | fuente: ${source} | eventos: ${events.length} | con canales: ${withCh}`);
}

main().catch(e => { console.error('ERROR FATAL:', e); process.exit(1); });
