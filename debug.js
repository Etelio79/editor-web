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

  console.log('');
  console.log('===== RESULTADO =====');

  const datos = await page.evaluate(() => {

    const elementos = [
      ...document.querySelectorAll(
        'a, button, [role="button"]'
      )
    ];

    const botones = elementos
      .map(el => ({
        texto: (el.innerText || '').trim(),
        href: el.href || ''
      }))
      .filter(x => x.texto)
      .slice(0, 100);

    const iframes = [
      ...document.querySelectorAll('iframe')
    ].map(el =>
      el.src ||
      el.getAttribute('src') ||
      ''
    ).filter(Boolean);

    const eventos =
      document.body.innerText
        .split('\n')
        .map(x => x.trim())
        .filter(x => x.length > 3)
        .filter(x =>
          /\d{1,2}:\d{2}/.test(x)
        )
        .slice(0, 30);

    return {
      botones,
      iframes,
      eventos
    };
  });

  console.log('');
  console.log('--- EVENTOS ---');

  datos.eventos.forEach(x =>
    console.log(x)
  );

  console.log('');
  console.log('--- BOTONES Y ENLACES ---');

  datos.botones.forEach((x, i) =>
    console.log(
      `${i}: ${x.texto} | ${x.href}`
    )
  );

  console.log('');
  console.log('--- IFRAMES ---');

  if (datos.iframes.length === 0) {
    console.log('NINGUNO');
  } else {
    datos.iframes.forEach(x =>
      console.log(x)
    );
  }

  console.log('');
  console.log('===== FIN =====');

  await browser.close();

})();
