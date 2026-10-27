import asyncio
import json
import re
from datetime import datetime, timedelta, timezone
from urllib.parse import urljoin

from playwright.async_api import async_playwright

URL = "https://futbollibres.ad/"
OUTPUT_FILE = "eventos2.json"

# Esta página YA muestra las horas en hora de Colombia (UTC-5), así que no se corrigen.
PAGE_UTC_OFFSET = -5
# Zona horaria en la que van las horas en el JSON (Colombia = UTC-5)
OUT_UTC_OFFSET = -5

# Pestañas trabajando en paralelo
N_WORKERS = 4
# No cargar el contenido de los iframes (solo necesitamos su src). Acelera mucho.
BLOQUEAR_IFRAMES = True

# Marca cada fila de evento con data-sc-idx (el índice evita problemas con eventos repetidos,
# por ejemplo dos filas "Bochum vs Mainz 05") y devuelve su texto.
EVENTOS_JS = """
() => {
    document.querySelectorAll('[data-sc-idx]').forEach(e => e.removeAttribute('data-sc-idx'));
    const vis = e => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
    const esFila = e => {
        const t = (e.innerText || '').trim();
        return /^\\d{1,2}:\\d{2}/.test(t) && /\\bvs\\b/i.test(t);
    };
    let filas = [...document.querySelectorAll('li, tr, div, a, button')].filter(e => vis(e) && esFila(e));
    // nos quedamos con el elemento más interno de cada fila
    filas = filas.filter(r => !filas.some(o => o !== r && r.contains(o)));
    filas.forEach((r, i) => r.setAttribute('data-sc-idx', i));
    return filas.map((r, i) => ({ idx: i, texto: r.innerText }));
}
"""

# Devuelve los canales visibles del evento idx (acordeón abierto) y los marca con data-sc-ch.
CANALES_JS = """
(idx) => {
    const row = document.querySelector(`[data-sc-idx="${idx}"]`);
    if (!row) return [];
    document.querySelectorAll('[data-sc-ch]').forEach(e => e.removeAttribute('data-sc-ch'));
    const vis = e => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
    const esEvento = e => {
        const t = (e.innerText || '').trim();
        return /^\\d{1,2}:\\d{2}/.test(t) && /\\bvs\\b/i.test(t);
    };
    const CLICK = 'a[href], button, [onclick]';
    // 1) canales dentro de la fila
    let found = [...row.querySelectorAll(CLICK)];
    // 2) si no hay, canales en los hermanos siguientes (hasta la próxima fila de evento)
    if (!found.length) {
        let s = row.nextElementSibling;
        while (s && !s.hasAttribute('data-sc-idx') && !s.querySelector('[data-sc-idx]')) {
            if (s.matches(CLICK)) found.push(s);
            else {
                const inner = [...s.querySelectorAll(CLICK)];
                if (inner.length) found.push(...inner); else found.push(s);
            }
            s = s.nextElementSibling;
        }
    }
    found = found.filter(e => vis(e) && !esEvento(e) && (e.innerText || '').trim().length > 1);
    return found.map((e, k) => {
        e.setAttribute('data-sc-ch', k);
        let href = '';
        if (e.tagName === 'A') {
            const h = e.getAttribute('href') || '';
            if (h && !h.startsWith('#') && !h.toLowerCase().startsWith('javascript')) href = e.href;
        }
        return { k, texto: e.innerText, href };
    });
}
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


def parse_hora(texto):
    """'12:30pm' -> '12:30', '1:00pm' -> '13:00', '12:00am' -> '00:00' (también acepta 24h)."""
    m = re.search(r"(\d{1,2}):(\d{2})\s*([ap])?\.?\s*m?", texto, flags=re.IGNORECASE)
    if not m:
        return ""
    h, mi, ap = int(m.group(1)), int(m.group(2)), (m.group(3) or "").lower()
    if ap:
        h = h % 12 + (12 if ap == "p" else 0)
    return f"{h:02d}:{mi:02d}"


def parse_evento(texto):
    """Del texto de la fila saca (titulo, hora_24h)."""
    lineas = [l.strip() for l in texto.splitlines() if l.strip()]
    hora = parse_hora(lineas[0]) if lineas else ""
    titulo = ""
    for l in lineas:
        if re.search(r"\bvs\b", l, flags=re.IGNORECASE):
            titulo = re.sub(r"^\s*\d{1,2}:\d{2}\s*[ap]?\.?\s*m?\.?\s*", "", l, flags=re.IGNORECASE).strip()
            break
    return titulo, hora


def limpiar_nombre(texto):
    """Quita flechitas, la calidad ('Calidad 720p') y la palabra 'Español'. Deja la opción si viene (| opc3, | OP2...)."""
    n = re.sub(r"[▶►▸➤]", " ", texto).replace("\n", " ")
    n = re.sub(r"Calidad\s*\d+\s*p?", "", n, flags=re.IGNORECASE)
    n = re.sub(r"Espa\S{1,2}ol", "", n, flags=re.IGNORECASE)
    n = re.sub(r"\s+", " ", n).strip()
    return n.strip(" |·-").strip()


def calcular_horas(horas):
    """
    Recibe las horas de la página en orden ('HH:MM') y devuelve [(hora_salida, time_utc), ...].
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
    """Abre la agenda y marca las filas de evento. Devuelve la lista de filas."""
    await page.goto(URL, wait_until="domcontentloaded", timeout=60000)
    await page.wait_for_function(
        "() => /\\d{1,2}:\\d{2}\\s*[ap]?m?[\\s\\S]*\\bvs\\b/i.test(document.body.innerText)",
        timeout=30000,
    )
    await page.wait_for_timeout(1000)
    return await page.evaluate(EVENTOS_JS)


async def obtener_canales(page, idx):
    return await page.evaluate(CANALES_JS, idx)


async def abrir_acordeon(page, idx):
    """Abre el acordeón del evento idx (si no está ya abierto) y devuelve sus canales."""
    chs = await obtener_canales(page, idx)
    if chs:
        return chs  # ya estaba abierto: un click lo cerraría

    fila = page.locator(f'[data-sc-idx="{idx}"]')
    try:
        await fila.click(timeout=3000, force=True)
    except Exception:
        pass
    await page.wait_for_timeout(300)
    chs = await obtener_canales(page, idx)
    if chs:
        return chs

    # Plan B: click por JS sobre el primer elemento clicable de la fila (o la fila)
    await fila.evaluate("el => (el.querySelector('a, button, [onclick]') || el).click()")
    await page.wait_for_timeout(300)
    return await obtener_canales(page, idx)


async def leer_src(p):
    """Espera el iframe en la página del canal y devuelve su src absoluto."""
    await p.wait_for_function(HAS_SRC_JS, timeout=8000)
    src = await p.evaluate(GET_SRC_JS)
    return urljoin(p.url, src) if src else ""


async def src_desde_url(context, url):
    """Abre la página del canal en una pestaña nueva y saca el src del iframe."""
    p = await context.new_page()
    p.set_default_timeout(8000)
    try:
        await p.goto(url, wait_until="domcontentloaded", timeout=20000, referer=URL)
        return await leer_src(p)
    finally:
        await p.close()


async def src_desde_click(context, page, idx, k):
    """
    El canal no es un enlace directo: se hace click y se lee el iframe de la página que abre
    (pestaña nueva o navegación en la misma pestaña).
    Devuelve (src, recargo) — recargo=True si hubo que volver a cargar la agenda.
    """
    url_antes = page.url
    el = page.locator(f'[data-sc-ch="{k}"]')
    try:
        async with context.expect_page(timeout=3000) as info:
            await el.click(timeout=3000, force=True)
        nueva = await info.value
        try:
            await nueva.wait_for_load_state("domcontentloaded", timeout=15000)
            return await leer_src(nueva), False
        finally:
            await nueva.close()
    except Exception:
        pass

    await page.wait_for_timeout(500)
    if page.url != url_antes:
        try:
            src = await leer_src(page)
        except Exception:
            src = ""
        await cargar_agenda(page)  # volver a la agenda
        return src, True
    return "", False


async def procesar_evento(context, page, idx, titulo):
    canales_evento = []

    chs = await abrir_acordeon(page, idx)
    if not chs:
        return canales_evento  # evento sin canales

    print(f"  -> {titulo}: {len(chs)} canales", flush=True)

    j = 0
    while j < len(chs):
        c = chs[j]
        j += 1
        try:
            nombre_canal = limpiar_nombre(c["texto"])
            if len(nombre_canal) < 3 or re.search(r"\bvs\b", nombre_canal, flags=re.IGNORECASE):
                continue

            if c["href"]:
                src = await src_desde_url(context, c["href"])
                recargo = False
            else:
                src, recargo = await src_desde_click(context, page, idx, c["k"])

            if recargo:
                # la agenda se recargó: hay que reabrir el acordeón y re-marcar los canales
                chs = await abrir_acordeon(page, idx)

            if src:
                canales_evento.append({"name": nombre_canal, "url": src})
                print(f"     ✅ {nombre_canal}: {src}", flush=True)
            else:
                print(f"     ❌ {nombre_canal}: sin src", flush=True)

        except Exception as e:
            print(f"     ⚠️ Error al abrir canal: {e}", flush=True)

    return canales_evento


async def worker(context, cola, resultados, titulos, wid):
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
            i = cola.get_nowait()
        except asyncio.QueueEmpty:
            break
        try:
            resultados[i] = await procesar_evento(context, page, i, titulos[i])
        except Exception as e:
            print(f"  ⚠️ Error con el evento {titulos[i]}: {e}", flush=True)
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

        print("🌐 Abriendo futbollibres.ad...", flush=True)
        try:
            filas = await cargar_agenda(page)
            await page.wait_for_timeout(1500)
        except Exception as e:
            print(f"Error cargando página: {e}", flush=True)
            await browser.close()
            return
        await page.close()

        # 1. TÍTULOS Y HORAS de todos los eventos de una sola pasada
        datos = []
        for f in filas:
            titulo, hora = parse_evento(f["texto"])
            if titulo:
                datos.append({"idx": f["idx"], "titulo": titulo, "hora": hora})
        print(f"Se encontraron {len(datos)} eventos.", flush=True)

        horas = calcular_horas([d["hora"] for d in datos])

        # 2. CANALES en paralelo (se identifica cada evento por su índice en la página)
        titulos = {d["idx"]: d["titulo"] for d in datos}
        cola = asyncio.Queue()
        for d in datos:
            cola.put_nowait(d["idx"])
        resultados = {}
        n = max(1, min(N_WORKERS, len(datos)))
        await asyncio.gather(*(worker(context, cola, resultados, titulos, w + 1) for w in range(n)))

        await browser.close()

    events = []
    for pos, d in enumerate(datos):
        hora, time_utc = horas[pos]
        events.append(construir_evento(d["titulo"], hora, time_utc, resultados.get(d["idx"], [])))

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
