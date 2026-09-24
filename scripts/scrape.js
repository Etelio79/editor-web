const puppeteer = require('puppeteer');
const fs = require('fs');

const SITE_URL =
  process.env.SITE_URL || 'https://rojadirectatvplus.net/agenda';

const OUTPUT_FILE = 'eventos.json';

/* =========================================================
   UTILIDADES (idénticas a futbollibres.info)
========================================================= */

function normalizeTime(text) {
  if (!text) return null;

  let value = String(text)
    .replace(/\s+/g, ' ')
    .trim();

  const ampm = value.match(
    /\b(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\b/i
  );

  if (ampm) {
    let hour = Number(ampm[1]);
    const minute = Number(ampm[2] || 0);
    const period = ampm[3].toUpperCase();

    if (period === 'PM' && hour !== 12) hour += 12;
    if (period === 'AM' && hour === 12) hour = 0;

    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }

  const normal = value.match(/\b(\d{1,2}):(\d{2})\b/);

  if (normal) {
    const hour = Number(normal[1]);
    const minute = Number(normal[2]);

    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    }
  }

  return null;
}

/*
  RojaDirecta también muestra horarios en hora de Colombia (UTC-5),
  igual que futbollibres. Si notas que el horario mostrado no
  corresponde, ajusta el offset aquí.
*/
function timeBogotaToUTC(time) {
  if (!time) return null;

  const match = time.match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;

  let hour = Number(match[1]);
  const minute = Number(match[2]);

  hour += 5;

  let dayOffset = 0;
  if (hour >= 24) {
    hour -= 24;
    dayOffset = 1;
  }

  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const day = now.getUTCDate() + dayOffset;

  return new Date(
    Date.UTC(year, month, day, hour, minute, 0)
  ).toISOString();
}

function cleanChannelName(name, index) {
  if (!name) return `Canal ${index + 1}`;

  let value = String(name)
    .replace(/\s+/g, ' ')
    .replace(/^[•·▪▫▶►»]+\s*/g, '')
    .trim();

  value = value
    .replace(/^\d{1,2}(?::\d{2})?\s*(?:AM|PM)?\s*[-|:]*\s*/i, '')
    .trim();

  return value || `Canal ${index + 1}`;
}

/*
  -----------------------------------------------------------
  DECODIFICACIÓN DEL CANAL (lo nuevo respecto a futbollibres)
  -----------------------------------------------------------

  En futbollibres.info el href del canal YA era la URL final
  (no había que decodificar nada).

  En rojadirectatvplus.net el flujo es distinto:

  1. .ag-play trae un href a una "página reproductor" real
     (ej: https://rojadirectatvplus.net/vivo/tnt-sports-chile)
  2. Esa página contiene un <iframe> cuyo src es:
       https://rojadirectatvplus.net/embed/eventos.html?r=<base64>
  3. El parámetro "r" en base64 decodifica a la URL real del stream:
       https://tvf90.com/1.php?stream=tntsportschile

  decodeEmbedParam() hace el paso 3. extractStreamFromChannelPage()
  hace los pasos 1-2 navegando de verdad con Puppeteer, porque el
  iframe solo aparece después de que la página carga (no viene en
  el HTML estático).
*/
function decodeEmbedParam(iframeSrc, baseUrl) {
  if (!iframeSrc) return null;

  let embedUrl;
  try {
    embedUrl = new URL(iframeSrc, baseUrl || SITE_URL);
  } catch (e) {
    return iframeSrc;
  }

  const encoded = embedUrl.searchParams.get('r');

  if (!encoded) {
    // No trae parámetro "r": puede que el iframe ya sea la URL final.
    return embedUrl.href;
  }

  try {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    new URL(decoded); // valida que el resultado sea una URL real
    return decoded;
  } catch (e) {
    console.log(
      `[PUP] No se pudo decodificar base64 del parámetro r: ${e.message}`
    );
    return embedUrl.href;
  }
}

async function extractStreamFromChannelPage(page, channelPageUrl) {
  try {
    await page.goto(channelPageUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
  } catch (e) {
    console.log(
      `[PUP] Error navegando a ${channelPageUrl}: ${e.message}`
    );
    return null;
  }

  let iframeSrc = null;

  try {
    await page.waitForSelector('iframe', { timeout: 8000 });

    iframeSrc = await page.evaluate(() => {
      const iframe = document.querySelector('iframe');
      return iframe ? iframe.getAttribute('src') : null;
    });
  } catch (e) {
    console.log(
      `[PUP] No apareció <iframe> en ${channelPageUrl}: ${e.message}`
    );
  }

  return decodeEmbedParam(iframeSrc, channelPageUrl);
}

/* =========================================================
   SCRAPER
========================================================= */

async function scrapeRojaDirecta() {
  console.log('========================================');
  console.log('Iniciando scraper');
  console.log(`URL: ${SITE_URL}`);
  console.log('========================================');

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ]
  });

  const page = await browser.newPage();

  await page.setRequestInterception(true);

  page.on('request', request => {
    const type = request.resourceType();
    if (type === 'image' || type === 'font' || type === 'media') {
      request.abort();
    } else {
      request.continue();
    }
  });

  await page.setUserAgent(
    'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
  );

  await page.setViewport({ width: 390, height: 844, isMobile: true });

  console.log('[PUP] Cargando página...');

  await page.goto(SITE_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });

  console.log('[PUP] Página cargada');

  await new Promise(resolve => setTimeout(resolve, 2500));

  await page.waitForSelector('#ag-list', { timeout: 30000 });

  try {
    await page.waitForFunction(
      () => document.querySelectorAll('#ag-list li[data-id]').length > 0,
      { timeout: 10000 }
    );
  } catch (e) {
    console.log('[PUP] No aparecieron eventos dentro del tiempo esperado');
  }

  const eventIds = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('#ag-list li[data-id]'))
      .map(li => li.getAttribute('data-id'))
      .filter(Boolean);
  });

  console.log(`[PUP] ${eventIds.length} eventos detectados`);

  const events = [];

  for (let i = 0; i < eventIds.length; i++) {
    const eventId = eventIds[i];

    console.log(`[PUP] Procesando evento ${i + 1}/${eventIds.length}`);

    try {
      /*
        -----------------------------------------------------
        INFORMACIÓN DEL EVENTO (igual que futbollibres.info)
        -----------------------------------------------------
      */
      const info = await page.evaluate(id => {
        const li = document.querySelector(
          `#ag-list li[data-id="${CSS.escape(id)}"]`
        );
        if (!li) return null;

        const fullText = li.innerText || '';

        const leafTexts = Array.from(li.querySelectorAll('*'))
          .map(el => (el.innerText || '').trim())
          .filter(Boolean);

        const timeCandidates = [
          ...Array.from(li.querySelectorAll('time')).map(el => el.textContent),
          ...Array.from(li.querySelectorAll('.ag-time')).map(el => el.textContent),
          ...Array.from(li.querySelectorAll('[class*="time"]')).map(el => el.textContent),
          ...Array.from(li.querySelectorAll('.ag-toggle')).map(el => el.textContent)
        ];

        let timeText = null;
        for (const candidate of timeCandidates) {
          if (!candidate) continue;
          const match = String(candidate).match(/\b\d{1,2}(?::\d{2})?\s*(?:AM|PM)?\b/i);
          if (match) {
            timeText = match[0];
            break;
          }
        }

        if (!timeText) {
          const match = fullText.match(/\b\d{1,2}(?::\d{2})?\s*(?:AM|PM)?\b/i);
          if (match) timeText = match[0];
        }

        let matchText = leafTexts.find(text => /\s+vs\s+/i.test(text));
        if (!matchText) matchText = leafTexts.find(text => /\s+v\s+/i.test(text));

        if (!matchText) {
          const fallback = li.querySelector('.ag-name, .ag-title, .ag-event-title');
          if (fallback) matchText = fallback.innerText.trim();
        }

        if (!matchText) matchText = fullText;

        return { id, fullText, timeText, matchText };
      }, eventId);

      if (!info) {
        console.log(`[PUP] No se pudo leer el evento ${eventId}`);
        continue;
      }

      const time = normalizeTime(info.timeText);

      let rawMatch = info.matchText || '';

      if (time) {
        rawMatch = rawMatch.replace(/^\s*\d{1,2}(?::\d{2})?\s*(?:AM|PM)?\s*/i, '');
      }

      rawMatch = rawMatch.replace(/\s+/g, ' ').trim();

      let league = '';
      let match = rawMatch;

      const colonIndex = rawMatch.indexOf(':');
      if (colonIndex > -1) {
        const possibleLeague = rawMatch.slice(0, colonIndex).trim();
        const possibleMatch = rawMatch.slice(colonIndex + 1).trim();

        if (
          possibleLeague &&
          possibleMatch &&
          (/\s+vs\s+/i.test(possibleMatch) || /\s+v\s+/i.test(possibleMatch))
        ) {
          league = possibleLeague;
          match = possibleMatch;
        }
      }

      if (!/\s+vs\s+/i.test(match) && !/\s+v\s+/i.test(match)) {
        const foundMatch = rawMatch.match(/(.+?\s+(?:vs|v)\s+.+)/i);
        if (foundMatch) match = foundMatch[1].trim();
      }

      /*
        -----------------------------------------------------
        CANALES — aquí está el cambio real respecto al script
        original: en vez de esperar un modal, navegamos a la
        página del canal, leemos el iframe y decodificamos "r".
        -----------------------------------------------------
      */

      let channels = [];

      const opened = await page.evaluate(id => {
        const li = document.querySelector(
          `#ag-list li[data-id="${CSS.escape(id)}"]`
        );
        if (!li) return false;

        const toggle = li.querySelector('.ag-toggle');
        if (toggle) {
          toggle.click();
          return true;
        }

        li.click();
        return true;
      }, eventId);

      if (opened) {
        try {
          await page.waitForSelector(
            `#ag-list li[data-id="${CSS.escape(eventId)}"] .ag-play`,
            { timeout: 5000 }
          );
        } catch (e) {
          // puede que ya estén presentes o que el selector cambie
        }
      }

      const channelButtons = await page.evaluate(id => {
        const li = document.querySelector(
          `#ag-list li[data-id="${CSS.escape(id)}"]`
        );
        if (!li) return [];

        let elements = Array.from(li.querySelectorAll('.ag-play'));

        if (!elements.length) {
          elements = Array.from(
            li.querySelectorAll('[data-url], [data-href], a[href]')
          );
        }

        return elements.map((el, index) => ({
          index,
          text: (el.innerText || el.textContent || '').trim(),
          href: el.getAttribute('href'),
          dataUrl: el.getAttribute('data-url'),
          dataHref: el.getAttribute('data-href')
        }));
      }, eventId);

      console.log(
        `[PUP] ${channelButtons.length} canales encontrados para el evento`
      );

      for (let c = 0; c < channelButtons.length; c++) {
        const button = channelButtons[c];

        const rawHref = button.href || button.dataUrl || button.dataHref;

        if (!rawHref || rawHref === '#' || rawHref.startsWith('javascript:')) {
          continue;
        }

        let channelPageUrl;
        try {
          channelPageUrl = new URL(rawHref, SITE_URL).href;
        } catch (e) {
          continue;
        }

        console.log(
          `[PUP] Abriendo canal ${c + 1}/${channelButtons.length}: ${channelPageUrl}`
        );

        const streamUrl = await extractStreamFromChannelPage(page, channelPageUrl);

        if (streamUrl) {
          channels.push({
            name: cleanChannelName(button.text, c),
            url: streamUrl
          });
        }

        /*
          Volvemos a la agenda y reabrimos el acordeón del mismo
          evento antes de procesar el siguiente canal.
        */
        try {
          await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 });
        } catch (e) {
          console.log(`[PUP] goBack falló, recargando agenda: ${e.message}`);
          await page.goto(SITE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
        }

        await new Promise(resolve => setTimeout(resolve, 500));

        try {
          await page.waitForSelector('#ag-list', { timeout: 15000 });
        } catch (e) {
          console.log('[PUP] #ag-list no reapareció tras volver atrás');
        }

        if (c < channelButtons.length - 1) {
          await page.evaluate(id => {
            const li = document.querySelector(
              `#ag-list li[data-id="${CSS.escape(id)}"]`
            );
            if (!li) return;

            const toggle = li.querySelector('.ag-toggle');
            if (toggle) {
              toggle.click();
            } else {
              li.click();
            }
          }, eventId);

          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }

      const uniqueChannels = [];
      const seenChannels = new Set();

      for (const channel of channels) {
        if (!channel || !channel.url) continue;
        if (seenChannels.has(channel.url)) continue;

        seenChannels.add(channel.url);
        uniqueChannels.push({
          name: channel.name || `Canal ${uniqueChannels.length + 1}`,
          url: channel.url
        });
      }

      channels = uniqueChannels;

      console.log(
        `-- ${time || '--:--'} | ${league ? league + ': ' : ''}${match} -> ${channels.length} canales`
      );

      events.push({
        time: time || '',
        time_utc: timeBogotaToUTC(time),
        match: match || '',
        league: league || '',
        flag: '⚽',
        channels
      });

    } catch (error) {
      console.log(`[PUP] Error procesando evento ${eventId}: ${error.message}`);
    }
  }

  events.sort((a, b) => String(a.time).localeCompare(String(b.time)));

  const uniqueEvents = [];
  const seenEvents = new Set();

  for (const event of events) {
    const key = `${event.time}|${event.match}`;
    if (seenEvents.has(key)) continue;
    seenEvents.add(key);
    uniqueEvents.push(event);
  }

  const result = {
    actualizado_en: new Date().toISOString(),
    fecha: new Date().toISOString().slice(0, 10),
    fuente: 'rojadirecta-puppeteer',
    contar: uniqueEvents.length,
    contar_con_canales: uniqueEvents.filter(
      event => Array.isArray(event.channels) && event.channels.length > 0
    ).length,
    events: uniqueEvents,
    eventos: uniqueEvents
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(result, null, 2), 'utf8');

  console.log('========================================');
  console.log(`[PUP] Total: ${result.contar}`);
  console.log(`[PUP] Con canales: ${result.contar_con_canales}`);
  console.log('========================================');

  await browser.close();

  console.log('[PUP] Navegador cerrado');
  console.log(
    `LISTO | rojadirecta-puppeteer | total:${result.contar} | canales:${result.contar_con_canales}`
  );
  console.log(`Archivo: ${process.cwd()}/${OUTPUT_FILE}`);
}

scrapeRojaDirecta().catch(error => {
  console.error('[PUP] ERROR FATAL:', error);
  process.exit(1);
});
