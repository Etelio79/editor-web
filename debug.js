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

  await new Promise(r => setTimeout(r, 4000));

  const ids = await page.$$eval(
    '#ag-list > li[data-id]',
    elementos => elementos.map(el => el.getAttribute('data-id'))
  );

  console.log('===== PARTIDOS =====');
  console.log('Total:', ids.length);

  const resultados = [];

  for (const id of ids) {

    console.log(`\n===== PARTIDO ${id} =====`);

    try {

      const selector = `li[data-id="${id}"] .ag-toggle`;

      await page.click(selector);

      // Esperar a que el sitio abra el evento
      await new Promise(r => setTimeout(r, 500));

      const datos = await page.$eval(
        `li[data-id="${id}"]`,
        li => {

          const boton = li.querySelector('.ag-toggle');

          const canales = [
            ...li.querySelectorAll('.ag-play')
          ].map(el => ({
            nombre: el.innerText
              .replace(/\s+/g, ' ')
              .trim()
          }));

          return {
            id: li.getAttribute('data-id'),
            evento: boton
              ? boton.innerText.replace(/\s+/g, ' ').trim()
              : '',
            canales
          };

        }
      );

      console.log('Evento:', datos.evento);
      console.log('Canales encontrados:', datos.canales.length);

      for (const canal of datos.canales) {
        console.log('  Canal:', canal.nombre);
      }

      resultados.push(datos);

    } catch (error) {

      console.log(
        'ERROR:',
        error.message
      );

      resultados.push({
        id,
        error: error.message
      });

    }

  }

  console.log('\n===== RESULTADO FINAL =====');

  console.log(
    JSON.stringify(resultados, null, 2)
  );

  await browser.close();

})();
