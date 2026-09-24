const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const SITE_URL =
  process.env.SITE_URL || 'https://futbollibres.info/';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeTime(text) {
  if (!text) return '';

  text = text.replace(/\s+/g, ' ').trim();

  const m = text.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);

  if (!m) return '';

  let h = Number(m[1]);
  const min = Number(m[2]);
  const ampm = m[3]?.toUpperCase();

  if (ampm === 'PM' && h < 12) h += 12;
  if (ampm === 'AM' && h === 12) h = 0;

  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function timeBogotaToUTC(time) {
  const [h, m] = time.split(':').map(Number);

  const now = new Date();

  const bogota = new Date(
    now.toLocaleString('en-US', {
      timeZone: 'America/Bogota'
    })
  );

  const utc = new Date(
    Date.UTC(
      bogota.getFullYear(),
      bogota.getMonth(),
      bogota.getDate(),
      h + 5,
      m
    )
  );

  return utc.toISOString();
}

function normalizeChannelUrl(href) {
  if (!href) return '';

  href = href
    .replace(/\r/g, '')
    .replace(/\n/g, '')
    .trim();

  if (!href) return '';

  try {
    return new URL(href, SITE_URL).href;
  } catch {
    return href;
  }
}

function decodeEmbedUrl(href) {
  if (!href) return '';

  try {
    const url = new URL(href, SITE_URL);
    const r = url.searchParams.get('r');

    if (r) {
      const decoded = Buffer
        .from(r, 'base64')
        .toString('utf8');

      try {
        new URL(decoded);
        return decoded;
      } catch {}
    }

    return href;
  } catch {
    return href;
  }
}

function cleanChannelName(name, index) {
  if (!name) return `Canal ${index + 1}`;

  name = name
    .replace(/[▶►•]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  name = name
    .replace(/^\d{1,2}:\d{2}\s*(AM|PM)?\s*/i, '')
    .trim();

  return name || `Canal ${index + 1}`;
}

async function scrapeFutbolLibre() {

  console.log('[PUP] ========================================');
  console.log('[PUP] Iniciando scraper');
  console.log(`[PUP] URL: ${SITE_URL}`);
  console.log('[PUP] ========================================');

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote'
    ]
  });

  try {

    const page = await browser.newPage();

    await page.setRequestInterception(true);

    page.on('request', req => {
      const type = req.resourceType();

      if (['image', 'font', 'media'].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.setUserAgent(
      'Mozilla/5.0 (Linux; Android 13; Pixel 7) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/120.0.0.0 Mobile Safari/537.36'
    );

    await page.setViewport({
      width: 390,
      height: 844
    });

    console.log('[PUP] Cargando página...');

    await page.goto(SITE_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    await sleep(2500);

    try {
      await page.waitForSelector('#ag-list', {
        timeout: 15000
      });

      console.log('[PUP] #ag-list encontrado');

    } catch {
      console.warn('[PUP] #ag-list no apareció');
    }

    for (let i = 0; i < 10; i++) {

      const count = await page.evaluate(() => {
        const list = document.querySelector('#ag-list');
        if (!list) return 0;

        return list.querySelectorAll('li[data-id]').length;
      });

      if (count > 0) {
        console.log(`[PUP] Eventos cargados: ${count}`);
        break;
      }

      await sleep(1000);
    }

    const eventIds = await page.evaluate(() => {

      const list = document.querySelector('#ag-list');

      if (!list) return [];

      return Array.from(
        list.querySelectorAll('li[data-id]')
      )
        .map(li => ({
          id: li.getAttribute('data-id'),
          text: li.innerText
            .replace(/\s+/g, ' ')
            .trim()
        }))
        .filter(x => x.id);

    });

    console.log(
      `[PUP] ${eventIds.length} eventos encontrados en #ag-list`
    );

    const events = [];

    for (let i = 0; i < eventIds.length; i++) {

      const eventId = eventIds[i].id;

      console.log(
        `[PUP] Procesando ${i + 1}/${eventIds.length} | ID ${eventId}`
      );

      const info = await page.evaluate(id => {

        const li = document.querySelector(
          `#ag-list li[data-id="${CSS.escape(id)}"]`
        );

        if (!li) return null;

        const timeCandidates = Array.from(
          li.querySelectorAll(
            'time, .ag-time, [class*="time"], .ag-toggle'
          )
        );

        let timeText = '';

        for (const el of timeCandidates) {

          const text = el.innerText
            ?.replace(/\s+/g, ' ')
            .trim();

          if (
            text &&
            /\d{1,2}:\d{2}/.test(text)
          ) {
            timeText = text;
            break;
          }
        }

        if (!timeText) {

          const m = li.innerText.match(
            /\d{1,2}:\d{2}\s*(?:AM|PM)?/i
          );

          if (m) timeText = m[0];
        }

        const fullText = li.innerText
          .replace(/\s+/g, ' ')
          .trim();

        const elements = Array.from(
          li.querySelectorAll('*')
        )
          .filter(el => el.children.length === 0)
          .map(el =>
            el.textContent
              .replace(/\s+/g, ' ')
              .trim()
          )
          .filter(t => t.length >= 4);

        let match = '';

        for (const t of elements) {

          if (
            /\bvs\.?\b/i.test(t) &&
            !/^\d{1,2}:\d{2}/.test(t)
          ) {
            match = t;
            break;
          }
        }

        if (!match) {

          for (const t of elements) {

            if (
              /\s+v\s+/i.test(t) &&
              !/^\d{1,2}:\d{2}/.test(t)
            ) {
              match = t;
              break;
            }
          }
        }

        if (!match) {

          match =
            li.querySelector(
              '.ag-name, .ag-title, .ag-event-title'
            )?.innerText
              ?.replace(/\s+/g, ' ')
              .trim() || '';
        }

        if (!match) match = fullText;

        match = match
          .replace(
            /^\d{1,2}:\d{2}\s*(?:AM|PM)?\s*/i,
            ''
          )
          .trim();

        let league = '';

        const colon = match.indexOf(':');

        if (colon > 0) {

          const left = match.slice(0, colon).trim();
          const right = match.slice(colon + 1).trim();

          if (
            left.length >= 3 &&
            right.length >= 5
          ) {
            league = left;
            match = right;
          }
        }

        return {
          id,
          time: timeText,
          match,
          league
        };

      }, eventId);

      if (!info) continue;

      const time = normalizeTime(info.time);

      let channels = [];

      await page.evaluate(id => {

        const li = document.querySelector(
          `#ag-list li[data-id="${CSS.escape(id)}"]`
        );

        if (!li) return;

        const toggle = li.querySelector('.ag-toggle');

        if (toggle) {
          toggle.click();
          return;
        }

        li.click();

      }, eventId);

      await sleep(500);

      for (let wait = 0; wait < 10; wait++) {

        const count = await page.evaluate(id => {

          const li = document.querySelector(
            `#ag-list li[data-id="${CSS.escape(id)}"]`
          );

          if (!li) return 0;

          return li.querySelectorAll('.ag-play').length;

        }, eventId);

        if (count > 0) break;

        await sleep(300);
      }

      const buttons = await page.evaluate(id => {

        const li = document.querySelector(
          `#ag-list li[data-id="${CSS.escape(id)}"]`
        );

        if (!li) return [];

        let els = Array.from(
          li.querySelectorAll('.ag-play')
        );

        if (els.length === 0) {

          els = Array.from(
            li.querySelectorAll(
              '[data-url], [data-href], a[href*="/reproducir/"]'
            )
          );
        }

        return els.map((el, index) => ({
          index,
          name:
            el.innerText
              ?.replace(/\s+/g, ' ')
              .trim() ||
            el.getAttribute('title') ||
            el.getAttribute('aria-label') ||
            `Canal ${index + 1}`,
          href:
            el.getAttribute('href') ||
            el.getAttribute('data-url') ||
            el.getAttribute('data-href') ||
            ''
        }));

      }, eventId);

      for (const button of buttons) {

        if (!button.href) continue;

        channels.push({
          name: cleanChannelName(
            button.name,
            channels.length
          ),
          href: normalizeChannelUrl(
            decodeEmbedUrl(button.href)
          )
        });
      }

      if (
        channels.length === 0 &&
        buttons.length > 0
      ) {

        for (const button of buttons) {

          await page.evaluate(
            ({ id, index }) => {

              const li = document.querySelector(
                `#ag-list li[data-id="${CSS.escape(id)}"]`
              );

              if (!li) return;

              const els =
                li.querySelectorAll('.ag-play');

              const el = els[index];

              if (el) el.click();

            },
            {
              id: eventId,
              index: button.index
            }
          );

          await sleep(500);

          let frameUrl = '';

          for (let wait = 0; wait < 10; wait++) {

            frameUrl = await page.evaluate(() => {

              const frame =
                document.querySelector('#ag-modal-frame');

              if (!frame) return '';

              return (
                frame.getAttribute('src') ||
                frame.src ||
                ''
              );

            });

            if (frameUrl) break;

            await sleep(300);
          }

          if (frameUrl) {

            channels.push({
              name: cleanChannelName(
                button.name,
                channels.length
              ),
              href: normalizeChannelUrl(
                decodeEmbedUrl(frameUrl)
              )
            });
          }

          await page.keyboard.press('Escape');

          await page.evaluate(() => {

            const close =
              document.querySelector(
                '[class*="close"], ' +
                '[class*="cerrar"], ' +
                '[aria-label*="lose"]'
              );

            if (
              close &&
              close.getBoundingClientRect().width > 0
            ) {
              close.click();
            }

          });

          await sleep(150);
        }
      }

      const seenChannels = new Set();

      channels = channels.filter(channel => {

        if (!channel.href) return false;

        if (seenChannels.has(channel.href)) {
          return false;
        }

        seenChannels.add(channel.href);

        return true;
      });

      events.push({
        time,
        time_utc:
          time
            ? timeBogotaToUTC(time)
            : null,
        match: info.match,
        league: info.league,
        flag: '⚽',
        channels
      });

      if (channels.length) {

        console.log(
          `OK ${time} | ${info.match} -> ${channels.length} canales`
        );

        channels.forEach(c => {
          console.log(
            `   ${c.name}: ${c.href}`
          );
        });

      } else {

        console.log(
          `-- ${time} | ${info.match} -> sin canales`
        );
      }

      await page.keyboard.press('Escape');

      await sleep(100);
    }

    return events;

  } finally {

    await browser.close();

    console.log('[PUP] Navegador cerrado');
  }
}

async function main() {

  console.log(
    `[${new Date().toISOString()}] === SportStream Scraper ===`
  );

  let events = [];
  let source = 'none';

  try {

    events = await scrapeFutbolLibre();

    if (events.length > 0) {
      source = 'futbollibres-puppeteer';
    }

  } catch (e) {

    console.warn(
      `[PUP] FALLO: ${e.message}`
    );
  }

  events.sort((a, b) => {

    const toMinutes = time => {

      if (!time) return 9999;

      const [h, m] = time.split(':').map(Number);

      return h * 60 + m;
    };

    return toMinutes(a.time) - toMinutes(b.time);
  });

  const seen = new Set();

  events = events.filter(event => {

    const key =
      `${event.time}|${event.match}`;

    if (seen.has(key)) return false;

    seen.add(key);

    return true;
  });

  const withChannels =
    events.filter(
      e =>
        Array.isArray(e.channels) &&
        e.channels.length > 0
    ).length;

  const output = {

    actualizado_en:
      new Date().toISOString(),

    fecha:
      new Date().toLocaleDateString(
        'es-ES',
        {
          weekday: 'long',
          day: 'numeric',
          month: 'long',
          timeZone: 'America/Bogota'
        }
      ),

    fuente: source,

    contar: events.length,

    contar_con_canales: withChannels,

    events,

    eventos: events
  };

  const outputPath =
    path.join(
      process.cwd(),
      'eventos.json'
    );

  fs.writeFileSync(
    outputPath,
    JSON.stringify(output, null, 2),
    'utf8'
  );

  console.log('');

  console.log(
    `LISTO | ${source} | total:${events.length} | canales:${withChannels}`
  );

  console.log(
    `Archivo: ${outputPath}`
  );
}

main().catch(err => {

  console.error(
    'ERROR FATAL:',
    err
  );

  process.exit(1);
});
