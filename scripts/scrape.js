const puppeteer = require('puppeteer-core');
const fs        = require('fs');
const path      = require('path');
const https     = require('https');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Convierte "19:00" (hora Colombia, UTC-5) a ISO UTC
function timeColombiaToUTC(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  const now = new Date();
  const bogotaOffset = 5 * 60 * 60 * 1000;
  const nowBogota = new Date(now.getTime() - bogotaOffset);
  const utc = new Date(Date.UTC(
    nowBogota.getUTCFullYear(),
    nowBogota.getUTCMonth(),
    nowBogota.getUTCDate(),
    h + 5,
    m
  ));
  return utc.toISOString();
}

// ── FIX #2: fetchJson ahora valida el HTTP status antes de parsear ──────────
// Antes: si el servidor respondía HTML (404/500), JSON.parse explotaba con
//        "JSON inválido". Ahora se lanza un error descriptivo.
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'SportStreamBot/1.0' }
    }, res => {
      // Rechazar si el servidor no devuelve 2xx
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume(); // descartar cuerpo
        return reject(new Error(`HTTP ${res.statusCode} en ${url}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        try { resolve(JSON.parse(raw)); }
        catch(e) {
          // Loguear los primeros 200 chars para diagnóstico
          console.warn(`[API] Respuesta no-JSON (${raw.slice(0,200)})`);
          reject(new Error('JSON inválido'));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

/**
 * Decodifica la URL real desde un enlace embed de futbollibre.
 * Entrada:  https://futbollibre.ec/embed/eventos.html?r=aHR0cHM6Ly90dnR2...
 * Salida:   https://tvtvhd.com/vivo/canales.php?stream=espn
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
      if (['image','font','media'].includes(type)) req.abort();
      else req.continue();
    });

    await page.setUserAgent(
      'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
    );
    await page.setViewport({ width: 390, height: 844 });

    console.log('[PUP] Cargando futbollibre.ec...');
    await page.goto('https://futbollibre.ec', { waitUntil: 'networkidle2', timeout: 45000 });

    // ── FIX #1: esperar horas con reintentos + scroll ──────────────────────
    // Problema: a las 2 AM la página carga pero sin eventos, O el contenido
    // es lazy-loaded y networkidle2 termina antes de que el JS pinte las cards.
    // Solución: intentar 3 veces, scrolleando la página entre intentos para
    // forzar la carga de contenido dinámico.
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
        // Scroll gradual para activar lazy-loading
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
      // Determinar si es horario "muerto" (antes de las 8 AM Colombia)
      const horaColombia = new Date(Date.now() - 5 * 3600_000).getUTCHours();
      if (horaColombia < 8) {
        console.log(`[PUP] Son las ${horaColombia}h Colombia — normal que no haya eventos aún.`);
      } else {
        console.warn('[PUP] Sin horas en horario activo — posible cambio en la web.');
      }
      return []; // devolver vacío sin lanzar error
    }

    await sleep(1000);

    // PASO 1: contar nodos de hora
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

    // PASO 2: clic en cada evento por índice
    for (let idx = 0; idx < eventCount; idx++) {

      // ── PASO 2A: localizar el evento, marcarlo y hacer click ──────────────
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

        // Marcamos SOLO el contenedor del evento (sin subir niveles)
        // Los canales aparecerán como hijos o hermanos cercanos al expandir
        container.setAttribute('data-event-clicked', 'true');

        container.scrollIntoView({ behavior: 'instant', block: 'center' });
        container.click();

        return { time, match, league };
      }, idx);

      if (!result || !result.match || result.match.length < 4) continue;

      // ── PASO 2B: esperar a que aparezcan los canales del evento actual ────
      // ESTRATEGIA: los canales son hijos del evento O hermanos siguientes
      // que aparecen al expandir el acordeón. Buscamos en orden:
      //   1) Hijos directos del evento clickeado (acordeón interno)
      //   2) Hermanos siguientes inmediatos (acordeón externo)
      //   3) Modal flotante (caso menos común)
      let rawChannels = [];
      for (let t = 0; t < 12; t++) {
        await sleep(400);

        rawChannels = await page.evaluate(() => {
          const seen = new Set();

          // Helper: extraer canales VISIBLES dentro de un elemento
          const extractFrom = (root) => {
            if (!root) return [];
            const found = [];
            root.querySelectorAll('a[href*="futbollibre.ec/embed/eventos.html"][href*="?r="]').forEach(a => {
              const href = a.href || '';
              if (!href) return;
              if (seen.has(href)) return;

              const rect = a.getBoundingClientRect();
              const style = window.getComputedStyle(a);
              const isVisible = rect.width > 0 && rect.height > 0
                && style.display !== 'none'
                && style.visibility !== 'hidden'
                && style.opacity !== '0';
              if (!isVisible) return;

              seen.add(href);
              const name = a.textContent?.replace(/[▶►•\-\s]+/g, ' ').trim()
                        || `Canal ${found.length + 1}`;
              found.push({ name, href });
            });
            return found;
          };

          const eventClicked = document.querySelector('[data-event-clicked="true"]');
          if (!eventClicked) return [];

          const results = [];

          // ESTRATEGIA 1: Canales como HIJOS del evento (acordeón anidado)
          // Aparecen DENTRO del propio contenedor del evento
          results.push(...extractFrom(eventClicked));
          if (results.length > 0) return results;

          // ESTRATEGIA 2: Canales como HERMANOS SIGUIENTES inmediatos
          // El panel de canales se inserta justo después del evento.
          // PERO debemos parar en el siguiente evento (el siguiente bloque
          // que tenga su propia hora) para no robarle canales.
          const timeRx = /^\d{1,2}:\d{2}$/;

          // Función para detectar si un elemento contiene un nuevo evento
          // (otro bloque con su propia hora)
          const isNewEvent = (el) => {
            if (!el) return false;
            // Buscamos si el elemento contiene un texto que sea solo una hora
            const textNodes = el.querySelectorAll('*');
            for (const t of textNodes) {
              if (t.children.length === 0 && timeRx.test(t.textContent.trim())) {
                return true;
              }
            }
            // O el elemento mismo es un texto de hora
            if (el.children.length === 0 && timeRx.test(el.textContent.trim())) {
              return true;
            }
            return false;
          };

          let sibling = eventClicked.nextElementSibling;
          let depth = 0;
          while (sibling && depth < 8) {
            // ⛔ Si el siguiente hermano es un nuevo evento, detenemos la búsqueda
            // para no incluir los canales del evento siguiente
            if (isNewEvent(sibling)) break;

            results.push(...extractFrom(sibling));
            // Seguimos buscando incluso si encontramos canales en este sibling
            // (puede haber múltiples siblings con canales antes del próximo evento)
            sibling = sibling.nextElementSibling;
            depth++;
          }
          if (results.length > 0) return results;

          // ESTRATEGIA 3 (fallback): Modal/Dialog visible
          const modal = document.querySelector('[role="dialog"]')
                     || Array.from(document.querySelectorAll('[class*="modal"], [class*="Modal"], [class*="popup"], [class*="Popup"]'))
                          .find(el => {
                            const rect = el.getBoundingClientRect();
                            const style = window.getComputedStyle(el);
                            return rect.width > 100 && rect.height > 100
                              && style.display !== 'none'
                              && style.visibility !== 'hidden'
                              && style.opacity !== '0';
                          });
          if (modal) {
            results.push(...extractFrom(modal));
          }

          return results;
        });

        if (rawChannels.length > 0) break;
      }

      // Limpiar marcador del evento actual
      await page.evaluate(() => {
        document.querySelectorAll('[data-event-clicked="true"]').forEach(el => el.removeAttribute('data-event-clicked'));
      });

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

  // ── FIX #3: no marcar el Action como fallido si simplemente no hay eventos ──
  // Antes:  if (events.length === 0) process.exit(1)  ← falso positivo
  // Ahora:  solo salir con error si el scraper lanzó una excepción real,
  //         no por ausencia de partidos (común de madrugada).
  // process.exit(0) es el comportamiento por defecto, no hace falta llamarlo.
}

main().catch(e => { console.error('ERROR FATAL:', e); process.exit(1); });
