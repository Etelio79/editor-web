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

/* ── Resuelve el m3u8 con token para una URL embed ── */
async function resolveStreamUrl(browser, embedUrl) {
  const page = await browser.newPage();
  let m3u8Url = null;

  try {
    await page.setRequestInterception(true);

    // Interceptar requests: capturar m3u8, bloquear medios pesados
    page.on('request', req => {
      const url  = req.url();
      const type = req.resourceType();

      if (url.includes('.m3u8') && !m3u8Url) {
        m3u8Url = url;
        console.log(`  🎯 m3u8: ${url.substring(0, 80)}`);
        req.abort();
        return;
      }
      if (['image','font','media','stylesheet'].includes(type)) {
        req.abort();
        return;
      }
      req.continue();
    });

    await page.setUserAgent(
      'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
    );

    await page.goto(embedUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });

    // Esperar hasta que aparezca el m3u8 (máx 8 segundos)
    const start = Date.now();
    while (!m3u8Url && Date.now() - start < 8000) {
      await new Promise(r => setTimeout(r, 300));
    }

    // Si no encontró por intercept, buscar en el HTML de la página
    if (!m3u8Url) {
      const content = await page.content();
      const match = content.match(/["'`](https?:\/\/[^"'`\s\\]+\.m3u8[^"'`\s\\]*)["'`]/);
      if (match) m3u8Url = match[1];
    }

  } catch(e) {
    // timeout o error, continuar
  } finally {
    await page.close().catch(()=>{});
  }

  return m3u8Url;
}

/* ── Scraping principal ── */
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
    /* ── PASO 1: Cargar futbollibre.ec y extraer eventos+canales ── */
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
    ).catch(() => console.warn('[PUP] Timeout horas'));

    console.log('[PUP] Extrayendo eventos...');

    const events = await page.evaluate(() => {
      const timeRx = /^\d{1,2}:\d{2}$/;
      const results = [], seen = new Set();
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
      const timeNodes = [];
      let node;
      while ((node = walker.nextNode())) {
        if (timeRx.test(node.textContent.trim())) timeNodes.push(node);
      }

      timeNodes.forEach(timeNode => {
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

        const channels = [];
        container.querySelectorAll('a[href]').forEach(a => {
          const name = a.textContent.replace(/[►▶•\-]/g,'').trim();
          const href = a.href;
          if (name && href && href.startsWith('http') && !href.includes('javascript'))
            channels.push({ name, href, streamUrl: null });
        });

        const key = `${time}|${match}`;
        if (seen.has(key)) return;
        seen.add(key);
        results.push({ time, match, league, flag:'⚽', channels });
      });
      return results;
    });

    console.log(`[PUP] ${events.length} eventos`);

    // Expandir canales faltantes
    const noChannels = events.filter(ev => ev.channels.length === 0);
    for (let i = 0; i < noChannels.length; i++) {
      const ev = noChannels[i];
      try {
        const clicked = await page.evaluate((time, match) => {
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
          let node;
          while ((node = walker.nextNode())) {
            if (node.textContent.trim() === time) {
              let c = node.parentElement;
              for (let j = 0; j < 8; j++) {
                if (!c) break;
                const texts = Array.from(c.querySelectorAll('*')).filter(el=>el.children.length===0).map(el=>el.textContent.trim());
                if (texts.some(t => t.includes(match.substring(0,15)))) { c.click(); return true; }
                c = c.parentElement;
              }
            }
          }
          return false;
        }, ev.time, ev.match);

        if (clicked) {
          await new Promise(r => setTimeout(r, 1000));
          const channels = await page.evaluate((time) => {
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
                        result.push({ name, href, streamUrl: null });
                    });
                    if (result.length > 0) return result;
                  }
                  c = c.parentElement;
                }
              }
            }
            return [];
          }, ev.time);

          const evInList = events.find(e => e.time===ev.time && e.match===ev.match);
          if (evInList && channels.length > 0) evInList.channels = channels;
        }
      } catch(e) {}
      await new Promise(r => setTimeout(r, 200));
    }

    await page.close();

    /* ── PASO 2: Resolver m3u8 para cada canal ── */
    console.log('\n[STREAM] Resolviendo URLs de stream...');
    let totalStreams = 0;

    // Procesar en lotes de 3 (paralelo) para no sobrecargar
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      if (!ev.channels.length) continue;

      // Tomar solo los primeros 3 canales de cada evento (para ahorrar tiempo)
      const chToResolve = ev.channels.slice(0, 3);

      const resolved = await Promise.all(
        chToResolve.map(async ch => {
          if (!ch.href) return ch;
          try {
            const m3u8 = await resolveStreamUrl(browser, ch.href);
            if (m3u8) {
              ch.streamUrl = m3u8;
              totalStreams++;
            }
          } catch(e) {}
          return ch;
        })
      );

      // Los canales restantes (>3) se mantienen sin streamUrl (se resuelven en el cliente)
      ev.channels = [...resolved, ...ev.channels.slice(3)];
      process.stdout.write(`\r  Progreso: ${i+1}/${events.length} eventos`);
    }

    console.log(`\n[STREAM] ${totalStreams} streams resueltos`);

    const withChannels = events.filter(e => e.channels.some(c => c.streamUrl)).length;
    console.log(`[PUP] Total: ${events.length} eventos, ${withChannels} con stream`);

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
    source, count: events.length, events
  };

  fs.writeFileSync(
    path.join(process.cwd(),'eventos.json'),
    JSON.stringify(output, null, 2), 'utf-8'
  );

  const withStream = events.filter(e=>e.channels.some(c=>c.streamUrl)).length;
  console.log(`✅ LISTO | eventos: ${events.length} | con stream: ${withStream}`);
}

main().catch(e => { console.error('ERROR FATAL:', e); process.exit(1); });
