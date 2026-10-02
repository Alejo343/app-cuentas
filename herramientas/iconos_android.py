"""Genera los íconos y la pantalla de carga de Android a partir del diseño de la app.

Uso:  python herramientas/iconos_android.py
"""
import glob
import os

from PIL import Image, ImageDraw, ImageFont

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RES = os.path.join(RAIZ, 'android', 'app', 'src', 'main', 'res')
COLOR = '#c2255c'
FUENTE = 'C:/Windows/Fonts/arialbd.ttf'


def bolsa(lado, escala_dibujo=1.0, fondo=COLOR, redondo=False):
    """Bolsa blanca con $ (el mismo dibujo que icons/icon.svg)."""
    s = 4  # sobremuestreo para bordes suaves
    S = lado * s
    im = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    if fondo:
        if redondo:
            d.ellipse([0, 0, S - 1, S - 1], fill=fondo)
        else:
            d.rectangle([0, 0, S, S], fill=fondo)
    # El dibujo original vive en un lienzo de 512; se escala y centra
    k = S / 512 * escala_dibujo
    off = (S - 512 * k) / 2
    t = lambda v: off + v * k
    d.arc([t(196), t(88), t(316), t(208)], 180, 360, fill='white', width=max(1, round(28 * k)))
    d.rounded_rectangle([t(136), t(150), t(376), t(400)], radius=28 * k, fill='white')
    f = ImageFont.truetype(FUENTE, max(1, round(170 * k)))
    d.text((t(256), t(285)), '$', font=f, fill=COLOR, anchor='mm')
    return im.resize((lado, lado), Image.LANCZOS)


DENSIDADES = {'mdpi': 1, 'hdpi': 1.5, 'xhdpi': 2, 'xxhdpi': 3, 'xxxhdpi': 4}

for nombre, f in DENSIDADES.items():
    carpeta = os.path.join(RES, f'mipmap-{nombre}')
    os.makedirs(carpeta, exist_ok=True)
    bolsa(round(48 * f), 1.15).save(os.path.join(carpeta, 'ic_launcher.png'))
    bolsa(round(48 * f), 1.0, redondo=True).save(os.path.join(carpeta, 'ic_launcher_round.png'))
    # Ícono adaptable: 108 dp, el dibujo debe quedar dentro de la zona segura (66 dp)
    bolsa(round(108 * f), 0.75, fondo=None).save(os.path.join(carpeta, 'ic_launcher_foreground.png'))

with open(os.path.join(RES, 'values', 'ic_launcher_background.xml'), 'w', encoding='utf-8') as fh:
    fh.write(f'<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">{COLOR}</color>\n</resources>\n')

# Pantallas de carga: mismo tamaño que las de la plantilla, color de la app y la bolsa al centro
for ruta in glob.glob(os.path.join(RES, 'drawable*', 'splash.png')):
    with Image.open(ruta) as viejo:
        ancho, alto = viejo.size
    lienzo = Image.new('RGB', (ancho, alto), COLOR)
    lado = round(min(ancho, alto) * 0.4)
    icono = bolsa(lado, 1.0, fondo=None)
    lienzo.paste(icono, ((ancho - lado) // 2, (alto - lado) // 2), icono)
    lienzo.save(ruta)

print('Íconos y pantallas de carga generados.')
