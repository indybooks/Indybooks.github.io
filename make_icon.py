#!/usr/bin/env python3
"""
IndyBooks mascot icon — single source of truth.

There is no SVG rasteriser in this environment, so the icon is described once
as a list of circles and rotated ellipses, then emitted twice: as inline SVG
for the header, and rasterised with PIL for the PWA icons. Both renderers
consume the same shape list, so they cannot drift apart.

Drawn from photographs of Indy — a long-coated white dog. What the reference
actually shows, and what this build encodes:

  * The coat is long, straight and silky, hanging in strands that taper to
    points. It is warm cream, not cool white.
  * The ears are curtains of longer, distinctly apricot-tinted hair hanging
    down the sides. The right one hangs lower. They are hair, not the smooth
    rounded flaps of a short-coated breed.
  * Fur sweeps up and back off the brow into a spiky crown.
  * The nose is large, glossy and near-black — the strongest dark accent in
    the face, and the feature that survives longest as the icon shrinks.
  * Warm tan rings the eyes.
  * Mouth open, pink tongue out.

A narrow rotated ellipse tapers to a point at both ends. That was a liability
when these shapes were used for smooth ears; for hair it is exactly right, so
the coat is built from fans of them radiating out of the head.

Colours are lifted from samples of the photographs. The raw values sit low
and desaturated (the reference was shot in warm evening light) so they are
raised for a flat icon while the hue relationships are preserved: warm coat,
clearly darker apricot ears, near-black nose, muted pink tongue.
"""

import math
from PIL import Image, ImageDraw

# --- palette -------------------------------------------------------------
# comments give the raw sampled value each colour was derived from
SKY = '#C3D7EA'         # brand backdrop, unchanged
COAT = '#FFFDF9'        # #DAD4CB  warm white, never pure #FFF
COAT_SHADE = '#F1E7D9'  # #C8BCAF  ivory underlayer, gives the coat depth
EAR = '#DCAF88'         # #9F7E68  apricot ear hair
EAR_DEEP = '#C89A70'    #          shadow inside the long ear
EYE_TAN = '#E8C9A8'     # #65403C  warm ring around the eyes
NOSE = '#20222A'        # #1C191A  near-black, faintly cool to sit with --navy
EYE = '#241F1E'         # #464549
TONGUE = '#E8909A'      # #96545F  lifted to a clean pink
WHITE = '#FFFFFF'


def ellipse(cx, cy, rx, ry, rot=0, fill=COAT, opacity=None):
    d = dict(k='ellipse', cx=round(cx, 2), cy=round(cy, 2),
             rx=round(rx, 2), ry=round(ry, 2), rot=round(rot, 2), fill=fill)
    if opacity is not None:
        d['opacity'] = opacity
    return d


def circle(cx, cy, r, fill=COAT, opacity=None):
    d = dict(k='circle', cx=round(cx, 2), cy=round(cy, 2), r=round(r, 2), fill=fill)
    if opacity is not None:
        d['opacity'] = opacity
    return d


def fan(cx, cy, r0, a_from, a_to, n, length, width, fill, vary=(1.0,)):
    """
    A fan of short tufts radiating out of (cx, cy). Used only for the crown,
    where fur genuinely sweeps outward off the brow.

    Angles are degrees in screen space: 0 right, 90 down, 270 up. Each tuft is
    a narrow ellipse rotated to point along its radius, so the outer end reads
    as a tapered tip. `r0` is kept well inside the head mass, or the tufts
    detach and read as a tiara floating above the dog.

    `vary` cycles length multipliers, because identical tufts read as a gear.
    """
    out = []
    for i in range(n):
        a = a_from + (a_to - a_from) * (i / (n - 1) if n > 1 else 0.5)
        ln = length * vary[i % len(vary)]
        rad = math.radians(a)
        r = r0 + ln / 2
        out.append(ellipse(cx + r * math.cos(rad), cy + r * math.sin(rad),
                           width, ln / 2, a - 90, fill))
    return out


def wobble(n, lo=0.58, hi=1.0, seed=0.0):
    """
    Non-repeating length multipliers.

    A short `vary` tuple cycling over many locks produces a visibly periodic
    hem — the eye reads it as scalloped lace trim. Stepping by the golden
    angle gives a sequence that never repeats over any practical count while
    staying fully deterministic, so the SVG and the PNGs still match.
    """
    return [lo + (hi - lo) * (0.5 + 0.5 * math.sin(seed + i * 2.3999632))
            for i in range(n)]


def _ruff_bottom(x, cx=50, cy=68, rx=28.5, ry=21.0):
    """Lower edge of the ruff ellipse at a given x — where the locks start."""
    t = min(1.0, abs(x - cx) / rx)
    return cy + ry * math.sqrt(max(0.0, 1 - t * t))


def locks(x_from, x_to, n, length, width, fill, overhang=5.0,
          tilt=16.0, vary=(1.0,), y_fn=None):
    """
    A row of long hanging locks across the lower coat.

    This is the difference between a long-coated dog and a poodle. Hair this
    length hangs under its own weight, so the locks are near-vertical and only
    splay outward toward the sides — a radial fan of the same strands reads as
    lace trim around the jaw instead of a silky coat.

    Each lock's tip follows the ruff's own lower edge plus `overhang`, so the
    coat keeps the silhouette's shape instead of flattening it. Roots sit
    inside the white mass and are never seen.
    """
    out = []
    half = (x_to - x_from) / 2 or 1
    mid = (x_to + x_from) / 2
    for i in range(n):
        x = x_from + (x_to - x_from) * (i / (n - 1) if n > 1 else 0.5)
        t = (x - mid) / half
        v = vary[i % len(vary)]
        tip = (y_fn or _ruff_bottom)(x) + overhang * v
        ln = length * v
        # Negative rotation leans a lock's tip away from centre on the right;
        # the sign follows from rotate() being clockwise in screen space.
        out.append(ellipse(x, tip - ln / 2, width, ln / 2, -tilt * t, fill))
    return out


# --- the mark ------------------------------------------------------------
# Built in draw order, back to front.

SHAPES = [circle(50, 50, 50, SKY)]

# Ear curtains: long apricot locks hanging down each side, rooted inside the
# head so their tops are hidden and they read as attached. Apricot is the one
# saturated note in the coat, and it is what makes the ears legible against
# all that white.
# Right ear — the long one, hanging past the jaw.
SHAPES += [
    ellipse(72.0, 53.0, 6.2, 21.0, -6, EAR_DEEP),
    ellipse(77.5, 56.5, 6.8, 23.5, -10, EAR),
    ellipse(82.5, 53.0, 4.2, 17.0, -13, EAR),
]
# Left ear — same hair, stopping higher, so the pair reads as a deliberate
# asymmetry rather than a mistake.
SHAPES += [
    ellipse(27.5, 50.0, 6.0, 17.0, 6, EAR_DEEP),
    ellipse(22.5, 49.0, 6.2, 18.0, 11, EAR),
    ellipse(18.0, 46.0, 3.8, 13.0, 14, EAR),
]

# Ivory underlayer. Wide, soft locks sitting just behind the white ones, so
# the ivory fills the notches between white tips instead of out-reaching them.
# An earlier version overhung by 9 units and the icon grew a row of narrow
# ivory spikes against the sky that read as teeth. Depth, not a second
# silhouette — and no outline, which would only muddy at 40px.
SHAPES += locks(19, 81, 20, 32.0, 3.4, COAT_SHADE, overhang=3.5, tilt=21,
                vary=wobble(20, 0.70, 1.0, seed=0.7))

# Head and ruff: round cranium, wide fluffy ruff below it.
SHAPES += [
    ellipse(50, 49.0, 24.5, 24.0, 0, COAT),
    ellipse(50, 68.0, 28.5, 21.0, 0, COAT),
]

# The coat itself.
SHAPES += locks(20, 80, 21, 30.0, 2.1, COAT, overhang=2.0, tilt=19,
                vary=wobble(21, 0.60, 1.0, seed=2.1))

# Crown: fur sweeping up and back off the brow. Rooted deep inside the head.
SHAPES += fan(50, 49, 15.0, 230, 310, 13, 14.0, 2.2, COAT,
              vary=wobble(13, 0.55, 1.0, seed=1.3))

# Warm rings around the eyes. Subtle on purpose — pushed any further and the
# face reads as an owl.
SHAPES += [
    ellipse(40.5, 46.0, 6.6, 5.6, 0, EYE_TAN, opacity=0.38),
    ellipse(59.5, 46.0, 6.6, 5.6, 0, EYE_TAN, opacity=0.38),
]

# Eyes: large, round, wide-set. The single biggest lever on cuteness.
SHAPES += [
    circle(40.5, 46.0, 5.45, EYE),
    circle(59.5, 46.0, 5.45, EYE),
    circle(38.7, 44.1, 1.95, WHITE),
    circle(57.7, 44.1, 1.95, WHITE),
]

# Nose: deliberately oversized. It is the only near-black mass in the mark and
# the last feature to survive as the icon scales down. The sheen is small and
# bright; at half opacity it turned into a grey smudge.
SHAPES += [
    ellipse(50, 58.5, 6.6, 5.3, 0, NOSE),
    ellipse(47.9, 56.4, 2.1, 0.85, -18, WHITE, opacity=0.5),
]

# Muzzle: beard locks framing an open mouth, tongue out.
SHAPES += [
    ellipse(42.0, 68.0, 3.0, 6.5, 15, COAT),
    ellipse(58.0, 68.0, 3.0, 6.5, -15, COAT),
    ellipse(50, 68.2, 4.3, 3.9, 0, TONGUE),
]


# --- geometry ------------------------------------------------------------

def _ellipse_points(cx, cy, rx, ry, rot=0.0, steps=180):
    """Parametric ellipse, rotated clockwise in screen space (y down)."""
    a = math.radians(rot)
    ca, sa = math.cos(a), math.sin(a)
    pts = []
    for i in range(steps):
        t = 2 * math.pi * i / steps
        ex, ey = rx * math.cos(t), ry * math.sin(t)
        pts.append((cx + ex * ca - ey * sa, cy + ex * sa + ey * ca))
    return pts


# --- SVG emitter ---------------------------------------------------------

def to_svg(size=None, extra_attrs=''):
    attrs = f' width="{size}" height="{size}"' if size else ''
    out = [f'<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"'
           f'{attrs}{extra_attrs}>']
    # Clip to the backdrop so a stray strand tip can never poke outside.
    out.append('  <defs><clipPath id="indy-clip">'
               '<circle cx="50" cy="50" r="50"/></clipPath></defs>')
    out.append('  <g clip-path="url(#indy-clip)">')
    for s in SHAPES:
        op = s.get('opacity')
        op_attr = f' fill-opacity="{op}"' if op is not None else ''
        if s['k'] == 'circle':
            out.append(f'    <circle cx="{s["cx"]}" cy="{s["cy"]}" r="{s["r"]}"'
                       f' fill="{s["fill"]}"{op_attr}/>')
        else:
            rot = s.get('rot', 0)
            tr = f' transform="rotate({rot} {s["cx"]} {s["cy"]})"' if rot else ''
            out.append(f'    <ellipse cx="{s["cx"]}" cy="{s["cy"]}"'
                       f' rx="{s["rx"]}" ry="{s["ry"]}"'
                       f' fill="{s["fill"]}"{op_attr}{tr}/>')
    out.append('  </g>')
    out.append('</svg>')
    return '\n'.join(out)


# --- PIL renderer --------------------------------------------------------

SS = 2048  # supersample, then downscale for clean edges


def render(size, maskable=False):
    img = Image.new('RGBA', (SS, SS), (0, 0, 0, 0))

    if maskable:
        # Maskable icons get cropped, sometimes to a circle, so the art is
        # inset into the 80% safe zone over a solid brand field.
        ImageDraw.Draw(img).rectangle([0, 0, SS, SS], fill='#2B4C6D')
        inset, scale = 10.0, 0.80
    else:
        inset, scale = 0.0, 1.0

    u = SS / 100.0

    def tx(x, y):
        return ((inset + x * scale) * u, (inset + y * scale) * u)

    for s in SHAPES:
        # Semi-transparent shapes need their own layer, or the alpha would
        # composite against whatever was drawn beneath instead of blending.
        op = s.get('opacity')
        target = img if op is None else Image.new('RGBA', (SS, SS), (0, 0, 0, 0))
        d = ImageDraw.Draw(target)

        if s['k'] == 'circle':
            pts = _ellipse_points(s['cx'], s['cy'], s['r'], s['r'])
        else:
            pts = _ellipse_points(s['cx'], s['cy'], s['rx'], s['ry'], s.get('rot', 0))

        d.polygon([tx(x, y) for x, y in pts], fill=s['fill'])

        if op is not None:
            alpha = target.getchannel('A').point(lambda v: int(v * op))
            target.putalpha(alpha)
            img = Image.alpha_composite(img, target)

    # Matches the SVG clipPath above.
    if not maskable:
        mask = Image.new('L', (SS, SS), 0)
        ImageDraw.Draw(mask).ellipse([0, 0, SS - 1, SS - 1], fill=255)
        img.putalpha(Image.composite(img.getchannel('A'),
                                     Image.new('L', (SS, SS), 0), mask))

    return img.resize((size, size), Image.LANCZOS)


if __name__ == '__main__':
    render(192).save('icon-192.png')
    render(512).save('icon-512.png')
    render(512, maskable=True).save('icon-maskable-512.png')
    render(1024).save('preview-1024.png')
    render(40).save('preview-40.png')      # header size: the legibility test
    with open('icon.svg', 'w') as f:
        f.write(to_svg() + '\n')
    print(f'wrote icons + icon.svg ({len(SHAPES)} shapes)')
