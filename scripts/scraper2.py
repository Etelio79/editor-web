import asyncio
import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urljoin

from playwright.async_api import TimeoutError as PWTimeout, async_playwright

SITE_URL = "http://rojadirecta.tel/"
OUTPUT_FILE = "eventos.json"
NAV_TIMEOUT_MS = 20_000
MOBILE_UA = (
    "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"
)

# =========================================================
# UTILIDADES
# =========================================================

def normalize_time(time_text):
    if not time_text:
        return None
    m = re.match(r"^(\d{2}):(\d{2})", str(time_text).strip())
    return f"{m.group(1)}:{m.group(2)}" if m else None

def time_mexico_to_utc(time_str):
    if not time_str:
        return None
    m = re.match(r"^(\d{2}):(\d{2})$", time_str)
    if not m:
        return None
    hour = int(m.group(1)) + 6  # Convertir de UTC-6 a UTC
    minute = int(m.group(2))
    day_offset = 0
    if hour >= 24:
        hour -= 24
        day_offset = 1
    now = datetime.now(timezone.utc)
    base = now.replace(hour=0, minute=0, second=0, microsecond=0)
    return (base + timedelta(days=day_offset, hours=hour, minutes=minute)).isoformat()

def split_league_match(raw_title):
    text = re.sub(r"\s+", " ", str(raw_title or "")).strip()

    parts = [p.strip() for p in text.split(":")]
    if len(parts) >= 2:
        league = parts[0]
        match = ": ".join(parts[1:]).strip()
        league_re = re.compile(rf"^{re.escape(league)}[:\s-]+", re.IGNORECASE)
        match = league_re.sub("", match).strip()
        if league and match:
            return league, match

    for sep in ("–", "—", " - "):
        idx = text.find(sep)
        if idx > -1:
            league = text[:idx].strip()
            match = text[idx + len(sep):].strip()
            league_re = re.compile(rf"^{re.escape(league)}[:\s-]+", re.IGNORECASE)
            match = league_re.sub("", match).strip()
            if league and match and re.search(r"\bvs\.?\b", match, re.IGNORECASE):
                return league, match

    return "", text

def clean_channel_name(name, index):
    if not name:
        return f"Canal {index + 1}"
    value = re.sub(r"\s+", " ", str(name)).strip()
    return value or f"Canal {index + 1}"

# =========================================================
# EXTRACTOR DE IFRAME
# =========================================================
async def get_iframe_src(context, channel_url):
    if not channel_url:
        return None
    page = await context.new_page()
    try:
        await page.goto(channel_url, wait_until="domcontentloaded", timeout=15000)
        try:
            await page.wait_for_selector("iframe", timeout=8000)
            src = await page.eval_on_selector("iframe", "el => el && el.src")
        except PWTimeout:
            src = None
        await page.close()
        return src or channel_url
    except Exception:
        print(f"   [!] No se pudo extraer iframe de: {channel_url}")
        await page.close()
        return channel_url

# =========================================================
# SCRAPER PRINCIPAL
# =========================================================
async def scrape_rojadirecta():
    print("========================================")
    print("Iniciando scraper para rojadirecta.tel")
    print("========================================")

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
        )
        context = await browser.new_context(
            user_agent=MOBILE_UA,
            viewport={"width": 390, "height": 844},
            is_mobile=True
        )

        async def _route(route):
            if route.request.resource_type in ("image", "font", "media"):
                await route.abort()
            else:
                await route.continue_()

        page = await context.new_page()
        await page.route("**/*", _route)

        print("[PY] Cargando página...")
        await page.goto(SITE_URL, wait_until="networkidle", timeout=60000)
        print("[PY] Página cargada")

        await asyncio.sleep(4)

        print("[PY] Extrayendo datos del DOM...")

        # FIX 1: la liga ("Premier League:") es texto suelto FUERA del <a>,
        # antes del enlace. Con un Range tomamos todo el texto que hay desde
        # el inicio de la fila hasta el enlace y se lo anteponemos al título.
        # FIX 2: la hora ya no se busca por selector (.t / span), sino por
        # regex hh:mm subiendo por los ancestros del enlace hasta hallar una
        # fila que contenga UNA sola hora. Así no depende de la estructura.
        raw_rows = await page.evaluate(r"""
            () => {
                const results = [];
                const timeRe = /\b\d{2}:\d{2}\b/;
                const timeReG = /\b\d{2}:\d{2}\b/g;
                const isVsLink = (a) => !!a && /\bvs\b/i.test(a.textContent || '');

                // Todos los nodos de texto visibles, en orden de documento
                const nodes = [];
                const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
                while (walker.nextNode()) {
                    const n = walker.currentNode;
                    const tag = n.parentElement ? n.parentElement.tagName : '';
                    if (['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(tag)) continue;
                    if (!n.textContent.trim()) continue;
                    nodes.push(n);
                }

                const links = Array.from(document.querySelectorAll('a'));
                for (const a of links) {
                    if (!isVsLink(a)) continue;
                    const href = a.getAttribute('href');
                    if (!href) continue;

                    let first = -1, last = -1;
                    for (let i = 0; i < nodes.length; i++) {
                        if (a.contains(nodes[i])) {
                            if (first === -1) first = i;
                            last = i;
                        }
                    }
                    if (first === -1) continue;

                    // Hora: primer texto con hh:mm DESPUES del enlace
                    // (si antes aparece otro enlace de partido, esta fila no tiene hora)
                    let timeText = '';
                    for (let j = last + 1; j < Math.min(nodes.length, last + 15); j++) {
                        const other = nodes[j].parentElement.closest('a');
                        if (other && other !== a && isVsLink(other)) break;
                        const m = nodes[j].textContent.match(timeRe);
                        if (m) { timeText = m[0]; break; }
                    }
                    if (!timeText) continue;

                    // Liga: texto inmediatamente ANTES del enlace (termina en ':')
                    let prefix = '';
                    for (let j = first - 1; j >= Math.max(0, first - 3); j--) {
                        const other = nodes[j].parentElement.closest('a');
                        if (other && isVsLink(other)) break;
                        const t = nodes[j].textContent.replace(timeReG, '').replace(/\s+/g, ' ').trim();
                        if (!t) continue;
                        if (t.endsWith(':') && t.length < 60) prefix = t;
                        break;
                    }

                    const text = a.textContent.replace(/\s+/g, ' ').trim();
                    results.push({ timeText, titleText: prefix ? prefix + text : text, href });
                }
                return results;
            }
        """)

        # Diagnóstico: compara enlaces con 'vs' contra filas detectadas
        vs_links = await page.locator("a:has-text('vs')").count()
        print(f"[DEBUG] enlaces con 'vs': {vs_links} | filas detectadas: {len(raw_rows)}")
        if len(raw_rows) < vs_links:
            sample = await page.evaluate(r"""
                () => {
                    const a = Array.from(document.querySelectorAll('a'))
                        .find(x => /\bvs\b/i.test(x.textContent || ''));
                    if (!a) return '';
                    const box = a.parentElement && a.parentElement.parentElement
                        ? a.parentElement.parentElement : a.parentElement;
                    return box ? box.outerHTML.slice(0, 900) : '';
                }
            """)
            print("[DEBUG] muestra HTML:", sample)
            html = await page.content()
            Path("debug.html").write_text(html, encoding="utf-8")
            print(f"[DEBUG] título: {await page.title()} | html: {len(html)} chars")

        print(f"[PY] {len(raw_rows)} filas de canales detectadas. Agrupando eventos...")

        events_map = {}

        for raw in raw_rows:
            time_str = normalize_time(raw["timeText"])
            if not time_str:
                continue

            league, match = split_league_match(raw["titleText"])
            key = f"{time_str}|{match}"

            if key not in events_map:
                events_map[key] = {
                    "time": time_str,
                    "time_utc": time_mexico_to_utc(time_str),
                    "match": match or "",
                    "league": league or "",
                    "flag": "⚽",
                    "channels": []
                }
            elif league and not events_map[key]["league"]:
                events_map[key]["league"] = league

            event = events_map[key]

            parts = [p for p in raw["href"].split('/') if p]
            channel_slug = parts[-1] if parts else f"Canal {len(event['channels']) + 1}"

            if not any(c["originalUrl"] == raw["href"] for c in event["channels"]):
                event["channels"].append({"originalUrl": raw["href"], "name": channel_slug})

        events = []

        for event in events_map.values():
            resolved_channels = []
            seen_channels = set()

            for i, ch in enumerate(event["channels"]):
                absolute_url = urljoin(SITE_URL, ch["originalUrl"])
                final_url = await get_iframe_src(context, absolute_url)

                if not final_url or final_url in seen_channels:
                    continue
                seen_channels.add(final_url)

                resolved_channels.append({
                    "name": clean_channel_name(ch["name"], i),
                    "url": final_url
                })

            event["channels"] = resolved_channels

            print(f"-- {event['time'] or '--:--'} | {event['league'] + ': ' if event['league'] else ''}{event['match']} -> {len(event['channels'])} canales")
            events.append(event)

        events.sort(key=lambda x: str(x["time"]))

        result = {
            "actualizado_en": datetime.now(timezone.utc).isoformat(),
            "fecha": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
            "fuente": "rojadirecta.tel-playwright",
            "contar": len(events),
            "contar_con_canales": sum(1 for e in events if e["channels"]),
            "events": events,
            "eventos": events,
        }

        Path(OUTPUT_FILE).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")

        print("========================================")
        print(f"[PY] Total: {result['contar']}")
        print(f"[PY] Con canales: {result['contar_con_canales']}")
        print("========================================")

        await browser.close()

        print(f"LISTO | rojadirecta.tel-playwright | total:{result['contar']} | canales:{result['contar_con_canales']}")

if __name__ == "__main__":
    asyncio.run(scrape_rojadirecta())
