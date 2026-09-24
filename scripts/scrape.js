const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

const SITE_URL =
  process.env.SITE_URL || 'https://futbollibres.info/';

/*
 * Convierte una hora local de Colombia a UTC.
 * El sitio muestra las horas según su propia página.
 *
 * Se mantiene el campo time_utc porque tu API ya lo utiliza.
 */
function timeBogotaToUTC(timeStr) {
  try {
    const [h, m] = timeStr.split(':').map(Number);

    const now = new Date();

    const bogotaNow = new Date(
      now.toLocaleString('en-US', {
        timeZone: 'America/Bogota'
      })
    );

    const utc = new Date(
      Date.UTC(
        bogotaNow.getFullYear(),
        bogotaNow.getMonth(),
        bogotaNow.getDate(),
        h + 5,
        m
      )
    );

    return utc.toISOString();

  } catch {
    return new Date().toISOString();
  }
}


async function scrapeFutbolLibre() {

  console.log(`[PUP] Usando Chromium de Puppeteer`);
  console.log(`[PUP] URL: ${SITE_URL}`);

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

      /*
       * No necesitamos descargar imágenes, fuentes ni audio/video
       * para obtener la información de los eventos.
       */
      if (['image', 'font', 'media'].includes(type)) {
        req.abort();
      } else {
        req.continue();
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
      timeout: 60000
    });

    await sleep(5000);


    /*
     * Obtener todos los IDs de los partidos.
     */
    const ids = await page.$$eval(
      '#ag-list > li[data-id]',
      elementos =>
        elementos.map(el =>
          el.getAttribute('data-id')
        )
    );

    console.log(
      `[PUP] ${ids.length} partidos detectados`
    );


    if (!ids.length) {

      console.warn(
        '[PUP] No se encontraron partidos.'
      );

      return [];

    }


    const events = [];


    /*
     * Procesar cada partido.
     */
    for (const id of ids) {

      try {

        const selector =
          `li[data-id="${id}"] .ag-toggle`;


        /*
         * Leer información básica antes de abrirlo.
         */
        const basicInfo = await page.$eval(
          `li[data-id="${id}"]`,
          li => {

            const timeElement =
              li.querySelector('time');

            const toggle =
              li.querySelector('.ag-toggle');

            return {

              time: timeElement
                ? timeElement.innerText.trim()
                : '',

              texto: toggle
                ? toggle.innerText
                    .replace(/\s+/g, ' ')
                    .trim()
                : ''

            };

          }
        );


        if (!basicInfo.time) {
          console.log(
            `[PUP] ${id} -> sin hora`
          );
          continue;
        }


        /*
         * Separar liga y partido.
         *
         * Ejemplo:
         *
         * Liga de Naciones de la CONCACAF:
         * República Dominicana vs Nicaragua
         */
        let texto = basicInfo.texto;

        /*
         * Quitar la flecha del acordeón.
         */
        texto = texto
          .replace(/[▾▴]/g, '')
          .replace(/\s+/g, ' ')
          .trim();


        let league = '';
        let match = texto;


        if (texto.includes(':')) {

          const partes = texto.split(':');

          if (partes.length >= 2) {

            league = partes.shift().trim();

            match = partes
              .join(':')
              .trim();

          }

        }


        console.log(
          `\n[PUP] ${id} | ${basicInfo.time} | ${match}`
        );


        /*
         * Abrir el partido.
         */
        await page.click(selector);

        await sleep(500);


        /*
         * Esperar a que aparezcan los canales.
         */
        let canales = [];

        for (let intento = 0; intento < 10; intento++) {

          canales = await page.$$eval(
            `li[data-id="${id}"] .ag-play`,
            elementos =>
              elementos.map((el, index) => ({
                index,
                nombre: el.innerText
                  .replace(/^[▶►•]\s*/g, '')
                  .replace(/\s+/g, ' ')
                  .trim()
              }))
          );

          if (canales.length > 0) {
            break;
          }

          await sleep(300);

        }


        console.log(
          `[PUP] Canales encontrados: ${canales.length}`
        );


        const channels = [];


        /*
         * Abrir cada canal.
         */
        for (const canal of canales) {

          try {

            console.log(
              `[PUP] Canal: ${canal.nombre}`
            );


            /*
             * Localizar nuevamente el botón porque
             * el DOM puede cambiar después de cada clic.
             */
            const canalSelector =
              `li[data-id="${id}"] .ag-play`;


            const botones =
              await page.$$(canalSelector);


            if (!botones[canal.index]) {

              console.log(
                `[PUP] No se pudo localizar el canal ${canal.nombre}`
              );

              continue;

            }


            await botones[canal.index].click();


            /*
             * Esperar a que el sitio coloque la URL
             * dentro de #ag-modal-frame.
             */
            let iframeSrc = '';

            for (let intento = 0; intento < 10; intento++) {

              iframeSrc = await page.$eval(
                '#ag-modal-frame',
                iframe =>
                  iframe.getAttribute('src') || ''
              ).catch(() => '');


              if (iframeSrc) {
                break;
              }

              await sleep(300);

            }


            /*
             * Convertir URL relativa en absoluta.
             */
            if (iframeSrc) {

              try {

                iframeSrc = new URL(
                  iframeSrc,
                  SITE_URL
                ).href;

              } catch {}

            }


            if (iframeSrc) {

              channels.push({

                name: canal.nombre,

                href: iframeSrc

              });

              console.log(
                `   OK: ${iframeSrc}`
              );

            } else {

              console.log(
                `   -- sin URL para ${canal.nombre}`
              );

            }


          } catch (error) {

            console.warn(
              `[PUP] Error canal ${canal.nombre}: ${error.message}`
            );

          }

        }


        /*
         * Guardar el evento.
         */
        events.push({

          time: basicInfo.time,

          time_utc:
            timeBogotaToUTC(basicInfo.time),

          match,

          league,

          flag: '⚽',

          channels

        });


        if (channels.length > 0) {

          console.log(
            `[PUP] OK ${basicInfo.time} | ${match} -> ${channels.length} canales`
          );

        } else {

          console.log(
            `[PUP] -- ${basicInfo.time} | ${match} -> sin canales`
          );

        }


        /*
         * Cerrar el modal si está abierto.
         */
        await page.keyboard
          .press('Escape')
          .catch(() => {});


        await sleep(200);

      } catch (error) {

        console.warn(
          `[PUP] Error en partido ${id}: ${error.message}`
        );

      }

    }


    console.log(
      `\n[PUP] Total: ${events.length}`
    );

    console.log(
      `[PUP] Con canales: ${
        events.filter(e => e.channels.length > 0).length
      }`
    );


    return events;


  } finally {

    await browser.close();

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


  /*
   * Ordenar por hora.
   */
  events.sort((a, b) => {

    const minutos = t => {

      const [h, m] =
        (t || '0:0')
          .split(':')
          .map(Number);

      return h * 60 + (m || 0);

    };

    return minutos(a.time) - minutos(b.time);

  });


  /*
   * Eliminar duplicados.
   */
  const seen = new Set();

  events = events.filter(ev => {

    const key =
      `${ev.time}|${ev.match}`;

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);

    return true;

  });


  const withCh =
    events.filter(
      e => (e.channels || []).length > 0
    ).length;


  /*
   * Mantener exactamente la estructura
   * que tenía tu scraper anterior.
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

    fuente:
      source,

    contar:
      events.length,

    contar_con_canales:
      withCh,

    events,

    eventos:
      events

  };


  fs.writeFileSync(

    path.join(
      process.cwd(),
      'eventos.json'
    ),

    JSON.stringify(
      output,
      null,
      2
    ),

    'utf-8'

  );


  console.log(
    `LISTO | ${source} | total:${events.length} | canales:${withCh}`
  );

}


main().catch(e => {

  console.error(
    'ERROR FATAL:',
    e
  );

  process.exit(1);

});
