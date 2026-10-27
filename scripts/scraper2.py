import asyncio
import base64
import json
import re
import sys
from datetime import datetime, timedelta, timezone
from urllib.parse import urljoin, urlparse, parse_qs
from playwright.async_api import async_playwright

URL = "https://futbollibres.ad/"
SITE_ROOT = "https://futbollibres.ad"
OUTPUT_FILE = "eventos2.json"

# Zona horaria en la que la PÁGINA muestra las horas.
# futbollibres.ad muestra la agenda en hora de Colombia (UTC-5) -> si cambia, ajusta aquí.
PAGE_UTC_OFFSET = -5
# Zona horaria en la que quieres las horas en el JSON (Colombia = UTC-5)
OUT_UTC_OFFSET = -5

# Pestañas trabajando en paralelo (para abrir las páginas de los canales)
N_WORKERS = 4
# No cargar el contenido de los iframes (solo necesitamos su src). Acelera mucho.
BLOQUEAR_IFRAMES = True

# Cada fila de la agenda = un evento. Si la página usa otras etiquetas, cámbialo aquí.
EVENT_SELECTOR = "li, tr"

# python scraper1.py --debug  -> guarda HTML de la agenda y del primer canal para depurar
DEBUG = "--debug" in sys.argv

# Devuelve [{titulo, hora}] y marca cada fila con data-sc=<índice> (así los eventos
# repetidos, como "Bochum vs Mainz 05" dos veces, no se confunden).
LISTA_JS = """
(sel) => {
    const reHora = /^\\s*(\\d{1,2}:\\d{2}\\s*(?:[ap]\\.?\\s*m\\.?)?)/i;
    const out = [];
    let n = 0;
    document.querySelectorAll(sel).forEach(el => {
        const txt = (el.innerText || '').trim();
        const m = txt.match(reHora);
        if (!m) return;
        // si dentro hay otra fila con hora, este es un contenedor, no un evento
        const contenedor = [...el.querySelectorAll(sel)].some(d => reHora.test(d.innerText || ''));
        if (contenedor) return;
        const lineas = txt.split('\\n').map(s => s.trim()).filter(Boolean);
        let resto = lineas[0].slice(m[0].length).trim();
        if (!resto || resto.length < 4) resto = lineas[1] || '';
        if (!resto) return;
        el.setAttribute('data-sc', String(n++));
        out.push({ titulo: resto, hora: m[1].trim() });
    });
    return out;
}
"""

# Abre el acordeón del evento i
CLICK_JS = """
(i) => {
    const li = document.querySelector(`[data-sc="${i}"]`);
    if (!li || !li.firstElementChild) return false;
    const head = li.firstElementChild;
    const t = head.matches('a, button') ? head : (head.querySelector('a, button') || head);
    t.click();
    return true;
}
"""

# Lee los canales (nombre + enlace) del acordeón del evento i
CANALES_JS = """
(i) => {
    const li = document.querySelector(`[data-sc="${i}"]`);
    if (!li) return [];
    const head = li.firstElementChild;
    const vistos = new Set();
    const out = [];
    li.querySelectorAll('a[href], [data-href], [data-url]').forEach(el => {
        if (el === head || (head && head.contains(el))) return;
        let href = el.getAttribute('data-href') || el.getAttribute('data-url') || el.getAttribute('href') || '';
        const raw = (el.innerText || '').trim();
        if (!raw) return;
        if (!href || href === '#' || href.startsWith('javascript')) { href = ''; }
        else { try { href = new URL(href, location.href).href; } catch (e) { href = ''; } }
        const key = raw + '|' + href;
        if (vistos.has(key)) return;
        vistos.add(key);
        out.push({ raw, href });
    });
    return out;
}
"""

HAS_SRC_JS = """
() => [...document.querySelectorAll('iframe')].some(f => {
    const s = f.getAttribute('src') || f.getAttribute('data-src');
    return s && s !== 'about:blank';
})
"""
GET_SRC_JS = """
() => {
    const f = [...document.querySelectorAll('iframe')]
        .map(x => x.getAttribute('src') || x.getAttribute('data-src') || '')
        .filter(s => s && s !== 'about:blank');
    return f.length ? f[0] : '';
}
"""


def limpiar_nombre(texto):
    """Quita la flechita, la calidad ('Calidad 720p') y la palabra 'Español'."""
    n = texto.replace("▶", " ").replace("►", " ").replace("\n", " ")
    n = re.sub(r"Calidad\s*\d+\s*p?", "", n, flags=re.IGNORECASE)
    n = re.sub(r"Espa\S{1,2}ol", "", n, flags=re.IGNORECASE)
    n = re.sub(r"\s+", " ", n).strip()
    return n.strip(" |·-").strip()


def hora_24(raw):
    """'12:30pm' -> '12:30', '1:00pm' -> '13:00', '12:00am' -> '00:00'. Si ya viene en 24h la deja igual."""
    m = re.match(r"(\d{1,2}):(\d{2})\s*([ap])?", raw.strip().lower().replace(".", ""))
    if not m:
        return raw
    h, mi, ap = int(m.group(1)), m.group(2), m.group(3)
    if ap == "p" and h < 12:
        h += 12
    elif ap == "a" and h == 12:
        h = 0
    return f"{h:02d}:{mi}"


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


def src_desde_url(href):
    """Plan B: algunos enlaces llevan la URL del player en base64 en un parámetro (?r=...)."""
    try:
        for vals in parse_qs(urlparse(href).query).values():
            for v in vals:
                try:
                    dec = base64.b64decode(v + "=" * (-len(v) % 4)).decode("utf-8")
                except Exception:
                    continue
                if dec.startswith("http"):
                    return dec
    except Exception:
        pass
    return ""


async def cargar_agenda(page):
    await page.goto(URL, wait_until="domcontentloaded", timeout=60000)
    await page.wait_for_function(
        """(sel) => [...document.querySelectorAll(sel)].some(e => /^\\s*\\d{1,2}:\\d{2}/.test(e.innerText || ''))""",
        arg=EVENT_SELECTOR, timeout=30000)
    await page.wait_for_timeout(1000)


async def extraer_canales_evento(page, i, titulo):
    """Abre el acordeón del evento i y devuelve [{'name', 'href'}]."""
    try:
        await page.evaluate(CLICK_JS, i)
    except Exception as e:
        print(f"  ⚠️ No pude abrir el evento {titulo}: {e}", flush=True)
        return []

    crudos = []
    for _ in range(4):  # el acordeón puede tardar un momento
        await page.wait_for_timeout(250)
        crudos = await page.evaluate(CANALES_JS, i)
        if crudos:
            break

    canales = []
    for c in crudos:
        nombre = limpiar_nombre(c["raw"])
        if len(nombre) < 3 or " vs " in nombre.lower():
            continue
        if not c["href"]:
            print(f"     ⚠️ {nombre}: sin enlace (¿se abre por JS?)", flush=True)
            continue
        canales.append({"name": nombre, "href": c["href"]})
    print(f"  -> {titulo}: {len(canales)} canales", flush=True)
    return canales


async def resolver_iframe(context, href):
    """Abre la página del canal y devuelve el src del iframe."""
    page = await context.new_page()
    page.set_default_timeout(8000)
    try:
        await page.goto(href, wait_until="domcontentloaded", timeout=30000)
        try:
            await page.wait_for_function(HAS_SRC_JS, timeout=8000)
        except Exception:
            pass
        src = await page.evaluate(GET_SRC_JS)
        if not src:
            src = src_desde_url(href)
            if DEBUG and not src:
                with open("debug_canal.html", "w", encoding="utf-8") as f:
                    f.write(await page.content())
        if src:
            src = urljoin(page.url, src)
        return src
    except Exception as e:
        print(f"     ⚠️ Error abriendo {href}: {e}", flush=True)
        return ""
    finally:
        await page.close()


async def worker(context, cola, cache, wid):
    while True:
        try:
            href = cola.get_nowait()
        except asyncio.QueueEmpty:
            break
        src = await resolver_iframe(context, href)
        cache[href] = src
        print(f"     {'✅' if src else '❌'} {href} -> {src or 'sin src'}", flush=True)


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
            # Si la página pinta la hora con JS, la pinta en hora de Colombia
            timezone_id="America/Bogota",
            locale="es-CO",
        )
        await context.route("**/*", filtrar)

        page = await context.new_page()
        page.set_default_timeout(8000)

        print("🌐 Abriendo futbollibres.ad...", flush=True)
        try:
            await cargar_agenda(page)
            await page.wait_for_timeout(1500)
        except Exception as e:
            print(f"Error cargando página: {e}", flush=True)
            if DEBUG:
                with open("debug_agenda.html", "w", encoding="utf-8") as f:
                    f.write(await page.content())
            await browser.close()
            return

        # 1. TÍTULOS Y HORAS de todos los eventos de una sola pasada
        datos = [d for d in await page.evaluate(LISTA_JS, EVENT_SELECTOR) if d["titulo"]]
        print(f"Se encontraron {len(datos)} eventos.", flush=True)
        if DEBUG or not datos:
            with open("debug_agenda.html", "w", encoding="utf-8") as f:
                f.write(await page.content())

        horas = calcular_horas([hora_24(d["hora"]) for d in datos])

        # 2. CANALES de cada evento (abre el acordeón y lee los enlaces)
        canales_por_evento = {}
        for i, d in enumerate(datos):
            canales_por_evento[i] = await extraer_canales_evento(page, i, d["titulo"])
            if DEBUG and i == 0:
                html = await page.evaluate("(i) => document.querySelector(`[data-sc=\"${i}\"]`).outerHTML", 0)
                with open("debug_evento.html", "w", encoding="utf-8") as f:
                    f.write(html)
        await page.close()

        # 3. IFRAME de cada canal (página del canal) en paralelo, sin repetir enlaces
        cola = asyncio.Queue()
        for href in dict.fromkeys(c["href"] for cs in canales_por_evento.values() for c in cs):
            cola.put_nowait(href)
        cache = {}
        n = max(1, min(N_WORKERS, cola.qsize()))
        await asyncio.gather(*(worker(context, cola, cache, w + 1) for w in range(n)))

        await browser.close()

    events = []
    for i, d in enumerate(datos):
        hora, time_utc = horas[i]
        canales = [{"name": c["name"], "url": cache[c["href"]]}
                   for c in canales_por_evento.get(i, []) if cache.get(c["href"])]
        events.append(construir_evento(d["titulo"], hora, time_utc, canales))

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
