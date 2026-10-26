import asyncio
import json
import re
from datetime import datetime, timedelta, timezone
from playwright.async_api import async_playwright

URL = "https://pirlotvapp.pro/"
SITE_ROOT = "https://pirlotvapp.pro"
OUTPUT_FILE = "eventos.json"
# Zona horaria de las horas que muestra la página (UTC-6 = México, como en tu eventos.json)
UTC_OFFSET_HORAS = -6

def construir_evento(titulo, hora, canales):
    """Convierte el título 'Liga: A vs B' + hora + canales al formato de eventos.json"""
    if ": " in titulo:
        liga, partido = titulo.split(": ", 1)
    else:
        liga, partido = "", titulo

    time_utc = ""
    if hora:
        try:
            h, m = map(int, hora.split(":"))
            tz = timezone(timedelta(hours=UTC_OFFSET_HORAS))
            hoy = datetime.now(tz).replace(hour=h, minute=m, second=0, microsecond=0)
            time_utc = hoy.astimezone(timezone.utc).isoformat()
            hora = f"{h:02d}:{m:02d}"
        except Exception:
            pass

    return {
        "time": hora,
        "time_utc": time_utc,
        "match": partido.strip(),
        "league": liga.strip(),
        "flag": "⚽",
        "channels": canales,
    }

async def main():
    events = []
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(
            user_agent=("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                        "AppleWebKit/537.36 (KHTML, like Gecko) "
                        "Chrome/120.0.0.0 Safari/537.36"),
            viewport={"width": 1280, "height": 900},
        )
        page = await context.new_page()
        page.set_default_timeout(8000)

        print("🌐 Abriendo pirlotvapp...", flush=True)
        try:
            await page.goto(URL, wait_until="domcontentloaded", timeout=60000)
        except Exception as e:
            print(f"Error cargando página: {e}", flush=True)
            await browser.close()
            return

        await page.wait_for_timeout(5000)

        # 1. OBTENER LISTA DE TÍTULOS (Evita errores si la página se actualiza)
        botones_eventos = page.locator("button.ag-toggle")
        total_eventos = await botones_eventos.count()
        print(f"Se encontraron {total_eventos} eventos.", flush=True)

        titulos_eventos = []
        for i in range(total_eventos):
            try:
                texto = await botones_eventos.nth(i).locator("span.font-semibold").inner_text()
                titulos_eventos.append(texto.strip())
            except:
                pass

        for i, titulo in enumerate(titulos_eventos):
            print(f"\n[{i+1}/{len(titulos_eventos)}] Abriendo evento: {titulo}", flush=True)
            
            try:
                # Buscamos el evento exacto por su título
                evento_li = page.locator("li", has_text=titulo).first
                
                # Hora del evento (si la página la muestra dentro del <li>)
                texto_li = await evento_li.inner_text()
                m_hora = re.search(r"\b(\d{1,2}:\d{2})\b", texto_li)
                hora_evento = m_hora.group(1) if m_hora else ""

                # Hacemos clic en el acordeón
                await evento_li.locator("button.ag-toggle").click()
                await page.wait_for_timeout(2500)

                canales_evento = []

                # 2. BUSCAR CANALES (Solo dentro de este evento)
                # Buscamos los botones que estén dentro de este <li>
                canales = evento_li.locator("button, a").filter(has_text="Español")
                total_canales = await canales.count()
                print(f"  -> Canales encontrados en este evento: {total_canales}", flush=True)

                for j in range(total_canales):
                    try:
                        canal_elem = canales.nth(j)
                        
                        # 3. LIMPIAR EL NOMBRE DEL CANAL (Quitar la flechita ▶)
                        nombre_canal = await canal_elem.inner_text()
                        nombre_canal = nombre_canal.replace("▶", "").strip().replace("\n", " ")
                        
                        if len(nombre_canal) < 3 or "vs" in nombre_canal: 
                            continue

                        print(f"     -> Abriendo canal: {nombre_canal}", flush=True)
                        
                        await canal_elem.click(force=True) 
                        await page.wait_for_timeout(4000)

                        # 4. EXTRAER Y COMPLETAR LA URL
                        iframe = page.locator("iframe").first
                        if await iframe.count() > 0:
                            src = await iframe.get_attribute("src")
                            if src:
                                # Si el enlace empieza con "/", le agregamos el dominio
                                if src.startswith("/"):
                                    src = SITE_ROOT + src
                                canales_evento.append({"name": nombre_canal, "url": src})
                                print(f"     ✅ {src}", flush=True)
                        else:
                            print("     ❌ No se encontró iframe", flush=True)

                        # 5. CERRAR EL MODAL A LA FUERZA
                        # Intentamos con Escape
                        await page.keyboard.press("Escape") 
                        await page.wait_for_timeout(1000)
                        
                        # Si el iframe sigue ahí, significa que el modal no se cerró.
                        # Buscamos el botón de la "X" y le damos clic.
                        if await page.locator("iframe").count() > 0:
                            try:
                                # Buscamos cualquier botón que diga "×", "X" o tenga la clase close
                                cerrar = page.locator("button", has_text="×").or_(page.locator("button", has_text="X")).or_(page.locator(".close-btn")).first
                                await cerrar.click(timeout=3000)
                            except:
                                # Si de plano no encuentra cómo cerrar, recarga la página (a prueba de balas)
                                print("     (Forzando recarga para cerrar modal)", flush=True)
                                await page.goto(URL, wait_until="domcontentloaded", timeout=60000)
                                await page.wait_for_timeout(3000)
                                await page.locator("li", has_text=titulo).first.locator("button.ag-toggle").click()
                                await page.wait_for_timeout(2000)

                    except Exception as e:
                        print(f"     ⚠️ Error al abrir canal: {e}", flush=True)

                events.append(construir_evento(titulo, hora_evento, canales_evento))

                # Al terminar con los canales, cerramos el acordeón (si no se recargó la página)
                if await page.locator("iframe").count() == 0:
                    await evento_li.locator("button.ag-toggle").click()
                    await page.wait_for_timeout(1000)

            except Exception as e:
                print(f"  ⚠️ Error con el evento: {e}", flush=True)

        await browser.close()

    ahora = datetime.now(timezone.utc)
    salida = {
        "actualizado_en": ahora.isoformat(),
        "fecha": ahora.astimezone(timezone(timedelta(hours=UTC_OFFSET_HORAS))).strftime("%Y-%m-%d"),
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
