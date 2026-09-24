const puppeteer = require('puppeteer');

(async () => {

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox'
    ]
  });

  const page = await browser.newPage();

  await page.goto('https://futbollibres.info/', {
    waitUntil: 'networkidle2',
    timeout: 60000
  });

  await new Promise(r => setTimeout(r, 5000));

  console.log('===== BUSCANDO PARTIDOS =====');

  const partidos = await page.$$(
    '#ag-list > li[data-id]'
  );

  console.log(
    'Partidos encontrados:',
    partidos.length
  );

  const resultados = [];

  for (let i = 0; i < partidos.length; i++) {

    try {

      const li = partidos[i];

      const info = await page.evaluate(el => {

        const boton = el.querySelector('.ag-toggle');

        return {
          id: el.getAttribute('data-id'),
          texto: boton ? boton.innerText.trim() : '',
        };

      }, li);

      console.log(
        `\n[${i + 1}/${partidos.length}]`,
        info.id,
        info.texto.replace(/\n/g, ' ')
      );

      await li.$eval(
        '.ag-toggle',
        el => el.click()
      );

      await new Promise(r => setTimeout(r, 300));

      const canales = await li.$$(
        '.ag-play'
      );

      console.log(
        'Canales:',
        canales.length
      );

      const listaCanales = [];

      for (let j = 0; j < canales.length; j++) {

        const canal = canales[j];

        const nombre = await page.evaluate(
          el => el.innerText.trim(),
          canal
        );

        await canal.click();

        await new Promise(r => setTimeout(r, 500));

        const src = await page.$eval(
          '#ag-modal-frame',
          iframe => iframe.getAttribute('src') || ''
        ).catch(() => '');

        console.log(
          '  -',
          nombre.replace(/\n/g, ' '),
          '=>',
          src
        );

        listaCanales.push({
          nombre: nombre.replace(/\s+/g, ' '),
          url: src
        });

      }

      resultados.push({
        id: info.id,
        evento: info.texto.replace(/\s+/g, ' '),
        canales: listaCanales
      });

    } catch (error) {

      console.log(
        'ERROR:',
        error.message
      );

    }

  }

  console.log('\n===== RESULTADO FINAL =====');

  console.log(
    JSON.stringify(resultados, null, 2)
  );

  await browser.close();

})();
