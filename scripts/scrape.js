const puppeteer = require('puppeteer');
const fs        = require('fs');
const path      = require('path');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// URL del sitio - cambiar aquí si vuelve a moverse el dominio
const SITE_URL = process.env.SITE_URL || 'https://futbollibres.info/';
const DEBUG = !!process.env.DEBUG;

// Convierte "19:00" (hora México, America/Mexico_City) a ISO UTC
function timeMexicoToUTC(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  const now = new Date();
  const mexicoNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/Mexico_City' }));
  const mexicoOffset = Math.round((mexicoNow - now) / 3600000);
  const utc = new Date(Date.UTC(
    mexicoNow.getFullYear(),
    mexicoNow.getMonth(),
    mexicoNow.getDate(),
    h - mexicoOffset,
    m
  ));
  return utc.toISOString();
}

// Por si algún canal todavía trae un link tipo /embed/xxx?r=BASE64 (sitios espejo viejos)
function decodeEmbedUrl(href) {
  try {
    const url = new URL(href);
    const r = url.searchParams.get('r');
    if (!r) return href;
    const decoded = Buffer.from(r, 'base64').toString('utf-8');
    new URL(decoded);
    return decoded;
  } catch {
    return href;
  }
}

async function scrapeFutbolLibre() {
  console.log(`[PUP] Usando Chromium de Puppeteer`);
  console.log(`[PUP] URL: ${SITE_URL}`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox','--disable-setuid-sandbox',
      '--disable-dev-shm-usage','--disable-gpu',
      '--no-first-run','--no-zygote','--single-process',
    ]
  });

  try {
    const page = await browser.newPage();

    // OJO: aquí NO bloqueamos 'media' porque algunos reproductores dependen
    // de peticiones tipo media/xhr para levantar el iframe. Sí bloqueamos
    // imágenes y fuentes para que cargue rápido.
    await page.setRequestInterception(true);
    page.on('request', req => {
      const type = req.resourceType();
      if (['image','font'].includes(type)) req.abort();
      else req.continue();
    });

    await page.setUserAgent(
      'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
    );
    await page.setViewport({ width: 390, height: 844 });

    console.log('[PUP] Cargando página...');
    await page.goto(SITE_URL, { waitUntil: 'networkidle2', timeout: 45000 });

    // La agenda se carga por AJAX y muestra "Cargando agenda…" mientras tanto
    try {
      await page.waitForFunction(
        () => !document.body.innerText.includes('Cargando agenda'),
        { timeout: 20000 }
      );
      console.log('[PUP] Placeholder de carga desapareció');
    } catch {
      console.warn('[PUP] La agenda no terminó de cargar a tiempo, sigo de todas formas');
    }

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
      const horaMexico = Number(new Date().toLocaleString('en-US', {
        timeZone: 'America/Mexico_City', hour: '2-digit', hour12: false
      }));
      if (horaMexico < 8) {
        console.log(`[PUP] Son las ${horaMexico}h México — normal que no haya eventos aún.`);
      } else {
        console.warn('[PUP] Sin horas en horario activo — posible cambio en la web.');
      }

      // ── DIAGNÓSTICO: guardar evidencia de qué vio realmente el navegador ──
      try {
        await page.screenshot({ path: path.join(process.cwd(), 'debug-screenshot.png'), fullPage: true });
        const html = await page.content();
        fs.writeFileSync(path.join(process.cwd(), 'debug-page.html'), html, 'utf-8');
        console.warn('[PUP] Guardé debug-screenshot.png y debug-page.html');

        const title = await page.title();
        console.warn(`[PUP] <title>: ${title}`);

        const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 400));
        console.warn('[PUP] Primeros 400 caracteres del texto visible:');
        console.warn(bodyText);

        const blockHints = ['cloudflare','just a moment','verificando','checking your browser','captcha','attention required','access denied','are you human','403 forbidden'];
        const htmlLower = html.toLowerCase();
        const found = blockHints.filter(h => htmlLower.includes(h));
        if (found.length) {
          console.warn(`[PUP] Posibles señales de bloqueo anti-bot: ${found.join(', ')}`);
        } else {
          console.warn('[PUP] No hay señales obvias de bloqueo anti-bot en el HTML.');
        }

        const iframeCount = await page.evaluate(() => document.querySelectorAll('iframe').length);
        console.warn(`[PUP] iframes en la página: ${iframeCount}`);
      } catch (e) {
        console.warn('[PUP] No pude guardar el diagnóstico:', e.message);
      }

      return [];
    }

    await sleep(1000);

    // Contar nodos de hora (dentro de la sección de agenda, para no contar
    // horas sueltas que pudieran aparecer en otras partes de la página)
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
        const timeEl = node.parentElement;
        timeEl.setAttribute('data-time-marker', `evt-${index}`);

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

      // ── PASO B: esperar los botones de canal (prefijo ▶/►) del evento ──
      let channelHandles = [];
      for (let t = 0; t < 15; t++) {
        await sleep(400);

        channelHandles = await page.evaluate((eventIdx) => {
          const timeRx  = /^\d{1,2}:\d{2}$/;
          const arrowRx = /^[▶►•\-\s]+\S/; // debe empezar con flecha y tener texto después

          const isVisible = (el) => {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return rect.width > 0 && rect.height > 0
              && style.display !== 'none'
              && style.visibility !== 'hidden'
              && style.opacity !== '0';
          };

          const timeEl = document.querySelector(`[data-time-marker="evt-${eventIdx}"]`);
          if (!timeEl) return [];

          // Subir ancestros hasta encontrar el contenedor que agrupa
          // exactamente esta hora (evita mezclar con otros eventos)
          let bestAncestor = null;
          let ancestor = timeEl.parentElement;
          for (let level = 0; level < 10 && ancestor; level++) {
            const allTimes = [];
            const walker = document.createTreeWalker(ancestor, NodeFilter.SHOW_TEXT, null);
            let n;
            while ((n = walker.nextNode())) {
              if (timeRx.test(n.textContent.trim())) allTimes.push(n.parentElement);
            }
            if (allTimes.length === 1 && allTimes[0] === timeEl) {
              bestAncestor = ancestor;
            }
            if (allTimes.length > 1) break;
            ancestor = ancestor.parentElement;
          }
          if (!bestAncestor) bestAncestor = timeEl.parentElement?.parentElement;
          if (!bestAncestor) return [];

          // Buscar elementos "hoja lógica" cuyo texto empiece con flecha ▶/►
          const all = Array.from(bestAncestor.querySelectorAll('*'));
          const matches = all.filter(el => arrowRx.test((el.textContent || '').trim()));
          // quedarnos solo con los más internos (sin otro match anidado adentro)
          const innermost = matches.filter(el =>
            !matches.some(other => other !== el && el.contains(other))
          );

          const seenText = new Set();
          const results = [];
          innermost.forEach((el, i) => {
            if (!isVisible(el)) return;
            const name = el.textContent.replace(/[▶►•\-\s]+/g, ' ').trim();
            if (!name || name.length < 2) return;
            if (seenText.has(name)) return;
            seenText.add(name);
            el.setAttribute('data-chan-marker', `ch-${eventIdx}-${i}`);
            results.push({ name, marker: `ch-${eventIdx}-${i}` });
          });
          return results;
        }, result.eventIdx);

        if (channelHandles.length > 0) break;
      }

      // Limpiar marcador de hora del evento actual
      await page.evaluate((eventIdx) => {
        const el = document.querySelector(`[data-time-marker="evt-${eventIdx}"]`);
        if (el) el.removeAttribute('data-time-marker');
      }, result.eventIdx);

      // ── PASO C: hacer click en cada canal y capturar el src real del iframe ──
      const channels = [];
      for (const chan of channelHandles) {
        const clicked = await page.evaluate((marker) => {
          const el = document.querySelector(`[data-chan-marker="${marker}"]`);
          if (!el) return false;
          el.scrollIntoView({ behavior: 'instant', block: 'center' });
          el.click();
          return true;
        }, chan.marker);

        if (!clicked) continue;

        let streamUrl = null;
        for (let t = 0; t < 15; t++) {
          await sleep(400);
          streamUrl = await page.evaluate(() => {
            const iframes = Array.from(document.querySelectorAll('iframe'));
            for (const f of iframes) {
              if (f.src && /^https?:\/\//i.test(f.src) && f.getBoundingClientRect().width > 50) {
                return f.src;
              }
            }
            return null;
          });
          if (streamUrl) break;
        }

        if (streamUrl) {
          channels.push({ name: chan.name, href: decodeEmbedUrl(streamUrl) });
        } else if (DEBUG) {
          console.warn(`[DEBUG] Sin iframe tras click en "${chan.name}"`);
        }

        // Cerrar el modal del reproductor antes del siguiente canal
        await page.evaluate(() => {
          const candidates = Array.from(document.querySelectorAll('button, a, span, div'));
          for (const el of candidates) {
            const t = (el.textContent || '').trim();
            if (/^✕?\s*Cerrar$/i.test(t) && el.getBoundingClientRect().width > 0) {
              el.click();
              return true;
            }
          }
          const sels = ['[class*="close"]', '[class*="cerrar"]', '[aria-label*="lose"]'];
          for (const s of sels) {
            const b = document.querySelector(s);
            if (b && b.getBoundingClientRect().width > 0) { b.click(); return true; }
          }
          return false;
        });
        await sleep(300);
      }

      // limpiar marcadores de canal de este evento
      await page.evaluate((eventIdx) => {
        document.querySelectorAll(`[data-chan-marker^="ch-${eventIdx}-"]`)
          .forEach(el => el.removeAttribute('data-chan-marker'));
      }, result.eventIdx);

      events.push({
        time     : result.time,
        time_utc : timeMexicoToUTC(result.time),
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

      // Cerrar acordeón antes del siguiente evento
      await page.keyboard.press('Escape');
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
    if (events.length > 0) source = 'futbollibres-puppeteer';
  } catch(e) {
    console.warn(`[PUP] FALLO: ${e.message}`);
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
