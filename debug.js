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

  console.log('Abriendo futbollibres.info...');

  await page.goto('https://futbollibres.info/', {
    waitUntil: 'networkidle2',
    timeout: 60000
  });

  await new Promise(r => setTimeout(r, 5000));

  console.log('\n===== PAGINA =====\n');

  const texto = await page.evaluate(() => {
    return document.body.innerText;
  });

  console.log(texto.substring(0, 15000));

  console.log('\n===== ENLACES Y BOTONES =====\n');

  const elementos = await page.evaluate(() => {

    return [...document.querySelectorAll(
      'a, button, [role="button"]'
    )]
    .map(el => ({
      texto: (el.innerText || '').trim(),
      href: el.href || ''
    }))
    .filter(x => x.texto);

  });

  console.log(
    JSON.stringify(elementos, null, 2)
  );

  console.log('\n===== IFRAMES =====\n');

  const iframes = await page.evaluate(() => {

    return [...document.querySelectorAll('iframe')]
      .map(el =>
        el.src ||
        el.getAttribute('src') ||
        ''
      )
      .filter(Boolean);

  });

  console.log(
    JSON.stringify(iframes, null, 2)
  );

  await browser.close();

})();
