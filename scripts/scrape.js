const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const SITE_URL =
  process.env.SITE_URL || 'https://futbollibres.info/';

/**
 * Normaliza una hora:
 *
 * 08:00       -> 08:00
 * 8:00        -> 08:00
 * 01:00 PM    -> 13:00
 * 1:00 PM     -> 13:00
 * 12:30 AM    -> 00:30
 */
function normalizeTime(timeStr) {
  if (!timeStr) return null;

  const match = String(timeStr)
    .trim()
    .match(/^(\d{1,2}):(\d{2})(?:\s*(AM|PM))?$/i);

  if (!match) return null;

  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const ampm = match[3]?.toUpperCase();

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


/**
 * Convierte hora de Colombia (America/Bogota) a UTC.
 *
 * Colombia = UTC-5 durante todo el año.
 */
function timeBogotaToUTC(timeStr) {
  const normalized = normalizeTime(timeStr);

  if (!normalized) {
    return new Date().toISOString();
  }

  const [hour, minute] = normalized.split(':').map(Number);

  const now = new Date();

  const colombiaNow = new Date(
    now.toLocaleString('en-US', {
      timeZone: 'America/Bogota'
    })
  );

  // Colombia está en UTC-5.
  const utc = new Date(
    Date.UTC(
      colombiaNow.getFullYear(),
      colombiaNow.getMonth(),
      colombiaNow.getDate(),
      hour + 5,
      minute
    )
  );

  return utc.toISOString();
}


/**
 * Extrae la URL real si el enlace usa ?r=BASE64
 */
function decodeEmbedUrl(href) {
  try {
    const url = new URL(href);
    const r = url.searchParams.get('r');

    if (!r) return href;

    const decoded = Buffer.from(r, 'base64').toString('utf-8');

    new URL(decoded);

    return decoded;
  } catch {
    return href;
  }
}


/**
 * Extrae liga y partido de:
 *
 * Torneo de Reserva: Newell's Old Boys vs Rosario Central
 *
 * Resultado:
 *
 * league = Torneo de Reserva
 * match  = Newell's Old Boys vs Rosario Central
 */
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

  // Quitar hora al principio por seguridad.
  text = text.replace(
    /^\d{1,2}:\d{2}(?:\s*(?:AM|PM))?\s*/i,
    ''
  ).trim();

  const colon = text.indexOf(':');

  if (colon > 0) {
    const left = text.slice(0, colon).trim();
    const right = text.slice(colon + 1).trim();

    // Si la parte derecha parece un partido,
    // usamos la parte izquierda como liga.
    if (
      right.length > 3 &&
      /\bvs\.?\b/i.test(right)
    ) {
      return {
        league: left,
        match: right
      };
    }
  }

  return {
    league: '',
    match: text
  };
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
      '--no-zygote',
      '--single-process'
    ]
  });

  try {
    const page = await browser.newPage();

    // No cargar imágenes, fuentes ni vídeo.
    await page.setRequestInterception(true);

    page.on('request', request => {
      const type = request.resourceType();

      if (['image', 'font', 'media'].includes(type)) {
        request.abort();
      } else {
        request.continue();
      }
    });

    await page.setUserAgent(
      'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
    );

    await page.setViewport({
      width: 390,
      height: 844
    });

    console.log('[PUP] Cargando página...');

    await page.goto(SITE_URL, {
      waitUntil: 'networkidle2',
      timeout: 45000
    });

    console.log('[PUP] Página cargada');

    /**
     * Algunas partes de la página pueden cargarse después.
     */
    let horasDetectadas = false;

    for (let intento = 1; intento <= 3; intento++) {
      try {
        await page.waitForFunction(
          () => {
            const rx =
              /^\d{1,2}:\d{2}(?:\s*(?:AM|PM))?$/i;

            const walker = document.createTreeWalker(
              document.body,
              NodeFilter.SHOW_TEXT
            );

            let node;

            while ((node = walker.nextNode())) {
              if (rx.test(node.textContent.trim())) {
                return true;
              }
            }

            return false;
          },
          {
            timeout: 7000
          }
        );

        horasDetectadas = true;

        console.log(
          `[PUP] Horarios detectados (intento ${intento})`
        );

        break;

      } catch {
        console.log(
          `[PUP] No se detectaron horarios ` +
          `(intento ${intento}/3)`
        );

        await page.evaluate(async () => {
          for (
            let y = 0;
            y < document.body.scrollHeight;
            y += 400
          ) {
            window.scrollTo(0, y);

            await new Promise(resolve =>
              setTimeout(resolve, 100)
            );
          }

          window.scrollTo(0, 0);
        });

        await sleep(800);
      }
    }

    if (!horasDetectadas) {
      console.warn('[PUP] No se encontraron eventos.');
      return [];
    }

    await sleep(500);


    /**
     * Contar horarios reales.
     *
     * Usamos TreeWalker como en el scraper original.
     * Esto evita depender de:
     *
     * #ag-list > li[data-id]
     *
     * que era lo que estaba haciendo que faltaran eventos.
     */
    const eventCount = await page.evaluate(() => {
      const timeRx =
        /^\d{1,2}:\d{2}(?:\s*(?:AM|PM))?$/i;

      const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT
      );

      let node;
      let count = 0;

      while ((node = walker.nextNode())) {
        const text = node.textContent.trim();

        if (!timeRx.test(text)) continue;

        const parent = node.parentElement;

        if (!parent) continue;

        const rect = parent.getBoundingClientRect();

        const style = window.getComputedStyle(parent);

        const visible =
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          style.opacity !== '0';

        if (visible) {
          count++;
        }
      }

      return count;
    });

    console.log(
      `[PUP] ${eventCount} eventos detectados`
    );


    const events = [];


    /**
     * Procesar cada evento.
     */
    for (let idx = 0; idx < eventCount; idx++) {

      console.log(
        `[PUP] Procesando evento ${idx + 1}/${eventCount}`
      );


      /**
       * PASO A
       *
       * Localizar el horario exacto.
       */
      const result = await page.evaluate(
        async (index) => {

          const timeRx =
            /^\d{1,2}:\d{2}(?:\s*(?:AM|PM))?$/i;

          const walker = document.createTreeWalker(
            document.body,
            NodeFilter.SHOW_TEXT
          );

          let node;
          let count = 0;

          while ((node = walker.nextNode())) {

            const text = node.textContent.trim();

            if (!timeRx.test(text)) {
              continue;
            }

            const parent = node.parentElement;

            if (!parent) continue;

            const rect =
              parent.getBoundingClientRect();

            const style =
              window.getComputedStyle(parent);

            const visible =
              rect.width > 0 &&
              rect.height > 0 &&
              style.display !== 'none' &&
              style.visibility !== 'hidden' &&
              style.opacity !== '0';

            if (!visible) continue;

            if (count === index) {
              break;
            }

            count++;
          }

          if (!node) return null;

          const time = node.textContent.trim();

          const timeEl = node.parentElement;

          if (!timeEl) return null;

          /**
           * Marcador para volver a encontrar
           * este evento después del click.
           */
          timeEl.setAttribute(
            'data-time-marker',
            `evt-${index}`
          );


          /**
           * Buscar el contenedor del evento.
           */
          let container = timeEl;

          for (let level = 0; level < 8; level++) {

            if (!container) break;

            const leaves = Array.from(
              container.querySelectorAll('*')
            )
              .filter(el => el.children.length === 0)
              .map(el => el.textContent.trim())
              .filter(text =>
                text.length > 3 &&
                !timeRx.test(text)
              );

            if (leaves.length > 0) {
              break;
            }

            container =
              container.parentElement;
          }

          if (!container) return null;


          /**
           * Obtener textos del contenedor.
           */
          const texts = Array.from(
            container.querySelectorAll('*')
          )
            .filter(el => el.children.length === 0)
            .map(el => el.textContent.trim())
            .filter(text =>
              text.length > 2 &&
              !timeRx.test(text)
            );


          /**
           * Buscar primero un texto que tenga
           * "vs".
           */
          let title =
            texts.find(text =>
              /\bvs\.?\b/i.test(text)
            ) || '';


          /**
           * Si no encontramos un texto con vs,
           * buscar un texto que tenga ":".
           */
          if (!title) {
            title =
              texts.find(text =>
                text.includes(':')
              ) || '';
          }


          /**
           * Último recurso.
           */
          if (!title) {
            title = texts[0] || '';
          }

          if (!title || title.length < 4) {
            return null;
          }


          /**
           * Quitar hora si por alguna razón
           * viene pegada al título.
           */
          title = title
            .replace(
              /^\d{1,2}:\d{2}(?:\s*(?:AM|PM))?\s*/i,
              ''
            )
            .trim();


          /**
           * Abrir el evento.
           */
          container.scrollIntoView({
            behavior: 'instant',
            block: 'center'
          });

          container.click();


          return {
            time,
            title,
            eventIdx: index
          };

        },
        idx
      );


      if (
        !result ||
        !result.title ||
        result.title.length < 4
      ) {
        console.log(
          `[PUP] Evento ${idx + 1} no pudo identificarse`
        );

        continue;
      }


      /**
       * Separar liga y partido.
       */
      const parts =
        splitLeagueMatch(result.title);


      /**
       * PASO B
       *
       * Buscar los canales SIN hacer click en ellos.
       *
       * Esto es importante para reducir muchísimo
       * el tiempo de ejecución.
       */
      let rawChannels = [];

      for (let intento = 0; intento < 10; intento++) {

        await sleep(300);

        rawChannels = await page.evaluate(
          eventIdx => {

            const timeRx =
              /^\d{1,2}:\d{2}(?:\s*(?:AM|PM))?$/i;


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


            /**
             * Detectar enlaces de canales.
             */
            const isChannel = href => {

              if (!href) return false;

              try {

                const url = new URL(href);

                const host =
                  url.hostname.toLowerCase();

                const pathname =
                  url.pathname.toLowerCase();

                /**
                 * Nuevo sitio:
                 *
                 * /reproducir/?url=...
                 */
                if (
                  host.includes('futbollibre') &&
                  pathname.includes('reproducir')
                ) {
                  return true;
                }


                /**
                 * Compatibilidad con embeds antiguos.
                 */
                if (
                  pathname.includes('/embed/') &&
                  url.searchParams.has('r')
                ) {
                  return true;
                }


                /**
                 * Otros dominios relacionados.
                 */
                if (
                  host.includes('pelotalibre') ||
                  host.includes('rojadirecta')
                ) {
                  return true;
                }

              } catch {
                return false;
              }

              return false;
            };


            /**
             * Encontrar horario marcado.
             */
            const timeEl =
              document.querySelector(
                `[data-time-marker="evt-${eventIdx}"]`
              );

            if (!timeEl) return [];


            /**
             * Subir por los ancestros hasta encontrar
             * el contenedor mínimo que tenga:
             *
             * - nuestro horario
             * - enlaces de canales
             */
            let bestAncestor = null;

            let ancestor =
              timeEl.parentElement;


            for (
              let level = 0;
              level < 10 && ancestor;
              level++
            ) {

              const links =
                Array.from(
                  ancestor.querySelectorAll('a[href]')
                )
                  .filter(a =>
                    isChannel(a.href)
                  )
                  .filter(isVisible);


              if (links.length > 0) {

                /**
                 * Contar horarios dentro
                 * del ancestro.
                 */
                const allTimes = [];

                const walker =
                  document.createTreeWalker(
                    ancestor,
                    NodeFilter.SHOW_TEXT
                  );

                let n;

                while ((n = walker.nextNode())) {

                  if (
                    timeRx.test(
                      n.textContent.trim()
                    )
                  ) {
                    allTimes.push(
                      n.parentElement
                    );
                  }
                }


                /**
                 * Perfecto:
                 * solo contiene nuestro horario.
                 */
                if (
                  allTimes.length === 1 &&
                  allTimes[0] === timeEl
                ) {
                  bestAncestor = ancestor;
                  break;
                }


                /**
                 * Si contiene varios horarios,
                 * ya estamos abrazando otros eventos.
                 */
                if (allTimes.length > 1) {
                  break;
                }


                bestAncestor = ancestor;
              }


              ancestor =
                ancestor.parentElement;
            }


            if (!bestAncestor) {
              return [];
            }


            /**
             * Extraer canales.
             */
            const results = [];
            const seen = new Set();


            bestAncestor
              .querySelectorAll('a[href]')
              .forEach(a => {

                const href =
                  a.href || '';

                if (!isChannel(href)) {
                  return;
                }

                if (seen.has(href)) {
                  return;
                }

                if (!isVisible(a)) {
                  return;
                }

                seen.add(href);


                let name =
                  a.textContent
                    ?.replace(
                      /[▶►•\-\s]+/g,
                      ' '
                    )
                    .trim();


                if (!name) {
                  name =
                    `Canal ${results.length + 1}`;
                }


                results.push({
                  name,
                  href
                });
              });


            return results;

          },
          result.eventIdx
        );


        if (rawChannels.length > 0) {
          break;
        }
      }


      /**
       * Quitar marcador.
       */
      await page.evaluate(
        eventIdx => {

          const el =
            document.querySelector(
              `[data-time-marker="evt-${eventIdx}"]`
            );

          if (el) {
            el.removeAttribute(
              'data-time-marker'
            );
          }

        },
        result.eventIdx
      );


      /**
       * Normalizar hora.
       */
      const normalizedTime =
        normalizeTime(result.time);


      if (!normalizedTime) {
        console.log(
          `[PUP] Hora inválida: ${result.time}`
        );

        continue;
      }


      /**
       * Procesar canales.
       */
      const channels =
        rawChannels.map(channel => ({
          name: channel.name,
          href: decodeEmbedUrl(channel.href)
        }));


      /**
       * Guardar evento.
       */
      events.push({
        time: normalizedTime,

        time_utc:
          timeBogotaToUTC(normalizedTime),

        match: parts.match,

        league: parts.league,

        flag: '⚽',

        channels
      });


      if (channels.length > 0) {

        console.log(
          `OK ${normalizedTime} | ` +
          `${parts.league ? parts.league + ': ' : ''}` +
          `${parts.match} -> ` +
          `${channels.length} canales`
        );

        channels.forEach(channel => {
          console.log(
            `   ${channel.name}: ${channel.href}`
          );
        });

      } else {

        console.log(
          `-- ${normalizedTime} | ` +
          `${parts.league ? parts.league + ': ' : ''}` +
          `${parts.match} -> sin canales`
        );
      }


      /**
       * Cerrar acordeón/modal.
       */
      await page.keyboard.press('Escape');

      await sleep(150);


      await page.evaluate(() => {

        const selectors = [
          '[class*="close"]',
          '[class*="cerrar"]',
          '[aria-label*="lose"]'
        ];

        for (const selector of selectors) {

          const button =
            document.querySelector(selector);

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


    /**
     * Eliminar duplicados.
     */
    const unique = new Map();

    for (const event of events) {

      const key =
        `${event.time}|${event.match}`;

      if (!unique.has(key)) {
        unique.set(key, event);
      } else {

        /**
         * Si el duplicado tiene canales y el
         * original no, conservar el que tiene canales.
         */
        const current =
          unique.get(key);

        if (
          current.channels.length === 0 &&
          event.channels.length > 0
        ) {
          unique.set(key, event);
        }
      }
    }


    const finalEvents =
      Array.from(unique.values());


    /**
     * Ordenar por hora.
     */
    finalEvents.sort((a, b) => {

      const toMinutes = time => {

        const [h, m] =
          time.split(':').map(Number);

        return h * 60 + m;
      };

      return (
        toMinutes(a.time) -
        toMinutes(b.time)
      );
    });


    const withChannels =
      finalEvents.filter(
        event =>
          event.channels &&
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

    console.log('[PUP] Navegador cerrado');
  }
}


/**
 * MAIN
 */
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


  /**
   * Fecha actual en Colombia.
   */
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


  /**
   * Mantener exactamente la estructura
   * que utilizaba el scraper original.
   */
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
    'utf-8'
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
