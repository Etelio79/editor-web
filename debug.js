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

  console.log('===== ABRIENDO PARTIDO =====');

  const partido = page.locator(
    'li[data-id="39982"] .ag-toggle'
  );

  console.log(
    'Botón encontrado:',
    await partido.count()
  );

  await partido.click();

  await new Promise(r => setTimeout(r, 2000));

  console.log('\n===== DESPUES DEL CLIC =====');

  const resultado = await page.evaluate(() => {

    const li = document.querySelector(
      'li[data-id="39982"]'
    );

    if (!li) {
      return {
        encontrado: false
      };
    }

    return {
      encontrado: true,
      html: li.outerHTML.substring(0, 10000),
      texto: li.innerText,
      enlaces: [
        ...li.querySelectorAll('a')
      ].map(a => ({
        texto: a.innerText.trim(),
        href: a.getAttribute('href')
      })),
      botones: [
        ...li.querySelectorAll('button')
      ].map(b => ({
        texto: b.innerText.trim(),
        clase: b.className
      })),
      iframes: [
        ...li.querySelectorAll('iframe')
      ].map(f => ({
        src: f.getAttribute('src') || ''
      }))
    };

  });

  console.log(
    JSON.stringify(resultado, null, 2)
  );

  console.log('\n===== IFRAMES DE TODA LA PAGINA =====');

  const iframes = await page.evaluate(() => {

    return [
      ...document.querySelectorAll('iframe')
    ].map((f, i) => ({
      numero: i,
      src: f.getAttribute('src') || '',
      html: f.outerHTML.substring(0, 1000)
    }));

  });

  console.log(
    JSON.stringify(iframes, null, 2)
  );

  console.log('\n===== FIN =====');

  await browser.close();

})();
