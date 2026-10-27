#!/usr/bin/env python3
"""QA de movimiento real: ¿hay acción en el plano o es una foto fija con zoom/pan (Ken Burns)?

Método, por pares de fotogramas separados --gap s, en gris con el lado mayor a 640 px:
  1. Transformación global (afín: zoom, pan, giro, temblor de mano) con puntos Lucas-Kanade + RANSAC,
     refinada con ECC (subpíxel). Se repite una vez con los puntos que no encajan (segunda capa: tarjeta
     con su propio Ken Burns sobre fondo desenfocado, típico de los vídeos de fotos).
  2. Residuo por píxel = mínimo entre |actual - anterior sin mover| (rótulos fijos encima) y
     |actual - anterior compensado| por cada capa. Una foto con zoom/pan queda en ~0; la acción real no.
  3. Bloques de una rejilla 16x28 con ≥ 10 % de píxeles con residuo > --pix-thr. "Área" del par =
     fracción de bloques activos. Si casi todo cambia (> 80 %) es un corte o fundido: se excluye
     (junto con el par anterior y el siguiente).
  4. Mediana móvil de ~1 s sobre el área (un rótulo que aparece un instante no cuenta) y par "real" si ≥ --area.
Salida JSON: % de duración con movimiento real, planos (cortes), tramos estáticos y PASA/FALLA.

Uso: python3 scripts/motion-qa.py video.mp4 [--min-real 0.6] [--out qa.json]
  --min-real 0.6  pieza montada (por defecto): ≥ 60 % de la duración con acción real.
  --min-real 0.25 cribado de material bruto del proveedor (vídeos reales suelen traer colas quietas;
                  una foto con zoom da < 10 %).
Código de salida: 0 PASA, 1 FALLA, 2 error. Requiere python3 con opencv (cv2) y numpy (no van en npm).
"""
import argparse, json, sys

import cv2
import numpy as np

LONG = 640             # lado mayor de análisis (px): 360x640 en 9:16, 640x360 en 16:9
GRID = (16, 28)        # bloques (lado corto, lado largo)
MARGIN = 0.05          # borde ignorado (entra/sale imagen al hacer pan)
DISP = 0.75           # px de desplazamiento aparente mínimo (ver pair_area)
CUT_AREA = 0.8         # área por encima de esto = corte/fundido (la acción real medida no pasa de ~0,7)
ECC_CRIT = (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 40, 1e-5)
IDENT = np.float32([[1, 0, 0], [0, 1, 0]])


def _fit(p0, p1, prev, cur):
    """Afín p0→p1 (RANSAC) y su refinado ECC sobre la zona de sus inliers.
    Devuelve ([candidatas], inliers) o (None, None). Se usan las dos: ECC a veces diverge."""
    if len(p0) < 12:
        return None, None
    M, inl = cv2.estimateAffine2D(p0, p1, method=cv2.RANSAC, ransacReprojThreshold=1.0)
    if M is None or inl.sum() < 12:
        return None, None
    M = M.astype(np.float32)
    inl = inl.ravel().astype(bool)
    mask = np.zeros(prev.shape, np.uint8)            # ECC solo dentro de la capa (si no, el fondo lo arrastra)
    cv2.fillConvexPoly(mask, cv2.convexHull(p0[inl]).astype(np.int32), 255)
    try:  # ECC: cur(M·x) ≈ prev(x); misma convención que M
        return [M, cv2.findTransformECC(prev, cur, M.copy(), cv2.MOTION_AFFINE, ECC_CRIT, mask, 1)[1]], inl
    except cv2.error:
        return [M], inl                                # sin convergencia: solo la estimación RANSAC


def pair_area(prev, cur, pix_thr):
    """Fracción de bloques con movimiento no explicable por zoom/pan/rótulos fijos."""
    h, w = cur.shape
    bp, bc = cv2.GaussianBlur(prev, (0, 0), 1.0), cv2.GaussianBlur(cur, (0, 0), 1.0)
    c16 = bc.astype(np.int16)
    res = np.abs(bp.astype(np.int16) - c16)            # hipótesis "nada se mueve" (rótulos fijos)
    pts = cv2.goodFeaturesToTrack(bp, 500, 0.01, 5)
    if pts is not None and len(pts) >= 12:
        nxt, st, _ = cv2.calcOpticalFlowPyrLK(bp, bc, pts, None, winSize=(21, 21), maxLevel=3)
        ok = st.ravel() == 1
        p0, p1 = pts[ok], nxt[ok]
        for _ in range(2):                             # capa principal + una segunda capa
            Ms, inl = _fit(p0, p1, bp, bc)
            if Ms is None:
                break
            for M in Ms:
                warped = cv2.warpAffine(bp, M, (w, h), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
                res = np.minimum(res, np.abs(warped.astype(np.int16) - c16))
            p0, p1 = p0[~inl], p1[~inl]
    # Un borde nítido desalineado 0,3 px ya da residuo alto: se exige además residuo > DISP·gradiente local,
    # es decir, un desplazamiento aparente de más de DISP píxeles (o un cambio de textura real).
    gx, gy = cv2.Sobel(bc, cv2.CV_32F, 1, 0, scale=0.125), cv2.Sobel(bc, cv2.CV_32F, 0, 1, scale=0.125)
    grad = cv2.dilate(cv2.magnitude(gx, gy), np.ones((3, 3), np.uint8))
    m = np.logical_and(res > pix_thr, res > DISP * grad)
    my, mx = int(h * MARGIN), int(w * MARGIN)
    m = m[my:h - my, mx:w - mx]
    cols, rows = GRID if h >= w else GRID[::-1]
    gh, gw = m.shape[0] // rows, m.shape[1] // cols
    blocks = m[:gh * rows, :gw * cols].reshape(rows, gh, cols, gw).mean(axis=(1, 3))
    return float((blocks >= 0.10).mean())


def _ranges(ts, flags, dt):
    """Tramos [ini, fin] (s) donde flags es True; cada muestra cubre (t-dt, t]."""
    out = []
    for t, f in zip(ts, flags):
        if not f:
            continue
        if out and abs(out[-1][1] - (t - dt)) < dt / 2:
            out[-1][1] = round(t, 2)
        else:
            out.append([round(t - dt, 2), round(t, 2)])
    return out


def analyze(path, gap=0.2, pix_thr=5.0, area=0.03, min_real=0.6):
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        raise RuntimeError(f'no se puede abrir {path}')
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    step = max(1, round(gap * fps))
    prev, idx, ts, areas = None, 0, [], []
    while cap.grab():
        if idx % step == 0:
            _, frame = cap.retrieve()
            g = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            k = LONG / max(g.shape)
            g = cv2.resize(g, (round(g.shape[1] * k), round(g.shape[0] * k)), interpolation=cv2.INTER_AREA)
            if prev is not None:
                ts.append(idx / fps)
                areas.append(pair_area(prev, g, pix_thr))
            prev = g
        idx += 1
    cap.release()
    duration = idx / fps
    if len(areas) < 3:
        raise RuntimeError('vídeo demasiado corto o ilegible')
    dt = step / fps
    a = np.array(areas)
    hard = a > CUT_AREA
    cut = hard | np.r_[hard[1:], False] | np.r_[False, hard[:-1]]   # ± 1 par: cola de fundidos/deslizamientos
    k = max(1, round(1.0 / dt)) // 2                   # mediana móvil de ~1 s, sin contar cortes
    smooth = np.array([np.median(a[max(0, i - k):i + k + 1][~cut[max(0, i - k):i + k + 1]])
                       if (~cut[max(0, i - k):i + k + 1]).any() else 0.0 for i in range(len(a))])
    real = (smooth >= area) & ~cut
    valid = int((~cut).sum()) or 1
    pct = real.sum() / valid
    cuts = []                                          # cortes seguidos (fundido) = una transición
    for t, c in zip(ts, hard):
        if c and (not cuts or t - cuts[-1] > dt * 1.6):
            cuts.append(round(t, 2))
    static = _ranges(ts, ~real & ~cut, dt)
    return {
        'archivo': path, 'duracion_s': round(duration, 2), 'fps': round(fps, 2),
        'pct_movimiento_real': round(pct * 100, 1),
        'segundos_con_movimiento_real': round(float(real.sum()) * dt, 2),
        'segundos_estaticos': round(sum(b - a_ for a_, b in static), 2), 'tramos_estaticos': static,
        'planos_detectados': len(cuts) + 1, 'cortes_s': cuts,
        'umbral_min_real_pct': round(min_real * 100, 1),
        'veredicto': 'PASA' if pct >= min_real else 'FALLA',
        'parametros': {'gap_s': gap, 'pix_thr': pix_thr, 'area': area},
        'pares': [[round(t, 2), round(x, 3), round(float(s), 3)] for t, x, s in zip(ts, areas, smooth)],
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('video')
    ap.add_argument('--min-real', type=float, default=0.6, help='fracción mínima de la duración con movimiento real (0-1)')
    ap.add_argument('--gap', type=float, default=0.2, help='segundos entre fotogramas comparados')
    ap.add_argument('--pix-thr', type=float, default=5.0, help='residuo (0-255) para que un píxel "se mueva"')
    ap.add_argument('--area', type=float, default=0.03, help='fracción de bloques activos para que un instante cuente')
    ap.add_argument('--out', help='escribe el JSON también en este archivo')
    ap.add_argument('--sin-pares', action='store_true', help='omite el detalle por par en la salida')
    a = ap.parse_args()
    if not 0 < a.min_real <= 1 or a.gap <= 0:
        ap.error('--min-real debe estar en (0,1] y --gap > 0')
    try:
        r = analyze(a.video, a.gap, a.pix_thr, a.area, a.min_real)
    except Exception as e:  # noqa: BLE001 — CLI: error legible y código 2
        print(json.dumps({'archivo': a.video, 'error': str(e)}, ensure_ascii=False))
        sys.exit(2)
    if a.sin_pares:
        r.pop('pares')
    txt = json.dumps(r, ensure_ascii=False, indent=1)
    if a.out:
        with open(a.out, 'w', encoding='utf8') as f:
            f.write(txt)
    print(txt)
    sys.exit(0 if r['veredicto'] == 'PASA' else 1)


if __name__ == '__main__':
    main()
