
const puppeteer = require('puppeteer-core');
const fs        = require('fs');
const path      = require('path');
const https     = require('https');
const http      = require('http');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ── HTTP fetch con headers de navegador ─────────────────────── */
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: {
        'User-Agent' : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept'     : 'application/json, */*',
        'Referer'    : 'https://futbollibre.ec/',
        'Origin'     : 'https://futbollibre.ec',
      }
    }, res => {
      // Seguir redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        try { resolve(JSON.parse(text)); }
        catch(e) { reject(new Error(`JSON inválido (${url}): ${text.slice(0, 80)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

/* ══════════════════════════════════════════════════════════════
   FUENTE 1 — pltvhd.com/diaries.json (sin Puppeteer)
══════════════════════════════════════════════════════════════ */
async function fetchDiaries() {
  console.log('[API] Fetching pltvhd.com/diaries.json ...');
  const raw   = await fetchUrl('https://pltvhd.com/diaries.json');
  const today = new Date().toISOString().slice(0, 10); // "2026-04-18"

  console.log(`[API] Campos raíz: ${Object.keys(raw).join(', ')}`);

  // Buscar la lista de eventos en la estructura del JSON
  const list = findEventList(raw, today);

  if (!list || list.length === 0) {
    console.log('[API] ⚠️  No se encontró lista de eventos');
    console.log('[API] Primeros 800 chars:', JSON.stringify(raw).slice(0, 800));
    return [];
  }

  console.log(`[API] ${list.length} eventos encontrados`);
  console.log('[API] Campos del primer evento:', Object.keys(list[0]).join(', '));
  console.log('[API] Primer evento:', JSON.stringify(list[0]).slice(0, 300));

  return list;
}

/* Busca recursivamente la lista de eventos en el JSON */
function findEventList(data, today, depth = 0) {
  if (depth > 6 || !data || typeof data !== 'object') return null;

  const d = data.data !== undefined ? data.data : data;

  // Array directo
  if (Array.isArray(d) && d.length > 3 && hasEventShape(d[0])) return d;

  // Keyed por fecha de hoy
  if (d[today] && Array.isArray(d[today]) && d[today].length > 0) return d[today];

  // Campos comunes
  for (const key of ['events','eventos','matches','schedule','partidos','data','items','list']) {
    if (Array.isArray(d[key]) && d[key].length > 3 && hasEventShape(d[key][0])) return d[key];
  }

  // Buscar en todos los campos
  for (const key of Object.keys(d)) {
    const val = d[key];
    if (!val || typeof val !== 'object') continue;
    const found = findEventList(val, today, depth + 1);
    if (found) return found;
  }

  return null;
}

function hasEventShape(obj) {
  if (!obj || typeof obj !== 'object') return false;
  const keys = Object.keys(obj).join(' ').toLowerCase();
  return keys.includes('tiempo') || keys.includes('time')   ||
         keys.includes('hora')   || keys.includes('match')  ||
         keys.includes('partido')|| keys.includes('titulo') ||
         keys.includes('fósforo');
}

/* ══════════════════════════════════════════════════════════════
   FUENTE 2 — Puppeteer con clics
   
   Carga futbollibre.ec, hace clic en cada evento y captura
   las URLs de canal del modal.
   
   CLAVE: ahora acepta href que incluyan "futbollibre.ec/embed"
   ↑ este era el bug en todas las versiones anteriores
══════════════════════════════════════════════════════════════ */
async function scrapeWithPuppeteer() {
  console.log('[PUP] Iniciando scraping con Puppeteer...');

  const browser = await puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXEC || '/usr/bin/chromium-browser',
    headless: 'new',
    args: [
      '--no-sandbox','--disable-setuid-sandbox',
      '--disable-dev-shm-usage','--disable-gpu',
      '--no-first-run','--no-zygote','--single-process',
    ]
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

    await page.goto('https://futbollibre.ec', { waitUntil:'networkidle2', timeout:60000 });
    try { await page.waitForFunction(() => document.body.innerText.match(/\d{1,2}:\d{2}/), { timeout:20000 }); } catch(e) {}
    await sleep(2000);

    // Obtener todos los elementos de evento clickeables
    const targets = await page.evaluate(() => {
      const timeRx = /\d{1,2}:\d{2}/;
      const found  = [];
      const seen   = new Set();

      for (const el of document.querySelectorAll('*')) {
        const txt  = el.textContent?.trim() || '';
        const rect = el.getBoundingClientRect();
        if (
          timeRx.test(txt) && txt.length > 8 && txt.length < 300 &&
          rect.width > 50 && rect.height > 5 && rect.height < 200 &&
          el.children.length > 0 && el.children.length < 15 &&
          !seen.has(txt.slice(0, 35))
        ) {
          seen.add(txt.slice(0, 35));
          found.push({ x: rect.left + rect.width/2, y: rect.top + rect.height/2, text: txt.slice(0,80) });
          if (found.length >= 70) break;
        }
      }
      return found;
    });

    console.log(`[PUP] ${targets.length} eventos encontrados`);
    const seen = new Set();

    for (const target of targets) {
      // Capturar links ANTES del clic
      const before = await page.evaluate(() =>
        Array.from(document.querySelectorAll('a[href]')).map(a => a.href)
      );
      const beforeSet = new Set(before);

      try { await page.mouse.click(target.x, target.y); } catch(e) { continue; }
      await sleep(1500);

      // Capturar TODOS los links nuevos que aparecieron
      // ✅ CORRECCIÓN: aceptar futbollibre.ec/embed URLs
      const newLinks = await page.evaluate((beforeArr) => {
        const beforeSet = new Set(beforeArr);
        const results   = [];
        document.querySelectorAll('a[href]').forEach(a => {
          const href = a.href || '';
          if (
            !beforeSet.has(href) &&
            href.startsWith('http') &&
            !href.includes('javascript') &&
            !href.includes('google') &&
            !href.includes('facebook') &&
            !href.includes('twitter')
            // ✅ NO filtrar futbollibre.ec — sus /embed/ son los canales
          ) {
            results.push({
              href,
              name: a.textContent?.replace(/[^\w\s]/g,' ').trim().slice(0,40) || 'Canal'
            });
          }
        });
        return results;
      }, before);

      if (newLinks.length > 0) {
        // Parsear hora y nombre del texto del target
        const timeMatch = target.text.match(/(\d{1,2}:\d{2})/);
        const time      = timeMatch ? timeMatch[1] : '00:00';
        const matchText = target.text.replace(/\d{1,2}:\d{2}\s*/, '').split('\n')[0].trim().slice(0, 80);

        const key = `${time}|${matchText}`;
        if (!seen.has(key) && matchText.length > 3) {
          seen.add(key);

          const channels = newLinks.map(l => ({
            name: l.name || 'Canal',
            href: l.href
          }));

          events.push({
            time,
            match   : matchText,
            league  : '',
            flag    : '⚽',
            channels
          });

          console.log(`[PUP] "${matchText}" → ${channels.length} canal(es)`);
          channels.forEach(c => console.log(`   → ${c.name}: ${c.href.slice(0,80)}`));
        }

        await page.keyboard.press('Escape');
        await sleep(400);
      }
    }

    await page.close();
  } finally {
    await browser.close();
  }

  return events;
}

/* ══════════════════════════════════════════════════════════════
   NORMALIZAR — convierte cualquier formato a campos en inglés
══════════════════════════════════════════════════════════════ */
function normalizeEvents(list) {
  return list.map(item => {
    const rawCh = item.channels || item.canales || item.links || item.streams || [];

    const channels = rawCh.map(ch => {
      if (typeof ch === 'string') return { name:'Canal', href: ch };
      return {
        name: ch.name || ch.nombre || ch.canal || 'Canal',
        href: ch.href || ch.url   || ch.link  || ch.embed || ''
      };
    }).filter(ch => {
      const href = ch.href || '';
      return href.startsWith('http') && !href.includes('javascript');
      // ✅ NO filtrar futbollibre.ec/embed — son los canales válidos
    });

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
  console.log(`\n[${new Date().toISOString()}] === SportStream Scraper v7 ===\n`);
  let rawList = [], source = 'none';

  /* ── 1. API directa pltvhd.com ───────────────────────────── */
  try {
    rawList = await fetchDiaries();
    if (rawList.length > 0) source = 'pltvhd-api';
  } catch(e) {
    console.warn(`[API] FALLÓ: ${e.message}`);
  }

  let events = normalizeEvents(rawList);
  const withCh = events.filter(e => e.channels.length > 0).length;

  /* ── 2. Si la API no trajo canales, usar Puppeteer ─────────
     (la API devuelve eventos pero canales vacíos normalmente) */
  if (withCh === 0) {
    console.log('[PUP] API sin canales → usando Puppeteer con clics...');
    try {
      const puppeteerEvents = await scrapeWithPuppeteer();
      if (puppeteerEvents.length > 0) {
        if (events.length > 0) {
          // Fusionar: usar datos de la API pero canales de Puppeteer
          events.forEach(ev => {
            const match = puppeteerEvents.find(pe =>
              pe.match.toLowerCase().includes(ev.match.toLowerCase().slice(0, 12)) ||
              ev.match.toLowerCase().includes(pe.match.toLowerCase().slice(0, 12))
            );
            if (match && match.channels.length > 0) ev.channels = match.channels;
          });
          // Agregar eventos de Puppeteer que no estaban en la API
          puppeteerEvents.forEach(pe => {
            if (!events.some(ev => ev.match.toLowerCase().includes(pe.match.toLowerCase().slice(0, 10)))) {
              events.push(pe);
            }
          });
          source = 'pltvhd+puppeteer';
        } else {
          events = puppeteerEvents;
          source = 'puppeteer';
        }
      }
    } catch(e) {
      console.error(`[PUP] FALLÓ: ${e.message}`);
    }
  }

  /* ── 3. Fallback Railway ─────────────────────────────────── */
  if (events.length === 0 && process.env.API_URL) {
    try {
      const data = await fetchUrl(process.env.API_URL + '/eventos');
      const list = data.events || data.eventos || [];
      if (list.length > 0) { events = normalizeEvents(list); source = 'railway'; }
    } catch(e) { console.warn(`[RAILWAY] ${e.message}`); }
  }

  // Ordenar por hora
  events.sort((a, b) => {
    const m = t => { const [h,mm]=(t||'0:0').split(':').map(Number); return h*60+(mm||0); };
    return m(a.time) - m(b.time);
  });

  const finalWithCh = events.filter(e => e.channels.length > 0).length;

  /* ── Resumen ─────────────────────────────────────────────── */
  console.log('\n════ RESUMEN ════');
  events.forEach(ev => {
    if (ev.channels.length > 0) {
      console.log(`  ✅ ${ev.time} | ${ev.match}`);
      ev.channels.forEach(c => console.log(`     → ${c.name}: ${c.href.slice(0,80)}`));
    } else {
      console.log(`  ○  ${ev.time} | ${ev.match} (sin canales)`);
    }
  });
  console.log(`════════════════`);
  console.log(`Total: ${events.length} | Con canales: ${finalWithCh}\n`);

  const output = {
    actualizado_en     : new Date().toISOString(),
    fecha              : new Date().toLocaleDateString('es-ES',{weekday:'long',day:'numeric',month:'long'}),
    fuente             : source,
    contar             : events.length,
    contar_con_canales : finalWithCh,
    events,
    eventos: events
  };

  fs.writeFileSync(
    path.join(process.cwd(), 'eventos.json'),
    JSON.stringify(output, null, 2),
    'utf-8'
  );

  console.log(`✅ LISTO | ${source} | ${events.length} eventos | ${finalWithCh} con canales`);
  if (events.length === 0) process.exit(1);
}

main().catch(e => { console.error('ERROR FATAL:', e.message); process.exit(1); });
