const puppeteer = require('puppeteer');

async function debugPage() {
  console.log('🔍 Iniciando diagnóstico de tarjetaroja.love...');
  
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  
  // Simulamos un celular
  await page.setUserAgent('Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36');
  await page.setViewport({ width: 390, height: 844, isMobile: true });

  console.log('⏳ Cargando página...');
  await page.goto('https://tarjetaroja.love/', { waitUntil: 'networkidle2', timeout: 60000 });
  
  // Esperamos 8 segundos para dar tiempo a que cargue el JavaScript de los partidos
  await new Promise(r => setTimeout(r, 8000));

  const info = await page.evaluate(() => {
    // 1. Título y texto visible
    const title = document.title;
    const bodyText = document.body.innerText.substring(0, 1500);

    // 2. Clases únicas (las que usan los elementos de la página)
    const allElements = document.querySelectorAll('*');
    const classNames = new Set();
    allElements.forEach(el => {
      if (el.className && typeof el.className === 'string') {
        el.className.split(/\s+/).forEach(c => {
          if (c.length > 2 && !c.includes('css') && !c.includes('js')) classNames.add(c);
        });
      }
    });

    // 3. Enlaces (Links) - Aquí veremos si los canales están ahí
    const links = Array.from(document.querySelectorAll('a')).slice(0, 40).map(a => ({
      text: (a.innerText || '').trim().substring(0, 50),
      href: a.getAttribute('href')
    })).filter(l => l.text && l.href);

    // 4. Si hay iframes
    const iframes = Array.from(document.querySelectorAll('iframe')).map(i => i.src);

    return { title, bodyText, classNames: Array.from(classNames), links, iframes };
  });

  console.log('\n================ RESULTADOS ================');
  console.log('📌 TÍTULO:', info.title);
  
  console.log('\n📝 TEXTO VISIBLE (primeros 1500 caracteres):');
  console.log(info.bodyText);
  
  console.log('\n🎨 CLASES CSS ENCONTRADAS:');
  console.log(info.classNames.join(', '));
  
  console.log('\n🔗 ENLACES ENCONTRADOS (primeros 40):');
  info.links.forEach(l => console.log(`"${l.text}" -> ${l.href}`));
  
  if (info.iframes.length > 0) {
    console.log('\n🖼️ IFRAMES ENCONTRADOS:');
    info.iframes.forEach(i => console.log(i));
  }
  
  console.log('============================================');

  await browser.close();
  console.log('✅ Diagnóstico terminado.');
}

debugPage().catch(error => {
  console.error('❌ ERROR FATAL:', error);
  process.exit(1);
});
