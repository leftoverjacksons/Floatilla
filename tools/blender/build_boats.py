"""
Floatilla — Blender builds of every boat type except the sloop (see build_sloop.py).

    blender -b --python tools/blender/build_boats.py -- public/models [previewDir] [kind ...]

Writes public/models/<kind>.glb for: raft rowboat skiff fishing tug yacht houseboat barge schooner raider.
"""
import sys, os, math, random
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fl_common import Build, Hull

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT_DIR = argv[0] if argv else 'public/models'
PREV_DIR = argv[1] if len(argv) > 1 and argv[1] != '-' else None
ONLY = set(argv[2:])


def base_mats(b, topsides=(0.86, 0.84, 0.78), boot=(0.04, 0.09, 0.2), antifoul=(0.3, 0.08, 0.06), cove=None, deck='teak', double_top=False):
    b.mat('topsides', 'Topsides', topsides, 0.3, double=double_top)
    b.mat('boot', 'Bootstripe', boot, 0.3)
    b.mat('antifoul', 'Antifoul', antifoul, 0.85)
    b.mat('cove', 'CoveStripe', cove or boot, 0.3)
    b.mat('gelcoat', 'Gelcoat', (0.88, 0.86, 0.8), 0.3)
    b.mat('steel', 'Stainless', (0.78, 0.78, 0.8), 0.22, 1.0)
    b.mat('metal', 'PaintedSteel', (0.42, 0.44, 0.45), 0.55, 0.4)
    b.mat('rust', 'RustSteel', (0.32, 0.17, 0.09), 0.9, 0.2)
    b.mat('glass', 'Glass', (0.03, 0.05, 0.06), 0.05)
    b.mat('black', 'Rubber', (0.025, 0.025, 0.028), 0.6)
    b.mat('wood', 'VarnishedTeak', (0.36, 0.19, 0.08), 0.35)
    b.mat('rope', 'Rope', (0.62, 0.52, 0.36), 0.95)
    b.mat('canvas', 'Canvas', (0.09, 0.16, 0.28), 0.9, double=True)
    b.mat('orange', 'Buoy', (0.95, 0.35, 0.05), 0.5)
    b.mat('white', 'WhitePaint', (0.9, 0.9, 0.88), 0.45)
    b.mat('mask', 'WaterMask', (0, 0, 0), 1.0, double=True)
    if deck == 'teak': b.mat('deck', 'TeakDeck', (1, 1, 1), 0.8, image=b.plank_image('teak', (0.36, 0.24, 0.14)))
    elif deck == 'paint': b.mat('deck', 'PaintedDeck', (1, 1, 1), 0.75, image=b.plank_image('deckpaint', (0.42, 0.44, 0.4), tones=(0.9, 1.05), seam=(0.25, 0.26, 0.24)))
    elif deck == 'steel': b.mat('deck', 'SteelDeck', (0.36, 0.37, 0.36), 0.7, 0.3)
    elif deck == 'nonskid': b.mat('deck', 'NonSkid', (0.82, 0.8, 0.74), 0.75)
    return b.M


def paint(M): return {'cove': M['cove'], 'topsides': M['topsides'], 'boot': M['boot'], 'antifoul': M['antifoul']}


def inner_shell(b, h, mat, shrink=0.06, drop=0.03, segs=(2, 8, 2, 10)):
    """Inside skin for open hulls/bulwarks, wound to face inward."""
    inner = Hull(b, h.FB - drop, h.D - 0.05, h.cmax, h.transom, h.bow, h.bowp, h.sheer_bow, h.sheer_stern, h.xexp, h.zexp, h.flat)
    inner.B = h.B - 2 * shrink
    ob = inner.build({'cove': mat, 'topsides': mat, 'boot': mat, 'antifoul': mat}, segs=segs)
    me = ob.data
    for p in me.polygons: p.flip()
    me.update()
    ob.name = 'InnerShell'
    return ob


def floor(b, h, z, mat, s0, s1, shrink=0.1):
    """Flat floorboards at height z inside an open hull."""
    v, f = [], []
    n = 24
    for i in range(n + 1):
        s = s0 + (s1 - s0) * i / n
        hw = max(0.05, h.point(s, h.t_at_z(s, z))[0] - shrink)
        v += [(hw, b.Y(s), z), (-hw, b.Y(s), z)]
        if i: f.append((2 * i - 2, 2 * i, 2 * i + 1, 2 * i - 1))
    return b.make_obj('Floor', v, f, [mat], uv=lambda co: (co.x / 0.9, co.y / 3.2), recalc=False)


def outboard(b, y, z_top, name='Prop', x=0.0, scale=1.0, mat=None):
    m = b.M
    s = scale
    b.box('Bracket', (x, y + 0.08 * s, z_top - 0.1 * s), (0.25 * s, 0.16 * s, 0.3 * s), m['metal'])
    # engine cover: a squarish body with a domed lid, tapering aft like a real outboard cowl
    b.box('Cowling', (x, y + 0.3 * s, z_top + 0.2 * s), (0.4 * s, 0.56 * s, 0.42 * s), mat or m['black'], smooth=False)
    b.ellipsoid('CowlingLid', (x, y + 0.3 * s, z_top + 0.41 * s), (0.2 * s, 0.3 * s, 0.1 * s), mat or m['black'])
    b.box('CowlingStripe', (x, y + 0.3 * s, z_top + 0.25 * s), (0.41 * s, 0.57 * s, 0.05 * s), m['white'])
    b.box('Leg', (x, y + 0.34 * s, z_top - 0.45 * s), (0.11 * s, 0.2 * s, 1.1 * s), m['black'])
    b.box('CavPlate', (x, y + 0.36 * s, z_top - 0.95 * s), (0.28 * s, 0.34 * s, 0.03 * s), m['black'])
    hub = b.empty(name, (x, y + 0.5 * s, z_top - 1.0 * s))
    for k in range(3):
        a = 2 * math.pi * k / 3
        b.box('Blade', (0.09 * s * math.cos(a), 0, 0.09 * s * math.sin(a)), (0.16 * s, 0.03 * s, 0.07 * s), m['steel'], rot=(a, 'Y'), parent=hub)
    b.cyl('Hub', (0, 0, 0), 0.035 * s, 0.1 * s, m['steel'], axis='Y', parent=hub)
    return name


def stanchions(b, h, s_list, z_fn, height=0.6, wires=(0.0, -0.28)):
    M = b.M
    for side in (1, -1):
        tops = []
        for s in s_list:
            x = side * (h.deck_hw(s) - 0.07)
            b.rod('Stanchion', (x, b.Y(s), z_fn(s)), (x, b.Y(s), z_fn(s) + height), 0.014, M['steel'])
            tops.append((x, b.Y(s), z_fn(s) + height))
        for dz in wires: b.tube('Lifeline', [(p[0], p[1], p[2] + dz) for p in tops], 0.006, M['steel'], 6)


def tires(b, h, s_list, z):
    for side in (1, -1):
        for s in s_list:
            b.torus('Tire', (side * (h.half_beam(s) + 0.1), b.Y(s), z), 0.32, 0.12, b.M['black'], axis='X')


def windows_band(b, x0, x1, s0, s1, z, hgt, mat):
    for x in (x0, x1):
        b.box('Window', (x, (b.Y(s0) + b.Y(s1)) / 2, z), (0.03, abs(b.Y(s1) - b.Y(s0)), hgt), mat)


# ---------------------------------------------------------------------------------------
def build_rowboat():
    b = Build('Rowboat', 4.2, 1.55)
    M = base_mats(b, topsides=(0.22, 0.42, 0.46), boot=(0.85, 0.82, 0.74), antifoul=(0.85, 0.82, 0.74), cove=(0.42, 0.24, 0.12), deck='paint')
    b.mat('interior', 'Interior', (0.78, 0.74, 0.62), 0.6)
    h = Hull(b, 0.52, 0.32, cmax=0.46, transom=0.5, bowp=1.6, sheer_bow=0.2, sheer_stern=0.12, xexp=0.75, zexp=1.25)
    h.build(paint(M), cove=0.06, boot=(0.06, -0.03))
    inner_shell(b, h, M['interior'], shrink=0.035, drop=0.0)
    FZ = -0.14
    floor(b, h, FZ, M['deck'], 0.1, 0.9)
    h.rail(M['wood'], dz=0.0, prof=(0.05, 0.05))
    for s, w in ((0.3, 0.85), (0.56, 0.8), (0.12, 0.55)):
        b.box('Thwart', (0, b.Y(s), 0.24), (2 * h.half_beam(s) * w, 0.24, 0.04), M['wood'])
    for side, name in ((1, 'OarPivotL'), (-1, 'OarPivotR')):
        piv = b.empty(name, (side * (h.half_beam(0.45) - 0.02), b.Y(0.45), h.sheer(0.45) + 0.03))
        b.rod('OarShaft', (-side * 0.75, 0, 0), (side * 1.65, 0, 0), 0.022, M['wood'], parent=piv)
        b.box('OarBlade', (side * 1.85, 0, 0), (0.5, 0.13, 0.015), M['wood'], parent=piv)
        b.cyl('Oarlock', (side * (h.half_beam(0.45) - 0.02), b.Y(0.45), h.sheer(0.45)), 0.025, 0.08, M['steel'])
    b.torus('BowEye', (0, b.Y(0.99), h.sheer(0.99) - 0.1), 0.04, 0.008, M['steel'], axis='X')
    h.water_mask(M['mask'])
    b.obstacle(-0.6, 0.6, 0.27, 0.33, 0.26); b.obstacle(-0.6, 0.6, 0.53, 0.59, 0.26)
    return b, {'deckY': FZ, 'walk': h.walk(lambda s: FZ, 0.12, 0.85, 0.2), 'helm': b.G(0, b.Y(0.12), FZ), 'zone': [-0.25 * b.L, 0.15 * b.L],
               'oars': ['OarPivotL', 'OarPivotR'], 'open': True}


def build_skiff(raider=False):
    L, B = (6.5, 2.4) if raider else (5.6, 2.1)
    b = Build('Raider' if raider else 'Skiff', L, B)
    if raider:
        M = base_mats(b, topsides=(0.08, 0.085, 0.09), boot=(0.32, 0.12, 0.05), antifoul=(0.12, 0.1, 0.09), cove=(0.32, 0.17, 0.09), deck='steel')
    else:
        M = base_mats(b, topsides=(0.9, 0.9, 0.87), boot=(0.05, 0.2, 0.35), antifoul=(0.1, 0.12, 0.14), deck='nonskid')
    b.mat('interior', 'Interior', (0.86, 0.85, 0.8) if not raider else (0.2, 0.2, 0.2), 0.5)
    h = Hull(b, 0.72 if raider else 0.66, 0.42, cmax=0.45, transom=0.92, bowp=1.8, sheer_bow=0.28, sheer_stern=0.0, xexp=0.42, zexp=1.0, bot_ends=0.0)
    h.build(paint(M), cove=0.08, boot=(0.12, -0.02))
    inner_shell(b, h, M['interior'], shrink=0.05, drop=0.0)
    FZ = 0.0
    floor(b, h, FZ, M['deck'], 0.03, 0.8)
    h.rail(M['black'], dz=0.0, prof=(0.05, 0.07))
    # bow casting deck
    b.box('CastDeck', (0, b.Y(0.84), 0.35), (2 * h.half_beam(0.8) * 0.9, abs(b.Y(0.92) - b.Y(0.76)), 0.06), M['deck'])
    cs = 0.45
    b.box('Console', (0, b.Y(cs), 0.5), (0.75, 0.6, 1.0), M['gelcoat'] if not raider else M['rust'])
    b.box('Windscreen', (0, b.Y(cs) - 0.32, 1.12), (0.78, 0.04, 0.32), M['glass'], rot=(math.radians(-25), 'X'))
    b.torus('Wheel', (0, b.Y(cs) + 0.32, 0.92), 0.17, 0.018, M['black'], axis='Y')
    b.box('LeanPost', (0, b.Y(cs - 0.13), 0.42), (0.6, 0.35, 0.84), M['gelcoat'] if not raider else M['metal'])
    b.box('Cooler', (0, b.Y(cs + 0.13), 0.22), (0.6, 0.38, 0.44), M['white'])
    out = [outboard(b, b.Y(0.004), h.sheer(0.004), 'Prop', x=(0.35 if raider else 0.0), scale=1.0)]
    if raider:
        out.append(outboard(b, b.Y(0.004), h.sheer(0.004), 'Prop2', x=-0.35, scale=1.0))
        for side in (1, -1):
            for k in range(4):
                s = 0.2 + 0.17 * k
                b.box('Plate', (side * (h.half_beam(s) + 0.02), b.Y(s), 0.35), (0.04, 0.85, 0.45), M['rust'])
        for k in range(5):
            b.make_obj('Spike', [(0, b.Y(1.0) - 0.9, 0.55 + 0.08 * k), (0.06, b.Y(0.985), 0.5 + 0.08 * k), (-0.06, b.Y(0.985), 0.5 + 0.08 * k), (0, b.Y(0.985), 0.6 + 0.08 * k)],
                       [(0, 1, 2), (0, 2, 3), (0, 3, 1), (1, 3, 2)], [M['steel']], smooth=False)
        for side in (1, -1): b.rod('RollBar', (side * 0.8, b.Y(0.3), 0.0), (side * 0.6, b.Y(0.3), 2.0), 0.04, M['metal'])
        b.rod('RollBarTop', (0.6, b.Y(0.3), 2.0), (-0.6, b.Y(0.3), 2.0), 0.04, M['metal'])
        b.cyl('Spotlight', (0, b.Y(0.3) - 0.15, 2.15), 0.14, 0.3, M['steel'], axis='Y')
        b.box('Tarp', (0, b.Y(0.15), 0.45), (1.3, 0.8, 0.5), M['canvas'])
    else:
        for side in (1, -1):
            b.tube('BowRail', [(side * (h.deck_hw(s) - 0.06), b.Y(s), h.sheer(s) + 0.45) for s in (0.66, 0.78, 0.88, 0.95)], 0.016, M['steel'])
            for s in (0.66, 0.8, 0.93): b.rod('RailPost', (side * (h.deck_hw(s) - 0.06), b.Y(s), h.sheer(s)), (side * (h.deck_hw(s) - 0.06), b.Y(s), h.sheer(s) + 0.45), 0.014, M['steel'])
            for s in (0.12, 0.2): b.cyl('RodHolder', (side * (h.deck_hw(s) - 0.08), b.Y(s), h.sheer(s) + 0.05), 0.025, 0.25, M['steel'])
    h.water_mask(M['mask'])
    b.obstacle(-0.4, 0.4, cs - 0.06, cs + 0.06, 2.0)
    b.obstacle(-h.deck_hw(0.84), h.deck_hw(0.84), 0.76, 0.92, 0.38)
    return b, {'deckY': FZ, 'walk': h.walk(lambda s: FZ, 0.06, 0.9, 0.18), 'helm': b.G(0, b.Y(cs) + 0.65, FZ), 'zone': [-0.3 * b.L, -0.12 * b.L], 'outboard': out, 'open': True}


def build_fishing():
    b = Build('Trawler', 10.0, 3.4)
    M = base_mats(b, topsides=(0.62, 0.12, 0.09), boot=(0.9, 0.9, 0.88), antifoul=(0.12, 0.13, 0.12), cove=(0.9, 0.9, 0.88), deck='paint')
    h = Hull(b, 1.35, 1.1, cmax=0.5, transom=0.8, bowp=2.0, sheer_bow=0.6, sheer_stern=0.05, xexp=0.5, zexp=1.6)
    h.build(paint(M), cove=0.18, boot=(0.12, -0.03))
    inner_shell(b, h, M['white'], shrink=0.08, drop=0.0)
    DZ = lambda s: h.sheer(s) - 0.8
    h.deck(M['deck'], drop=0.8, camber=0.04)
    h.rail(M['black'], dz=-0.35, prof=(0.07, 0.12))
    b.foil('Keel', b.Y(0.75), 6.5, 6.0, h.bottom(0.5) + 0.1, -1.45, 0.06, 0.2, M['antifoul'])
    # wheelhouse forward
    s0, s1, hw = 0.55, 0.76, 1.15
    zb = DZ(0.65)
    b.box('Wheelhouse', (0, (b.Y(s0) + b.Y(s1)) / 2, zb + 1.05), (2 * hw, abs(b.Y(s1) - b.Y(s0)), 2.1), M['white'])
    b.box('WheelhouseRoof', (0, (b.Y(s0) + b.Y(s1)) / 2 + 0.1, zb + 2.15), (2 * hw + 0.3, abs(b.Y(s1) - b.Y(s0)) + 0.5, 0.12), M['metal'])
    b.box('FrontWindows', (0, b.Y(s1) - 0.01, zb + 1.55), (2 * hw - 0.2, 0.04, 0.6), M['glass'])
    windows_band(b, hw + 0.01, -hw - 0.01, s0 + 0.03, s1 - 0.03, zb + 1.55, 0.55, M['glass'])
    b.box('Door', (hw + 0.01, b.Y(s0 + 0.04), zb + 0.95), (0.03, 0.6, 1.8), M['metal'])
    b.rod('Mast', (0, b.Y(0.65), zb + 2.2), (0, b.Y(0.65), zb + 5.4), 0.06, M['metal'])
    b.box('Yard', (0, b.Y(0.65), zb + 4.6), (1.6, 0.06, 0.06), M['metal'])
    b.ellipsoid('Radar', (0, b.Y(0.63), zb + 2.45), (0.35, 0.35, 0.18), M['white'])
    for side, mm in ((1, 'orange'), (-1, 'orange')):
        b.box('MastLight', (side * 0.7, b.Y(0.65), zb + 4.7), (0.08, 0.08, 0.12), M[mm])
    # stern gantry, net drum, trawl doors
    gy = b.Y(0.06)
    for side in (1, -1): b.rod('Gantry', (side * 1.25, gy, DZ(0.06)), (side * 1.05, gy, DZ(0.06) + 3.4), 0.09, M['orange'])
    b.rod('GantryTop', (1.05, gy, DZ(0.06) + 3.4), (-1.05, gy, DZ(0.06) + 3.4), 0.09, M['orange'])
    b.cyl('NetDrum', (0, b.Y(0.2), DZ(0.2) + 0.65), 0.6, 2.0, M['canvas'], axis='X')
    for side in (1, -1):
        b.cyl('DrumEnd', (side * 1.0, b.Y(0.2), DZ(0.2) + 0.65), 0.75, 0.06, M['metal'], axis='X')
        b.box('TrawlDoor', (side * (h.half_beam(0.1) + 0.1), b.Y(0.1), DZ(0.1) + 0.5), (0.12, 1.1, 0.8), M['rust'])
    b.box('Hatch', (0, b.Y(0.38), DZ(0.38) + 0.18), (1.2, 1.2, 0.35), M['metal'])
    for s in (0.3, 0.45): b.ellipsoid('Buoy', (0.95, b.Y(s), DZ(s) + 0.3), (0.28, 0.28, 0.28), M['orange'])
    tires(b, h, (0.25, 0.42, 0.6), 0.55)
    h.water_mask(M['mask'])
    b.obstacle(-hw, hw, s0, s1, zb + 2.2)
    b.obstacle(-1.0, 1.0, 0.15, 0.25, DZ(0.2) + 1.3)
    return b, {'deckY': DZ(0.4), 'walk': h.walk(DZ, 0.05, 0.94, 0.3), 'helm': b.G(0, (b.Y(s0) + b.Y(s1)) / 2, zb), 'helmEnclosed': True,
               'zone': [-0.3 * b.L, -0.05 * b.L], 'smoke': None}


def build_tug():
    b = Build('Tug', 12.0, 4.5)
    M = base_mats(b, topsides=(0.1, 0.12, 0.14), boot=(0.85, 0.65, 0.1), antifoul=(0.45, 0.1, 0.07), cove=(0.85, 0.65, 0.1), deck='paint')
    h = Hull(b, 1.5, 1.7, cmax=0.48, transom=0.78, bowp=1.6, sheer_bow=0.75, sheer_stern=0.18, xexp=0.42, zexp=1.9)
    h.build(paint(M), cove=0.22, boot=(0.12, -0.04))
    inner_shell(b, h, M['white'], shrink=0.09, drop=0.0)
    DZ = lambda s: h.sheer(s) - 0.85
    h.deck(M['deck'], drop=0.85, camber=0.04)
    h.rail(M['black'], dz=-0.4, prof=(0.1, 0.18))
    b.tube('BowFender', [(math.cos(a) * h.half_beam(0.93) * 1.02, b.Y(0.93) - math.sin(a) * 0.55, h.sheer(0.97) - 0.6) for a in [math.pi * k / 12 for k in range(13)]], 0.28, M['rope'])
    tires(b, h, (0.15, 0.3, 0.45, 0.6, 0.75), 0.75)
    zb = DZ(0.55)
    b.box('HouseLower', (0, b.Y(0.56), zb + 1.0), (3.0, abs(b.Y(0.7) - b.Y(0.42)), 2.0), M['white'])
    b.box('HouseUpper', (0, b.Y(0.6), zb + 2.75), (2.5, abs(b.Y(0.68) - b.Y(0.52)), 1.5), M['white'])
    b.box('UpperRoof', (0, b.Y(0.6), zb + 3.55), (2.8, abs(b.Y(0.69) - b.Y(0.5)), 0.12), M['metal'])
    b.box('UpperWindowsF', (0, b.Y(0.68) - 0.01, zb + 2.95), (2.3, 0.04, 0.7), M['glass'])
    windows_band(b, 1.26, -1.26, 0.53, 0.67, zb + 2.95, 0.6, M['glass'])
    windows_band(b, 1.51, -1.51, 0.45, 0.67, zb + 1.3, 0.45, M['glass'])
    b.cyl('Funnel', (0, b.Y(0.38), zb + 2.3), 0.55, 3.0, M['boot'])
    b.cyl('FunnelBand', (0, b.Y(0.38), zb + 3.65), 0.57, 0.35, M['black'])
    b.rod('Mast', (0, b.Y(0.6), zb + 3.6), (0, b.Y(0.6), zb + 6.2), 0.07, M['metal'])
    for s in (0.15, 0.25):
        b.cyl('Bitt', (0.5, b.Y(s), DZ(s) + 0.35), 0.16, 0.7, M['metal']); b.cyl('Bitt', (-0.5, b.Y(s), DZ(s) + 0.35), 0.16, 0.7, M['metal'])
    b.box('TowHook', (0, b.Y(0.3), DZ(0.3) + 0.6), (0.4, 0.3, 0.5), M['metal'])
    h.water_mask(M['mask'])
    b.obstacle(-1.5, 1.5, 0.42, 0.7, zb + 3.6)
    b.obstacle(-0.6, 0.6, 0.35, 0.41, zb + 3.8)
    return b, {'deckY': DZ(0.3), 'walk': h.walk(DZ, 0.05, 0.92, 0.35), 'helm': b.G(0, b.Y(0.6), zb), 'helmEnclosed': True,
               'zone': [-0.35 * b.L, -0.2 * b.L], 'smoke': b.G(0, b.Y(0.38), zb + 3.9)}


def build_yacht():
    b = Build('MotorYacht', 14.5, 4.3)
    M = base_mats(b, topsides=(0.93, 0.93, 0.92), boot=(0.06, 0.08, 0.12), antifoul=(0.08, 0.1, 0.14), cove=(0.06, 0.08, 0.12), deck='teak')
    h = Hull(b, 1.75, 0.95, cmax=0.42, transom=0.9, bowp=1.9, sheer_bow=0.35, sheer_stern=0.0, xexp=0.4, zexp=0.9, bot_ends=0.0)
    h.build(paint(M), cove=0.35, boot=(0.15, -0.02))
    DZ = lambda s: h.deck_z(s)
    h.deck(M['deck'], camber=0.05)
    h.rail(M['steel'], dz=0.65, prof=(0.03, 0.03))
    for side in (1, -1):
        for s in (0.55, 0.68, 0.8, 0.9):
            b.rod('RailPost', (side * (h.deck_hw(s) - 0.05), b.Y(s), DZ(s)), (side * (h.deck_hw(s) - 0.04), b.Y(s), DZ(s) + 0.65), 0.015, M['steel'])
    zb = DZ(0.5)
    b.box('Saloon', (0, b.Y(0.47), zb + 0.95), (3.4, abs(b.Y(0.68) - b.Y(0.25)), 1.9), M['gelcoat'])
    windows_band(b, 1.71, -1.71, 0.3, 0.64, zb + 1.1, 0.7, M['glass'])
    b.box('Windshield', (0, b.Y(0.69), zb + 1.3), (3.2, 0.05, 1.1), M['glass'], rot=(math.radians(-35), 'X'))
    b.box('Flybridge', (0, b.Y(0.42), zb + 2.0), (3.1, abs(b.Y(0.58) - b.Y(0.26)), 0.25), M['gelcoat'])
    b.box('FlyConsole', (0, b.Y(0.53), zb + 2.5), (1.2, 0.5, 0.8), M['gelcoat'])
    b.box('FlySeat', (0, b.Y(0.33), zb + 2.35), (2.2, 0.6, 0.45), M['canvas'])
    for side in (1, -1): b.rod('ArchLeg', (side * 1.2, b.Y(0.37), zb + 2.1), (side * 0.9, b.Y(0.33), zb + 3.4), 0.06, M['white'])
    b.rod('ArchTop', (0.9, b.Y(0.33), zb + 3.4), (-0.9, b.Y(0.33), zb + 3.4), 0.06, M['white'])
    b.ellipsoid('Radar', (0, b.Y(0.33), zb + 3.55), (0.4, 0.4, 0.12), M['white'])
    b.box('SwimPlatform', (0, b.Y(0.0) + 0.45, 0.35), (h.B * 0.85, 0.9, 0.1), M['deck'])
    b.box('Sunpad', (0, b.Y(0.82), DZ(0.82) + 0.15), (1.8, 1.9, 0.25), M['canvas'])
    h.water_mask(M['mask'])
    b.obstacle(-1.7, 1.7, 0.25, 0.69, zb + 1.9)
    b.obstacle(-0.9, 0.9, 0.78, 0.86, DZ(0.82) + 0.3)
    return b, {'deckY': DZ(0.15), 'walk': h.walk(DZ, 0.04, 0.95, 0.3), 'helm': b.G(0, b.Y(0.2), DZ(0.2)), 'zone': [0.25 * b.L, 0.36 * b.L]}


def build_houseboat():
    b = Build('Houseboat', 11.0, 4.0)
    M = base_mats(b, topsides=(0.28, 0.33, 0.36), boot=(0.85, 0.82, 0.74), antifoul=(0.2, 0.2, 0.2), deck='teak')
    b.mat('wall', 'HouseWall', (0.78, 0.69, 0.52), 0.8)
    b.mat('roof', 'RoofTiles', (0.38, 0.22, 0.16), 0.85)
    b.mat('trim', 'WindowTrim', (0.92, 0.92, 0.88), 0.5)
    b.mat('plant', 'Plants', (0.2, 0.4, 0.16), 0.9)
    h = Hull(b, 0.6, 0.55, cmax=0.5, transom=0.97, bow=0.85, flat=True, sheer_bow=0.1, sheer_stern=0.0, xexp=0.12, zexp=4.0)
    h.build(paint(M), cove=0.08, boot=(0.1, -0.03), segs=(1, 4, 1, 6))
    DZ = lambda s: h.deck_z(s, 0.03)
    h.deck(M['deck'], drop=0.03, camber=0.0)
    s0, s1, hw, H = 0.12, 0.8, 1.7, 2.4
    zb = DZ(0.5)
    mid = (b.Y(s0) + b.Y(s1)) / 2
    b.box('House', (0, mid, zb + H / 2), (2 * hw, abs(b.Y(s1) - b.Y(s0)), H), M['wall'])
    ln = abs(b.Y(s1) - b.Y(s0)) + 0.5
    b.make_obj('Roof', [(hw + 0.35, mid - ln / 2, zb + H), (-hw - 0.35, mid - ln / 2, zb + H), (0, mid - ln / 2, zb + H + 1.3),
                        (hw + 0.35, mid + ln / 2, zb + H), (-hw - 0.35, mid + ln / 2, zb + H), (0, mid + ln / 2, zb + H + 1.3)],
               [(0, 2, 5, 3), (1, 4, 5, 2), (0, 3, 4, 1), (0, 1, 2), (3, 5, 4)], [M['roof']], smooth=False)
    b.box('Chimney', (0.8, b.Y(0.3), zb + H + 1.0), (0.35, 0.35, 1.2), M['wall'])
    for side in (1, -1):
        for s in (0.22, 0.4, 0.58, 0.72):
            b.box('Window', (side * (hw + 0.01), b.Y(s), zb + 1.35), (0.04, 0.8, 0.9), M['glass'])
            b.box('Shutter', (side * (hw + 0.02), b.Y(s) - 0.55, zb + 1.35), (0.03, 0.25, 1.0), M['topsides'])
    b.box('FrontDoor', (0, b.Y(s1) - 0.01, zb + 1.0), (0.9, 0.04, 2.0), M['wood'])
    b.box('BackDoor', (0, b.Y(s0) + 0.01, zb + 1.0), (0.9, 0.04, 2.0), M['wood'])
    b.box('Solar', (-0.8, b.Y(0.5), zb + H + 0.75), (1.0, 1.6, 0.05), M['glass'], rot=(math.radians(28), 'Y'))
    for side in (1, -1):
        b.tube('PorchRail', [(side * (h.deck_hw(s) - 0.08), b.Y(s), DZ(s) + 0.9) for s in (s1 + 0.01, 0.9, 0.97)], 0.03, M['trim'])
        for s in (s1 + 0.01, 0.9, 0.97): b.rod('PorchPost', (side * (h.deck_hw(s) - 0.08), b.Y(s), DZ(s)), (side * (h.deck_hw(s) - 0.08), b.Y(s), DZ(s) + 0.9), 0.03, M['trim'])
    for x in (-1.2, 1.2):
        b.cyl('Pot', (x, b.Y(0.88), DZ(0.88) + 0.2), 0.22, 0.4, M['antifoul'])
        b.ellipsoid('Plant', (x, b.Y(0.88), DZ(0.88) + 0.6), (0.35, 0.35, 0.35), M['plant'])
    b.torus('LifeRing', (hw + 0.03, b.Y(0.84), zb + 1.2), 0.26, 0.055, M['orange'], axis='X')
    h.water_mask(M['mask'])
    b.obstacle(-hw, hw, s0, s1, zb + H)
    return b, {'deckY': DZ(0.5), 'walk': h.walk(DZ, 0.04, 0.97, 0.25), 'helm': b.G(0, b.Y(0.88), DZ(0.88)), 'zone': [0.33 * b.L, 0.44 * b.L]}


def build_barge():
    b = Build('Barge', 18.0, 6.0)
    M = base_mats(b, topsides=(0.2, 0.22, 0.2), boot=(0.8, 0.6, 0.1), antifoul=(0.3, 0.12, 0.08), cove=(0.8, 0.6, 0.1), deck='steel')
    h = Hull(b, 1.1, 1.1, cmax=0.5, transom=0.98, bow=0.9, flat=True, sheer_bow=0.25, sheer_stern=0.1, xexp=0.08, zexp=5.0)
    h.build(paint(M), cove=0.15, boot=(0.15, -0.03), segs=(1, 4, 1, 6))
    DZ = lambda s: h.deck_z(s, 0.04)
    h.deck(M['deck'], drop=0.04, camber=0.0)
    h.rail(M['rust'], dz=0.15, prof=(0.1, 0.3))
    colors = [(0.7, 0.23, 0.18), (0.18, 0.37, 0.64), (0.18, 0.54, 0.32), (0.82, 0.6, 0.16), (0.42, 0.44, 0.46), (0.64, 0.31, 0.18)]
    cm = [b.mat(f'c{i}', f'Container{i}', c, 0.6, 0.3) for i, c in enumerate(colors)]
    rng = random.Random(3)
    for row in range(4):
        for side in (1, -1):
            s = 0.25 + row * 0.165
            for k in range(rng.randint(1, 3)):
                b.box('Container', (side * 1.4, b.Y(s), DZ(s) + 1.3 + k * 2.6), (2.44, 6.0, 2.55), rng.choice(cm))
    b.box('Deckhouse', (0, b.Y(0.08), DZ(0.08) + 1.1), (3.2, 2.4, 2.2), M['white'])
    b.box('DeckhouseWin', (0, b.Y(0.08) - 1.21, DZ(0.08) + 1.5), (2.8, 0.04, 0.6), M['glass'])
    b.box('DeckhouseRoof', (0, b.Y(0.08), DZ(0.08) + 2.26), (3.5, 2.7, 0.12), M['metal'])
    for s in (0.03, 0.97):
        for side in (1, -1): b.cyl('Bitt', (side * 2.3, b.Y(s), DZ(s) + 0.3), 0.15, 0.6, M['metal'])
    h.water_mask(M['mask'])
    b.obstacle(-2.7, 2.7, 0.2, 0.83, DZ(0.5) + 2.6)
    b.obstacle(-1.6, 1.6, 0.03, 0.135, DZ(0.08) + 2.2)
    return b, {'deckY': DZ(0.5), 'walk': h.walk(DZ, 0.03, 0.97, 0.25), 'helm': b.G(0, b.Y(0.08) - 1.5, DZ(0.08)), 'zone': [-0.4 * b.L, -0.36 * b.L]}


def build_schooner():
    b = Build('Schooner', 19.0, 4.8)
    M = base_mats(b, topsides=(0.07, 0.2, 0.13), boot=(0.75, 0.6, 0.25), antifoul=(0.4, 0.12, 0.08), cove=(0.75, 0.6, 0.25), deck='teak')
    h = Hull(b, 1.45, 1.35, cmax=0.45, transom=0.5, bowp=2.3, sheer_bow=0.8, sheer_stern=0.3, xexp=0.6, zexp=1.5)
    h.build(paint(M), cove=0.1, boot=(0.1, -0.03))
    b.foil('Keel', b.Y(0.72), 9.0, 8.0, h.bottom(0.5) + 0.1, -2.3, 0.05, 0.6, M['antifoul'])
    inner_shell(b, h, M['white'], shrink=0.07, drop=0.0)
    DZ = lambda s: h.sheer(s) - 0.45
    h.deck(M['deck'], drop=0.45, camber=0.05)
    for side in (1, -1):
        b.sweep('CapRail', [(side * (h.half_beam(s) - 0.04), b.Y(s), h.sheer(s) + 0.03) for s in [0.01 + 0.98 * i / 50 for i in range(51)]], b.rect(0.14, 0.06), M['wood'])
    b.rod('Bowsprit', (0, b.Y(0.9), h.sheer(0.95) + 0.1), (0, b.Y(1.0) - 4.5, h.sheer(1.0) + 0.6), 0.12, M['wood'])
    b.rod('Bobstay', (0, b.Y(1.0) - 4.3, h.sheer(1.0) + 0.55), (0, b.Y(0.995), 0.3), 0.012, M['black'], 6)
    rigs = []
    for name, s, mh, boom in (('BoomPivot2', 0.68, 15.0, 5.2), ('BoomPivot', 0.44, 18.0, 6.8)):
        zb = DZ(s)
        b.rod('Mast', (0, b.Y(s), zb), (0, b.Y(s), zb + mh + 0.3), 0.14, M['wood'])
        b.rod('Topmast', (0, b.Y(s), zb + mh + 0.3), (0, b.Y(s), zb + mh + 2.5), 0.07, M['wood'])
        for side in (1, -1):
            b.rod('Shroud', (0, b.Y(s), zb + mh * 0.85), (side * (h.half_beam(s) - 0.05), b.Y(s) + 0.4, h.sheer(s) + 0.1), 0.011, M['black'], 6)
            b.rod('Shroud', (0, b.Y(s), zb + mh * 0.85), (side * (h.half_beam(s) - 0.05), b.Y(s) + 1.2, h.sheer(s) + 0.1), 0.011, M['black'], 6)
        piv = b.empty(name, (0, b.Y(s) + 0.15, zb + 1.0))
        b.sweep('Boom', [(0, 0, 0), (0, boom, 0)], b.circle(0.08, 10), M['wood'], parent=piv)
        b.make_obj('FurledSail', [(0.12 * math.cos(a), boom * 0.05 + boom * 0.9 * t, 0.12 + 0.1 * math.sin(a)) for t in (0, 1) for a in [2 * math.pi * k / 8 for k in range(8)]],
                   b.grid_faces(2, 8, True), [M['canvas']], parent=piv)
        rigs.append({'pivot': name, 'mastH': mh, 'boomLen': boom, 'mastZ': round(-b.Y(s), 3)})
    b.rod('Forestay', (0, b.Y(0.68), DZ(0.68) + 15.2), (0, b.Y(1.0) - 4.4, h.sheer(1.0) + 0.6), 0.012, M['black'], 6)
    b.rod('Springstay', (0, b.Y(0.68), DZ(0.68) + 15.0), (0, b.Y(0.44), DZ(0.44) + 17.5), 0.012, M['black'], 6)
    b.box('Deckhouse', (0, b.Y(0.3), DZ(0.3) + 0.45), (2.0, 3.0, 0.9), M['wood'])
    b.box('Skylight', (0, b.Y(0.57), DZ(0.57) + 0.3), (1.0, 1.2, 0.6), M['wood'])
    b.torus('Wheel', (0, b.Y(0.1), DZ(0.1) + 1.0), 0.55, 0.035, M['wood'], axis='Y')
    for k in range(8):
        a = 2 * math.pi * k / 8
        b.rod('Spoke', (0, b.Y(0.1), DZ(0.1) + 1.0), (0.7 * math.cos(a), b.Y(0.1), DZ(0.1) + 1.0 + 0.7 * math.sin(a)), 0.02, M['wood'])
    b.box('WheelBox', (0, b.Y(0.1) - 0.15, DZ(0.1) + 0.4), (0.3, 0.3, 0.8), M['wood'])
    h.water_mask(M['mask'])
    b.obstacle(-1.0, 1.0, 0.26, 0.34, DZ(0.3) + 0.9)
    b.obstacle(-0.15, 0.15, 0.435, 0.445, 30); b.obstacle(-0.15, 0.15, 0.675, 0.685, 30)
    return b, {'deckY': DZ(0.3), 'walk': h.walk(DZ, 0.04, 0.95, 0.3), 'helm': b.G(0, b.Y(0.1) + 0.6, DZ(0.1)), 'zone': [-0.25 * b.L, -0.12 * b.L], 'rigs': rigs}


def build_raft():
    b = Build('Raft', 4.4, 3.0)
    M = base_mats(b, deck='paint')
    bark = b.mat('bark', 'Logs', (0.38, 0.27, 0.17), 0.95)
    blue = b.mat('drum', 'Drums', (0.12, 0.3, 0.6), 0.5)
    n, r = 9, 3.0 / 18
    for i in range(n):
        x = -1.5 + r + i * 2 * r
        L = 4.4 * random.uniform(0.9, 1.0)
        b.rod('Log', (x, -L / 2, 0.18), (x, L / 2, 0.18), r * random.uniform(0.9, 1.0), bark, 10)
    for y in (-1.6, 0, 1.6):
        b.box('Beam', (0, y, 0.38), (3.1, 0.18, 0.12), M['wood'])
        for k in range(4): b.torus('Lashing', (-1.2 + 0.8 * k, y, 0.3), 0.12, 0.012, M['rope'], axis='Y')
    for x, y in ((1.0, 1.5), (-1.0, 1.5), (1.0, -1.5), (-1.0, -1.5)):
        b.cyl('Drum', (x, y, -0.05), 0.3, 0.85, blue, axis='Y')
    b.box('Crate', (0.7, -0.2, 0.62), (0.6, 0.6, 0.5), M['wood'])
    b.rod('SteeringOar', (0, 1.9, 0.6), (0, 3.6, -0.3), 0.03, M['wood'])
    b.box('OarBlade', (0, 3.7, -0.38), (0.06, 0.5, 0.25), M['wood'])
    return b, {'deckY': 0.42, 'walk': [[round(-y, 3), 1.3, 0.42] for y in (-2.0, -1.0, 0, 1.0, 2.0)], 'helm': b.G(0, 1.7, 0.42), 'zone': [-1.2, 1.2], 'open': True}


BUILDERS = {
    'raft': build_raft, 'rowboat': build_rowboat, 'skiff': build_skiff, 'raider': lambda: build_skiff(True),
    'fishing': build_fishing, 'tug': build_tug, 'yacht': build_yacht, 'houseboat': build_houseboat,
    'barge': build_barge, 'schooner': build_schooner,
}
CAMS = {'raft': (5, -6, 3), 'rowboat': (5, -6, 3), 'skiff': (6.5, -7.5, 3.5), 'raider': (7, -8, 3.8), 'fishing': (11, -13, 6),
        'tug': (13, -15, 7), 'yacht': (15, -17, 7.5), 'houseboat': (12, -13, 6), 'barge': (18, -20, 9), 'schooner': (20, -22, 11)}

for kind, fn in BUILDERS.items():
    if ONLY and kind not in ONLY: continue
    b, extras = fn()
    b.bake_ao()
    prev = os.path.join(PREV_DIR, f'{kind}.png') if PREV_DIR else None
    b.export(os.path.join(OUT_DIR, f'{kind}.glb'), extras, prev, cam=CAMS[kind], target=(0, -0.3, b.B * 0.35))
