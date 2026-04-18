const puppeteer = require('puppeteer-core');
const fs        = require('fs');
const path      = require('path');

async function resolveM3u8(browser, embedUrl) {
  const page = await browser.newPage();
  let m3u8 = null;

  try {
    await page.setRequestInterception(true);
    page.on('request', req => {
      const url  = req.url();
      const type = req.resourceType();
      if (url.includes('.m3u8') && !m3u8) {
        m3u8 = url;
        req.abort();
        return;
      }
      if (['image','font','media','stylesheet'].includes(type)) { req.abort(); return; }
      req.continue();
    });

    await page.setUserAgent('Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36');
    await page.setExtraHTTPHeaders({ 'Referer':'https://futbollibre.ec', 'Origin':'https://futbollibre.ec' });

    await page.goto(embedUrl, { waitUntil:'domcontentloaded', timeout:20000 });

    // Esperar m3u8 hasta 10 segundos
    const t = Date.now();
    while (!m3u8 && Date.now()-t < 10000) await new Promise(r=>setTimeout(r,300));

    // Fallback: buscar en el HTML
    if (!m3u8) {
      const html = await page.content();
      const m = html.match(/["'`](https?:\/\/[^"'`\s\\]+\.m3u8[^"'`\s\\]*)["'`]/);
      if (m) m3u8 = m[1];
    }
  } catch(e) { /* timeout o error */ }
  finally { await page.close().catch(()=>{}); }

  return m3u8;
}

async function scrapeFutbolLibre() {
  const execPath = process.env.PUPPETEER_EXEC || '/usr/bin/chromium-browser';
  const browser  = await puppeteer.launch({
    executablePath: execPath,
    headless: 'new',
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-first-run','--no-zygote','--single-process']
  });

  try {
    /* ── Paso 1: extraer eventos + canales ── */
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', req => {
      if (['image','font','media'].includes(req.resourceType())) req.abort();
      else req.continue();
    });
    await page.setUserAgent('Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36');
    await page.setViewport({ width:390, height:844 });

    console.log('[1] Navegando a futbollibre.ec...');
    await page.goto('https://futbollibre.ec', { waitUntil:'networkidle2', timeout:45000 });
    await page.waitForFunction(() => document.body.innerText.match(/\d{1,2}:\d{2}/), { timeout:15000 })
      .catch(()=>console.warn('Timeout horas'));
    await new Promise(r=>setTimeout(r,2000)); // esperar canales

    const events = await page.evaluate(() => {
      const timeRx=/^\d{1,2}:\d{2}$/, results=[], seen=new Set();
      const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT,null);
      const timeNodes=[];
      let node;
      while((node=walker.nextNode())) if(timeRx.test(node.textContent.trim())) timeNodes.push(node);

      timeNodes.forEach(tn => {
        const time=tn.textContent.trim();
        let c=tn.parentElement;
        for(let i=0;i<8;i++){
          if(!c) break;
          if(c.querySelectorAll('a[href*="embed/eventos"]').length>0) break;
          c=c.parentElement;
        }
        if(!c) return;

        const allText=Array.from(c.querySelectorAll('*'))
          .filter(el=>el.children.length===0).map(el=>el.textContent.trim())
          .filter(t=>t.length>5&&!timeRx.test(t)&&!/[►▶]/.test(t));
        const matchTitle=allText[0]||'';
        if(!matchTitle||matchTitle.length<4) return;

        let league='',match=matchTitle;
        if(matchTitle.includes(':')){const pts=matchTitle.split(':');league=pts[0].trim();match=pts.slice(1).join(':').trim()||matchTitle;}

        const channels=[];
        c.querySelectorAll('a[href*="embed/eventos"]').forEach(a=>{
          const name=a.textContent.replace(/[►▶•\-\s]+/g,' ').trim();
          const href=a.href;
          if(name&&href) channels.push({name,href,streamUrl:null});
        });

        const key=`${time}|${match}`;
        if(seen.has(key)) return;
        seen.add(key);
        results.push({time,match,league,flag:'⚽',channels});
      });
      return results;
    });

    await page.close();
    console.log(`[1] ${events.length} eventos, ${events.reduce((s,e)=>s+e.channels.length,0)} canales`);

    /* ── Paso 2: resolver m3u8 para cada canal ── */
    console.log('[2] Resolviendo streams...');
    let total=0;

    for (let i=0; i<events.length; i++) {
      const ev = events[i];
      if (!ev.channels.length) continue;

      // Resolver hasta 3 canales por evento en paralelo
      const toResolve = ev.channels.slice(0,3);
      const resolved  = await Promise.all(toResolve.map(async ch => {
        if (!ch.href) return ch;
        try {
          // Decodificar BASE64 del r= param
          let sourceUrl = ch.href;
          try {
            const u=new URL(ch.href); const r=u.searchParams.get('r');
            if(r) sourceUrl=Buffer.from(r.replace(/-/g,'+').replace(/_/g,'/'),'base64').toString('utf-8');
          } catch(e){}

          const m3u8 = await resolveM3u8(browser, ch.href);
          if (m3u8) { ch.streamUrl=m3u8; total++; console.log(`  ✅ ${ev.time} ${ch.name}: ${m3u8.substring(0,60)}`); }
        } catch(e){}
        return ch;
      }));

      ev.channels = [...resolved, ...ev.channels.slice(3)];
    }

    console.log(`[2] ${total} streams resueltos`);
    return events;

  } finally { await browser.close(); }
}

async function main() {
  console.log(`[${new Date().toISOString()}] === SportStream Scraper ===`);
  let events=[], source='none';

  try {
    events = await scrapeFutbolLibre();
    if(events.length>0) source='futbollibre';
  } catch(e) { console.error('[PUP] FALLÓ:', e.message); }

  events.sort((a,b)=>{
    const m=t=>{if(!t)return 9999;const[h,mm]=(t||'0:0').split(':').map(Number);return h*60+(mm||0);};
    return m(a.time)-m(b.time);
  });

  const withStream = events.filter(e=>e.channels.some(c=>c.streamUrl)).length;
  const output = {
    updated_at: new Date().toISOString(),
    date: new Date().toLocaleDateString('es-ES',{weekday:'long',day:'numeric',month:'long'}),
    source, count: events.length, events
  };

  fs.writeFileSync(path.join(process.cwd(),'eventos.json'), JSON.stringify(output,null,2),'utf-8');
  console.log(`✅ LISTO | eventos: ${events.length} | con stream: ${withStream}`);
}

main().catch(e=>{console.error('ERROR FATAL:',e);process.exit(1);});
