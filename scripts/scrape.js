const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

const SITE_URL =
  process.env.SITE_URL || 'https://futbollibres.info/';


/* =========================================================
   UTILIDADES
========================================================= */

function normalizeTime(value) {
  if (!value) return null;

  const m = String(value)
    .trim()
    .match(/^(\d{1,2}):(\d{2})(?:\s*(AM|PM))?$/i);

  if (!m) return null;

  let hour = Number(m[1]);
  const minute = Number(m[2]);
  const ampm = m[3]?.toUpperCase();

  if (minute > 59) return null;

  if (ampm) {
    if (hour < 1 || hour > 12) return null;

    if (ampm === 'AM') {
      if (hour === 12) hour = 0;
    } else {
      if (hour !== 12) hour += 12;
    }
  } else {
    if (hour > 23) return null;
  }

  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}


function timeBogotaToUTC(timeStr) {
  const time = normalizeTime(timeStr);

  if (!time) {
    return new Date().toISOString();
  }

  const [hour, minute] = time.split(':').map(Number);

  const now = new Date();

  const bogotaNow = new Date(
    now.toLocaleString('en-US', {
      timeZone: 'America/Bogota'
    })
  );

  return new Date(
    Date.UTC(
      bogotaNow.getFullYear(),
      bogotaNow.getMonth(),
      bogotaNow.getDate(),
      hour + 5,
      minute
    )
  ).toISOString();
}


function decodeEmbedUrl(href) {
  try {
    const url = new URL(href);

    const r = url.searchParams.get('r');

    if (!r) return href;

    const decoded =
      Buffer.from(r, 'base64').toString('utf8');

    new URL(decoded);

    return decoded;

  } catch {
    return href;
  }
}


function splitLeagueMatch(title) {

  if (!title) {
    return {
      league: '',
      match: ''
    };
  }

  let text = String(title)
    .replace(/\s+/g, ' ')
    .trim();

  text = text.replace(
    /^\d{1,2}:\d{2}(?:\s*(?:AM|PM))?\s*/i,
    ''
  ).trim();

  const colon = text.indexOf(':');

  if (colon > 0) {

    const league =
      text.substring(0, colon).trim();

    const match =
      text.substring(colon + 1).trim();

    if (
      league &&
      match &&
      /\bvs\.?\b/i.test(match)
    ) {
      return {
        league,
        match
      };
    }
  }

  return {
    league: '',
    match: text
  };
}


/* =========================================================
   SCRAPER
========================================================= */

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
      '--no-zygote',
      '--single-process'
    ]
  });

  try {

    const page = await browser.newPage();


    /* -----------------------------------------------------
       BLOQUEAR RECURSOS PESADOS
    ----------------------------------------------------- */

    await page.setRequestInterception(true);

    page.on('request', req => {

      const type = req.resourceType();

      if (
        ['image', 'font', 'media'].includes(type)
      ) {
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


    /* -----------------------------------------------------
       CARGAR
    ----------------------------------------------------- */

    console.log('[PUP] Cargando página...');

    await page.goto(SITE_URL, {
      waitUntil: 'networkidle2',
      timeout: 45000
    });

    console.log('[PUP] Página cargada');


    /* -----------------------------------------------------
       ESPERAR HORARIOS
    ----------------------------------------------------- */

    let horarios = false;

    for (let intento = 1; intento <= 3; intento++) {

      try {

        await page.waitForFunction(() => {

          const rx =
            /^\d{1,2}:\d{2}(?:\s*(?:AM|PM))?$/i;

          const walker =
            document.createTreeWalker(
              document.body,
              NodeFilter.SHOW_TEXT
            );

          let node;

          while ((node = walker.nextNode())) {

            if (
              rx.test(
                node.textContent.trim()
              )
            ) {
              return true;
            }
          }

          return false;

        }, {
          timeout: 7000
        });

        horarios = true;

        console.log(
          `[PUP] Horarios detectados (intento ${intento})`
        );

        break;

      } catch {

        console.log(
          `[PUP] Sin horarios ` +
          `(intento ${intento}/3)`
        );

        await page.evaluate(async () => {

          for (
            let y = 0;
            y < document.body.scrollHeight;
            y += 400
          ) {

            window.scrollTo(0, y);

            await new Promise(r =>
              setTimeout(r, 100)
            );
          }

          window.scrollTo(0, 0);

        });

        await sleep(800);
      }
    }


    if (!horarios) {
      console.log(
        '[PUP] No se encontraron eventos'
      );

      return [];
    }


    /* -----------------------------------------------------
       CONTAR EVENTOS
    ----------------------------------------------------- */

    const eventCount = await page.evaluate(() => {

      const rx =
        /^\d{1,2}:\d{2}(?:\s*(?:AM|PM))?$/i;

      const walker =
        document.createTreeWalker(
          document.body,
          NodeFilter.SHOW_TEXT
        );

      let node;
      let count = 0;

      while ((node = walker.nextNode())) {

        if (!rx.test(node.textContent.trim())) {
          continue;
        }

        const parent =
          node.parentElement;

        if (!parent) continue;

        const rect =
          parent.getBoundingClientRect();

        const style =
          window.getComputedStyle(parent);

        if (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          style.opacity !== '0'
        ) {
          count++;
        }
      }

      return count;
    });


    console.log(
      `[PUP] ${eventCount} eventos detectados`
    );


    const events = [];


    /* =====================================================
       PROCESAR EVENTOS
    ===================================================== */

    for (
      let index = 0;
      index < eventCount;
      index++
    ) {

      console.log(
        `[PUP] Procesando evento ` +
        `${index + 1}/${eventCount}`
      );


      /* ---------------------------------------------------
         ENCONTRAR EVENTO
      --------------------------------------------------- */

      const eventInfo = await page.evaluate(
        index => {

          const rx =
            /^\d{1,2}:\d{2}(?:\s*(?:AM|PM))?$/i;

          const walker =
            document.createTreeWalker(
              document.body,
              NodeFilter.SHOW_TEXT
            );

          let node;
          let count = 0;

          while ((node = walker.nextNode())) {

            const text =
              node.textContent.trim();

            if (!rx.test(text)) {
              continue;
            }

            const parent =
              node.parentElement;

            if (!parent) continue;

            const rect =
              parent.getBoundingClientRect();

            if (
              rect.width <= 0 ||
              rect.height <= 0
            ) {
              continue;
            }

            if (count === index) {
              break;
            }

            count++;
          }

          if (!node) return null;

          const time =
            node.textContent.trim();

          const timeEl =
            node.parentElement;

          if (!timeEl) return null;


          timeEl.setAttribute(
            'data-scrape-event',
            `event-${index}`
          );


          /*
           * Buscar el texto del partido.
           *
           * Preferimos un elemento que contenga "vs".
           */
          let container = timeEl;

          let title = '';

          for (
            let level = 0;
            level < 8 && container;
            level++
          ) {

            const texts =
              Array.from(
                container.querySelectorAll('*')
              )
                .filter(el =>
                  el.children.length === 0
                )
                .map(el =>
                  el.textContent
                    .replace(/\s+/g, ' ')
                    .trim()
                )
                .filter(text =>
                  text.length > 3 &&
                  !rx.test(text)
                );


            title =
              texts.find(text =>
                /\bvs\.?\b/i.test(text)
              ) || '';


            if (title) break;

            container =
              container.parentElement;
          }


          if (!title) {
            return null;
          }


          title = title
            .replace(
              /^\d{1,2}:\d{2}(?:\s*(?:AM|PM))?\s*/i,
              ''
            )
            .trim();


          /*
           * Guardamos también referencias a posibles
           * contenedores relacionados.
           */
          container.scrollIntoView({
            behavior: 'instant',
            block: 'center'
          });


          /*
           * Abrir evento.
           */
          container.click();


          return {
            time,
            title,
            eventIndex: index
          };

        },
        index
      );


      if (
        !eventInfo ||
        !eventInfo.title
      ) {
        console.log(
          `[PUP] No se pudo identificar ` +
          `evento ${index + 1}`
        );

        continue;
      }


      const {
        league,
        match
      } = splitLeagueMatch(
        eventInfo.title
      );


      /* ---------------------------------------------------
         BUSCAR CANALES
         
         AQUÍ ESTÁ EL CAMBIO IMPORTANTE.
         
         No buscamos solamente dentro de un ancestro.
         Buscamos todos los enlaces de reproducción
         visibles después de abrir el evento y usamos
         proximidad al evento para asociarlos.
      --------------------------------------------------- */

      let rawChannels = [];


      for (
        let intento = 0;
        intento < 8;
        intento++
      ) {

        await sleep(300);


        rawChannels =
          await page.evaluate(
            eventIndex => {

              const isVisible = el => {

                const rect =
                  el.getBoundingClientRect();

                const style =
                  window.getComputedStyle(el);

                return (
                  rect.width > 0 &&
                  rect.height > 0 &&
                  style.display !== 'none' &&
                  style.visibility !== 'hidden' &&
                  style.opacity !== '0'
                );
              };


              /*
               * Este es el formato que vimos en el
               * sitio nuevo:
               *
               * /reproducir/?url=...
               */
              const isChannelHref = href => {

                if (!href) return false;

                try {

                  const url =
                    new URL(href);

                  const host =
                    url.hostname.toLowerCase();

                  const path =
                    url.pathname.toLowerCase();


                  if (
                    host.includes('futbollibre') &&
                    path.includes('reproducir')
                  ) {
                    return true;
                  }


                  /*
                   * Compatibilidad con embeds.
                   */
                  if (
                    path.includes('/embed/') &&
                    url.searchParams.has('r')
                  ) {
                    return true;
                  }


                  return false;

                } catch {
                  return false;
                }
              };


              /*
               * Localizar el horario actual.
               */
              const timeEl =
                document.querySelector(
                  `[data-scrape-event="event-${eventIndex}"]`
                );


              if (!timeEl) {
                return [];
              }


              /*
               * Primero buscamos un contenedor que
               * tenga el evento y enlaces.
               */
              const ancestors = [];

              let current =
                timeEl.parentElement;


              for (
                let i = 0;
                i < 12 && current;
                i++
              ) {

                ancestors.push(current);

                current =
                  current.parentElement;
              }


              /*
               * Ordenar de pequeño a grande.
               */
              for (
                const ancestor of ancestors
              ) {

                const links =
                  Array.from(
                    ancestor.querySelectorAll(
                      'a[href]'
                    )
                  )
                    .filter(a =>
                      isChannelHref(a.href)
                    )
                    .filter(isVisible);


                if (!links.length) {
                  continue;
                }


                /*
                 * Comprobar cuántos horarios tiene.
                 */
                const timeRx =
                  /^\d{1,2}:\d{2}(?:\s*(?:AM|PM))?$/i;

                const times = [];

                const walker =
                  document.createTreeWalker(
                    ancestor,
                    NodeFilter.SHOW_TEXT
                  );

                let node;

                while (
                  (node = walker.nextNode())
                ) {

                  if (
                    timeRx.test(
                      node.textContent.trim()
                    )
                  ) {
                    times.push(
                      node.parentElement
                    );
                  }
                }


                /*
                 * Si este contenedor solo tiene
                 * nuestro horario, perfecto.
                 */
                if (
                  times.length === 1 &&
                  times[0] === timeEl
                ) {

                  const result = [];
                  const seen = new Set();


                  for (const link of links) {

                    const href =
                      link.href;

                    if (seen.has(href)) {
                      continue;
                    }

                    seen.add(href);


                    let name =
                      link.textContent
                        .replace(
                          /[▶►•\-\s]+/g,
                          ' '
                        )
                        .trim();


                    if (!name) {
                      name =
                        `Canal ${result.length + 1}`;
                    }


                    result.push({
                      name,
                      href
                    });
                  }


                  return result;
                }
              }


              /*
               * SEGUNDO MÉTODO
               *
               * Si no encontramos el ancestro perfecto,
               * buscar enlaces dentro de elementos que
               * estén muy cerca del horario en el DOM.
               */
              const allLinks =
                Array.from(
                  document.querySelectorAll(
                    'a[href]'
                  )
                )
                  .filter(a =>
                    isChannelHref(a.href)
                  )
                  .filter(isVisible);


              if (!allLinks.length) {
                return [];
              }


              /*
               * Buscar el primer contenedor común
               * razonablemente pequeño que tenga enlaces.
               */
              for (
                let level = 1;
                level <= 8;
                level++
              ) {

                let parent =
                  timeEl;

                for (
                  let i = 0;
                  i < level && parent;
                  i++
                ) {
                  parent =
                    parent.parentElement;
                }

                if (!parent) continue;


                const links =
                  Array.from(
                    parent.querySelectorAll(
                      'a[href]'
                    )
                  )
                    .filter(a =>
                      isChannelHref(a.href)
                    )
                    .filter(isVisible);


                if (!links.length) {
                  continue;
                }


                const result = [];
                const seen = new Set();


                for (const link of links) {

                  const href =
                    link.href;

                  if (seen.has(href)) {
                    continue;
                  }

                  seen.add(href);


                  let name =
                    link.textContent
                      .replace(
                        /[▶►•\-\s]+/g,
                        ' '
                      )
                      .trim();


                  if (!name) {
                    name =
                      `Canal ${result.length + 1}`;
                  }


                  result.push({
                    name,
                    href
                  });
                }


                if (result.length) {
                  return result;
                }
              }


              return [];

            },
            eventInfo.eventIndex
          );


        if (rawChannels.length > 0) {
          break;
        }
      }


      /* ---------------------------------------------------
         QUITAR MARCADOR
      --------------------------------------------------- */

      await page.evaluate(
        eventIndex => {

          const el =
            document.querySelector(
              `[data-scrape-event="event-${eventIndex}"]`
            );

          if (el) {
            el.removeAttribute(
              'data-scrape-event'
            );
          }

        },
        eventInfo.eventIndex
      );


      /* ---------------------------------------------------
         EVENTO FINAL
      --------------------------------------------------- */

      const time =
        normalizeTime(eventInfo.time);


      if (!time) {
        continue;
      }


      const channels =
        rawChannels.map(channel => ({
          name: channel.name,
          href: decodeEmbedUrl(channel.href)
        }));


      events.push({

        time,

        time_utc:
          timeBogotaToUTC(time),

        match,

        league,

        flag: '⚽',

        channels

      });


      if (channels.length) {

        console.log(
          `OK ${time} | ` +
          `${league}: ${match} -> ` +
          `${channels.length} canales`
        );

        channels.forEach(channel => {

          console.log(
            `   ${channel.name}: ${channel.href}`
          );

        });

      } else {

        console.log(
          `-- ${time} | ` +
          `${league}: ${match} -> sin canales`
        );

      }


      /* ---------------------------------------------------
         CERRAR EVENTO
      --------------------------------------------------- */

      await page.keyboard.press('Escape');

      await sleep(150);

      await page.evaluate(() => {

        const selectors = [
          '[class*="close"]',
          '[class*="cerrar"]',
          '[aria-label*="lose"]'
        ];

        for (
          const selector of selectors
        ) {

          const button =
            document.querySelector(
              selector
            );

          if (
            button &&
            button.getBoundingClientRect().width > 0
          ) {

            button.click();

            return;
          }
        }

      });

      await sleep(150);
    }


    /* =====================================================
       ELIMINAR DUPLICADOS
    ===================================================== */

    const map = new Map();

    for (const event of events) {

      const key =
        `${event.time}|${event.match}`;

      if (!map.has(key)) {

        map.set(key, event);

      } else {

        const old =
          map.get(key);

        if (
          old.channels.length === 0 &&
          event.channels.length > 0
        ) {
          map.set(key, event);
        }
      }
    }


    const finalEvents =
      Array.from(map.values());


    /* =====================================================
       ORDENAR
    ===================================================== */

    finalEvents.sort((a, b) => {

      const minutes = value => {

        const [h, m] =
          value.split(':').map(Number);

        return h * 60 + m;
      };

      return (
        minutes(a.time) -
        minutes(b.time)
      );
    });


    const withChannels =
      finalEvents.filter(
        event =>
          event.channels.length > 0
      ).length;


    console.log('');
    console.log(
      `[PUP] Total: ${finalEvents.length}`
    );

    console.log(
      `[PUP] Con canales: ${withChannels}`
    );


    return finalEvents;


  } finally {

    await browser.close();

    console.log(
      '[PUP] Navegador cerrado'
    );
  }
}


/* =========================================================
   MAIN
========================================================= */

async function main() {

  console.log(
    `[${new Date().toISOString()}] ` +
    `=== SportStream Scraper ===`
  );


  let events = [];
  let source = 'none';


  try {

    events =
      await scrapeFutbolLibre();

    if (events.length > 0) {
      source =
        'futbollibres-puppeteer';
    }

  } catch (error) {

    console.warn(
      `[PUP] FALLO: ${error.message}`
    );

    console.warn(error.stack);
  }


  const fecha =
    new Date().toLocaleDateString(
      'es-ES',
      {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        timeZone: 'America/Bogota'
      }
    );


  const withChannels =
    events.filter(
      event =>
        (event.channels || []).length > 0
    ).length;


  const output = {

    actualizado_en:
      new Date().toISOString(),

    fecha,

    fuente:
      source,

    contar:
      events.length,

    contar_con_canales:
      withChannels,

    events,

    eventos:
      events
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
    `LISTO | ${source} | ` +
    `total:${events.length} | ` +
    `canales:${withChannels}`
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
