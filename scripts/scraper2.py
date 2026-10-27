import asyncio
import json
import re
from datetime import datetime, timedelta, timezone
from playwright.async_api import async_playwright

URL = "https://futbollibres.ad/"
SITE_ROOT = "https://futbollibres.ad"
OUTPUT_FILE = "eventos2.json"

# Zona horaria en la que la PÁGINA muestra las horas.
PAGE_UTC_OFFSET = 2
# Zona horaria en la que quieres las horas en el JSON (Colombia = UTC-5)
OUT_UTC_OFFSET = -5

# Pestañas trabajando en paralelo (reducido a 2 por apertura de nuevas ventanas)
N_WORKERS = 2
BLOQUEAR_IFRAMES = False # En esta web el iframe carga en la nueva pestaña, no lo bloqueamos

# Extrae los eventos leyendo el texto de la fila
LISTA_JS = """
() => {
    const results = [];
    const timeRegex = /(\\d{1,2}:\\d{2}(?:am|pm))/i;
    
    // Buscamos contenedores que tengan " vs " y un formato de hora
    document.querySelectorAll('div, tr, li').forEach(el => {
        if (el.children.length === 0 || !el.innerText.includes(' vs ')) return;
        
        const text = el.innerText;
        // Evitar contenedores gigantes que tienen muchos eventos
        if (text.split('\\n').length > 5) return;

        const timeMatch = text.match(timeRegex);
        if (!timeMatch) return;

        const lines = text.split('\\n').map(s => s.trim()).filter(s => s);
        const matchLine = lines.find(l => l.includes(' vs '));

        if (matchLine) {
            let title = matchLine.replace(timeMatch[0], '').trim();
            // Limpiar emojis de banderas si se cuelan en el texto
            title = title.replace(/[\\uD800-\\uDBFF][\\uDC00-\\uDFFF]/g, '').trim();
            title = title.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, '').trim();

            results.push({
                titulo: title,
                hora: timeMatch[0]
            });
        }
    });

    // Deduplicar resultados
    const unique = [];
    const seen = new Set();
    for (const r of results) {
        const key = r.titulo + '|' + r.hora;
        if (!seen.has(key)) {
            seen.add(key);
            unique.push(r);
        }
    }
    return unique;
}
"""

def parse_time_to_24h(time_str):
    """Convierte 12:00pm a 12:00, 1:45pm a 13:45, etc."""
    time_str = time_str.lower().strip()
    match = re.search(r'(\d{1,2}):(\d{2})(am|pm)', time_str)
    if not match:
        return time_str
    h = int(match.group(1))
    m = match.group(2)
    ampm = match.group(3)
    if ampm == 'pm' and h != 12:
        h += 12
    if ampm == 'am' and h == 12:
        h = 0
    return f"{h:02d}:{m}"

def limpiar_nombre(texto):
    n = texto.replace("▶", " ").replace("\n", " ")
    n = re.sub(r"Calidad \d+p", "", n, flags=re.IGNORECASE)
    n = re.sub(r"\s+", " ", n).strip()
    return n.strip(" |·-").strip()

def calcular_horas(horas):
    """
    Recibe las horas en formato 24h ('HH:MM') y devuelve [(hora_colombia, time_utc), ...].
    """
    tz_page = timezone(timedelta(hours=PAGE_UTC_OFFSET))
    tz_out = timezone(timedelta(hours=OUT_UTC_OFFSET))
    fecha = datetime.now(tz_page).date()
    previo = -1
    salida = []
    for hora in horas:
        try:
            h, m = map(int, hora.split(":"))
        except Exception:
            salida.append((hora, ""))
            continue
        minutos = h * 60 + m
        if minutos < previo:
            fecha += timedelta(days=1)
        previo = minutos
        dt = datetime(fecha.year, fecha.month, fecha.day, h, m, tzinfo=tz_page)
        salida.append((dt.astimezone(tz_out).strftime("%H:%M"), dt.astimezone(timezone.utc).isoformat()))
    return salida

def construir_evento(titulo, hora, time_utc, canales):
    """Convierte el título 'Liga: A vs B' + hora + canales al formato de eventos.json"""
    if ": " in titulo:
        liga, partido = titulo.split(": ", 1)
    else:
        liga, partido = "", titulo

    return {
        "time": hora,
        "time_utc": time_utc,
        "match": partido.strip(),
        "league": liga.strip(),
        "flag": "⚽",
        "channels": canales,
    }

async def cargar_agenda(page):
    await page.goto(URL, wait_until="domcontentloaded", timeout=60000)
    # Esperar a que carguen los eventos
    await page.wait_for_selector('text=" vs "', state="attached", timeout=30000)
    await page.wait_for_timeout(1000)

async def procesar_evento(page, titulo):
    canales_evento = []
    
    try:
        # Recargamos la página para asegurar que el acordeón esté cerrado
        await cargar_agenda(page)

        # Buscar la fila del evento y hacer clic para abrir el acordeón
        evento_li = page.locator('div, tr, li').filter(has_text=titulo).filter(has_text=" vs ").first
        await evento_li.click()
        await page.wait_for_timeout(1500) # Esperar animación del acordeón

        # Buscar los canales dentro del acordeón abierto (contienen la palabra "Calidad")
        canales = page.locator('div, a, li').filter(has_text=re.compile(r'Calidad \d+p', re.I))
        
        total_canales = await canales.count()
        print(f"  -> {titulo}: {total_canales} canales", flush=True)

        for j in range(total_canales):
            try:
                canal_elem = canales.nth(j)
                texto_canal = await canal_elem.inner_text()
                nombre_canal = limpiar_nombre(texto_canal)

                if len(nombre_canal) < 2 or "vs" in nombre_canal:
                    continue

                # Al hacer clic, se abre una nueva pestaña. La atrapamos con expect_page
                async with page.context.expect_page(timeout=10000) as new_page_info:
                    await canal_elem.click()
                
                new_page = await new_page_info.value
                await new_page.wait_for_load_state('domcontentloaded')
                
                # Extraer el iframe de la nueva pestaña
                try:
                    await new_page.wait_for_selector('iframe', timeout=5000)
                    src = await new_page.evaluate("() => { const f = document.querySelector('iframe'); return f ? f.src : ''; }")
                    
                    if src:
                        if src.startswith("/"):
                            src = SITE_ROOT + src
                        canales_evento.append({"name": nombre_canal, "url": src})
                        print(f"     ✅ {nombre_canal}: {src}", flush=True)
                    else:
                        print(f"     ❌ {nombre_canal}: sin src", flush=True)
                except Exception as e:
                    print(f"     ❌ {nombre_canal}: iframe no encontrado ({e})", flush=True)
                
                # Cerrar la pestaña del canal
                await new_page.close()

            except Exception as e:
                print(f"     ⚠️ Error al abrir canal: {e}", flush=True)
                
    except Exception as e:
        print(f"  ⚠️ Error con el evento {titulo}: {e}", flush=True)
        
    return canales_evento

async def worker(context, cola, resultados, wid):
    page = await context.new_page()
    page.set_default_timeout(15000)
    
    while True:
        try:
            i, titulo = cola.get_nowait()
        except asyncio.QueueEmpty:
            break
        try:
            resultados[i] = await procesar_evento(page, titulo)
        except Exception as e:
            print(f"  ⚠️ Error grave con {titulo}: {e}", flush=True)
            resultados[i] = []

    await page.close()

async def filtrar(route):
    try:
        req = route.request
        if req.resource_type in ("image", "media", "font"):
            await route.abort()
            return
    except Exception:
        pass
    await route.continue_()

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(
            user_agent=("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                        "AppleWebKit/537.36 (KHTML, like Gecko) "
                        "Chrome/120.0.0.0 Safari/537.36"),
            viewport={"width": 1280, "height": 900},
        )
        await context.route("**/*", filtrar)

        page = await context.new_page()
        page.set_default_timeout(15000)

        print("🌐 Abriendo futbollibres.ad...", flush=True)
        try:
            await cargar_agenda(page)
            await page.wait_for_timeout(1500)
        except Exception as e:
            print(f"Error cargando página: {e}", flush=True)
            await browser.close()
            return

        # 1. TÍTULOS Y HORAS de todos los eventos de una sola pasada
        datos = await page.evaluate(LISTA_JS)
        await page.close()
        print(f"Se encontraron {len(datos)} eventos.", flush=True)

        # Convertimos las horas a 24h para que calcular_horas haga su magia
        horas_24h = [parse_time_to_24h(d["hora"]) for d in datos]
        horas = calcular_horas(horas_24h)

        # 2. CANALES en paralelo
        cola = asyncio.Queue()
        for i, d in enumerate(datos):
            cola.put_nowait((i, d["titulo"]))
        resultados = {}
        n = max(1, min(N_WORKERS, len(datos)))
        await asyncio.gather(*(worker(context, cola, resultados, w + 1) for w in range(n)))

        await browser.close()

    events = []
    for i, d in enumerate(datos):
        hora, time_utc = horas[i]
        events.append(construir_evento(d["titulo"], hora, time_utc, resultados.get(i, [])))

    ahora = datetime.now(timezone.utc)
    salida = {
        "actualizado_en": ahora.isoformat(),
        "fecha": ahora.astimezone(timezone(timedelta(hours=OUT_UTC_OFFSET))).strftime("%Y-%m-%d"),
        "fuente": "futbollibres.ad-playwright",
        "contar": len(events),
        "contar_con_canales": sum(1 for e in events if e["channels"]),
        "events": events,
        "eventos": events,
    }
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(salida, f, indent=2, ensure_ascii=False)
    print(f"\n✅ Guardado en {OUTPUT_FILE}", flush=True)

if __name__ == "__main__":
    asyncio.run(main())
