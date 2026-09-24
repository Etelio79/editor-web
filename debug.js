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

  console.log('===== BUSCANDO PARTIDO =====');

  const encontrado = await page.evaluate(() => {

    const elementos = [...document.querySelectorAll('body *')];

    const elemento = elementos.find(el =>
      (el.innerText || '').includes(
        'República Dominicana vs Nicaragua'
      )
    );

    if (!elemento) return false;

    elemento.scrollIntoView({
      behavior: 'instant',
      block: 'center'
    });

    elemento.click();

    return true;
  });

  console.log('Partido encontrado:', encontrado);

  await new Promise(r => setTimeout(r, 2000));

  console.log('\n===== CONTENIDO DESPUES DE ABRIR =====');

  const datos = await page.evaluate(() => {

    const texto = document.body.innerText;

    const iframes = [
      ...document.querySelectorAll('iframe')
    ].map((iframe, i) => ({
      numero: i,
      src: iframe.getAttribute('src') || '',
      title: iframe.getAttribute('title') || ''
    }));

    const botones = [
      ...document.querySelectorAll(
        'a, button, [role="button"]'
      )
    ]
      .map(el => ({
        texto: (el.innerText || '').trim(),
        href: el.getAttribute('href') || ''
      }))
      .filter(x =>
        x.texto &&
        (
          x.texto.toLowerCase().includes('fox') ||
          x.texto.toLowerCase().includes('espn') ||
          x.texto.toLowerCase().includes('canal') ||
          x.texto.toLowerCase().includes('ver')
        )
      );

    return {
      iframes,
      botones,
      texto: texto.substring(
        Math.max(0, texto.indexOf(
          'República Dominicana vs Nicaragua'
        ) - 200),
        texto.indexOf(
          'República Dominicana vs Nicaragua'
        ) + 1500
      )
    };

  });

  console.log('\n--- TEXTO DEL PARTIDO ---');
  console.log(datos.texto);

  console.log('\n--- CANALES ---');
  console.log(
    JSON.stringify(datos.botones, null, 2)
  );

  console.log('\n--- IFRAMES ---');
  console.log(
    JSON.stringify(datos.iframes, null, 2)
  );

  console.log('\n===== FIN =====');

  await browser.close();

})();
