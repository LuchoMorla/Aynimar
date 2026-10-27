#!/usr/bin/env python3
"""Prueba mínima de scripts/motion-qa.py con vídeos sintéticos (sin ffmpeg ni archivos externos).

  - "fotos": dos imágenes fijas con zoom + pan (Ken Burns) y un rótulo fijo encima, con un corte → FALLA, 2 planos.
  - "accion": la misma foto con zoom y un objeto texturizado que se desplaza y gira → PASA.
Opcional: MOTION_QA_FALLA=v82_b.mp4 MOTION_QA_PASA=v82_d.mp4 añade esas comprobaciones con vídeos reales.
Opcional: FFMPEG_PATH=/ruta/ffmpeg prueba además scripts/supplier-clip-edit.py de punta a punta
(clip sintético con movimiento + foto fija + voz → APTA, 1080x1920, −14 LUFS ±1).
Uso: python3 scripts/motion-qa-test.py   (requiere opencv-python y numpy)
"""
import importlib.util, json, os, subprocess, sys, tempfile

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('motion_qa', os.path.join(HERE, 'motion-qa.py'))
mq = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mq)

W, H, FPS = 360, 640, 30


def texture(seed, h, w):
    rng = np.random.default_rng(seed)
    img = cv2.GaussianBlur(rng.integers(0, 255, (h, w, 3), dtype=np.uint8), (0, 0), 3)
    for _ in range(25):  # formas nítidas para que haya bordes y puntos que seguir
        x, y = int(rng.integers(0, w)), int(rng.integers(0, h))
        cv2.rectangle(img, (x, y), (x + int(rng.integers(10, 60)), y + int(rng.integers(10, 60))),
                      tuple(int(c) for c in rng.integers(0, 255, 3)), -1)
    return img


def write(path, frames):
    vw = cv2.VideoWriter(path, cv2.VideoWriter_fourcc(*'mp4v'), FPS, (W, H))
    assert vw.isOpened(), 'VideoWriter mp4v no disponible'
    for f in frames:
        vw.write(f)
    vw.release()


def kenburns(img, i, n):
    z = 1 + 0.15 * i / n
    M = cv2.getRotationMatrix2D((W / 2 + 20 * i / n, H / 2), 0, z)
    return cv2.warpAffine(img, M, (W, H), borderMode=cv2.BORDER_REFLECT)


def caption(f):
    cv2.putText(f, 'PRECIO $29.99', (40, 560), cv2.FONT_HERSHEY_SIMPLEX, 1.2, (255, 255, 255), 4)
    return f


def main():
    with tempfile.TemporaryDirectory(prefix='mqa-') as tmp:
        run(tmp)
    print('OK motion-qa')


def run(tmp):
    n = int(1.5 * FPS)
    a, b = texture(1, H, W), texture(2, H, W)
    fotos = [caption(kenburns(a, i, n)) for i in range(n)] + [caption(kenburns(b, n - i, n)) for i in range(n)]
    write(os.path.join(tmp, 'fotos.mp4'), fotos)

    obj = texture(3, 120, 120)
    accion = []
    for i in range(2 * n):
        f = kenburns(a, i, 2 * n)
        R = cv2.getRotationMatrix2D((60, 60), 6 * i, 1.0)  # el objeto gira y cruza el plano
        o = cv2.warpAffine(obj, R, (120, 120), borderMode=cv2.BORDER_REFLECT)
        x, y = 20 + 2 * i, 200 + int(60 * np.sin(i / 8))
        f[y:y + 120, x:x + 120] = o
        accion.append(caption(f))
    write(os.path.join(tmp, 'accion.mp4'), accion)

    r = mq.analyze(os.path.join(tmp, 'fotos.mp4'))
    print('fotos :', r['veredicto'], r['pct_movimiento_real'], '% planos', r['planos_detectados'])
    assert r['veredicto'] == 'FALLA' and r['pct_movimiento_real'] < 20, r
    assert r['planos_detectados'] == 2, r['cortes_s']
    r = mq.analyze(os.path.join(tmp, 'accion.mp4'))
    print('accion:', r['veredicto'], r['pct_movimiento_real'], '%')
    assert r['veredicto'] == 'PASA' and r['pct_movimiento_real'] > 80, r

    for env, want in (('MOTION_QA_FALLA', 'FALLA'), ('MOTION_QA_PASA', 'PASA')):
        if os.environ.get(env):
            r = mq.analyze(os.environ[env])
            print(f'{env}:', r['veredicto'], r['pct_movimiento_real'], '%')
            assert r['veredicto'] == want, r['veredicto']

    ffm = os.environ.get('FFMPEG_PATH')
    if ffm and os.path.isfile(ffm):
        gen = lambda *a: subprocess.run([ffm, '-v', 'error', '-y', *a], check=True)
        gen('-f', 'lavfi', '-i', 'testsrc2=s=720x1280:r=30:d=4', '-pix_fmt', 'yuv420p', os.path.join(tmp, 'prov.mp4'))
        gen('-f', 'lavfi', '-i', 'sine=f=160:d=3.2:r=48000', '-ac', '1', os.path.join(tmp, 'voz.wav'))
        cv2.imwrite(os.path.join(tmp, 'foto.jpg'), texture(4, 800, 800))
        with open(os.path.join(tmp, 'guion.json'), 'w', encoding='utf8') as f:
            json.dump({'voz': 'voz.wav', 'planos': [{'clip': 'prov.mp4', 'en': 0}, {'clip': 'foto.jpg', 'en': 3.2}],
                       'subtitulos': [{'ini': 0.1, 'fin': 2.0, 'texto': 'Prueba {amarilla}'}],
                       'cta': {'texto': 'Pídelo en {aynimar.com}', 'dur': 1.5, 'cola': 0.8}}, f)
        p = subprocess.run([sys.executable, os.path.join(HERE, 'supplier-clip-edit.py'), os.path.join(tmp, 'guion.json'),
                            os.path.join(tmp, 'out.mp4')], capture_output=True, text=True)
        assert p.returncode == 0, p.stdout + p.stderr
        r = json.loads(p.stdout)
        cap = cv2.VideoCapture(os.path.join(tmp, 'out.mp4'))
        size = (int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)))
        print('montaje:', r['estado'], size, r['lufs'], 'LUFS', r['qa']['pct_movimiento_real'], '%')
        assert size == (1080, 1920) and abs(r['lufs'] + 14) <= 1 and r['estado'] == 'APTA', r


if __name__ == '__main__':
    sys.exit(main())
