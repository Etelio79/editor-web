const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log(`[${new Date().toISOString()}] Iniciando scraper...`);

  const browser = await puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXEC || '/usr/bin/chromium-browser',
    headless: 'new',
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
           '--disable-gpu','--no-first-run','--no-zygote','--single-process']
  });

  const events = [];

  try {
    const page = await browser.newPage();

    await page.setRequestInterception(true);
    page.on('request', req => {
      if (['image','font','media'].includes(req.resourceType())) req.abort();
      else req.continue();
    });

    await page.setUserAgent(
      'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36'
    );
    await page.setViewport({ width: 390, height: 844 });

    // ── Cargar la página ─────────────────────────────────────────
    await page.goto('https://futbollibre.ec', { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForFunction(() => document.body.innerText.match(/\d{1,2}:\d{2}/), { timeout: 20000 })
      .catch(() => {});
    await sleep(2000);

    // ── Extraer todos los eventos del DOM ────────────────────────
    const eventNodes = await page.evaluate(() => {
      const timeRx = /^\d{1,2}:\d{2}$/;
      const seen   = new Set();
      const result = [];

      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
      let node;

      while ((node = walker.nextNode())) {
        const time = node.textContent.trim();
        if (!timeRx.test(time)) continue;

        // Buscar el contenedor del evento subiendo niveles
        let el = node.parentElement;
        for (let i = 0; i < 6; i++) {
          if (!el) break;
          const texts = Array.from(el.querySelectorAll('*'))
            .filter(e => e.children.length === 0 && e.textContent.trim().length > 5 && !timeRx.test(e.textContent.trim()));
          if (texts.length > 0) break;
          el = el.parentElement;
        }
        if (!el) continue;

        // Nombre del partido
        const texts = Array.from(el.querySelectorAll('*'))
          .filter(e => e.children.length === 0)
          .map(e => e.textContent.trim())
          .filter(t => t.length > 4 && !timeRx.test(t));

        let match = texts[0] || '';
        let league = '';

        // "Copa del Rey: Real vs Barça" → league="Copa del Rey", match="Real vs Barça"
        if (match.includes(':') && match.split(':')[1].trim().length > 3) {
          league = match.split(':')[0].trim();
          match  = match.split(':').slice(1).join(':').trim();
        } else if (match.endsWith(':') || match.length < 4) {
          // Buscar texto con "vs" o "-"
          match = texts.find(t => t.includes(' vs ') || t.includes(' - ')) || match.replace(/:$/, '');
        }

        if (!match || match.length < 4) continue;

        const key = `${time}|${match}`;
        if (seen.has(key)) continue;
        seen.add(key);

        result.push({ time, match, league, flag: '⚽' });
      }

      return result;
    });

    console.log(`${eventNodes.length} eventos encontrados`);

    // ── Para cada evento: clic → canales del modal → cerrar ──────
    for (let i = 0; i < eventNodes.length; i++) {
      const ev = eventNodes[i];

      // Links de embed ANTES del clic (para hacer diff)
      const before = await page.evaluate(() =>
        new Set(Array.from(document.querySelectorAll('a[href*="futbollibre.ec/embed"]')).map(a => a.href))
      );

      // Clic en el elemento del evento
      const clicked = await page.evaluate((time, matchSlice) => {
        const timeRx = /^\d{1,2}:\d{2}$/;
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
        let node;
        while ((node = walker.nextNode())) {
          if (node.textContent.trim() !== time) continue;
          let el = node.parentElement;
          for (let j = 0; j < 6; j++) {
            if (!el) break;
            if (el.textContent.includes(matchSlice)) {
              el.scrollIntoView({ behavior: 'instant', block: 'center' });
              el.click();
              return true;
            }
            el = el.parentElement;
          }
        }
        return false;
      }, ev.time, ev.match.slice(0, 12));

      if (!clicked) {
        events.push({ ...ev, channels: [] });
        continue;
      }

      // Esperar que aparezcan canales nuevos (polling hasta 4 segundos)
      let newChannels = [];
      for (let t = 0; t < 8; t++) {
        await sleep(500);
        newChannels = await page.evaluate((beforeArr) => {
          const beforeSet = new Set(beforeArr);
          const channels  = [];
          const seen      = new Set();

          document.querySelectorAll('a[href*="futbollibre.ec/embed/eventos.html"]').forEach(a => {
            const href = a.href || '';
            if (!href.includes('?r=') || beforeSet.has(href) || seen.has(href)) return;
            seen.add(href);
            const name = a.textContent?.replace(/[▶►\s]+/g,' ').trim() || `Canal ${channels.length + 1}`;
            channels.push({ name, href });
          });

          return channels;
        }, [...before]);

        if (newChannels.length > 0) break;
      }

      events.push({ ...ev, channels: newChannels });

      if (newChannels.length > 0) {
        console.log(`✅ ${ev.time} | ${ev.match} → ${newChannels.length} canal(es)`);
        newChannels.forEach(c => console.log(`   ${c.name}: ${c.href.slice(0, 80)}`));
      } else {
        console.log(`○  ${ev.time} | ${ev.match} → sin canales`);
      }

      // Cerrar modal
      await page.keyboard.press('Escape');
      await sleep(400);

      // Si el modal no cerró, buscar botón de cierre
      const stillOpen = await page.evaluate(() =>
        document.querySelectorAll('a[href*="futbollibre.ec/embed"]').length > 0
      );
      if (stillOpen) {
        await page.evaluate(() => {
          document.querySelector('[class*="close"],[class*="cerrar"],[aria-label*="lose"]')?.click();
        });
        await sleep(300);
      }
    }

    await page.close();
  } finally {
    await browser.close();
  }

  // Ordenar por hora
  events.sort((a, b) => {
    const m = t => { const [h, mm] = (t || '0:0').split(':').map(Number); return h * 60 + mm; };
    return m(a.time) - m(b.time);
  });

  const withCh = events.filter(e => e.channels.length > 0).length;
  console.log(`\nTotal: ${events.length} eventos | Con canales: ${withCh}`);

  const output = {
    actualizado_en     : new Date().toISOString(),
    fecha              : new Date().toLocaleDateString('es-ES', { weekday:'long', day:'numeric', month:'long' }),
    fuente             : 'futbollibre',
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

  console.log('✅ eventos.json guardado');
  if (events.length === 0) process.exit(1);
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
