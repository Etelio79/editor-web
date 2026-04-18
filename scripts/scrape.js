/**
 * SportStream Scraper v6 — DIAGNÓSTICO + OBTENCIÓN DE CANALES
 * 
 * CAMBIOS vs versiones anteriores:
 * - Imprime el HTML exacto de los primeros 3 eventos (para ver la estructura real)
 * - Captura TODAS las peticiones de red (no solo JSON)
 * - Hace clic en eventos y captura CUALQUIER cambio en el DOM
 * - Logs detallados de todo
 */

const puppeteer = require('puppeteer-core');
const fs        = require('fs');
const path      = require('path');
const https     = require('https');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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

async function main() {
  console.log(`\n[${new Date().toISOString()}] === SportStream Scraper v6 (diagnóstico) ===\n`);

  const browser = await puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXEC || '/usr/bin/chromium-browser',
    headless: 'new',
    args: [
      '--no-sandbox','--disable-setuid-sandbox',
      '--disable-dev-shm-usage','--disable-gpu',
      '--no-first-run','--no-zygote','--single-process',
      '--disable-blink-features=AutomationControlled',
    ]
  });

  let events = [];
  let source  = 'none';

  try {
    const page = await browser.newPage();

    /* ── Capturar TODAS las peticiones y respuestas de red ─── */
    const networkLog    = []; // todas las URLs pedidas
    const jsonResponses = []; // solo respuestas JSON

    page.on('request', req => {
      const url  = req.url();
      const type = req.resourceType();
      networkLog.push({ type, url: url.slice(0, 120) });
    });

    page.on('response', async res => {
      const url    = res.url();
      const status = res.status();
      const ct     = res.headers()['content-type'] || '';

      // Capturar TODAS las respuestas JSON/JS con contenido
      if (ct.includes('json') || (ct.includes('javascript') && url.includes('/api'))) {
        try {
          const text = await res.text();
          if (text.length > 30 && (text.startsWith('[') || text.startsWith('{'))) {
            const json = JSON.parse(text);
            jsonResponses.push({ url, status, json, ct });
          }
        } catch(e) {}
      }
    });

    // NO bloquear nada — dejar que todo pase para capturar la API
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
    );

    console.log('Cargando https://futbollibre.ec ...');
    await page.goto('https://futbollibre.ec', { waitUntil:'networkidle0', timeout:60000 });
    await sleep(3000);

    /* ═══════════════════════════════════════════════════════
       DIAGNÓSTICO 1: Todas las respuestas JSON capturadas
    ═══════════════════════════════════════════════════════ */
    console.log('\n═══ RESPUESTAS JSON CAPTURADAS ═══');
    if (jsonResponses.length === 0) {
      console.log('⚠️  NINGUNA respuesta JSON capturada');
    } else {
      jsonResponses.forEach(({ url, status, json }) => {
        const size  = JSON.stringify(json).length;
        const isArr = Array.isArray(json);
        const len   = isArr ? json.length : Object.keys(json).length;
        console.log(`  [${status}] ${url.slice(0, 100)}`);
        console.log(`         tipo:${isArr?'array':'objeto'} largo:${len} bytes:${size}`);
        if (size < 500) {
          console.log(`         contenido: ${JSON.stringify(json).slice(0, 200)}`);
        } else if (isArr && json.length > 0) {
          console.log(`         campos del primer item: ${Object.keys(json[0]).join(', ')}`);
          console.log(`         primer item: ${JSON.stringify(json[0]).slice(0, 200)}`);
        } else if (!isArr) {
          console.log(`         campos: ${Object.keys(json).join(', ')}`);
        }
      });
    }

    /* ═══════════════════════════════════════════════════════
       DIAGNÓSTICO 2: URLs pedidas (para encontrar el endpoint de canales)
    ═══════════════════════════════════════════════════════ */
    console.log('\n═══ TODAS LAS URLs PEDIDAS ═══');
    const uniqueUrls = [...new Set(networkLog.map(r => r.url))];
    uniqueUrls.forEach(url => console.log('  ' + url));

    /* ═══════════════════════════════════════════════════════
       DIAGNÓSTICO 3: HTML exacto de los primeros 3 eventos
    ═══════════════════════════════════════════════════════ */
    console.log('\n═══ HTML DE LOS PRIMEROS 3 EVENTOS ═══');
    const eventHtml = await page.evaluate(() => {
      const timeRx = /\d{1,2}:\d{2}/;
      const results = [];
      const all = Array.from(document.querySelectorAll('*'));

      for (const el of all) {
        if (results.length >= 3) break;
        if (el.children.length > 0 && el.children.length < 6) {
          const txt = el.textContent?.trim() || '';
          if (timeRx.test(txt) && txt.length > 10 && txt.length < 200) {
            results.push({
              tag       : el.tagName,
              id        : el.id || '',
              className : el.className?.slice(0, 60) || '',
              attrs     : Array.from(el.attributes).map(a => `${a.name}="${a.value.slice(0,50)}"`).join(' '),
              text      : txt.slice(0, 80),
              html      : el.outerHTML.slice(0, 500),
            });
          }
        }
      }
      return results;
    });

    eventHtml.forEach((el, i) => {
      console.log(`\n--- Evento ${i+1} ---`);
      console.log(`tag: ${el.tag}  id: "${el.id}"  class: "${el.className}"`);
      console.log(`attrs: ${el.attrs}`);
      console.log(`texto: ${el.text}`);
      console.log(`html: ${el.html}`);
    });

    /* ═══════════════════════════════════════════════════════
       OBTENCIÓN: Buscar eventos en las respuestas JSON
    ═══════════════════════════════════════════════════════ */
    console.log('\n═══ BUSCANDO EVENTOS EN RESPUESTAS JSON ═══');
    let bestList = [];

    for (const { url, json } of jsonResponses) {
      const list = Array.isArray(json) ? json
        : (json.data || json.eventos || json.events || json.matches ||
           json.partidos || json.schedule || json.results || []);

      if (!Array.isArray(list) || list.length < 3) continue;

      const sample = list[0];
      if (!sample || typeof sample !== 'object') continue;

      const keys = Object.keys(sample).join(' ').toLowerCase();
      const hasEventData = keys.includes('tiempo') || keys.includes('time') ||
                           keys.includes('fósforo') || keys.includes('match') ||
                           keys.includes('partido');

      if (hasEventData) {
        console.log(`✅ Lista de eventos encontrada: ${url.slice(0, 80)}`);
        console.log(`   ${list.length} items, campos: ${Object.keys(sample).join(', ')}`);
        if (list.length > bestList.length) bestList = list;
      }
    }

    if (bestList.length > 0) {
      events = normalizeEvents(bestList);
      source = 'api-json';
      console.log(`\nEventos normalizados: ${events.length}`);
      console.log(`Con canales: ${events.filter(e=>e.channels.length>0).length}`);
    }

    /* ═══════════════════════════════════════════════════════
       OBTENCIÓN: Si no hay canales, hacer CLIC en los eventos
       y capturar las nuevas respuestas de red
    ═══════════════════════════════════════════════════════ */
    if (events.filter(e => e.channels.length > 0).length === 0) {
      console.log('\n═══ HACIENDO CLIC EN EVENTOS PARA CAPTURAR CANALES ═══');

      // Encontrar elementos clickeables que representen eventos
      const clickTargets = await page.evaluate(() => {
        const timeRx = /^\d{1,2}:\d{2}/;
        const found  = [];
        const seen   = new Set();

        // Probar múltiples estrategias para encontrar elementos de evento
        const strategies = [
          // Elementos con clase que sugiere evento/partido
          '[class*="event"],[class*="partido"],[class*="match"],[class*="fixture"]',
          '[class*="item"],[class*="row"],[class*="card"]',
          // Elementos de lista
          'li,tr,article',
          // Cualquier div/span directo bajo el body con hora
          'div,section',
        ];

        for (const sel of strategies) {
          document.querySelectorAll(sel).forEach(el => {
            const txt = el.textContent?.trim() || '';
            if (
              timeRx.test(txt) &&
              txt.length > 10 &&
              txt.length < 300 &&
              !seen.has(txt.slice(0, 30))
            ) {
              seen.add(txt.slice(0, 30));
              const rect = el.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0 && rect.height < 200) {
                found.push({
                  index    : found.length,
                  selector : el.tagName.toLowerCase() +
                             (el.id ? `#${el.id}` : '') +
                             (el.className ? `.${[...el.classList][0]||''}` : ''),
                  text     : txt.slice(0, 60),
                  rect     : { top: rect.top, left: rect.left, w: rect.width, h: rect.height },
                  dataAttrs: Array.from(el.attributes)
                               .filter(a => a.name.startsWith('data-'))
                               .map(a => `${a.name}=${a.value.slice(0,50)}`)
                               .join(', '),
                });
                if (found.length >= 10) return;
              }
            }
          });
          if (found.length >= 5) break;
        }
        return found;
      });

      console.log(`Elementos clickeables encontrados: ${clickTargets.length}`);
      clickTargets.forEach((t, i) =>
        console.log(`  ${i}: ${t.selector} | "${t.text}" | data:[${t.dataAttrs}]`)
      );

      // Hacer clic en los primeros 5 eventos y capturar resultados
      for (const target of clickTargets.slice(0, 5)) {
        console.log(`\nClicando: "${target.text}"`);

        const prevJsonLen = jsonResponses.length;

        // Hacer clic usando coordenadas
        try {
          await page.mouse.click(
            target.rect.left + target.rect.w / 2,
            target.rect.top  + target.rect.h / 2
          );
        } catch(e) {
          // Fallback: clic via evaluate
          await page.evaluate((sel, idx) => {
            const els = document.querySelectorAll(sel.split('.')[0]);
            if (els[idx]) els[idx].click();
          }, target.selector, target.index);
        }

        await sleep(2500);

        // Nuevas respuestas JSON desde el clic
        const newJson = jsonResponses.slice(prevJsonLen);
        if (newJson.length > 0) {
          newJson.forEach(({ url, json }) => {
            console.log(`  Nueva API: ${url.slice(0, 100)}`);
            console.log(`  Datos: ${JSON.stringify(json).slice(0, 300)}`);
          });
        } else {
          console.log('  (sin nuevas respuestas JSON)');
        }

        // Nuevo HTML que apareció (modal, dropdown, etc.)
        const newHtml = await page.evaluate(() => {
          // Buscar elementos que hayan aparecido o sean visibles con links
          const fresh = [];
          document.querySelectorAll('[class*="modal"],[class*="popup"],[class*="overlay"],[class*="dropdown"]').forEach(el => {
            if (el.offsetWidth > 0 && el.offsetHeight > 0) {
              fresh.push({ html: el.outerHTML.slice(0, 800), class: el.className });
            }
          });
          // También buscar links con embeds que no estaban antes
          document.querySelectorAll('a[href*="embed"],a[href*="player"],iframe[src]').forEach(el => {
            fresh.push({ type: el.tagName, href: el.href || el.src });
          });
          return fresh;
        });

        if (newHtml.length > 0) {
          console.log('  Nuevo contenido:');
          newHtml.forEach(h => console.log(`    ${JSON.stringify(h).slice(0, 200)}`));
        } else {
          console.log('  (sin nuevo contenido visible)');
        }

        // Cerrar modal si abrió
        await page.keyboard.press('Escape');
        await sleep(500);
      }
    }

    await page.close();

  } catch(e) {
    console.error(`[ERROR] ${e.message}\n${e.stack}`);
  } finally {
    await browser.close();
  }

  /* ═══════════════════════════════════════════════════════
     Si no encontramos canales, usar fallback Railway
  ═══════════════════════════════════════════════════════ */
  if (events.length === 0) {
    try {
      const apiUrl = process.env.API_URL;
      if (apiUrl) {
        console.log(`\nUsando fallback: ${apiUrl}/eventos`);
        const data = await fetchJson(apiUrl + '/eventos');
        const list = data.events || data.eventos || [];
        if (list.length > 0) { events = normalizeEvents(list); source = 'fallback'; }
      }
    } catch(e) { console.warn(`Fallback falló: ${e.message}`); }
  }

  events.sort((a, b) => {
    const m = t => { const [h,mm]=(t||'0:0').split(':').map(Number); return h*60+(mm||0); };
    return m(a.time) - m(b.time);
  });

  const withCh = events.filter(e => e.channels.length > 0).length;

  const output = {
    actualizado_en     : new Date().toISOString(),
    fecha              : new Date().toLocaleDateString('es-ES',{weekday:'long',day:'numeric',month:'long'}),
    fuente             : source,
    contar             : events.length,
    contar_con_canales : withCh,
    events,
    eventos: events
  };

  fs.writeFileSync(path.join(process.cwd(), 'eventos.json'), JSON.stringify(output, null, 2), 'utf-8');
  console.log(`\n✅ LISTO | ${source} | ${events.length} eventos | ${withCh} con canales`);
  if (events.length === 0) process.exit(1);
}

/* ── Normalizar a campos en inglés ─── */
function normalizeEvents(list) {
  return list.map(item => {
    const rawCh = item.channels || item.canales || item.links || item.streams || [];
    const channels = rawCh.map(ch => {
      if (typeof ch === 'string') return { name:'Canal', href: ch };
      return {
        name: ch.name || ch.nombre || ch.canal || 'Canal',
        href: ch.href || ch.url   || ch.link  || ch.embed || ch.src || ''
      };
    }).filter(ch => ch.href && ch.href.startsWith('http'));

    return {
      time    : item.time     || item.tiempo   || '00:00',
      match   : item.match    || item.fósforo  || item.partido || item.titulo || item.name || '',
      league  : item.league   || item.liga     || item.torneo  || '',
      flag    : '⚽',
      channels
    };
  }).filter(ev => ev.match && ev.match.length > 2);
}

main().catch(e => { console.error('ERROR FATAL:', e); process.exit(1); });
