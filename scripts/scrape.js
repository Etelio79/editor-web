const puppeteer = require('puppeteer');

async function debugEstructura() {
  console.log('🔍 Buscando la estructura HTML de un evento...');
  
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36');
  await page.setViewport({ width: 390, height: 844, isMobile: true });

  await page.goto('https://tarjetaroja.love/', { waitUntil: 'networkidle2', timeout: 60000 });
  await new Promise(r => setTimeout(r, 8000));

  const info = await page.evaluate(() => {
    // Buscamos el primer evento
    const primerEvento = document.querySelector('.tr-event');
    if (!primerEvento) return { error: 'No se encontró ningún elemento con la clase .tr-event' };

    // Extraemos el HTML de todo el evento
    const htmlEvento = primerEvento.outerHTML;

    // Intentamos buscar el contenedor de canales de varias formas
    const canales1 = primerEvento.querySelector('.tr-event-channels');
    const canales2 = primerEvento.querySelector('.tr-event-channel');
    const canales3 = document.querySelector('.tr-event-channels');
    
    // Extraemos todos los enlaces que contengan '/ver/' en la página
    const enlacesVer = Array.from(document.querySelectorAll('a[href*="/ver/"]')).map(a => a.outerHTML);

    return {
      htmlEvento: htmlEvento.substring(0, 3000), // Solo los primeros 3000 caracteres para que no sea gigante
      tieneCanales1: canales1 ? canales1.outerHTML.substring(0, 1000) : 'No encontrado dentro del evento',
      tieneCanales2: canales2 ? canales2.outerHTML.substring(0, 1000) : 'No encontrado dentro del evento',
      tieneCanales3: canales3 ? canales3.outerHTML.substring(0, 1000) : 'No encontrado a nivel global',
      enlacesVer: enlacesVer.slice(0, 5) // Mostramos los primeros 5 enlaces de canales
    };
  });

  console.log('\n================ RESULTADOS ================');
  if (info.error) {
    console.log('❌', info.error);
  } else {
    console.log('📌 HTML DEL PRIMER EVENTO:');
    console.log(info.htmlEvento);
    
    console.log('\n📌 HTML DE .tr-event-channels (dentro del evento):');
    console.log(info.tieneCanales1);
    
    console.log('\n📌 HTML DE .tr-event-channel (dentro del evento):');
    console.log(info.tieneCanales2);

    console.log('\n📌 HTML DE .tr-event-channels (global):');
    console.log(info.tieneCanales3);

    console.log('\n📌 PRIMEROS 5 ENLACES DE CANALES EN LA PÁGINA:');
    info.enlacesVer.forEach(e => console.log(e));
  }
  console.log('============================================');

  await browser.close();
}

debugEstructura().catch(console.error);
