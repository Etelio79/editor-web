import asyncio
import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urljoin

from playwright.async_api import TimeoutError as PWTimeout, async_playwright

SITE_URL = "https://futbollibremx.mx/"
OUTPUT_FILE = "eventos.json"
MAX_CONCURRENT_PAGES = 4
NAV_TIMEOUT_MS = 20_000
MOBILE_UA = (
    "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"
)

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
    hour = int(m.group(1)) + 6
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
        if idx == -1:
            continue
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

async def get_iframe_src(context, channel_url, sem):
    if not channel_url:
        return None
    async with sem:
        page = await context.new_page()
        try:
            await page.goto(channel_url, wait_until="domcontentloaded", timeout=NAV_TIMEOUT_MS)
            try:
                await page.wait_for_selector("iframe", timeout=8_000)
                src = await page.eval_on_selector("iframe", "el => el && el.src")
            except PWTimeout:
                src = None
            return src or channel_url
        except Exception:
            print(f"   [!] No se pudo extraer iframe de: {channel_url}")
            return channel_url
        finally:
            await page.close()

async def scrape():
    print("Iniciando scraper futbollibremx.mx...")
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, args=["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"])
        context = await browser.new_context(user_agent=MOBILE_UA, viewport={"width": 390, "height": 844}, is_mobile=True)

        async def _route(route):
            if route.request.resource_type in ("image", "font", "media"):
                await route.abort()
            else:
                await route.continue_()

        page = await context.new_page()
        await page.route("**/*", _route)
        await page.goto(SITE_URL, wait_until="networkidle", timeout=60_000)

        try:
            await page.wait_for_selector("#menu-agenda", timeout=15_000)
        except PWTimeout:
            print("[WARN] #menu-agenda no apareció a tiempo")
        await asyncio.sleep(3)

        raw_events = await page.evaluate("""
            () => {
                const menu = document.querySelector('#menu-agenda');
                if (!menu) return [];
                return Array.from(menu.children).map(li => {
                    const mainLink = li.querySelector('a');
                    if (!mainLink) return null;
                    const timeSpan = mainLink.querySelector('.t');
                    const timeText = timeSpan ? timeSpan.textContent.trim() : '';
                    const clone = mainLink.cloneNode(true);
                    const t = clone.querySelector('.t');
                    if (t) t.remove();
                    const titleText = clone.textContent.trim();
                    const leagueText = li.className || '';
                    const channels = [];
                    const subUl = li.querySelector('ul');
                    if (subUl) {
                        subUl.querySelectorAll('li.subitem1').forEach(subLi => {
                            const a = subLi.querySelector('a');
                            if (!a) return;
                            const name = a.textContent.replace(/\\s*HD\\s*$/i, '').trim();
                            const href = a.getAttribute('href');
                            if (name && href) channels.push({ name, href });
                        });
                    }
                    return { timeText, titleText, leagueText, channels };
                }).filter(e => e && e.titleText);
            }
        """)

        sem = asyncio.Semaphore(MAX_CONCURRENT_PAGES)
        events = []

        for raw in raw_events:
            time_str = normalize_time(raw["timeText"])
            league, match = split_league_match(raw["titleText"])

            channel_tasks = []
            for i, ch in enumerate(raw["channels"]):
                abs_url = urljoin(SITE_URL, ch["href"])
                channel_tasks.append((i, ch, asyncio.create_task(get_iframe_src(context, abs_url, sem))))

            channels, seen = [], set()
            for i, ch, task in channel_tasks:
                final_url = await task
                if not final_url or final_url in seen:
                    continue
                seen.add(final_url)
                channels.append({"name": clean_channel_name(ch["name"], i), "url": final_url})

            events.append({
                "time": time_str or "",
                "time_utc": time_mexico_to_utc(time_str),
                "match": match or "",
                "league": league or "",
                "flag": "⚽",
                "channels": channels,
            })

        events.sort(key=lambda e: str(e["time"]))
        unique_events, seen_keys = [], set()
        for ev in events:
            key = f"{ev['time']}|{ev['match']}"
            if key in seen_keys:
                continue
            seen_keys.add(key)
            unique_events.append(ev)

        result = {
            "actualizado_en": datetime.now(timezone.utc).isoformat(),
            "fecha": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
            "fuente": "futbollibremx.mx-playwright",
            "contar": len(unique_events),
            "contar_con_canales": sum(1 for e in unique_events if e["channels"]),
            "events": unique_events,
            "eventos": unique_events,
        }

        Path(OUTPUT_FILE).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"¡Listo! Se guardaron {len(unique_events)} eventos en eventos.json")
        await browser.close()

if __name__ == "__main__":
    asyncio.run(scrape())
