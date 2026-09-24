const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ============================================================
// CONFIGURACIÓN
// ============================================================

const SITE_URL =
  process.env.SITE_URL || 'https://futbollibres.info/';

// ============================================================
// CONVERSIÓN DE HORA
// ============================================================

function timeMexicoToUTC(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);

  const now = new Date();

  const mexicoNow = new Date(
    now.toLocaleString('en-US', {
      timeZone: 'America/Mexico_City'
    })
  );

  const mexicoOffset = Math.round(
    (mexicoNow - now) / 3600000
  );

  const utc = new Date(
    Date.UTC(
      mexicoNow.getFullYear(),
      mexicoNow.getMonth(),
      mexicoNow.getDate(),
      h - mexicoOffset,
      m
    )
  );

  return utc.toISOString();
}

// ============================================================
// DECODIFICAR URL BASE64 SI EXISTE
// ============================================================

function decodeEmbedUrl(href) {
  try {
    const url = new URL(href);

    const r = url.searchParams.get('r');

    if (!r) return href;

    const decoded = Buffer
      .from(r, 'base64')
      .toString('utf-8');

    new URL(decoded);

    return decoded;

  } catch {
    return href;
  }
}

// ============================================================
// SCRAPER PRINCIPAL
// ============================================================

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
      '--no-zygote',
      '--single-process'
    ]
  });

  try {

    const page = await browser.newPage();

    // --------------------------------------------------------
    // BLOQUEAR RECURSOS PESADOS
    // --------------------------------------------------------

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

    // --------------------------------------------------------
    // USER AGENT
    // --------------------------------------------------------

    await page.setUserAgent(
      'Mozilla/5.0 (Linux; Android 13; Pixel 7) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/120.0.0.0 Mobile Safari/537.36'
    );

    await page.setViewport({
      width: 390,
      height: 844
    });

    // --------------------------------------------------------
    // ABRIR SITIO
    // --------------------------------------------------------

    console.log('[PUP] Cargando página...');

    await page.goto(
      SITE_URL,
      {
        waitUntil: 'networkidle2',
        timeout: 45000
      }
    );

    // --------------------------------------------------------
    // ESPERAR EVENTOS
    // --------------------------------------------------------

    let horasDetectadas = false;

    for (let intento = 1; intento <= 3; intento++) {

      try {

        await page.waitForFunction(
          () => /\d{1,2}:\d{2}/.test(
            document.body.innerText
          ),
          {
            timeout: 8000
          }
        );

        horasDetectadas = true;

        console.log(
          `[PUP] Horas detectadas (intento ${intento})`
        );

        break;

      } catch {

        console.warn(
          `[PUP] Sin horas (intento ${intento}/3), scrolleando...`
        );

        await page.evaluate(async () => {

          for (
            let y = 0;
            y < document.body.scrollHeight;
            y += 300
          ) {

            window.scrollTo(0, y);

            await new Promise(
              r => setTimeout(r, 150)
            );
          }

          window.scrollTo(0, 0);

        });

        await sleep(1500);
      }
    }

    if (!horasDetectadas) {

      console.warn(
        '[PUP] No se encontraron horarios.'
      );

      return [];
    }

    await sleep(1000);

    // --------------------------------------------------------
    // CONTAR EVENTOS
    // --------------------------------------------------------

    const eventCount = await page.evaluate(() => {

      const timeRx = /^\d{1,2}:\d{2}$/;

      const walker =
        document.createTreeWalker(
          document.body,
          NodeFilter.SHOW_TEXT,
          null
        );

      let node;
      let count = 0;

      while ((node = walker.nextNode())) {

        if (
          timeRx.test(
            node.textContent.trim()
          )
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

    // ========================================================
    // PROCESAR EVENTOS
    // ========================================================

    for (
      let idx = 0;
      idx < eventCount;
      idx++
    ) {

      // ------------------------------------------------------
      // LOCALIZAR EVENTO
      // ------------------------------------------------------

      const result = await page.evaluate(
        async index => {

          const timeRx =
            /^\d{1,2}:\d{2}$/;

          const walker =
            document.createTreeWalker(
              document.body,
              NodeFilter.SHOW_TEXT,
              null
            );

          let node;
          let count = 0;

          while ((node = walker.nextNode())) {

            if (
              !timeRx.test(
                node.textContent.trim()
              )
            ) {
              continue;
            }

            if (count === index) {
              break;
            }

            count++;
          }

          if (!node) {
            return null;
          }

          const time =
            node.textContent.trim();

          const timeEl =
            node.parentElement;

          timeEl.setAttribute(
            'data-time-marker',
            `evt-${index}`
          );

          // Buscar contenedor del evento
          let container = timeEl;

          for (
            let i = 0;
            i < 8;
            i++
          ) {

            if (!container) break;

            const texts =
              Array.from(
                container.querySelectorAll('*')
              )
              .filter(el =>
                el.children.length === 0 &&
                el.textContent.trim().length > 5 &&
                !timeRx.test(
                  el.textContent.trim()
                )
              );

            if (texts.length > 0) {
              break;
            }

            container =
              container.parentElement;
          }

          if (!container) {
            return null;
          }

          const allText =
            Array.from(
              container.querySelectorAll('*')
            )
            .filter(
              el => el.children.length === 0
            )
            .map(
              el => el.textContent.trim()
            )
            .filter(
              t =>
                t.length > 4 &&
                !timeRx.test(t)
            );

          let matchTitle =
            allText[0] || '';

          if (
            !matchTitle ||
            matchTitle.length < 4
          ) {
            return null;
          }

          let league = '';
          let match = matchTitle;

          if (
            matchTitle.includes(':') &&
            matchTitle
              .split(':')[1]
              .trim()
              .length > 3
          ) {

            league =
              matchTitle
                .split(':')[0]
                .trim();

            match =
              matchTitle
                .split(':')
                .slice(1)
                .join(':')
                .trim();
          }

          container.scrollIntoView({
            behavior: 'instant',
            block: 'center'
          });

          container.click();

          return {
            time,
            match,
            league,
            eventIdx: index
          };

        },
        idx
      );

      if (
        !result ||
        !result.match ||
        result.match.length < 4
      ) {
        continue;
      }

      // ======================================================
      // BUSCAR CANALES
      // ======================================================

      let channelNames = [];

      for (
        let t = 0;
        t < 20;
        t++
      ) {

        channelNames =
          await page.evaluate(
            eventIdx => {

              const timeRx =
                /^\d{1,2}:\d{2}$/;

              const isVisible = el => {

                if (!el) return false;

                const r =
                  el.getBoundingClientRect();

                const s =
                  getComputedStyle(el);

                return (
                  r.width > 0 &&
                  r.height > 0 &&
                  s.display !== 'none' &&
                  s.visibility !== 'hidden' &&
                  s.opacity !== '0'
                );
              };

              const norm = s =>
                (s || '')
                  .replace(
                    /[▶►•\-\s]+/g,
                    ' '
                  )
                  .trim();

              const timeEl =
                document.querySelector(
                  `[data-time-marker="evt-${eventIdx}"]`
                );

              if (!timeEl) {
                return [];
              }

              let ancestor =
                timeEl.parentElement;

              let best = null;

              for (
                let level = 0;
                level < 10 && ancestor;
                level++,
                ancestor =
                  ancestor.parentElement
              ) {

                const times =
                  Array.from(
                    ancestor.querySelectorAll('*')
                  )
                  .filter(el =>
                    timeRx.test(
                      (
                        el.textContent || ''
                      ).trim()
                    )
                  );

                if (times.length > 1) {
                  break;
                }

                const clickable =
                  Array.from(
                    ancestor.querySelectorAll(
                      'a,button,[role="button"],[onclick],[tabindex]'
                    )
                  )
                  .filter(isVisible);

                if (clickable.length) {

                  best = ancestor;

                  break;
                }
              }

              if (!best) {
                return [];
              }

              const out = [];
              const seen = new Set();

              const clickable =
                Array.from(
                  best.querySelectorAll(
                    'a,button,[role="button"],[onclick],[tabindex]'
                  )
                );

              for (const el of clickable) {

                if (!isVisible(el)) {
                  continue;
                }

                const text =
                  norm(el.textContent);

                if (
                  !text ||
                  text.length < 3 ||
                  text.length > 100
                ) {
                  continue;
                }

                if (
                  timeRx.test(text)
                ) {
                  continue;
                }

                const low =
                  text.toLowerCase();

                if (
                  /^(cerrar|close|recargar|reload|buscar|filtrar|agenda)$/i
                    .test(text)
                ) {
                  continue;
                }

                if (
                  low.includes(
                    'descargar apk'
                  )
                ) {
                  continue;
                }

                const key =
                  text.toLowerCase();

                if (seen.has(key)) {
                  continue;
                }

                seen.add(key);

                out.push(text);
              }

              return out;
            },
            result.eventIdx
          );

        if (channelNames.length) {
          break;
        }

        await sleep(400);
      }

      console.log(
        `[PUP] ${result.time} | ${result.match} -> controles encontrados: ${channelNames.length}`
      );

      // ======================================================
      // FUNCIÓN PARA CERRAR EL REPRODUCTOR
      // ======================================================

      async function closePlayerModal() {

        await page
          .keyboard
          .press('Escape')
          .catch(() => {});

        await sleep(250);

        await page.evaluate(() => {

          const candidates = [

            '[class*="close"]',

            '[class*="cerrar"]',

            '[aria-label*="Close"]',

            '[aria-label*="close"]',

            '[aria-label*="Cerrar"]',

            '[aria-label*="cerrar"]'

          ];

          for (
            const selector of candidates
          ) {

            const elements =
              document.querySelectorAll(
                selector
              );

            for (
              const el of elements
            ) {

              const r =
                el.getBoundingClientRect();

              if (
                r.width > 0 &&
                r.height > 0
              ) {

                el.click();

                return;
              }
            }
          }

        }).catch(() => {});

        await sleep(350);
      }

      // ======================================================
      // PROCESAR CADA CANAL
      // ======================================================

      const rawChannels = [];

      for (
        let ci = 0;
        ci < channelNames.length;
        ci++
      ) {

        const channelName =
          channelNames[ci];

        await closePlayerModal();

        // ----------------------------------------------------
        // IFRAMES ANTES DEL CLICK
        // ----------------------------------------------------

        const beforeFrames =
          await page.evaluate(() => {

            return Array.from(
              document.querySelectorAll(
                'iframe'
              )
            )
            .map(f => ({
              src:
                f.src ||
                f.getAttribute('src') ||
                ''
            }))
            .filter(
              f => f.src
            );
          });

        const beforeSrcs =
          new Set(
            beforeFrames.map(
              f => f.src
            )
          );

        // ----------------------------------------------------
        // CLICK EN EL CANAL
        // ----------------------------------------------------

        const clicked =
          await page.evaluate(
            ({ eventIdx, channelName }) => {

              const norm = s =>
                (s || '')
                  .replace(
                    /[▶►•\-\s]+/g,
                    ' '
                  )
                  .trim();

              const timeEl =
                document.querySelector(
                  `[data-time-marker="evt-${eventIdx}"]`
                );

              if (!timeEl) {
                return false;
              }

              let ancestor =
                timeEl.parentElement;

              let best = null;

              for (
                let level = 0;
                level < 10 &&
                ancestor;
                level++,
                ancestor =
                  ancestor.parentElement
              ) {

                const times =
                  Array.from(
                    ancestor.querySelectorAll('*')
                  )
                  .filter(el =>
                    /^\d{1,2}:\d{2}$/.test(
                      (
                        el.textContent || ''
                      ).trim()
                    )
                  );

                if (times.length > 1) {
                  break;
                }

                const controls =
                  Array.from(
                    ancestor.querySelectorAll(
                      'a,button,[role="button"],[onclick],[tabindex]'
                    )
                  );

                if (controls.length) {

                  best = ancestor;

                  break;
                }
              }

              if (!best) {
                return false;
              }

              const target =
                norm(channelName)
                  .toLowerCase();

              const controls =
                Array.from(
                  best.querySelectorAll(
                    'a,button,[role="button"],[onclick],[tabindex]'
                  )
                );

              // Coincidencia exacta
              let el =
                controls.find(
                  x =>
                    norm(
                      x.textContent
                    ).toLowerCase() ===
                    target
                );

              // Coincidencia parcial
              if (!el) {

                el =
                  controls.find(x => {

                    const t =
                      norm(
                        x.textContent
                      ).toLowerCase();

                    return (
                      t.includes(target) ||
                      target.includes(t)
                    );
                  });
              }

              if (!el) {
                return false;
              }

              el.scrollIntoView({
                behavior: 'instant',
                block: 'center'
              });

              el.click();

              return true;
            },
            {
              eventIdx:
                result.eventIdx,
              channelName
            }
          );

        if (!clicked) {

          console.warn(
            `[PUP] No se pudo pulsar canal: ${channelName}`
          );

          continue;
        }

        // ====================================================
        // ESPERAR IFRAME
        // ====================================================

        let iframeInfo = null;

        for (
          let wait = 0;
          wait < 25;
          wait++
        ) {

          iframeInfo =
            await page.evaluate(
              before => {

                const isVisible =
                  el => {

                    const r =
                      el.getBoundingClientRect();

                    const s =
                      getComputedStyle(el);

                    return (
                      r.width > 0 &&
                      r.height > 0 &&
                      s.display !== 'none' &&
                      s.visibility !== 'hidden'
                    );
                  };

                const frames =
                  Array.from(
                    document.querySelectorAll(
                      'iframe'
                    )
                  )
                  .filter(isVisible)
                  .map(f => ({
                    src:
                      f.src ||
                      f.getAttribute(
                        'src'
                      ) ||
                      '',

                    title:
                      f.title || ''
                  }))
                  .filter(
                    f =>
                      f.src &&
                      f.src !==
                        'about:blank'
                  );

                // Buscar iframe nuevo
                const fresh =
                  frames.find(
                    f =>
                      !before.includes(
                        f.src
                      )
                  );

                return (
                  fresh ||
                  frames[
                    frames.length - 1
                  ] ||
                  null
                );
              },
              Array.from(
                beforeSrcs
              )
            );

          if (
            iframeInfo &&
            iframeInfo.src
          ) {
            break;
          }

          await sleep(400);
        }

        // ====================================================
        // GUARDAR CANAL
        // ====================================================

        if (
          iframeInfo &&
          iframeInfo.src
        ) {

          rawChannels.push({

            name:
              channelName,

            href:
              iframeInfo.src

          });

          console.log(
            `   CANAL ${ci + 1}: ${channelName} -> ${iframeInfo.src}`
          );

        } else {

          console.warn(
            `   CANAL ${ci + 1}: ${channelName} -> no apareció iframe`
          );
        }

        await closePlayerModal();
      }

      // ======================================================
      // LIMPIAR MARCADOR
      // ======================================================

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

      // ======================================================
      // CREAR EVENTO
      // ======================================================

      const channels =
        rawChannels.map(ch => ({

          name:
            ch.name,

          href:
            decodeEmbedUrl(
              ch.href
            )

        }));

      events.push({

        time:
          result.time,

        time_utc:
          timeMexicoToUTC(
            result.time
          ),

        match:
          result.match,

        league:
          result.league,

        flag:
          '⚽',

        channels

      });

      if (
        channels.length > 0
      ) {

        console.log(
          `OK ${result.time} | ${result.match} -> ${channels.length} canales`
        );

        channels.forEach(c =>
          console.log(
            `   ${c.name}: ${c.href}`
          )
        );

      } else {

        console.log(
          `-- ${result.time} | ${result.match} -> sin canales`
        );
      }

      // ------------------------------------------------------
      // CERRAR EVENTO
      // ------------------------------------------------------

      await page
        .keyboard
        .press('Escape');

      await sleep(200);

      await page.evaluate(() => {

        const selectors = [

          '[class*="close"]',

          '[class*="cerrar"]',

          '[aria-label*="lose"]'

        ];

        for (
          const selector of selectors
        ) {

          const buttons =
            document.querySelectorAll(
              selector
            );

          for (
            const b of buttons
          ) {

            if (
              b.getBoundingClientRect()
                .width > 0
            ) {

              b.click();

              return;
            }
          }
        }

      });

      await sleep(200);
    }

    // ========================================================
    // RESULTADO
    // ========================================================

    const withCh =
      events.filter(
        e =>
          e.channels.length > 0
      ).length;

    console.log(
      `\n[PUP] Total: ${events.length} | Con canales: ${withCh}`
    );

    return events;

  } finally {

    await browser.close();

  }
}

// ============================================================
// MAIN
// ============================================================

async function main() {

  console.log(
    `[${new Date().toISOString()}] === SportStream Scraper ===`
  );

  let events = [];
  let source = 'none';

  try {

    events =
      await scrapeFutbolLibre();

    if (
      events.length > 0
    ) {

      source =
        'futbollibres-puppeteer';
    }

  } catch (e) {

    console.warn(
      `[PUP] FALLO: ${e.message}`
    );
  }

  // ----------------------------------------------------------
  // ORDENAR POR HORA
  // ----------------------------------------------------------

  events.sort((a, b) => {

    const m = t => {

      const [
        h,
        mm
      ] =
        (t || '0:0')
          .split(':')
          .map(Number);

      return (
        h * 60 +
        (mm || 0)
      );
    };

    return (
      m(a.time) -
      m(b.time)
    );
  });

  // ----------------------------------------------------------
  //
