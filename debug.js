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

  const partido = await page.$(
    'li[data-id="39982"] .ag-toggle'
  );

  if (!partido) {
    console.log('No se encontró el partido');
    await browser.close();
    return;
  }

  await partido.click();

  await new Promise(r => setTimeout(r, 1500));

  console.log('Partido abierto');

  console.log('\n===== CANAL =====');

  const canal = await page.$(
    'li[data-id="39982"] .ag-play'
  );

  if (!canal) {
    console.log('No se encontró el canal');
    await browser.close();
    return;
  }

  const infoCanal = await page.evaluate(el => ({
    texto: el.innerText,
    html: el.outerHTML
  }), canal);

  console.log(JSON.stringify(infoCanal, null, 2));

  console.log('\n===== HACIENDO CLIC EN EL CANAL =====');

  await canal.click();

  await new Promise(r => setTimeout(r, 3000));

  console.log('\n===== MODAL =====');

  const modal = await page.evaluate(() => {

    const iframe = document.querySelector(
      '#ag-modal-frame'
    );

    if (!iframe) {
      return {
        encontrado: false
      };
    }

    return {
      encontrado: true,
      src: iframe.getAttribute('src') || '',
      html: iframe.outerHTML
    };

  });

  console.log(
    JSON.stringify(modal, null, 2)
  );

  console.log('\n===== TODOS LOS IFRAMES =====');

  const iframes = await page.evaluate(() => {

    return [
      ...document.querySelectorAll('iframe')
    ].map((f, i) => ({
      numero: i,
      id: f.id,
      src: f.getAttribute('src') || '',
      html: f.outerHTML.substring(0, 3000)
    }));

  });

  console.log(
    JSON.stringify(iframes, null, 2)
  );

  console.log('\n===== FIN =====');

  await browser.close();

})();
