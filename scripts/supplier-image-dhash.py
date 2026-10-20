#!/usr/bin/env python3
"""dHash de 64 bits (hex de 16) para imágenes LOCALES, para supplier_candidates.

Herramienta offline y opcional: el backend no tiene librería de imagen, así que el
hash se calcula aquí y se pasa en el export (storeImageHash / items[].imageHash).
No descarga nada ni llama a servicios: las imágenes se bajan aparte.
Requiere Pillow (si no está, la imagen queda «sin_comparar»).

Uso: python3 -I scripts/supplier-image-dhash.py <imagen> [<imagen> ...]
Salida: <hash>\t<ruta> por línea.
"""
import sys

from PIL import Image


def dhash(path):
    img = Image.open(path).convert('L').resize((9, 8), Image.LANCZOS)
    px = list(img.getdata())
    bits = 0
    for row in range(8):
        for col in range(8):
            bits = (bits << 1) | (px[row * 9 + col] > px[row * 9 + col + 1])
    return f'{bits:016x}'


if __name__ == '__main__':
    for p in sys.argv[1:]:
        print(f'{dhash(p)}\t{p}')
