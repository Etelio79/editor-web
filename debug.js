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

  await page.setViewport({
    width: 390,
    height: 844
  });

  await page.goto('https://futbollibres.info/', {
    waitUntil: 'networkidle2',
    timeout: 60000
  });

  await new Promise(r => setTimeout(r, 5000));

  console.log('===== BUSCANDO ELEMENTO DEL PARTIDO =====');

  const resultado = await page.evaluate(() => {

    const textoBuscado =
      'República Dominicana vs Nicaragua';

    const todos = [...document.querySelectorAll('body *')];

    const candidatos = todos.filter(el =>
      (el.innerText || '').includes(textoBuscado)
    );

    const datos = candidatos
      .slice(0, 5)
      .map((el, i) => {

        const atributos = {};

        for (const attr of el.attributes) {
          atributos[attr.name] = attr.value;
        }

        return {
          numero: i,
          tag: el.tagName,
          id: el.id || '',
          class: el.className || '',
          atributos,
          texto: (el.innerText || '').trim().substring(0, 500),
          html: el.outerHTML.substring(0, 2000)
        };

      });

    return datos;
  });

  console.log(
    JSON.stringify(resultado, null, 2)
  );

  console.log('\n===== FIN =====');

  await browser.close();

})();
