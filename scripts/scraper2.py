import asyncio
import json
import re
from datetime import datetime, timedelta, timezone
from playwright.async_api import async_playwright

URL = "https://pirlotvapp.pro/"
SITE_ROOT = "https://pirlotvapp.pro"
OUTPUT_FILE = "eventos2.json"

# Zona horaria en la que la PÁGINA muestra las horas.
# (Jaguares sale a las 01:00 en la página y juega a las 18:00 en Colombia -> la página va en UTC+2)
PAGE_UTC_OFFSET = 2
# Zona horaria en la que quieres las horas en el JSON (Colombia = UTC-5)
OUT_UTC_OFFSET = -5

# Pestañas trabajando en paralelo
N_WORKERS = 4
# No cargar el contenido de los iframes (solo necesitamos su src). Acelera mucho.
BLOQUEAR_IFRAMES = True

LISTA_JS = """
() => [...document.querySelectorAll('button.ag-toggle')].map(b => {
    const t = b.querySelector('span.font-semibold');
    const li = b.closest('li');
    const txt = li ? li.innerText : b.innerText;
    const m = txt.match(/\\b(\\d{1,2}:\\d{2})\\b/);
    return { titulo: t ? t.textContent.trim() : '', hora: m ? m[1] : '' };
})
"""
BLANK_JS = """
() => document.querySelectorAll('iframe').forEach(f => {
    try { f.setAttribute('src', 'about:blank'); } catch (e) {}
})
"""
HAS_SRC_JS = """
() => [...document.querySelectorAll('iframe')].some(f => {
    const s = f.getAttribute('src');
    return s && s !== 'about:blank';
})
"""
GET_SRC_JS = """
() => {
    const f = [...document.querySelectorAll('iframe')]
        .map(x => x.getAttribute('src') || '')
        .filter(s => s && s !== 'about:blank');
    return f.length ? f[0] : '';
}
"""


def limpiar_nombre(texto):
    """Quita la flechita y la palabra 'Español'. Deja la opción si viene (| opc3, | OP2...)."""
    n = texto.replace("▶", " ").replace("\n", " ")
    n = re.sub(r"Espa\S{1,2}ol", "", n, flags=re.IGNORECASE)
    n = re.sub(r"\s+", " ", n).strip()
    return n.strip(" |·-").strip()


def calcular_horas(horas):
    """
    Recibe las horas de la página en orden ('HH:MM') y devuelve [(hora_colombia, time_utc), ...].
    Si la hora baja respecto a la anterior (ej. 23:30 -> 01:00), la página cruzó la medianoche: suma un día.
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
    await page.wait_for_selector("button.ag-toggle", state="attached", timeout=30000)
    await page.wait_for_timeout(1000)


async def procesar_evento(page, titulo):
    canales_evento = []

    evento_li = page.locator("li", has_text=titulo).first
    # click por JS: no depende de que algo tape el botón
    await evento_li.locator("button.ag-toggle").evaluate("el => el.click()")

    canales = evento_li.locator("button, a").filter(has_text="Español")
    try:
        await canales.first.wait_for(state="attached", timeout=3000)
    except Exception:
        return canales_evento  # evento sin canales

    total_canales = await canales.count()
    print(f"  -> {titulo}: {total_canales} canales", flush=True)

    for j in range(total_canales):
        try:
            canal_elem = canales.nth(j)
            nombre_canal = limpiar_nombre(await canal_elem.inner_text())

            if len(nombre_canal) < 3 or "vs" in nombre_canal:
                continue

            # Vaciamos el iframe para detectar con certeza el src del canal que vamos a abrir
            await page.evaluate(BLANK_JS)
            await canal_elem.evaluate("el => el.click()")
            await page.wait_for_function(HAS_SRC_JS, timeout=8000)
            src = await page.evaluate(GET_SRC_JS)

            if src:
                if src.startswith("/"):
                    src = SITE_ROOT + src
                canales_evento.append({"name": nombre_canal, "url": src})
                print(f"     ✅ {nombre_canal}: {src}", flush=True)
            else:
                print(f"     ❌ {nombre_canal}: sin src", flush=True)

        except Exception as e:
            print(f"     ⚠️ Error al abrir canal: {e}", flush=True)

    return canales_evento


async def worker(context, cola, resultados, wid):
    page = await context.new_page()
    page.set_default_timeout(8000)
    try:
        await cargar_agenda(page)
    except Exception as e:
        print(f"[w{wid}] Error cargando página: {e}", flush=True)
        await page.close()
        return

    while True:
        try:
            i, titulo = cola.get_nowait()
        except asyncio.QueueEmpty:
            break
        try:
            resultados[i] = await procesar_evento(page, titulo)
        except Exception as e:
            print(f"  ⚠️ Error con el evento {titulo}: {e}", flush=True)
            resultados[i] = []
            try:
                await cargar_agenda(page)
            except Exception:
                pass

    await page.close()


async def filtrar(route):
    try:
        req = route.request
        if req.resource_type in ("image", "media", "font"):
            await route.abort()
            return
        if BLOQUEAR_IFRAMES and req.frame.parent_frame is not None:
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
        page.set_default_timeout(8000)

        print("🌐 Abriendo pirlotvapp...", flush=True)
        try:
            await cargar_agenda(page)
            await page.wait_for_timeout(1500)
        except Exception as e:
            print(f"Error cargando página: {e}", flush=True)
            await browser.close()
            return

        # 1. TÍTULOS Y HORAS de todos los eventos de una sola pasada
        datos = [d for d in await page.evaluate(LISTA_JS) if d["titulo"]]
        await page.close()
        print(f"Se encontraron {len(datos)} eventos.", flush=True)

        horas = calcular_horas([d["hora"] for d in datos])

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
        "fuente": "pirlotvapp.pro-playwright",
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
