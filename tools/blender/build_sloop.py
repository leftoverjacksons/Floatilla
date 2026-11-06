"""
Floatilla — procedural Blender build of the 10 m cruising sloop "Little Ark".

Run headless:
    blender -b --python tools/blender/build_sloop.py -- public/models/sloop.glb [preview.png]

Conventions (so the glTF lands in the game's frame without extra transforms):
  * Blender +X = port (game +x), bow toward Blender -Y (game +z), Z up (game +y).
  * Waterline at Z = 0. Lengths in metres. L = 10, B = 3.3 match the game design.
  * Gameplay data (deck heights, walkable outline, platforms/walls, helm, rig
    sizes) is exported as glTF "extras" on the root node, already in GAME
    coordinates (x, y, z) = (X, Z, -Y).
"""
import bpy, bmesh, math, sys, json, os, random
from mathutils import Vector, Matrix

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT = argv[0] if argv else 'sloop.glb'
PREVIEW = argv[1] if len(argv) > 1 else None

random.seed(7)
L, B, FB = 10.0, 3.3, 0.95
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene

# ----------------------------------------------------------------------------
# hull lines
# ----------------------------------------------------------------------------
def Y(s):  # s: 0 = transom, 1 = stem
    return (0.5 - s) * L

def half_beam(s):
    c = 0.44
    if s <= c:
        t = (c - s) / 0.64
        return B / 2 * max(0.0, 1 - t * t) ** 0.75
    t = (s - c) / (1.0 - c)
    return B / 2 * max(0.0, 1 - t ** 2.1) ** 0.95

def sheer(s):
    return FB + 0.24 * s ** 2.6 + 0.07 * (1 - s) ** 2

def canoe_bottom(s):
    return -0.42 * max(0.0, math.sin(math.pi * min(1.0, s * 0.97 + 0.04))) ** 0.55

def section_point(s, t):
    """t: 0 at the sheer, 1 on the centreline at the bottom (port half, X >= 0)."""
    w, top, bot = half_beam(s), sheer(s), canoe_bottom(s)
    a = t * math.pi / 2
    x = w * max(math.cos(a), 0.0) ** 0.55
    z = top - (top - bot) * math.sin(a) ** 1.55
    return x, z

def deck_z(s):
    return sheer(s) - 0.045

DECK_MID = deck_z(0.45)
COCKPIT = (0.035, 0.30, 0.80)      # s0, s1, half width
COCKPIT_FLOOR = deck_z(0.17) - 0.40
TRUNK = (0.31, 0.63)               # s range of the cabin trunk
TRUNK_H = 0.52
MAST_S = 0.615
MAST_H = 12.5                      # above the deck, as in the game's rig
BOOM_LEN = 4.2

# ----------------------------------------------------------------------------
# materials
# ----------------------------------------------------------------------------
def mat(name, color, rough=0.5, metal=0.0, image=None, double=False, alpha=None):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes['Principled BSDF']
    bsdf.inputs['Base Color'].default_value = (*color, 1)
    bsdf.inputs['Roughness'].default_value = rough
    bsdf.inputs['Metallic'].default_value = metal
    if image is not None:
        tex = m.node_tree.nodes.new('ShaderNodeTexImage'); tex.image = image
        m.node_tree.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
    m.use_backface_culling = not double
    return m

def teak_image():
    import array
    N = 512
    img = bpy.data.images.new('teak_deck', N, N, alpha=False)
    px = [0.0] * (N * N * 4)
    planks = 8
    pw = N // planks
    joints = [random.randint(0, N - 1) for _ in range(planks)]
    tones = [random.uniform(0.72, 1.08) for _ in range(planks)]
    for y in range(N):
        for x in range(N):
            p = x // pw
            lx = x - p * pw
            base = (0.36, 0.24, 0.14)
            t = tones[p]
            grain = 0.06 * math.sin(lx * 0.9 + 6 * math.sin(y * 0.021 + p)) + 0.04 * math.sin(y * 0.11 + lx * 0.3 + p * 3)
            k = t * (1 + grain)
            r, g, b = base[0] * k, base[1] * k, base[2] * k
            if lx < 3 or abs(y - joints[p]) < 2:  # black caulking seams and butt joints
                r, g, b = 0.035, 0.03, 0.025
            i = (y * N + x) * 4
            px[i:i + 4] = (r, g, b, 1.0)
    img.pixels = px
    img.pack()
    return img

M = {
    'topsides': mat('Topsides', (0.86, 0.84, 0.78), 0.28),
    'boot': mat('Bootstripe', (0.04, 0.09, 0.2), 0.3),
    'antifoul': mat('Antifoul', (0.3, 0.08, 0.06), 0.85),
    'cove': mat('CoveStripe', (0.04, 0.09, 0.2), 0.3),
    'teak': mat('TeakDeck', (1, 1, 1), 0.8, image=teak_image()),
    'nonskid': mat('NonSkid', (0.82, 0.8, 0.74), 0.7),
    'gelcoat': mat('Gelcoat', (0.88, 0.86, 0.8), 0.3),
    'wood': mat('VarnishedTeak', (0.36, 0.19, 0.08), 0.35),
    'steel': mat('Stainless', (0.78, 0.78, 0.8), 0.22, 1.0),
    'spar': mat('Aluminium', (0.72, 0.73, 0.74), 0.35, 1.0),
    'wire': mat('Rigging', (0.25, 0.26, 0.27), 0.4, 0.8),
    'glass': mat('Glass', (0.03, 0.05, 0.06), 0.05),
    'canvas': mat('Canvas', (0.09, 0.16, 0.28), 0.9, double=True),
    'black': mat('Rubber', (0.025, 0.025, 0.028), 0.6),
    'orange': mat('LifeRing', (0.95, 0.35, 0.05), 0.5),
    'fender': mat('Fender', (0.05, 0.18, 0.42), 0.45),
    'red': mat('PortLight', (0.8, 0.05, 0.04), 0.3),
    'green': mat('StbdLight', (0.05, 0.6, 0.15), 0.3),
    'mask': mat('WaterMask', (0, 0, 0), 1.0, double=True),
}

# ----------------------------------------------------------------------------
# mesh helpers
# ----------------------------------------------------------------------------
root = bpy.data.objects.new('Sloop', None)
scene.collection.objects.link(root)
parts = []

def make_obj(name, verts, faces, materials, face_mats=None, smooth=True, parent=None, uv=None, recalc=True):
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in verts], [], faces)
    for m_ in materials: me.materials.append(m_)
    if face_mats:
        for poly, mi in zip(me.polygons, face_mats): poly.material_index = mi
    if uv is not None:
        layer = me.uv_layers.new(name='UVMap')
        for poly in me.polygons:
            for li in poly.loop_indices:
                layer.data[li].uv = uv(me.vertices[me.loops[li].vertex_index].co)
    for poly in me.polygons: poly.use_smooth = smooth
    me.validate(); me.update()
    if recalc:  # closed parts: let Blender make every face point outward
        bm = bmesh.new(); bm.from_mesh(me)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        bm.to_mesh(me); bm.free(); me.update()
    ob = bpy.data.objects.new(name, me)
    scene.collection.objects.link(ob)
    ob.parent = parent or root
    parts.append(ob)
    return ob

def grid_faces(rows, cols, closed_cols=False):
    f = []
    for i in range(rows - 1):
        for j in range(cols - (0 if closed_cols else 1)):
            j2 = (j + 1) % cols
            a, b, c, d = i * cols + j, (i + 1) * cols + j, (i + 1) * cols + j2, i * cols + j2
            f.append((a, b, c, d))
    return f

def box(name, c, size, material, rot=None, parent=None, smooth=False):
    cx, cy, cz = c; sx, sy, sz = size[0] / 2, size[1] / 2, size[2] / 2
    v = [(cx + x * sx, cy + y * sy, cz + z * sz) for x in (-1, 1) for y in (-1, 1) for z in (-1, 1)]
    f = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    if rot is not None:
        R = Matrix.Rotation(rot[0], 4, rot[1]); C = Vector(c)
        v = [tuple(C + (R @ (Vector(p) - C))) for p in v]
    return make_obj(name, v, f, [material], smooth=smooth, parent=parent)

def frame_along(points, i):
    p = Vector(points[i])
    t = (Vector(points[min(i + 1, len(points) - 1)]) - Vector(points[max(i - 1, 0)])).normalized()
    up = Vector((0, 0, 1)) if abs(t.z) < 0.9 else Vector((1, 0, 0))
    n = t.cross(up).normalized(); b = n.cross(t).normalized()
    return p, n, b

def sweep(name, points, profile, material, closed_profile=True, cap=True, smooth=True, parent=None):
    """Sweep a 2D profile [(u, v)] along a polyline (u along the side normal, v along the binormal)."""
    verts, k = [], len(profile)
    for i in range(len(points)):
        p, n, b = frame_along(points, i)
        for (u, v) in profile: verts.append(tuple(p + n * u + b * v))
    faces = grid_faces(len(points), k, closed_profile)
    if cap and closed_profile:
        faces.append(tuple(range(k - 1, -1, -1)))
        base = (len(points) - 1) * k
        faces.append(tuple(base + j for j in range(k)))
    return make_obj(name, verts, faces, [material], smooth=smooth, parent=parent)

def circle(r, n=10):
    return [(r * math.cos(2 * math.pi * i / n), r * math.sin(2 * math.pi * i / n)) for i in range(n)]

def tube(name, points, r, material, n=10, parent=None):
    return sweep(name, points, circle(r, n), material, parent=parent)

def rod(name, a, b, r, material, n=8, parent=None):
    return tube(name, [a, b], r, material, n, parent=parent)

def cylinder(name, c, r, h, material, axis='Z', n=20, parent=None):
    cx, cy, cz = c
    if axis == 'Z': a, b = (cx, cy, cz - h / 2), (cx, cy, cz + h / 2)
    elif axis == 'X': a, b = (cx - h / 2, cy, cz), (cx + h / 2, cy, cz)
    else: a, b = (cx, cy - h / 2, cz), (cx, cy + h / 2, cz)
    return rod(name, a, b, r, material, n, parent=parent)

def ellipsoid(name, c, r, material, n=16, m=10, parent=None):
    verts, faces = [], []
    for i in range(m + 1):
        th = math.pi * i / m
        for j in range(n):
            ph = 2 * math.pi * j / n
            verts.append((c[0] + r[0] * math.sin(th) * math.cos(ph), c[1] + r[1] * math.cos(th), c[2] + r[2] * math.sin(th) * math.sin(ph)))
    faces = grid_faces(m + 1, n, True)
    return make_obj(name, verts, faces, [material], parent=parent)

# ----------------------------------------------------------------------------
# hull
# ----------------------------------------------------------------------------
NS = 80
# Rows are placed exactly on the paint lines (cove stripe, boot-top, waterline) so colour
# bands come out as clean lines instead of stair-steps.
SEGS = [('cove', 2), ('topsides', 8), ('boot', 2), ('antifoul', 10)]
MS = sum(n for _, n in SEGS)
def t_at_z(s, zt):
    lo, hi = 0.0, 1.0
    if section_point(s, 1.0)[1] > zt: return 1.0
    for _ in range(40):
        mid = (lo + hi) / 2
        if section_point(s, mid)[1] > zt: lo = mid
        else: hi = mid
    return (lo + hi) / 2
def section_ts(s):
    tc, tb, tw = t_at_z(s, sheer(s) - 0.12), t_at_z(s, 0.1), t_at_z(s, -0.03)
    tb, tw = max(tb, tc + 1e-3), max(tw, max(tb, tc + 1e-3) + 1e-3)
    bounds = [0.0, tc, tb, min(tw, 0.999), 1.0]
    ts = [0.0]
    for k, (_, n) in enumerate(SEGS):
        a, b = bounds[k], max(bounds[k + 1], bounds[k] + 1e-4)
        ts += [a + (b - a) * (q + 1) / n for q in range(n)]
    return ts
row_mat = []
for name, n in SEGS: row_mat += [ {'cove': 3, 'topsides': 0, 'boot': 1, 'antifoul': 2}[name] ] * n
hv, hfm = [], []
for i in range(NS + 1):
    s = 0.004 + 0.992 * (i / NS) ** 1.0
    ts = section_ts(s)
    for j in range(2 * MS + 1):
        t = ts[j] if j <= MS else ts[2 * MS - j]
        x, z = section_point(s, t)
        if j > MS: x = -x
        hv.append((x, Y(s), z))
hf = grid_faces(NS + 1, 2 * MS + 1)
for f in hf:
    j = f[0] % (2 * MS + 1)
    hfm.append(row_mat[j] if j < MS else row_mat[2 * MS - j - 1])
# transom
tr = list(range(0, 2 * MS + 1))
hf.append(tuple(tr)); hfm.append(0)  # wound to face aft
hull = make_obj('Hull', hv, hf, [M['topsides'], M['boot'], M['antifoul'], M['cove']], hfm, recalc=False)

# fin keel with bulb, and a spade rudder (NACA-ish sections)
def foil(name, s_le, chord_root, chord_tip, z_root, z_tip, thick, sweepback, material):
    verts, rows = [], 9
    prof = []
    for k in range(12):
        u = k / 11
        yt = 5 * thick * (0.2969 * math.sqrt(u) - 0.126 * u - 0.3516 * u * u + 0.2843 * u ** 3 - 0.1036 * u ** 4)
        prof.append((u, yt))
    ring = [(u, y) for u, y in prof] + [(u, -y) for u, y in reversed(prof[1:-1])]
    for r in range(rows):
        v = r / (rows - 1)
        z = z_root + (z_tip - z_root) * v
        c = chord_root + (chord_tip - chord_root) * v
        y0 = Y(s_le) + sweepback * v
        for (u, t) in ring: verts.append((t * c, y0 + u * c, z))
    n = len(ring)
    faces = grid_faces(rows, n, True)
    faces.append(tuple(range(n - 1, -1, -1)))
    faces.append(tuple((rows - 1) * n + j for j in range(n)))
    return make_obj(name, verts, faces, [material])

foil('Keel', 0.565, 1.55, 1.05, canoe_bottom(0.52) + 0.05, -1.0, 0.11, 0.25, M['antifoul'])
ellipsoid('KeelBulb', (0, Y(0.5) + 0.2, -1.04), (0.17, 0.75, 0.13), M['antifoul'])
foil('Rudder', 0.115, 0.62, 0.42, canoe_bottom(0.1) + 0.05, -0.95, 0.12, 0.12, M['antifoul'])

# rubrail along the sheer, both sides
for side in (1, -1):
    pts = [(side * (half_beam(s) + 0.012), Y(s), sheer(s) - 0.06) for s in [0.004 + 0.99 * i / 60 for i in range(61)]]
    sweep('Rubrail', pts, [(-0.02, -0.03), (0.02, -0.03), (0.02, 0.03), (-0.02, 0.03)], M['black'])

# ----------------------------------------------------------------------------
# deck (teak, cambered, with a cockpit opening)
# ----------------------------------------------------------------------------
DS, DK = 70, 14
dv, df, dskip = [], [], set()
def deck_hw(s): return max(0.0, half_beam(s) - 0.035)
for i in range(DS + 1):
    s = 0.012 + 0.975 * i / DS
    for j in range(DK + 1):
        u = -1 + 2 * j / DK
        x = u * deck_hw(s)
        z = deck_z(s) + 0.055 * (1 - u * u)
        dv.append((x, Y(s), z))
cs0, cs1, chw = COCKPIT
for i in range(DS):
    s = 0.012 + 0.975 * (i + 0.5) / DS
    for j in range(DK):
        u = -1 + 2 * (j + 0.5) / DK
        a, b2 = i * (DK + 1) + j, (i + 1) * (DK + 1) + j
        xm = u * deck_hw(s)
        if cs0 < s < cs1 and abs(xm) < chw: continue  # cockpit opening
        df.append((a, b2, b2 + 1, a + 1))  # wound to face up
make_obj('Deck', dv, df, [M['teak']], uv=lambda co: (co.x / 0.9, co.y / 3.2), recalc=False)

# toe rails
for side in (1, -1):
    pts = [(side * (deck_hw(s) - 0.02), Y(s), deck_z(s) + 0.035) for s in [0.012 + 0.97 * i / 60 for i in range(61)]]
    sweep('ToeRail', pts, [(-0.025, -0.04), (0.025, -0.04), (0.02, 0.04), (-0.02, 0.04)], M['wood'])

# ----------------------------------------------------------------------------
# cockpit well, benches, coamings
# ----------------------------------------------------------------------------
yA, yF = Y(cs0), Y(cs1)
dz = deck_z(0.17)
box('CockpitFloor', (0, (yA + yF) / 2, COCKPIT_FLOOR - 0.02), (2 * chw, abs(yF - yA), 0.04), M['teak'])
for side in (1, -1):
    box('CockpitWall', (side * chw, (yA + yF) / 2, (COCKPIT_FLOOR + dz) / 2), (0.04, abs(yF - yA), dz - COCKPIT_FLOOR + 0.02), M['gelcoat'])
    box('Bench', (side * (chw - 0.21), (yA + yF) / 2 + 0.1, COCKPIT_FLOOR + 0.38), (0.42, abs(yF - yA) - 0.4, 0.05), M['teak'])
    box('BenchFront', (side * (chw - 0.43), (yA + yF) / 2 + 0.1, COCKPIT_FLOOR + 0.19), (0.04, abs(yF - yA) - 0.4, 0.38), M['gelcoat'])
    box('Coaming', (side * (chw + 0.06), (yA + yF) / 2 - 0.15, dz + 0.16), (0.05, abs(yF - yA) * 0.82, 0.32), M['wood'])
    for sw in (0.12, 0.27):  # sheet winches
        cylinder('Winch', (side * (chw + 0.2), Y(sw), dz + 0.09), 0.085, 0.18, M['steel'])
        cylinder('WinchTop', (side * (chw + 0.2), Y(sw), dz + 0.2), 0.06, 0.04, M['black'])
box('CockpitFront', (0, yF, (COCKPIT_FLOOR + dz) / 2), (2 * chw, 0.04, dz - COCKPIT_FLOOR + 0.02), M['gelcoat'])
box('CockpitAft', (0, yA, (COCKPIT_FLOOR + dz) / 2), (2 * chw, 0.04, dz - COCKPIT_FLOOR + 0.02), M['gelcoat'])
# tiller from the rudder head
rod('Tiller', (0, Y(0.06), dz - 0.05), (0, Y(0.24), dz + 0.32), 0.03, M['wood'])
ellipsoid('TillerGrip', (0, Y(0.245), dz + 0.33), (0.035, 0.09, 0.035), M['black'])

# ----------------------------------------------------------------------------
# cabin trunk with portlights, handrails, hatches, spray hood
# ----------------------------------------------------------------------------
ts0, ts1 = TRUNK
def trunk_hw(s):
    v = (s - ts0) / (ts1 - ts0)
    w = 1.0 - 0.32 * v
    if v > 0.82: w *= math.sqrt(max(0.0, 1 - ((v - 0.82) / 0.18) ** 2))
    return max(w, 0.0)
TS, TP = 40, 9
tv = []
for i in range(TS + 1):
    s = ts0 + (ts1 - ts0) * min(i / TS, 0.9999)
    hw, z0 = trunk_hw(s), deck_z(s) + 0.04
    prof = [(hw, z0), (hw * 0.97, z0 + TRUNK_H * 0.55), (hw * 0.93, z0 + TRUNK_H), (hw * 0.6, z0 + TRUNK_H + 0.04), (0, z0 + TRUNK_H + 0.055),
            (-hw * 0.6, z0 + TRUNK_H + 0.04), (-hw * 0.93, z0 + TRUNK_H), (-hw * 0.97, z0 + TRUNK_H * 0.55), (-hw, z0)]
    for (x, z) in prof: tv.append((x, Y(s), z))
tf = grid_faces(TS + 1, TP)
tf.append(tuple(range(TP - 1, -1, -1)))
tfm = [0] * len(tf)
for k, f in enumerate(tf):  # roof faces get the non-skid
    if all(tv[v][2] > deck_z(0.45) + TRUNK_H * 0.8 for v in f): tfm[k] = 1
make_obj('CabinTrunk', tv, tf, [M['gelcoat'], M['nonskid']], tfm)
for side in (1, -1):
    for ps in (0.39, 0.47, 0.55):  # elongated portlights with stainless frames
        hw = trunk_hw(ps)
        c = (side * (hw * 0.965 + 0.012), Y(ps), deck_z(ps) + 0.04 + TRUNK_H * 0.48)
        ellipsoid('Portlight', c, (0.02, 0.17, 0.065), M['glass'])
        ellipsoid('PortFrame', (c[0] - side * 0.006, c[1], c[2]), (0.016, 0.2, 0.085), M['steel'])
    # roof handrails
    hx = side * 0.55
    pts = [(hx, Y(s), deck_z(s) + 0.04 + TRUNK_H + 0.11) for s in [0.35 + 0.22 * i / 10 for i in range(11)]]
    sweep('Handrail', pts, [(-0.018, -0.022), (0.018, -0.022), (0.018, 0.022), (-0.018, 0.022)], M['wood'])
    for s in (0.36, 0.44, 0.52, 0.565):
        box('HandrailFoot', (hx, Y(s), deck_z(s) + 0.04 + TRUNK_H + 0.07), (0.035, 0.05, 0.09), M['wood'])
# companionway: sliding hatch and dropboards
roof_aft = deck_z(ts0) + 0.04 + TRUNK_H
box('SlidingHatch', (0, Y(ts0 + 0.05), roof_aft + 0.07), (0.8, 0.85, 0.09), M['gelcoat'], smooth=False)
box('Dropboards', (0, Y(ts0) + 0.005, deck_z(ts0) + 0.04 + TRUNK_H * 0.48), (0.62, 0.03, TRUNK_H * 0.9), M['wood'])
# forehatch
box('Forehatch', (0, Y(0.72), deck_z(0.72) + 0.1), (0.6, 0.6, 0.1), M['gelcoat'])
box('ForehatchLens', (0, Y(0.72), deck_z(0.72) + 0.153), (0.5, 0.5, 0.01), M['glass'])
# dorade vents
for side in (1, -1):
    cylinder('DoradeBox', (side * 0.45, Y(0.6), roof_aft + 0.06), 0.09, 0.1, M['gelcoat'])
    rod('Cowl', (side * 0.45, Y(0.6), roof_aft + 0.1), (side * 0.45, Y(0.6), roof_aft + 0.3), 0.06, M['red'])
# spray hood (canvas dodger) over the companionway, with a clear window
SH = []
n_arc = 14
for ring_s, h, wf in ((ts0 + 0.01, 0.62, 0.98), (ts0 - 0.055, 0.66, 0.92), (ts0 - 0.11, 0.6, 0.85)):
    hw = trunk_hw(ts0) * wf
    z0 = deck_z(ring_s) + 0.04 + (TRUNK_H if ring_s >= ts0 else 0.0)
    for k in range(n_arc + 1):
        a = math.pi * k / n_arc
        SH.append((hw * math.cos(a), Y(ring_s), roof_aft + h * math.sin(a) * 0.9 if ring_s < ts0 else z0 + h * math.sin(a) * 0.7))
make_obj('SprayHood', SH, grid_faces(3, n_arc + 1), [M['canvas']], recalc=False)
box('HoodWindow', (0, Y(ts0 + 0.008), roof_aft + 0.42), (0.9, 0.012, 0.18), M['glass'])

# ----------------------------------------------------------------------------
# spars and rigging
# ----------------------------------------------------------------------------
mast_base = deck_z(MAST_S) + 0.04 + TRUNK_H + 0.05
mast_top = deck_z(MAST_S) + MAST_H
mpts = [(0, Y(MAST_S), mast_base + (mast_top - mast_base) * i / 12) for i in range(13)]
mast_prof = [(0.075 * math.cos(a), 0.055 * math.sin(a)) for a in [2 * math.pi * i / 14 for i in range(14)]]
sweep('Mast', mpts, mast_prof, M['spar'])
box('Masthead', (0, Y(MAST_S) + 0.05, mast_top + 0.04), (0.12, 0.3, 0.08), M['spar'])
rod('Windex', (0, Y(MAST_S), mast_top + 0.08), (0, Y(MAST_S), mast_top + 0.55), 0.008, M['black'])
spreader_z = deck_z(MAST_S) + MAST_H * 0.55
for side in (1, -1):
    rod('Spreader', (0, Y(MAST_S), spreader_z), (side * 0.85, Y(MAST_S) + 0.06, spreader_z + 0.06), 0.022, M['spar'])
chain = {side: (side * (deck_hw(MAST_S - 0.01) - 0.06), Y(MAST_S - 0.01), deck_z(MAST_S - 0.01) + 0.05) for side in (1, -1)}
W = 0.009
for side in (1, -1):
    tip = (side * 0.85, Y(MAST_S) + 0.06, spreader_z + 0.06)
    rod('UpperShroud', (0, Y(MAST_S), mast_top - 0.1), tip, W, M['wire'], 6)
    rod('UpperShroudLow', tip, chain[side], W, M['wire'], 6)
    rod('LowerShroud', (side * 0.05, Y(MAST_S), spreader_z - 0.05), (chain[side][0], chain[side][1] - 0.35, chain[side][2]), W, M['wire'], 6)
stem_head = (0, Y(0.995), sheer(0.995) + 0.05)
rod('Forestay', (0, Y(MAST_S) - 0.06, mast_top - 0.05), stem_head, W, M['wire'], 6)
rod('Backstay', (0, Y(MAST_S) + 0.08, mast_top), (0, Y(0.012), sheer(0.012) + 0.08), W, M['wire'], 6)
# furled headsail on the forestay
fa, fb = Vector((0, Y(MAST_S) - 0.06, mast_top - 0.05)), Vector(stem_head)
fur = [tuple(fa.lerp(fb, t)) for t in (0.05, 0.25, 0.5, 0.75, 0.93)]
sweep('FurledJib', fur, circle(0.035, 10)[:], M['canvas'])
for k, t in enumerate((0.35, 0.65, 0.9)):
    p = fa.lerp(fb, t)
    sweep('JibCover', [tuple(p), tuple(p + (fb - fa).normalized() * 0.001)], circle(0.075 - 0.015 * k, 12), M['canvas'])

# boom on a pivot node the game rotates (sail is added by the game, as on procedural rigs)
pivot = bpy.data.objects.new('BoomPivot', None)
scene.collection.objects.link(pivot); pivot.parent = root
pivot.location = (0, Y(MAST_S) + 0.09, deck_z(MAST_S) + 1.0)
boom_prof = [(0.05 * math.cos(a), 0.07 * math.sin(a)) for a in [2 * math.pi * i / 12 for i in range(12)]]
sweep('Boom', [(0, 0, 0), (0, BOOM_LEN, 0)], boom_prof, M['spar'], parent=pivot)
# sail cover / lazy-jack bag when furled is drawn by the game's sail; boom vang
rod('Vang', (0, Y(MAST_S) + 0.08, mast_base + 0.05), (0, Y(MAST_S) + 0.09 + 1.0, deck_z(MAST_S) + 0.98), 0.02, M['spar'])

# ----------------------------------------------------------------------------
# rails, stanchions, lifelines, fittings
# ----------------------------------------------------------------------------
stan_s = [0.08, 0.2, 0.33, 0.46, 0.58, 0.7, 0.8]
rail_h = 0.62
for side in (1, -1):
    tops = []
    for s in stan_s:
        x = side * (deck_hw(s) - 0.07)
        base = (x, Y(s), deck_z(s) + 0.03)
        topp = (x * 1.01, Y(s), deck_z(s) + rail_h)
        rod('Stanchion', base, topp, 0.014, M['steel'])
        cylinder('StanchionBase', (x, Y(s), deck_z(s) + 0.05), 0.03, 0.04, M['steel'])
        tops.append(topp)
    for hh in (0.0, -0.28):
        tube('Lifeline', [(p[0], p[1], p[2] + hh) for p in tops], 0.006, M['wire'], 6)
# bow pulpit and stern pushpit
pul = []
for k in range(15):
    a = math.pi * k / 14
    s = 0.86 + 0.12 * math.sin(a) ** 0.6
    x = math.cos(a) * (deck_hw(0.86) - 0.07) * (1 - 0.6 * math.sin(a) ** 2)
    pul.append((x, Y(s), deck_z(s) + rail_h))
tube('BowPulpit', pul, 0.016, M['steel'])
for p in (pul[0], pul[-1], pul[4], pul[-5]):
    rod('PulpitLeg', (p[0], p[1], p[2] - rail_h + 0.03), p, 0.014, M['steel'])
push = []
for k in range(17):
    a = math.pi * k / 16
    x = math.cos(a) * (deck_hw(0.02) - 0.06)
    s = 0.012 + 0.07 * (1 - math.sin(a)) * 0 + 0.0
    push.append((x, Y(0.015) - 0.02 * math.sin(a), deck_z(0.02) + rail_h + 0.05))
push = [(deck_hw(0.08) - 0.07, Y(0.08), deck_z(0.08) + rail_h)] + push + [(-(deck_hw(0.08) - 0.07), Y(0.08), deck_z(0.08) + rail_h)]
tube('Pushpit', push, 0.016, M['steel'])
for p in push[1:-1:4]:
    rod('PushpitLeg', (p[0] * 0.95, p[1], p[2] - rail_h - 0.02), p, 0.014, M['steel'])
# life ring on the pushpit, nav lights, cleats, anchor
ring_c = (deck_hw(0.03) - 0.1, Y(0.03) + 0.02, deck_z(0.03) + rail_h - 0.1)
rv = []
for i in range(24):
    a = 2 * math.pi * i / 24
    rv.append((ring_c[0] + 0.02, ring_c[1] + 0.26 * math.cos(a), ring_c[2] + 0.26 * math.sin(a)))
tube('LifeRing', rv + [rv[0]], 0.055, M['orange'])
box('NavLightPort', (0.12, Y(0.975), deck_z(0.97) + rail_h + 0.02), (0.05, 0.08, 0.05), M['red'])
box('NavLightStbd', (-0.12, Y(0.975), deck_z(0.97) + rail_h + 0.02), (0.05, 0.08, 0.05), M['green'])
for s in (0.03, 0.93):
    for side in (1, -1):
        box('Cleat', (side * (deck_hw(s) - 0.18), Y(s), deck_z(s) + 0.05), (0.05, 0.22, 0.04), M['steel'])
box('BowRoller', (0, Y(0.995) - 0.12, sheer(0.995) + 0.02), (0.12, 0.4, 0.1), M['steel'])
# fenders hanging over the starboard side
for s in (0.4, 0.55):
    x = -(half_beam(s) + 0.1)
    cylinder('Fender', (x, Y(s), 0.55), 0.11, 0.5, M['fender'])
    rod('FenderLine', (x, Y(s), 0.8), (-(deck_hw(s) - 0.07), Y(s), deck_z(s) + 0.3), 0.005, M['black'], 4)

# ----------------------------------------------------------------------------
# water mask lid (game replaces its material with a depth-only one)
# ----------------------------------------------------------------------------
mv = []
for i in range(41):
    s = 0.004 + 0.992 * i / 40
    mv += [(half_beam(s), Y(s), sheer(s) - 0.02), (-half_beam(s), Y(s), sheer(s) - 0.02)]
mfaces = [(2 * i, 2 * i + 1, 2 * i + 3, 2 * i + 2) for i in range(40)]
mask = make_obj('WaterMask', mv, mfaces, [M['mask']], smooth=False, recalc=False)

# ----------------------------------------------------------------------------
# ambient occlusion baked into vertex colours (exported as COLOR_0, multiplies albedo)
# ----------------------------------------------------------------------------
scene.render.engine = 'CYCLES'
scene.cycles.device = 'CPU'
scene.cycles.samples = 24
world = bpy.data.worlds.new('W'); scene.world = world
world.use_nodes = True
world.node_tree.nodes['Background'].inputs['Color'].default_value = (1, 1, 1, 1)
mask.hide_render = True
bake_skip = {'WaterMask'}
thin = ('Rigging', 'Stainless', 'Rubber')
for ob in parts:
    if ob.name.split('.')[0] in bake_skip: continue
    me = ob.data
    if not me.color_attributes:
        me.color_attributes.new('Col', 'BYTE_COLOR', 'CORNER')
    me.color_attributes.active_color = me.color_attributes[0]
    if len(me.vertices) < 24 or (me.materials and me.materials[0].name.startswith(thin)):
        # tiny/thin parts: flat white (no occlusion)
        for d in me.color_attributes[0].data: d.color = (1, 1, 1, 1)
        continue
    bpy.ops.object.select_all(action='DESELECT')
    ob.select_set(True); bpy.context.view_layer.objects.active = ob
    try:
        bpy.ops.object.bake(type='AO', target='VERTEX_COLORS')
    except Exception as e:
        print('bake failed for', ob.name, e)
        for d in me.color_attributes[0].data: d.color = (1, 1, 1, 1)
baked = [(ob.name, min(d.color[0] for d in ob.data.color_attributes[0].data)) for ob in parts if ob.data.color_attributes and len(ob.data.vertices) >= 24]
print('BAKE darkest AO per part (sample):', [(n, round(v, 2)) for n, v in baked[:12]])
# soften the bake: AO -> 0.45..1 so crevices darken without going black
for ob in parts:
    me = ob.data
    if not me.color_attributes: continue
    for d in me.color_attributes[0].data:
        c = d.color[0]
        v = 0.45 + 0.55 * c
        d.color = (v, v, v, 1)

# ----------------------------------------------------------------------------
# gameplay data -> glTF extras (GAME coordinates: x = X, y = Z, z = -Y)
# ----------------------------------------------------------------------------
def G(x, y, z): return [round(x, 3), round(z, 3), round(-y, 3)]
walk = []
for i in range(31):
    s = 0.03 + 0.93 * i / 30
    zz = -Y(s)
    if cs0 < s < cs1:
        walk.append([round(zz, 3), round(deck_hw(s) - 0.12, 3), round(COCKPIT_FLOOR, 3)])
    else:
        walk.append([round(zz, 3), round(deck_hw(s) - 0.12, 3), round(deck_z(s) + 0.05, 3)])
obstacles = []
def ob_box(x0, x1, s0, s1, top):
    zs = sorted([-Y(s0), -Y(s1)])
    obstacles.append({'minx': round(x0, 3), 'maxx': round(x1, 3), 'minz': round(zs[0], 3), 'maxz': round(zs[1], 3), 'top': round(top, 3)})
# side decks beside the cockpit and the benches: platforms (step up from the cockpit floor)
for side in (1, -1):
    xin, xout = sorted([side * chw, side * (deck_hw(0.17) - 0.1)])
    ob_box(xin, xout, cs0, cs1, deck_z(0.17) + 0.05)
    xb0, xb1 = sorted([side * chw, side * (chw - 0.42)])
    ob_box(xb0, xb1, cs0 + 0.02, cs1 - 0.02, COCKPIT_FLOOR + 0.4)
# cabin trunk: a platform you can climb onto from the side deck
ob_box(-trunk_hw(0.45), trunk_hw(0.45), ts0, ts1 - 0.03, deck_z(0.45) + 0.04 + TRUNK_H + 0.04)
# mast and spray hood: walls
ob_box(-0.12, 0.12, MAST_S - 0.012, MAST_S + 0.012, mast_top)
ob_box(-trunk_hw(ts0) * 0.9, trunk_hw(ts0) * 0.9, ts0 - 0.11, ts0 - 0.005, 2.0)
extras = {
    'floatilla': 1, 'length': L, 'beam': B,
    'deckY': round(DECK_MID + 0.05, 3), 'cockpitFloor': round(COCKPIT_FLOOR, 3),
    'helm': G(0, Y(0.07), COCKPIT_FLOOR),
    'mast': G(0, Y(MAST_S), deck_z(MAST_S)),
    'mastH': MAST_H, 'boomLen': BOOM_LEN,
    'walk': walk, 'obstacles': obstacles,
    'zone': [round(-Y(0.33), 3), round(-Y(0.6), 3)],
    'transom': G(0, Y(0.004), 0.5),
}
root['floatilla'] = json.dumps(extras)

# ----------------------------------------------------------------------------
# export (+ optional preview render)
# ----------------------------------------------------------------------------
os.makedirs(os.path.dirname(os.path.abspath(OUT)), exist_ok=True)
bpy.ops.object.select_all(action='SELECT')
bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB', export_yup=True, export_apply=True,
                          export_colors=True, export_extras=True, export_image_format='JPEG', export_image_quality=88,
                          export_materials='EXPORT', use_selection=False)
print('EXPORTED', OUT, os.path.getsize(OUT), 'bytes,', len(parts), 'parts,',
      sum(len(o.data.polygons) for o in parts), 'faces')

if PREVIEW:
    mask.hide_render = True
    sky = world.node_tree.nodes.new('ShaderNodeTexSky'); sky.sky_type = 'NISHITA'; sky.sun_elevation = math.radians(28); sky.sun_rotation = math.radians(130)
    world.node_tree.links.new(sky.outputs['Color'], world.node_tree.nodes['Background'].inputs['Color'])
    world.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.25
    sea = bpy.data.meshes.new('sea'); sea.from_pydata([(-60, -60, 0), (60, -60, 0), (60, 60, 0), (-60, 60, 0)], [], [(0, 1, 2, 3)])
    so = bpy.data.objects.new('sea', sea); scene.collection.objects.link(so)
    sm = mat('SeaPreview', (0.02, 0.07, 0.09), 0.08); sea.materials.append(sm)
    cam_data = bpy.data.cameras.new('cam'); cam_data.lens = 35
    cam = bpy.data.objects.new('cam', cam_data); scene.collection.objects.link(cam)
    cam.location = (9.5, -11.0, 5.2)
    d = Vector((0, -0.5, 2.6)) - cam.location
    cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
    scene.camera = cam
    scene.render.resolution_x, scene.render.resolution_y = 1280, 800
    scene.cycles.samples = 48
    scene.cycles.use_denoising = False  # Debian's Blender is built without OpenImageDenoise
    scene.render.filepath = PREVIEW
    bpy.ops.render.render(write_still=True)
    print('PREVIEW', PREVIEW)
