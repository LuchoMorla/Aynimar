#!/usr/bin/env python3
"""Montaje de material de proveedor (vídeos/fotos de Dropi) + clips ya pagados o genéricos → MP4 9:16 1080x1920
listo para Reels/TikTok, con QA de movimiento.

Uso: python3 scripts/supplier-clip-edit.py guion.json salida.mp4 [--musica bed.wav] [--min-real 0.6] [--keep]

guion.json (rutas relativas al propio guion; tiempos en segundos del montaje):
{
  "voz": "locucion.wav",                         # obligatoria; marca la duración
  "musica": "bed.mp3",                           # opcional (se repite en bucle y se agacha bajo la voz)
  "planos": [                                    # cada plano dura hasta el "en" del siguiente
    {"clip": "proveedor.mp4", "en": 0.0, "desde": 1.2, "vel": 1.0, "x": 0.5, "y": 0.5},
    {"clip": "kling_A.mp4", "en": 2.4, "encajar": true},
    {"clip": "foto_proveedor.jpg", "en": 4.0}
  ],                                             # desde = segundo dentro del clip; vel < 1 = cámara lenta;
                                                 # x/y = posición del recorte 9:16 (0 izq/arriba … 1 der/abajo);
                                                 # encajar = clip entero sobre fondo desenfocado (cuadrado/horizontal);
                                                 # foto (.jpg/.png/.webp) = plano fijo encajado, SIN zoom (cuenta como estático)
  "subtitulos": [{"ini": 0.2, "fin": 2.0, "texto": "¿Tu gato toma agua del {inodoro}?"}],  # {x} = amarillo
  "cta": {"texto": "Pídelo en {aynimar.com}", "dur": 2.5, "cola": 1.0}  # cola = s extra tras la voz
}
Hace: recorte/escala a 1080x1920@30, cortes secos, subtítulos ASS quemados (Lato Black, zona segura),
voz con EQ/compresión, música con ducking, loudness a −14 LUFS (2 pasadas, TP −1,5) y CTA final.
Después ejecuta scripts/motion-qa.py: si FALLA, deja el archivo pero sale con código 1 ("NO APTA").
ffmpeg: FFMPEG_PATH (como integrations/videoService.js) o "ffmpeg" del PATH; necesita libass y libx264.
Requiere python3 con opencv (cv2) y numpy para el QA.
"""
import argparse, importlib.util, json, os, re, subprocess, sys, tempfile, wave

HERE = os.path.dirname(os.path.abspath(__file__))
FONTS = os.path.join(HERE, '..', 'assets', 'fonts')   # Lato Black (OFL), la misma del motor de vídeo
FF = os.environ.get('FFMPEG_PATH') or 'ffmpeg'
W, H, FPS = 1080, 1920, 30
LUFS, TP = -14.0, -1.5
IMG_EXT = ('.jpg', '.jpeg', '.png', '.webp')
WHITE, YELLOW, GREEN = '&HFFFFFF&', '&H3CC9FF&', '&H2A3516&'


def ff(args, label):
    r = subprocess.run([FF, '-hide_banner', '-nostdin'] + args, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f'{label}: {r.stderr[-1500:]}')
    return r.stderr


def wav_duration(path):
    with wave.open(path) as w:
        return w.getnframes() / w.getframerate()


def ts(s):
    s = max(0.0, s)
    return f'{int(s // 3600)}:{int(s % 3600 // 60):02d}:{s % 60:05.2f}'


def ass_text(t, base=WHITE):
    """Texto del guion → ASS: sin llaves/barras sueltas; {palabra} en amarillo."""
    t = t.replace('\\', '/').replace('\n', ' ')
    t = re.sub(r'\{([^{}]*)\}', lambda m: '\x00' + m.group(1) + '\x01', t).replace('{', '(').replace('}', ')')
    return t.replace('\x00', '{\\1c' + YELLOW + '}').replace('\x01', '{\\1c' + base + '}')


def build_ass(subs, cta, total):
    ev = [f'Dialogue: 5,{ts(s["ini"])},{ts(s["fin"])},Sub,,0,0,0,,'
          f'{{\\fscx85\\fscy85\\t(0,90,\\fscx100\\fscy100)}}{ass_text(s["texto"])}' for s in subs]
    if cta:
        a = max(0.0, total - float(cta.get('dur', 2.5)))
        ev.append(f'Dialogue: 6,{ts(a)},{ts(total)},Cta,,0,0,0,,{{\\an5\\pos(480,1250)\\fscx70\\fscy70'
                  f'\\t(0,160,\\fscx100\\fscy100)\\t(600,900,\\fscx107\\fscy107)\\t(900,1200,\\fscx100\\fscy100)}}'
                  f'{ass_text(cta["texto"])}')
    # Zona segura 9:16: texto centrado en x∈[60,900] (libre la columna de botones) y por encima del 22 % inferior.
    return f"""[Script Info]
ScriptType: v4.00+
PlayResX: {W}
PlayResY: {H}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Sub,Lato Black,88,{WHITE},{WHITE},&H101010&,&H90000000&,0,0,0,0,100,100,0,0,1,8,5,2,60,180,420,1
Style: Cta,Lato Black,78,{WHITE},{WHITE},{GREEN},&H50000000&,0,0,0,0,100,100,0,0,3,26,6,5,60,180,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
""" + '\n'.join(ev) + '\n'


def load_guion(path, musica):
    base = os.path.dirname(os.path.abspath(path))
    with open(path, encoding='utf8') as f:
        g = json.load(f)
    rel = lambda p: p if os.path.isabs(p) else os.path.join(base, p)
    if not g.get('voz') or not g.get('planos'):
        raise ValueError('el guion necesita "voz" y al menos un "planos"')
    g['voz'] = rel(g['voz'])
    g['musica'] = musica or (rel(g['musica']) if g.get('musica') else None)
    for p in [g['voz']] + ([g['musica']] if g['musica'] else []) + [rel(x['clip']) for x in g['planos']]:
        if not os.path.isfile(p):
            raise ValueError(f'no existe: {p}')
    ens = [float(p.get('en', 0)) for p in g['planos']]
    if ens[0] != 0 or any(b <= a for a, b in zip(ens, ens[1:])):
        raise ValueError('"en" de los planos debe empezar en 0 y ser creciente')
    for p in g['planos']:
        p['clip'] = rel(p['clip'])
        if float(p.get('vel', 1)) <= 0 or not 0 <= float(p.get('x', .5)) <= 1 or not 0 <= float(p.get('y', .5)) <= 1:
            raise ValueError(f'plano inválido: {p}')
    for s in g.get('subtitulos', []):
        if not (0 <= float(s['ini']) < float(s['fin'])) or not str(s.get('texto', '')).strip():
            raise ValueError(f'subtítulo inválido: {s}')
    return g


def clip_duration(path):
    """Duración del clip según ffmpeg (sin ffprobe)."""
    err = subprocess.run([FF, '-hide_banner', '-i', path], capture_output=True, text=True).stderr
    m = re.search(r'Duration: (\d+):(\d+):([\d.]+)', err)
    if not m:
        raise ValueError(f'no se pudo leer la duración de {path}')
    return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))


def render(g, out, work):
    cta = g.get('cta')
    total = round(wav_duration(g['voz']) + float((cta or {}).get('cola', 1.0)), 3)
    planos = g['planos']
    ens = [float(p.get('en', 0)) for p in planos] + [total]
    if ens[-2] >= total:
        raise ValueError(f'el último plano empieza ({ens[-2]}s) después del final ({total}s)')
    avisos, args, fg = [], ['-y', '-loglevel', 'error'], []
    for i, p in enumerate(planos):
        dur, vel, desde = ens[i + 1] - ens[i], float(p.get('vel', 1)), float(p.get('desde', 0))
        need = dur * vel
        x, y = float(p.get('x', .5)), float(p.get('y', .5))
        if p['clip'].lower().endswith(IMG_EXT):
            # Foto del proveedor: plano FIJO (sin Ken Burns, por orden del propietario). El QA la cuenta como estática.
            args += ['-loop', '1', '-framerate', str(FPS), '-t', f'{dur + 0.1:.3f}', '-i', p['clip']]
            avisos.append(f'plano {i}: foto fija ({dur:.2f}s) — cuenta como estático en el QA')
            src = f'[{i}:v]'
        else:
            if desde + need > clip_duration(p['clip']) + 0.05:
                avisos.append(f'plano {i}: el clip se queda corto ({desde + need:.2f}s pedidos); se congela el final')
            args += ['-ss', f'{desde:.3f}', '-t', f'{need + 0.1:.3f}', '-i', p['clip']]   # busca en entrada: no decodifica lo previo
            src = f'[{i}:v]setpts=(PTS-STARTPTS)/{vel},'
        tail = (f'fps={FPS},tpad=stop_mode=clone:stop_duration={dur:.3f},trim=duration={dur:.3f},'
                f'setpts=N/{FPS}/TB,setsar=1,format=yuv420p[v{i}]')
        if p.get('encajar', p['clip'].lower().endswith(IMG_EXT)):
            # Material cuadrado/horizontal del proveedor: entero sobre su propia versión desenfocada (no se pierde el producto).
            fg.append(f'{src}split[a{i}][b{i}]')
            fg.append(f'[a{i}]scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},gblur=sigma=40,'
                      f'eq=brightness=-0.08:saturation=0.8[bg{i}]')
            fg.append(f'[b{i}]scale={W}:{H}:force_original_aspect_ratio=decrease:flags=lanczos[fg{i}]')
            fg.append(f'[bg{i}][fg{i}]overlay=(W-w)/2:(H-h)/2-80,{tail}')
        else:
            fg.append(f'{src}scale={W}:{H}:force_original_aspect_ratio=increase:flags=lanczos,'
                      f'crop={W}:{H}:(iw-{W})*{x}:(ih-{H})*{y},{tail}')
    n = len(planos)
    ass = os.path.join(work, 'subs.ass')
    with open(ass, 'w', encoding='utf8') as f:
        f.write(build_ass(g.get('subtitulos', []), cta, total))
    esc = lambda s: s.replace('\\', '\\\\').replace(':', '\\:').replace("'", "\\'")
    fg.append(''.join(f'[v{i}]' for i in range(n)) + f'concat=n={n}:v=1:a=0,'
              f'subtitles=filename={esc(ass)}:fontsdir={esc(os.path.abspath(FONTS))}[v]')
    args += ['-i', g['voz']]
    iv = n
    fg.append(f'[{iv}:a]aresample=48000,aformat=channel_layouts=mono,highpass=f=70,'
              f'equalizer=f=3000:t=q:w=1.2:g=2,acompressor=threshold=-20dB:ratio=3:attack=6:release=120:makeup=2,'
              f'apad=whole_dur={total:.3f},asplit=2[vo][vsc]')
    if g['musica']:
        args += ['-stream_loop', '-1', '-i', g['musica']]
        fg.append(f'[{iv + 1}:a]aresample=48000,aformat=channel_layouts=mono,atrim=duration={total:.3f},volume=-16dB,'
                  f'afade=t=out:st={max(0, total - 1):.3f}:d=1[bed0]')
        fg.append('[bed0][vsc]sidechaincompress=threshold=0.03:ratio=6:attack=20:release=300[bed]')
        fg.append('[vo][bed]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.89,aformat=channel_layouts=stereo[a]')
    else:
        fg.append('[vsc]anullsink')
        fg.append('[vo]alimiter=limit=0.89,aformat=channel_layouts=stereo[a]')
    pre = os.path.join(work, 'pre.mp4')
    ff(args + ['-filter_complex', ';'.join(fg), '-map', '[v]', '-map', '[a]', '-t', f'{total:.3f}', '-r', str(FPS),
               '-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
               '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', pre], 'render')
    # Loudness EBU R128 en dos pasadas (la 1.ª mide, la 2.ª corrige en modo lineal).
    j = _loud(ff(['-i', pre, '-af', f'loudnorm=I={LUFS}:TP={TP}:LRA=11:print_format=json', '-f', 'null', '-'], 'medida'))
    ff(['-y', '-loglevel', 'info', '-i', pre, '-c:v', 'copy', '-af',
        f"loudnorm=I={LUFS}:TP={TP}:LRA=11:measured_I={j['input_i']}:measured_TP={j['input_tp']}"
        f":measured_LRA={j['input_lra']}:measured_thresh={j['input_thresh']}:offset={j['target_offset']}"
        f':linear=true,aresample=48000', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
        '-movflags', '+faststart', out], 'loudnorm')
    final = _loud(ff(['-i', out, '-af', f'loudnorm=I={LUFS}:TP={TP}:print_format=json', '-f', 'null', '-'], 'verificación'))
    return {'duracion_s': total, 'planos': n, 'subtitulos': len(g.get('subtitulos', [])),
            'lufs': float(final['input_i']), 'true_peak_db': float(final['input_tp']), 'avisos': avisos}


def _loud(stderr):
    return json.loads(re.search(r'\{[^{}]*"input_i"[^{}]*\}', stderr).group(0))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('guion')
    ap.add_argument('salida')
    ap.add_argument('--musica', help='pista de música (sustituye a la del guion)')
    ap.add_argument('--min-real', type=float, default=0.6, help='umbral del QA de movimiento (0-1)')
    ap.add_argument('--keep', action='store_true', help='conserva los intermedios en <salida>_work/')
    a = ap.parse_args()
    out = os.path.abspath(a.salida)
    try:
        g = load_guion(a.guion, a.musica)
        if a.keep:
            work = out[:-4] + '_work'
            os.makedirs(work, exist_ok=True)
            info = render(g, out, work)
        else:
            with tempfile.TemporaryDirectory(prefix='clip-edit-') as work:
                info = render(g, out, work)
        spec = importlib.util.spec_from_file_location('motion_qa', os.path.join(HERE, 'motion-qa.py'))
        mq = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mq)
        qa = mq.analyze(out, min_real=a.min_real)
    except (ValueError, RuntimeError, OSError) as e:
        print(json.dumps({'error': str(e)}, ensure_ascii=False))
        sys.exit(2)
    qa.pop('pares', None)
    with open(out[:-4] + '.qa.json', 'w', encoding='utf8') as f:
        json.dump(qa, f, ensure_ascii=False, indent=1)
    if abs(info['lufs'] - LUFS) > 1.0:
        info['avisos'].append(f'loudness final {info["lufs"]} LUFS (objetivo {LUFS})')
    apta = qa['veredicto'] == 'PASA'
    print(json.dumps(dict(salida=out, **info, qa={k: qa[k] for k in ('pct_movimiento_real', 'tramos_estaticos',
                     'planos_detectados', 'veredicto')}, estado='APTA' if apta else 'NO APTA'),
                     ensure_ascii=False, indent=1))
    sys.exit(0 if apta else 1)


if __name__ == '__main__':
    main()
