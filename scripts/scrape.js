const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const SITE_URL = process.env.SITE_URL || 'https://futbollibres.info/';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeTime(value) {
  if (!value) return '';

  let s = value.trim().replace(/\s+/g, ' ');

  // 24 horas: 19:30
  let m = s.match(/\b(\d{1,2}):(\d{2})\b/);
  if (m) {
    let h = Number(m[1]);
    let min = Number(m[2]);

    // Si hay AM/PM, convertir
    const ampm = s.match(/\b(AM|PM)\b/i);
    if (ampm) {
      const p = ampm[1].toUpperCase();
      if (p === 'PM' && h < 12) h += 12;
      if (p === 'AM' && h === 12) h = 0;
    }

    return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
  }

  return '';
}

function timeBogotaToUTC(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);

  const now = new Date();

  const bogotaDate = new Date(
    now.toLocaleString('en-US', {
      timeZone: 'America/Bogota'
    })
  );

  // Bogotá = UTC-5
  const utc = new Date(Date.UTC(
    bogotaDate.getFullYear(),
    bogotaDate.getMonth(),
    bogotaDate.getDate(),
    h + 5,
    m
  ));

  return utc.toISOString();
}

function decodeEmbedUrl(href) {
  try {
    const url = new URL(href);

    const r = url.searchParams.get('r');

    if (!r) return href;

    const decoded = Buffer.from(r, 'base64').toString('utf8');

    new URL(decoded);

    return decoded;
  } catch {
    return href;
  }
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
      'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36'
    );

    await page.setViewport({
      width: 390,
      height: 844
    });

    console.log('[PUP] Cargando página...');

    await page.goto(SITE_URL, {
      waitUntil: 'networkidle2',
      timeout: 60000
    });

    console.log('[PUP] Página cargada');

    await sleep(1500);

    /*
     * ==========================================================
     * OBTENER EVENTOS
     * ==========================================================
     *
     * No dependemos exclusivamente de #ag-list.
     */

    const eventsInfo = await page.evaluate(() => {

      const timeRx = /^\d{1,2}:\d{2}(?:\s?(?:AM|PM))?$/i;

      const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT
      );

      const found = [];

      let node;

      while (node = walker.nextNode()) {

        const text = node.textContent
          .trim()
          .replace(/\s+/g, ' ');

        if (!timeRx.test(text)) continue;

        const timeEl = node.parentElement;

        if (!timeEl) continue;

        /*
         * Buscar hacia arriba el bloque del evento.
         */
        let container = timeEl;

        for (let level = 0; level < 8 && container; level++) {

          const textContent = container.innerText
            ?.trim()
            .replace(/\s+/g, ' ');

          if (!textContent) {
            container = container.parentElement;
            continue;
          }

          /*
           * Un bloque razonable de evento normalmente contiene
           * el nombre del partido.
           */
          const possibleTexts = Array.from(
            container.querySelectorAll('*')
          )
            .filter(el => el.children.length === 0)
            .map(el =>
              el.textContent
                .trim()
                .replace(/\s+/g, ' ')
            )
            .filter(t =>
              t.length > 4 &&
              !timeRx.test(t)
            );

          if (possibleTexts.length >= 1) {

            found.push({
              time: text,
              texts: possibleTexts,
              marker: found.length
            });

            break;
          }

          container = container.parentElement;
        }
      }

      return found;

    });

    console.log(
      `[PUP] ${eventsInfo.length} eventos detectados`
    );

    /*
     * ==========================================================
     * DEDUPLICAR EVENTOS
     * ==========================================================
     */

    const unique = [];

    const seen = new Set();

    for (const item of eventsInfo) {

      const key =
        `${item.time}|${item.texts.join('|')}`;

      if (seen.has(key)) continue;

      seen.add(key);

      unique.push(item);
    }

    console.log(
      `[PUP] ${unique.length} eventos únicos`
    );

    const events = [];

    /*
     * ==========================================================
     * PROCESAR EVENTOS
     * ==========================================================
     */

    for (let i = 0; i < unique.length; i++) {

      const info = unique[i];

      console.log(
        `[PUP] Procesando evento ${i + 1}/${unique.length}`
      );

      const result = await page.evaluate(
        ({ index, info }) => {

          const timeRx =
            /^\d{1,2}:\d{2}(?:\s?(?:AM|PM))?$/i;

          const walker =
            document.createTreeWalker(
              document.body,
              NodeFilter.SHOW_TEXT
            );

          let node;
          let count = 0;

          while (node = walker.nextNode()) {

            const text = node.textContent
              .trim()
              .replace(/\s+/g, ' ');

            if (!timeRx.test(text)) continue;

            if (count === index) break;

            count++;
          }

          if (!node) return null;

          const timeEl = node.parentElement;

          if (!timeEl) return null;

          /*
           * Buscar el contenedor real del evento.
           */
          let container = timeEl;

          for (let level = 0; level < 10; level++) {

            if (!container) break;

            const buttons =
              container.querySelectorAll(
                '.ag-play, .ag-toggle'
              );

            if (buttons.length > 0) {
              break;
            }

            container = container.parentElement;
          }

          if (!container) {
            container = timeEl.parentElement;
          }

          /*
           * Recoger textos visibles del evento.
           */
          const texts = Array.from(
            container.querySelectorAll('*')
          )
            .filter(el =>
              el.children.length === 0
            )
            .map(el =>
              el.textContent
                .trim()
                .replace(/\s+/g, ' ')
            )
            .filter(t =>
              t.length > 3 &&
              !timeRx.test(t)
            );

          /*
           * Buscar primero textos que parezcan partido.
           */
          let match = '';

          for (const text of texts) {

            if (
              /\s+(vs\.?|v\.?)\s+/i.test(text)
            ) {
              match = text;
              break;
            }
          }

          /*
           * Si no encontramos "vs", buscar un texto
           * que contenga dos equipos.
           */
          if (!match) {

            for (const text of texts) {

              if (
                text.length >= 10 &&
                text.length <= 150 &&
                !/clasificación|torneo|liga|copa|nations/i.test(text)
              ) {
                match = text;
                break;
              }
            }
          }

          if (!match) {
            match = texts[0] || '';
          }

          /*
           * Separar liga del partido.
           */
          let league = '';

          const colonIndex = match.indexOf(':');

          if (colonIndex > 0) {

            const left = match
              .slice(0, colonIndex)
              .trim();

            const right = match
              .slice(colonIndex + 1)
              .trim();

            if (
              left.length >= 3 &&
              right.length >= 5
            ) {
              league = left;
              match = right;
            }
          }

          /*
           * Quitar hora que pueda haberse colado.
           */
          match = match
            .replace(
              /^\d{1,2}:\d{2}(?:\s?(?:AM|PM))?\s*/i,
              ''
            )
            .trim();

          /*
           * Guardamos una referencia al evento.
           */
          container.setAttribute(
            'data-scraper-event',
            String(index)
          );

          container.scrollIntoView({
            block: 'center'
          });

          return {
            time: timeEl.textContent.trim(),
            match,
            league,
            eventIndex: index
          };

        },
        {
          index: i,
          info
        }
      );

      if (!result || !result.match) {
        continue;
      }

      /*
       * ========================================================
       * CANALES
       * ========================================================
       *
       * AQUÍ recuperamos la lógica que ya funcionaba:
       *
       * .ag-toggle
       * .ag-play
       * #ag-modal-frame
       *
       * No reproducimos el canal.
       */

      let channels = [];

      try {

        /*
         * Buscar botones .ag-play dentro del evento.
         */
        const playButtons = await page.evaluate(
          eventIndex => {

            const container =
              document.querySelector(
                `[data-scraper-event="${eventIndex}"]`
              );

            if (!container) return [];

            return Array.from(
              container.querySelectorAll('.ag-play')
            ).map((el, index) => {

              const text =
                el.textContent
                  ?.replace(/\s+/g, ' ')
                  .trim();

              return {
                index,
                name: text || `Canal ${index + 1}`
              };

            });

          },
          result.eventIndex
        );

        /*
         * Si no encontramos .ag-play directamente,
         * intentamos .ag-toggle.
         */
        if (playButtons.length === 0) {

          const toggles = await page.evaluate(
            eventIndex => {

              const container =
                document.querySelector(
                  `[data-scraper-event="${eventIndex}"]`
                );

              if (!container) return [];

              return Array.from(
                container.querySelectorAll('.ag-toggle')
              ).map((el, index) => {

                return {
                  index,
                  name: el.textContent
                    ?.replace(/\s+/g, ' ')
                    .trim()
                    || `Canal ${index + 1}`
                };

              });

            },
            result.eventIndex
          );

          /*
           * Usamos los toggles como botones.
           */
          for (const toggle of toggles) {

            const channel = await page.evaluate(
              ({ eventIndex, index }) => {

                const container =
                  document.querySelector(
                    `[data-scraper-event="${eventIndex}"]`
                  );

                if (!container) return null;

                const elements =
                  container.querySelectorAll('.ag-toggle');

                const el = elements[index];

                if (!el) return null;

                el.click();

                return true;

              },
              {
                eventIndex: result.eventIndex,
                index: toggle.index
              }
            );

            if (!channel) continue;

            await sleep(350);

            const frameUrl =
              await page.evaluate(() => {

                const frame =
                  document.querySelector(
                    '#ag-modal-frame'
                  );

                if (!frame) return '';

                return (
                  frame.getAttribute('src') ||
                  frame.src ||
                  ''
                );

              });

            if (frameUrl) {

              channels.push({
                name: toggle.name,
                href: decodeEmbedUrl(frameUrl)
              });
            }

            await page.keyboard.press('Escape');

            await sleep(100);
          }

        } else {

          /*
           * Caso normal: .ag-play.
           */
          for (const button of playButtons) {

            await page.evaluate(
              ({ eventIndex, index }) => {

                const container =
                  document.querySelector(
                    `[data-scraper-event="${eventIndex}"]`
                  );

                if (!container) return;

                const buttons =
                  container.querySelectorAll('.ag-play');

                const el = buttons[index];

                if (el) el.click();

              },
              {
                eventIndex: result.eventIndex,
                index: button.index
              }
            );

            await sleep(350);

            const frameUrl =
              await page.evaluate(() => {

                const frame =
                  document.querySelector(
                    '#ag-modal-frame'
                  );

                if (!frame) return '';

                return (
                  frame.getAttribute('src') ||
                  frame.src ||
                  ''
                );

              });

            if (frameUrl) {

              channels.push({
                name: button.name,
                href: decodeEmbedUrl(frameUrl)
              });
            }

            await page.keyboard.press('Escape');

            await sleep(100);
          }
        }

      } catch (err) {

        console.warn(
          `[PUP] Error canales: ${err.message}`
        );
      }

      /*
       * Eliminar duplicados.
       */
      const seenChannels = new Set();

      channels = channels.filter(channel => {

        if (!channel.href) return false;

        if (seenChannels.has(channel.href)) {
          return false;
        }

        seenChannels.add(channel.href);

        return true;
      });

      /*
       * Quitar marcador.
       */
      await page.evaluate(eventIndex => {

        const container =
          document.querySelector(
            `[data-scraper-event="${eventIndex}"]`
          );

        if (container) {
          container.removeAttribute(
            'data-scraper-event'
          );
        }

      }, result.eventIndex);

      /*
       * Normalizar hora.
       */
      const time = normalizeTime(result.time);

      events.push({
        time,
        time_utc: time ? timeBogotaToUTC(time) : null,
        match: result.match,
        league: result.league,
        flag: '⚽',
        channels
      });

      if (channels.length > 0) {

        console.log(
          `OK ${time} | ${result.match} -> ${channels.length} canales`
        );

        channels.forEach(channel => {
          console.log(
            `   ${channel.name}: ${channel.href}`
          );
        });

      } else {

        console.log(
          `-- ${time} | ${result.match} -> sin canales`
        );
      }

      await sleep(150);
    }

    return events;

  } finally {

    await browser.close();

    console.log('[PUP] Navegador cerrado');
  }
}


/*
 * ============================================================
 * MAIN
 * ============================================================
 */

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

  /*
   * Ordenar por hora.
   */
  events.sort((a, b) => {

    const minutes = time => {

      const [h, m] =
        (time || '00:00')
          .split(':')
          .map(Number);

      return h * 60 + m;
    };

    return minutes(a.time) - minutes(b.time);
  });

  /*
   * Eliminar eventos duplicados.
   */
  const seen = new Set();

  events = events.filter(event => {

    const key =
      `${event.time}|${event.match}`;

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);

    return true;
  });

  const withChannels =
    events.filter(
      event =>
        Array.isArray(event.channels) &&
        event.channels.length > 0
    ).length;

  /*
   * ==========================================================
   * JSON FINAL
   * ==========================================================
   */

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
    JSON.stringify(
      output,
      null,
      2
    ),
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

main().catch(error => {

  console.error(
    'ERROR FATAL:',
    error
  );

  process.exit(1);
});
