

const puppeteer = require('puppeteer-core');
const fs        = require('fs');
const path      = require('path');
const https     = require('https');
const http      = require('http');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept'    : 'application/json, */*',
        'Referer'   : 'https://futbollibre.ec/',
      }
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        try { resolve(JSON.parse(text)); }
        catch(e) { reject(new Error(`JSON inválido: ${text.slice(0,100)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

/* ══════════════════════════════════════════════════════════════
   FUENTE 1 — pltvhd.com/diaries.json
══════════════════════════════════════════════════════════════ */
async function fetchDiaries() {
  console.log('[API] pltvhd.com/diaries.json ...');
  const raw   = await fetchUrl('https://pltvhd.com/diaries.json');
  const today = new Date().toISOString().slice(0, 10);
  console.log('[API] Campos raíz:', Object.keys(raw).join(', '));

  const list = findList(raw, today);
  if (!list || list.length === 0) {
    console.log('[API] Sin lista. Muestra:', JSON.stringify(raw).slice(0, 500));
    return [];
  }
  console.log(`[API] ${list.length} eventos. Campos:`, Object.keys(list[0]).join(', '));
  console.log('[API] Muestra evento[0]:', JSON.stringify(list[0]).slice(0, 300));
  return list;
}

function findList(obj, today, depth=0) {
  if (depth > 6 || !obj || typeof obj !== 'object') return null;
  if (Array.isArray(obj) && obj.length > 2 && isEventObj(obj[0])) return obj;
  const d = obj.data ?? obj;
  if (!Array.isArray(d)) {
    for (const k of [today, 'events','eventos','matches','schedule','items','partidos','data']) {
      if (Array.isArray(d[k]) && d[k].length > 0 && isEventObj(d[k][0])) return d[k];
    }
    for (const k of Object.keys(d)) {
      const r = findList(d[k], today, depth+1);
      if (r) return r;
    }
  }
  return null;
}

function isEventObj(o) {
  if (!o || typeof o !== 'object') return false;
  const k = Object.keys(o).join(' ').toLowerCase();
  return k.includes('tiempo')||k.includes('time')||k.includes('hora')||
         k.includes('fósforo')||k.includes('match')||k.includes('partido')||k.includes('titulo');
}

/* ══════════════════════════════════════════════════════════════
   FUENTE 2 — Puppeteer
   
   ESTRATEGIA CORREGIDA:
   1. Scroll completo para cargar TODOS los eventos
   2. Recolectar referencias a elementos (no coordenadas)
   3. Para cada evento: scrollIntoView() → click() → esperar modal
   4. Capturar SOLO href que contengan "futbollibre.ec/embed"
   5. Cerrar modal → siguiente evento
══════════════════════════════════════════════════════════════ */
async function scrapeWithPuppeteer() {
  const browser = await puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXEC || '/usr/bin/chromium-browser',
    headless: 'new',
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
           '--disable-gpu','--no-first-run','--no-zygote','--single-process']
  });

  const events = [];

  try {
    const page = await browser.newPage();

    // No bloquear nada — algunos scripts son necesarios para el modal
    await page.setRequestInterception(true);
    page.on('request', req => {
      if (['image','media','font'].includes(req.resourceType())) req.abort();
      else req.continue();
    });

    await page.setUserAgent(
      'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36'
    );
    await page.setViewport({ width: 390, height: 844 });

    console.log('[PUP] Cargando futbollibre.ec...');
    await page.goto('https://futbollibre.ec', { waitUntil:'networkidle2', timeout:60000 });

    try {
      await page.waitForFunction(() => document.body.innerText.match(/\d{1,2}:\d{2}/), { timeout:20000 });
    } catch(e) { console.warn('[PUP] Horas no detectadas en página'); }

    // ── Scroll completo para cargar todos los eventos ────────────
    console.log('[PUP] Scrolleando página completa...');
    await page.evaluate(async () => {
      await new Promise(resolve => {
        let total = 0;
        const step = 400;
        const id = setInterval(() => {
          window.scrollBy(0, step);
          total += step;
          if (total >= document.body.scrollHeight) {
            clearInterval(id);
            window.scrollTo(0, 0); // volver al inicio
            resolve();
          }
        }, 150);
      });
    });
    await sleep(2000);

    // ── Paso 1: Recolectar info de TODOS los eventos ─────────────
    // Buscar el TEXTO de cada evento sin usar coordenadas
    const eventInfos = await page.evaluate(() => {
      const timeRx  = /^\d{1,2}:\d{2}$/;
      const results = [];
      const seen    = new Set();

      // Buscar nodos de texto que son una hora sola
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
      let node;

      while ((node = walker.nextNode())) {
        const timeText = node.textContent.trim();
        if (!timeRx.test(timeText)) continue;

        // Subir para encontrar el contenedor del evento
        let container = node.parentElement;
        for (let i = 0; i < 6; i++) {
          if (!container) break;
          // El contenedor tiene más texto (nombre del partido)
          const innerTexts = Array.from(container.querySelectorAll('*'))
            .filter(el => el.children.length === 0 && el.textContent.trim().length > 5)
            .map(el => el.textContent.trim())
            .filter(t => !timeRx.test(t));
          if (innerTexts.length > 0) break;
          container = container.parentElement;
        }
        if (!container) continue;

        // Extraer nombre del partido
        const innerTexts = Array.from(container.querySelectorAll('*'))
          .filter(el => el.children.length === 0)
          .map(el => el.textContent.trim())
          .filter(t => t.length > 3 && !timeRx.test(t));

        if (innerTexts.length === 0) continue;

        // Elegir el texto más representativo del partido
        // Ignorar textos muy cortos o que solo sean emojis
        let matchTitle = '';
        let leagueName = '';
        for (const t of innerTexts) {
          if (t.length > 5 && !/^[\s\W]+$/.test(t)) {
            if (!matchTitle) matchTitle = t;
            else if (!leagueName) leagueName = t;
          }
        }

        // Limpiar: "Copa del Rey: Real vs Barça" → league="Copa del Rey", match="Real vs Barça"
        if (matchTitle.includes(':') && matchTitle.split(':')[1].trim().length > 3) {
          const parts = matchTitle.split(':');
          leagueName  = parts[0].trim();
          matchTitle  = parts.slice(1).join(':').trim();
        } else if (matchTitle.endsWith(':')) {
          // "Copa del Rey:" sin nombre de equipos — buscar en más textos
          matchTitle = innerTexts.find(t => t.includes(' vs ') || t.includes(' - ')) || matchTitle.replace(/:$/, '');
          leagueName = innerTexts[0]?.replace(/:$/, '') || '';
        }

        if (matchTitle.length < 4) continue;

        const key = `${timeText}|${matchTitle}`;
        if (seen.has(key)) continue;
        seen.add(key);

        results.push({
          time   : timeText,
          match  : matchTitle,
          league : leagueName,
          // Guardar una "huella" del texto del contenedor para buscarlo después
          containerText: container.textContent.trim().slice(0, 60),
        });
      }

      return results;
    });

    console.log(`[PUP] ${eventInfos.length} eventos detectados`);

    // ── Paso 2: Clic en cada evento y captura de canales ─────────
    // Usar índice del elemento en el DOM, no coordenadas
    for (let i = 0; i < eventInfos.length; i++) {
      const evInfo = eventInfos[i];

      // Clic usando element.click() + scrollIntoView
      // ✅ Funciona para elementos fuera de pantalla
      const clicked = await page.evaluate((containerText) => {
        const timeRx = /\d{1,2}:\d{2}/;
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
        let node;
        while ((node = walker.nextNode())) {
          if (!timeRx.test(node.textContent.trim())) continue;
          let container = node.parentElement;
          for (let j = 0; j < 6; j++) {
            if (!container) break;
            if (container.textContent.trim().slice(0, 60) === containerText) {
              container.scrollIntoView({ behavior:'instant', block:'center' });
              container.click();
              return true;
            }
            container = container.parentElement;
          }
        }
        return false;
      }, evInfo.containerText);

      if (!clicked) continue;
      await sleep(1500);

      // ── Capturar SOLO futbollibre.ec/embed URLs ───────────────
      // ✅ Excluir Telegram share, Facebook share, Twitter, etc.
      const channels = await page.evaluate(() => {
        const results = [];
        const seen    = new Set();

        document.querySelectorAll('a[href]').forEach(a => {
          const href = a.href || '';

          // ✅ SOLO aceptar el formato de embed de futbollibre.ec
          if (
            href.includes('futbollibre.ec/embed/eventos.html') &&
            href.includes('?r=') &&
            !seen.has(href)
          ) {
            seen.add(href);
            const rawName = a.textContent?.replace(/[▶►\s]+/g, ' ').trim() || '';
            // Extraer nombre limpio del canal
            let name = rawName;
            // Si el nombre es una URL o está vacío, usar fallback
            if (!name || name.length < 2 || name.startsWith('http')) name = `Canal ${results.length + 1}`;
            results.push({ name, href });
          }
        });

        return results;
      });

      if (channels.length > 0) {
        events.push({
          time    : evInfo.time,
          match   : evInfo.match,
          league  : evInfo.league,
          flag    : '⚽',
          channels
        });
        console.log(`[PUP] ✅ "${evInfo.match}" → ${channels.length} canal(es)`);
        channels.forEach(c => console.log(`     → ${c.name}: ${c.href.slice(0, 80)}`));
      } else {
        // Sin canales también guardamos el evento (sin canales disponibles aún)
        events.push({
          time    : evInfo.time,
          match   : evInfo.match,
          league  : evInfo.league,
          flag    : '⚽',
          channels: []
        });
      }

      // Cerrar modal
      await page.keyboard.press('Escape');
      await sleep(300);
    }

    await page.close();
  } finally {
    await browser.close();
  }

  return events;
}

/* ── Normalizar cualquier formato a campos en inglés ─── */
function normalizeEvents(list) {
  return list.map(item => {
    const rawCh = item.channels || item.canales || item.links || [];
    const channels = rawCh.map(ch => {
      if (typeof ch === 'string') return { name:'Canal', href: ch };
      return {
        name: ch.name || ch.nombre || ch.canal || 'Canal',
        href: ch.href || ch.url   || ch.link  || ''
      };
    }).filter(ch => ch.href && ch.href.startsWith('http'));

    return {
      time    : item.time    || item.tiempo  || '00:00',
      match   : item.match   || item.fósforo || item.partido || item.titulo || item.name || '',
      league  : item.league  || item.liga    || item.torneo  || '',
      flag    : '⚽',
      channels
    };
  }).filter(ev => ev.match && ev.match.length > 2);
}

/* ══════════════════════════════════════════════════════════════
   MAIN
══════════════════════════════════════════════════════════════ */
async function main() {
  console.log(`\n[${new Date().toISOString()}] === SportStream Scraper v8 ===\n`);
  let events = [], source = 'none';

  // 1. API directa pltvhd
  try {
    const raw = await fetchDiaries();
    if (raw.length > 0) {
      events = normalizeEvents(raw);
      source = 'pltvhd';
      console.log(`[API] ${events.length} eventos, ${events.filter(e=>e.channels.length>0).length} con canales`);
    }
  } catch(e) { console.warn('[API] FALLÓ:', e.message); }

  // 2. Puppeteer — si la API no dio canales o falló
  const sinCanales = events.filter(e => e.channels.length === 0).length;
  if (sinCanales === events.length) {
    console.log('[PUP] Iniciando scraping con clics...');
    try {
      const pEvents = await scrapeWithPuppeteer();
      if (pEvents.length > 0) {
        if (events.length > 0) {
          // Fusionar: nombres de la API + canales del Puppeteer
          events.forEach(ev => {
            const match = pEvents.find(pe =>
              pe.match.toLowerCase().slice(0,10) === ev.match.toLowerCase().slice(0,10)
            );
            if (match?.channels.length) ev.channels = match.channels;
          });
          // Agregar los que no estaban
          pEvents.forEach(pe => {
            if (pe.channels.length > 0 && !events.some(ev =>
              ev.match.toLowerCase().slice(0,10) === pe.match.toLowerCase().slice(0,10)
            )) events.push(pe);
          });
          source = 'pltvhd+puppeteer';
        } else {
          events = pEvents;
          source = 'puppeteer';
        }
      }
    } catch(e) { console.error('[PUP] FALLÓ:', e.message); }
  }

  // 3. Fallback Railway
  if (events.length === 0 && process.env.API_URL) {
    try {
      const data = await fetchUrl(process.env.API_URL + '/eventos');
      const list = data.events || data.eventos || [];
      if (list.length > 0) { events = normalizeEvents(list); source = 'railway'; }
    } catch(e) { console.warn('[RAILWAY]', e.message); }
  }

  events.sort((a,b) => {
    const m = t => { const [h,mm]=(t||'0:0').split(':').map(Number); return h*60+(mm||0); };
    return m(a.time)-m(b.time);
  });

  const withCh = events.filter(e=>e.channels.length>0).length;

  console.log('\n════ RESUMEN ════');
  events.forEach(ev => {
    const mark = ev.channels.length > 0 ? '✅' : '○ ';
    console.log(`${mark} ${ev.time} | ${ev.match} (${ev.channels.length} canales)`);
    ev.channels.forEach(c => console.log(`    → ${c.name}: ${c.href.slice(0,80)}`));
  });
  console.log(`════ Total:${events.length} | Con canales:${withCh} ════\n`);

  const output = {
    actualizado_en     : new Date().toISOString(),
    fecha              : new Date().toLocaleDateString('es-ES',{weekday:'long',day:'numeric',month:'long'}),
    fuente             : source,
    contar             : events.length,
    contar_con_canales : withCh,
    events,
    eventos            : events
  };

  fs.writeFileSync(path.join(process.cwd(),'eventos.json'), JSON.stringify(output,null,2), 'utf-8');
  console.log(`✅ LISTO | ${source} | ${events.length} | canales:${withCh}`);
  if (events.length === 0) process.exit(1);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
