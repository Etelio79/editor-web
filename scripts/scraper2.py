import json

def main():
    print("Iniciando Scraper 2...")
    
    # Este es un ejemplo de datos, luego pondremos el tuyo real
    datos = {
        "fuente": "Scraper 2 de prueba",
        "eventos": ["Partido de prueba A vs B"]
    }
    
    # Guardamos el archivo eventos.json
    with open("eventos.json", "w", encoding="utf-8") as archivo:
        json.dump(datos, archivo, ensure_ascii=False, indent=2)
        
    print("¡Listo! Archivo eventos.json creado.")

if __name__ == "__main__":
    main()
