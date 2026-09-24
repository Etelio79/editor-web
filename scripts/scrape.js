const puppeteer = require('puppeteer');
const fs = require('fs');

const SITE_URL =
  process.env.SITE_URL || 'https://futbollibres.info/';

const OUTPUT_FILE = 'eventos.json';

/* =========================================================
   UTILIDADES
========================================================= */

function normalizeTime(text) {
  if (!text) return null;

  let value = String(text)
    .replace(/\s+/g, ' ')
    .trim();

  // 12 horas: 7:30 PM
  const ampm = value.match(
    /\b(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\b/i
  );

  if (ampm) {
    let hour = Number(ampm[1]);
    const minute = Number(ampm[2] || 0);
    const period = ampm[3].toUpperCase();

    if (period === 'PM' && hour !== 12) {
      hour += 12;
    }

    if (period === 'AM' && hour === 12) {
      hour = 0;
    }

    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }

  // 24 horas: 19:30
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
  FutbolLibre muestra los horarios en hora de Colombia.

  Colombia = UTC-5

  Ejemplo:
  19:30 Colombia -> 00:30 UTC del día siguiente
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

  const utcDate = new Date(
    Date.UTC(year, month, day, hour, minute, 0)
  );

  return utcDate.toISOString();
}


/*
  Algunos enlaces pueden venir codificados en:
  ?r=BASE64

  Si no existe r, conservamos el enlace original.
*/
function decodeEmbedUrl(href) {
  if (!href) return null;

  try {
    const url = new URL(href, SITE_URL);

    const encoded = url.searchParams.get('r');

    if (encoded) {
      try {
        return Buffer.from(encoded, 'base64').toString('utf8');
      } catch (e) {
        return href;
      }
    }

    return href;
  } catch (e) {
    return href;
  }
}


/*
  Limpia el nombre mostrado del canal.
*/
function cleanChannelName(name, index) {
  if (!name) {
    return `Canal ${index + 1}`;
  }

  let value = String(name)
    .replace(/\s+/g, ' ')
    .replace(/^[•·▪▫▶►»]+\s*/g, '')
    .trim();

  // El texto de .ag-toggle puede contener la hora.
  // No queremos que termine en el nombre del canal.
  value = value
    .replace(
      /^\d{1,2}(?::\d{2})?\s*(?:AM|PM)?\s*[-|:]*\s*/i,
      ''
    )
    .trim();

  return value || `Canal ${index + 1}`;
}


/* =========================================================
   SCRAPER
========================================================= */

async function scrapeFutbolLibre() {
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

  /*
    Bloqueamos recursos innecesarios para acelerar el scraper.
  */
  await page.setRequestInterception(true);

  page.on('request', request => {
    const type = request.resourceType();

    if (
      type === 'image' ||
      type === 'font' ||
      type === 'media'
    ) {
      request.abort();
    } else {
      request.continue();
    }
  });

  await page.setUserAgent(
    'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
  );

  await page.setViewport({
    width: 390,
    height: 844,
    isMobile: true
  });

  console.log('[PUP] Cargando página...');

  await page.goto(SITE_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });

  console.log('[PUP] Página cargada');

  /*
    Dejamos que JavaScript de la página termine de construir
    la lista de eventos.
  */
  await new Promise(resolve => setTimeout(resolve, 2500));

  await page.waitForSelector('#ag-list', {
    timeout: 30000
  });

  /*
    Esperamos a que aparezcan los eventos.
  */
  try {
    await page.waitForFunction(
      () => {
        return document.querySelectorAll(
          '#ag-list li[data-id]'
        ).length > 0;
      },
      { timeout: 10000 }
    );
  } catch (e) {
    console.log('[PUP] No aparecieron eventos dentro del tiempo esperado');
  }

  console.log('[PUP] Horarios detectados');

  const eventIds = await page.evaluate(() => {
    return Array.from(
      document.querySelectorAll('#ag-list li[data-id]')
    )
      .map(li => li.getAttribute('data-id'))
      .filter(Boolean);
  });

  console.log(
    `[PUP] ${eventIds.length} eventos detectados`
  );

  const events = [];

  /* =======================================================
     PROCESAR CADA EVENTO
  ======================================================= */

  for (let i = 0; i < eventIds.length; i++) {
    const eventId = eventIds[i];

    console.log(
      `[PUP] Procesando evento ${i + 1}/${eventIds.length}`
    );

    try {
      /*
        -----------------------------------------------------
        INFORMACIÓN DEL EVENTO
        -----------------------------------------------------
      */

      const info = await page.evaluate(id => {
        const li = document.querySelector(
          `#ag-list li[data-id="${CSS.escape(id)}"]`
        );

        if (!li) {
          return null;
        }

        const fullText = li.innerText || '';

        const leafTexts = Array.from(
          li.querySelectorAll('*')
        )
          .map(el => (el.innerText || '').trim())
          .filter(Boolean);

        const timeCandidates = [
          ...Array.from(li.querySelectorAll('time')).map(
            el => el.textContent
          ),
          ...Array.from(
            li.querySelectorAll('.ag-time')
          ).map(el => el.textContent),
          ...Array.from(
            li.querySelectorAll('[class*="time"]')
          ).map(el => el.textContent),
          ...Array.from(
            li.querySelectorAll('.ag-toggle')
          ).map(el => el.textContent)
        ];

        let timeText = null;

        for (const candidate of timeCandidates) {
          if (!candidate) continue;

          const match = String(candidate).match(
            /\b\d{1,2}(?::\d{2})?\s*(?:AM|PM)?\b/i
          );

          if (match) {
            timeText = match[0];
            break;
          }
        }

        if (!timeText) {
          const match = fullText.match(
            /\b\d{1,2}(?::\d{2})?\s*(?:AM|PM)?\b/i
          );

          if (match) {
            timeText = match[0];
          }
        }

        /*
          Buscamos el texto que contiene "vs" o " v ".
        */
        let matchText = leafTexts.find(text =>
          /\s+vs\s+/i.test(text)
        );

        if (!matchText) {
          matchText = leafTexts.find(text =>
            /\s+v\s+/i.test(text)
          );
        }

        if (!matchText) {
          const fallback = li.querySelector(
            '.ag-name, .ag-title, .ag-event-title'
          );

          if (fallback) {
            matchText = fallback.innerText.trim();
          }
        }

        if (!matchText) {
          matchText = fullText;
        }

        return {
          id,
          fullText,
          timeText,
          matchText
        };
      }, eventId);

      if (!info) {
        console.log(
          `[PUP] No se pudo leer el evento ${eventId}`
        );

        continue;
      }

      const time = normalizeTime(info.timeText);

      let rawMatch = info.matchText || '';

      /*
        Eliminamos la hora del comienzo del texto.
      */
      if (time) {
        rawMatch = rawMatch.replace(
          /^\s*\d{1,2}(?::\d{2})?\s*(?:AM|PM)?\s*/i,
          ''
        );
      }

      rawMatch = rawMatch
        .replace(/\s+/g, ' ')
        .trim();

      /*
        -----------------------------------------------------
        SEPARAR LIGA Y PARTIDO
        -----------------------------------------------------
      */

      let league = '';
      let match = rawMatch;

      const colonIndex = rawMatch.indexOf(':');

      if (colonIndex > -1) {
        const possibleLeague = rawMatch
          .slice(0, colonIndex)
          .trim();

        const possibleMatch = rawMatch
          .slice(colonIndex + 1)
          .trim();

        if (
          possibleLeague &&
          possibleMatch &&
          (
            /\s+vs\s+/i.test(possibleMatch) ||
            /\s+v\s+/i.test(possibleMatch)
          )
        ) {
          league = possibleLeague;
          match = possibleMatch;
        }
      }

      /*
        Si todavía tenemos texto extraño delante del partido,
        buscamos directamente la parte que contiene "vs".
      */
      if (
        !/\s+vs\s+/i.test(match) &&
        !/\s+v\s+/i.test(match)
      ) {
        const foundMatch = rawMatch.match(
          /(.+?\s+(?:vs|v)\s+.+)/i
        );

        if (foundMatch) {
          match = foundMatch[1].trim();
        }
      }

      /*
        -----------------------------------------------------
        CANALES
        -----------------------------------------------------

        Estrategia original:

        1. Abrir .ag-toggle
        2. Esperar .ag-play
        3. Buscar enlaces directos
        4. Si no hay enlace directo:
           hacer click en .ag-play
        5. Leer #ag-modal-frame
        6. Obtener src
      */

      let channels = [];

      const opened = await page.evaluate(id => {
        const li = document.querySelector(
          `#ag-list li[data-id="${CSS.escape(id)}"]`
        );

        if (!li) {
          return false;
        }

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
            {
              timeout: 5000
            }
          );
        } catch (e) {
          /*
            Puede que los canales ya estén presentes pero
            el selector no haya aparecido a tiempo.
          */
        }
      }

      /*
        Buscar canales.
      */
      const channelButtons = await page.evaluate(id => {
        const li = document.querySelector(
          `#ag-list li[data-id="${CSS.escape(id)}"]`
        );

        if (!li) {
          return [];
        }

        let elements = Array.from(
          li.querySelectorAll('.ag-play')
        );

        /*
          Fallback por si el sitio cambia ligeramente.
        */
        if (!elements.length) {
          elements = Array.from(
            li.querySelectorAll(
              '[data-url], [data-href], a[href*="/reproducir/"]'
            )
          );
        }

        return elements.map((el, index) => {
          return {
            index,
            text: (el.innerText || el.textContent || '').trim(),
            href: el.getAttribute('href'),
            dataUrl: el.getAttribute('data-url'),
            dataHref: el.getAttribute('data-href')
          };
        });
      }, eventId);

      /*
        Primero intentamos enlaces que ya estén disponibles
        directamente en el DOM.
      */
      for (let c = 0; c < channelButtons.length; c++) {
        const button = channelButtons[c];

        const href =
          button.href ||
          button.dataUrl ||
          button.dataHref;

        if (href) {
          const decoded = decodeEmbedUrl(href);

          if (decoded) {
            channels.push({
              name: cleanChannelName(
                button.text,
                c
              ),
              url: decoded
            });
          }
        }
      }

      /*
        Si no encontramos enlaces directos,
        hacemos click en cada .ag-play.

        Esto mantiene la estrategia que anteriormente
        funcionaba con futbollibres.info.
      */
      if (!channels.length && channelButtons.length) {
        for (let c = 0; c < channelButtons.length; c++) {
          console.log(
            `[PUP] Abriendo canal ${c + 1}/${channelButtons.length}`
          );

          try {
            const channelData = await page.evaluate(
              ({ id, index }) => {
                const li = document.querySelector(
                  `#ag-list li[data-id="${CSS.escape(id)}"]`
                );

                if (!li) {
                  return null;
                }

                const buttons = Array.from(
                  li.querySelectorAll('.ag-play')
                );

                const button = buttons[index];

                if (!button) {
                  return null;
                }

                const text =
                  button.innerText ||
                  button.textContent ||
                  '';

                button.click();

                return {
                  text: text.trim()
                };
              },
              {
                id: eventId,
                index: c
              }
            );

            if (!channelData) {
              continue;
            }

            /*
              Esperamos el iframe del modal.
            */
            try {
              await page.waitForSelector(
                '#ag-modal-frame',
                {
                  timeout: 5000
                }
              );
            } catch (e) {
              console.log(
                '[PUP] #ag-modal-frame no apareció'
              );
            }

            await new Promise(resolve =>
              setTimeout(resolve, 500)
            );

            const frameSrc = await page.evaluate(() => {
              const frame =
                document.querySelector(
                  '#ag-modal-frame'
                );

              return frame
                ? frame.getAttribute('src')
                : null;
            });

            if (frameSrc) {
              const decoded = decodeEmbedUrl(
                frameSrc
              );

              if (decoded) {
                channels.push({
                  name: cleanChannelName(
                    channelData.text,
                    c
                  ),
                  url: decoded
                });
              }
            }

            /*
              Cerrar modal antes del siguiente canal.
            */
            await page.evaluate(() => {
              const closeSelectors = [
                '#ag-modal .close',
                '#ag-modal-close',
                '.ag-modal-close',
                '[data-dismiss="modal"]'
              ];

              for (const selector of closeSelectors) {
                const close =
                  document.querySelector(selector);

                if (close) {
                  close.click();
                  break;
                }
              }
            });

            await new Promise(resolve =>
              setTimeout(resolve, 250)
            );

          } catch (error) {
            console.log(
              `[PUP] Error canal ${c + 1}: ${error.message}`
            );
          }
        }
      }

      /*
        -----------------------------------------------------
        ELIMINAR DUPLICADOS
        -----------------------------------------------------
      */

      const uniqueChannels = [];

      const seenChannels = new Set();

      for (const channel of channels) {
        if (!channel || !channel.url) {
          continue;
        }

        const key = channel.url;

        if (seenChannels.has(key)) {
          continue;
        }

        seenChannels.add(key);

        uniqueChannels.push({
          name:
            channel.name ||
            `Canal ${uniqueChannels.length + 1}`,
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
      console.log(
        `[PUP] Error procesando evento ${eventId}: ${error.message}`
      );
    }
  }

  /* =========================================================
     ORDENAR EVENTOS
  ========================================================= */

  events.sort((a, b) => {
    return String(a.time).localeCompare(
      String(b.time)
    );
  });

  /*
    Eliminar eventos duplicados.
  */
  const uniqueEvents = [];

  const seenEvents = new Set();

  for (const event of events) {
    const key =
      `${event.time}|${event.match}`;

    if (seenEvents.has(key)) {
      continue;
    }

    seenEvents.add(key);

    uniqueEvents.push(event);
  }

  /* =========================================================
     JSON FINAL
  ========================================================= */

  const result = {
    actualizado_en: new Date().toISOString(),
    fecha: new Date().toISOString().slice(0, 10),
    fuente: 'futbollibres-puppeteer',
    contar: uniqueEvents.length,
    contar_con_canales: uniqueEvents.filter(
      event =>
        Array.isArray(event.channels) &&
        event.channels.length > 0
    ).length,
    events: uniqueEvents,
    eventos: uniqueEvents
  };

  fs.writeFileSync(
    OUTPUT_FILE,
    JSON.stringify(result, null, 2),
    'utf8'
  );

  console.log('========================================');
  console.log(
    `[PUP] Total: ${result.contar}`
  );
  console.log(
    `[PUP] Con canales: ${result.contar_con_canales}`
  );
  console.log('========================================');

  await browser.close();

  console.log('[PUP] Navegador cerrado');

  console.log(
    `LISTO | futbollibres-puppeteer | total:${result.contar} | canales:${result.contar_con_canales}`
  );

  console.log(
    `Archivo: ${process.cwd()}/${OUTPUT_FILE}`
  );
}


/* =========================================================
   EJECUTAR
========================================================= */

scrapeFutbolLibre().catch(error => {
  console.error(
    '[PUP] ERROR FATAL:',
    error
  );

  process.exit(1);
});
