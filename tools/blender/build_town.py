"""
Floatilla — town kit: houses, shops, warehouses, pier and quay modules, containers, cars, trees.

    blender -b --python tools/blender/build_town.py -- public/models [previewDir]

Every asset becomes two meshes in one GLB: <name>_LOD0 (detailed) and <name>_LOD1 (a few boxes for
distance). Conventions: Blender Z up, the asset's FRONT faces -Y (game +z), origin at the centre of the
footprint on the ground (Z = 0); for piers and quays Z = 0 is the deck / coping top.
Per vertex: COLOR_0 = base colour x baked ambient occlusion; TEXCOORD_0.x = part id
  0 fixed colour, 1 wall (tinted per instance), 2 roof (tinted), 3 glass (lit at night), 4 lamp, 5 foliage (tinted)
Each LOD0 carries its authored size in the "floatilla" extra.
"""
import bpy, bmesh, math, json, os, sys, random
from mathutils import Vector, Matrix

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT_DIR = argv[0] if argv else 'public/models'
PREV_DIR = argv[1] if len(argv) > 1 else None

NEUTRAL, WALL, ROOF, GLASS, LAMP, LEAF = 0, 1, 2, 3, 4, 5


def lin(c):
    """sRGB 0..1 → linear."""
    return tuple(((v + 0.055) / 1.055) ** 2.4 if v > 0.04045 else v / 12.92 for v in c)


def hexc(h):
    return lin((((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255))


# base colours (wall/roof/leaf parts are near-white so the per-instance tint carries the colour)
WHITE = (0.92, 0.92, 0.92)
TRIM = hexc(0xeeeae0)
GLASSC = hexc(0x1d2a33)
DOORC = hexc(0x5a3d2a)
STONE = hexc(0x8d8a84)
STONE2 = hexc(0x76736d)
CONCRETE = hexc(0xa3a19b)
DARK = hexc(0x2a2a2c)
METAL = hexc(0x8a9096)
TIMBER = hexc(0x6e5641)
TIMBER2 = hexc(0x584433)
PILE = hexc(0x3f3328)
BRICKC = hexc(0x9a5b45)
RUBBER = hexc(0x1b1b1b)
CHIMNEY = hexc(0x8a5040)
AWNING = hexc(0x2f6b5a)
BARK = hexc(0x4a3828)
LAMPC = (1.0, 0.92, 0.7)


class Kit:
    def __init__(self):
        bpy.ops.wm.read_factory_settings(use_empty=True)
        self.scene = bpy.context.scene
        self.cur = []          # objects of the asset being built
        self.assets = []       # (name, lod, joined object, extras)
        random.seed(5)

    # ---- primitive mesh creation ---------------------------------------------------------
    def mesh(self, verts, faces, part, color, smooth=False, jitter=0.0):
        me = bpy.data.meshes.new('m')
        me.from_pydata([tuple(v) for v in verts], [], faces)
        me.validate(); me.update()
        bm = bmesh.new(); bm.from_mesh(me)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        bm.to_mesh(me); bm.free()
        for p in me.polygons: p.use_smooth = smooth
        ob = bpy.data.objects.new('p', me)
        self.scene.collection.objects.link(ob)
        col = me.color_attributes.new('Col', 'FLOAT_COLOR', 'CORNER')
        uv = me.uv_layers.new(name='UVMap')
        c = color
        for poly in me.polygons:
            k = 1.0 + (random.uniform(-jitter, jitter) if jitter else 0.0)
            for li in poly.loop_indices:
                col.data[li].color = (c[0] * k, c[1] * k, c[2] * k, 1)
                uv.data[li].uv = (part + 0.5, 0.5)
        self.cur.append(ob)
        return ob

    def box(self, c, s, part, color, rz=0.0, jitter=0.0):
        cx, cy, cz = c; hx, hy, hz = s[0] / 2, s[1] / 2, s[2] / 2
        v = [Vector((x * hx, y * hy, z * hz)) for x in (-1, 1) for y in (-1, 1) for z in (-1, 1)]
        R = Matrix.Rotation(rz, 3, 'Z')
        v = [R @ p + Vector((cx, cy, cz)) for p in v]
        f = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
        return self.mesh(v, f, part, color, jitter=jitter)

    def cyl(self, a, b, r0, part, color, n=10, r1=None, cap=True, smooth=True):
        a, b = Vector(a), Vector(b); r1 = r0 if r1 is None else r1
        t = (b - a).normalized(); up = Vector((0, 0, 1)) if abs(t.z) < 0.9 else Vector((1, 0, 0))
        u = t.cross(up).normalized(); w = t.cross(u).normalized()
        v = []
        for (p, r) in ((a, r0), (b, r1)):
            for i in range(n):
                ang = 2 * math.pi * i / n
                v.append(p + (u * math.cos(ang) + w * math.sin(ang)) * r)
        f = [(i, (i + 1) % n, n + (i + 1) % n, n + i) for i in range(n)]
        if cap: f += [tuple(range(n - 1, -1, -1)), tuple(range(n, 2 * n))]
        return self.mesh(v, f, part, color, smooth=smooth)

    def sphere(self, c, r, part, color, n=8, m=5, squash=1.0, noise=0.0):
        v = []
        for i in range(m + 1):
            th = math.pi * i / m
            for j in range(n):
                ph = 2 * math.pi * j / n
                k = 1 + random.uniform(-noise, noise) if 0 < i < m else 1
                v.append((c[0] + r * k * math.sin(th) * math.cos(ph), c[1] + r * k * math.sin(th) * math.sin(ph), c[2] + r * squash * k * math.cos(th)))
        f = []
        for i in range(m):
            for j in range(n):
                j2 = (j + 1) % n
                f.append((i * n + j, i * n + j2, (i + 1) * n + j2, (i + 1) * n + j))
        return self.mesh(v, f, part, color, smooth=True)

    # ---- architectural pieces ------------------------------------------------------------
    def walls(self, w, d, z0, z1, part=WALL, color=WHITE, t=0.25):
        """Four walls as one closed box (the interior is never seen)."""
        self.box((0, 0, (z0 + z1) / 2), (w, d, z1 - z0), part, color)

    def gable_roof(self, w, d, z0, hr, oh=0.45, ridge='X', thick=0.16, gable_part=WALL, gable_color=WHITE):
        """Pitched roof with eaves overhang; triangular gable ends filled with wall."""
        if ridge == 'X':
            L, S = w / 2 + oh, d / 2 + oh  # half length along ridge, half span
            v = [(-L, -S, z0 - oh * hr / (d / 2)), (L, -S, z0 - oh * hr / (d / 2)), (L, 0, z0 + hr), (-L, 0, z0 + hr),
                 (-L, S, z0 - oh * hr / (d / 2)), (L, S, z0 - oh * hr / (d / 2))]
        else:
            L, S = d / 2 + oh, w / 2 + oh
            v = [(-S, -L, z0 - oh * hr / (w / 2)), (-S, L, z0 - oh * hr / (w / 2)), (0, L, z0 + hr), (0, -L, z0 + hr),
                 (S, -L, z0 - oh * hr / (w / 2)), (S, L, z0 - oh * hr / (w / 2))]
        top = [Vector(p) for p in v]
        bot = [p - Vector((0, 0, thick)) for p in top]
        verts = top + bot
        # slopes (top and underside) and edges
        f = [(0, 1, 2, 3), (3, 2, 5, 4), (6, 9, 8, 7), (9, 10, 11, 8),
             (0, 6, 7, 1), (4, 5, 11, 10), (0, 3, 9, 6), (3, 4, 10, 9), (1, 7, 8, 2), (2, 8, 11, 5)]
        self.mesh(verts, f, ROOF, WHITE, jitter=0.0)
        # gable triangles
        if ridge == 'X':
            for sx in (-1, 1):
                x = sx * w / 2
                self.mesh([(x, -d / 2, z0), (x, d / 2, z0), (x, 0, z0 + hr * (1 - 0.02))], [(0, 1, 2)], gable_part, gable_color)
        else:
            for sy in (-1, 1):
                y = sy * d / 2
                self.mesh([(-w / 2, y, z0), (w / 2, y, z0), (0, y, z0 + hr * (1 - 0.02))], [(0, 1, 2)], gable_part, gable_color)

    def hip_roof(self, w, d, z0, hr, oh=0.5, thick=0.16):
        L, S = w / 2 + oh, d / 2 + oh
        drop = oh * hr / (min(w, d) / 2)
        r = max(0.0, (w - d) / 2) if w >= d else 0.0
        rr = max(0.0, (d - w) / 2) if d > w else 0.0
        top = [(-L, -S, z0 - drop), (L, -S, z0 - drop), (L, S, z0 - drop), (-L, S, z0 - drop), (-r, -rr, z0 + hr), (r, rr, z0 + hr)]
        if w >= d:
            faces = [(0, 1, 5, 4), (1, 2, 5), (2, 3, 4, 5), (3, 0, 4)]
        else:
            faces = [(0, 1, 4), (1, 2, 5, 4), (2, 3, 5), (3, 0, 4, 5)]
        v = [Vector(p) for p in top]
        verts = v + [p - Vector((0, 0, thick)) for p in v[:4]]
        faces += [(0, 6, 7, 1)[::-1], (1, 7, 8, 2)[::-1], (2, 8, 9, 3)[::-1], (3, 9, 6, 0)[::-1], (6, 7, 8, 9)]
        self.mesh(verts, faces, ROOF, WHITE)

    def window(self, side, u, z, ww, wh, w, d, depth=0.08, sill=True, shutters=None, mull=True):
        """A framed window on a wall face. side: 'F' (-Y), 'B' (+Y), 'L' (-X), 'R' (+X); u = position along the face."""
        f = 0.07
        def place(lu, lz, sx, sz, out, part, color, thick):
            if side in 'FB':
                y = (-d / 2 if side == 'F' else d / 2) + (-out if side == 'F' else out)
                self.box((lu, y, lz), (sx, thick, sz), part, color)
            else:
                x = (-w / 2 if side == 'L' else w / 2) + (-out if side == 'L' else out)
                self.box((x, lu, lz), (thick, sx, sz), part, color)
        place(u, z, ww, wh, 0.0, GLASS, GLASSC, 0.04)                                   # pane, flush
        for (lu, lz, sx, sz) in ((u, z + wh / 2 + f / 2, ww + 2 * f, f), (u, z - wh / 2 - f / 2, ww + 2 * f, f),
                                 (u - ww / 2 - f / 2, z, f, wh), (u + ww / 2 + f / 2, z, f, wh)):
            place(lu, lz, sx, sz, depth / 2, NEUTRAL, TRIM, depth)
        if mull:
            place(u, z, 0.04, wh, 0.03, NEUTRAL, TRIM, 0.04)
            if wh > 0.9: place(u, z + wh * 0.12, ww, 0.04, 0.03, NEUTRAL, TRIM, 0.04)
        if sill: place(u, z - wh / 2 - f - 0.03, ww + 0.3, 0.06, 0.12, NEUTRAL, TRIM, 0.22)
        if shutters is not None:
            for s in (-1, 1): place(u + s * (ww / 2 + f + ww * 0.25), z, ww * 0.45, wh + 0.05, 0.05, NEUTRAL, shutters, 0.05)

    def door(self, side, u, w, d, dw=1.0, dh=2.1, color=DOORC, z0=0.0):
        f = 0.09
        y = -d / 2 if side == 'F' else d / 2
        sgn = -1 if side == 'F' else 1
        self.box((u, y + sgn * 0.02, z0 + dh / 2), (dw, 0.06, dh), NEUTRAL, color)
        for (lu, lz, sx, sz) in ((u, z0 + dh + f / 2, dw + 2 * f, f), (u - dw / 2 - f / 2, z0 + dh / 2, f, dh), (u + dw / 2 + f / 2, z0 + dh / 2, f, dh)):
            self.box((lu, y + sgn * 0.05, lz), (sx, 0.1, sz), NEUTRAL, TRIM)
        self.box((u, y + sgn * 0.55, z0 - 0.08), (dw + 0.8, 1.0, 0.16), NEUTRAL, CONCRETE)  # step
        self.box((u + dw * 0.32, y + sgn * 0.07, z0 + dh * 0.5), (0.06, 0.06, 0.06), NEUTRAL, METAL)  # knob

    def plinth(self, w, d, h=0.45, color=STONE2):
        self.box((0, 0, h / 2 - 0.25), (w + 0.12, d + 0.12, h + 0.5), NEUTRAL, color)

    def chimney(self, x, y, z0, z1):
        self.box((x, y, (z0 + z1) / 2), (0.6, 0.6, z1 - z0), NEUTRAL, CHIMNEY, jitter=0.03)
        self.box((x, y, z1 + 0.06), (0.75, 0.75, 0.12), NEUTRAL, STONE)
        self.cyl((x, y, z1), (x, y, z1 + 0.35), 0.1, NEUTRAL, DARK, n=6)

    def gutter(self, w, d, z, ridge='X'):
        if ridge == 'X':
            for s in (-1, 1): self.cyl((-w / 2 - 0.4, s * (d / 2 + 0.38), z), (w / 2 + 0.4, s * (d / 2 + 0.38), z), 0.06, NEUTRAL, TRIM, n=6)
            for s in (-1, 1): self.cyl((w / 2 + 0.25, s * (d / 2 + 0.38), z), (w / 2 + 0.25, s * (d / 2 + 0.38), 0.1), 0.045, NEUTRAL, TRIM, n=6)

    # ---- finishing: join, bake AO into vertex colours, record ----------------------------
    def finish(self, name, lod, extras=None, ground=True, ao=True):
        objs = self.cur; self.cur = []
        bpy.ops.object.select_all(action='DESELECT')
        for o in objs: o.select_set(True)
        bpy.context.view_layer.objects.active = objs[0]
        bpy.ops.object.join()
        ob = bpy.context.active_object
        ob.name = f'{name}_LOD{lod}'
        me = ob.data
        if not me.materials:
            m = bpy.data.materials.get('Kit') or bpy.data.materials.new('Kit')
            me.materials.append(m)
        if ao:
            g = None
            if ground:
                gm = bpy.data.meshes.new('g'); s = 60
                gm.from_pydata([(-s, -s, 0), (s, -s, 0), (s, s, 0), (-s, s, 0)], [], [(0, 1, 2, 3)])
                g = bpy.data.objects.new('ground', gm); self.scene.collection.objects.link(g)
            aoc = me.color_attributes.new('AO', 'FLOAT_COLOR', 'CORNER')
            me.color_attributes.active_color = aoc
            bpy.ops.object.select_all(action='DESELECT'); ob.select_set(True); bpy.context.view_layer.objects.active = ob
            sc = self.scene
            sc.render.engine = 'CYCLES'; sc.cycles.device = 'CPU'; sc.cycles.samples = 24
            if not sc.world:
                wd = bpy.data.worlds.new('W'); sc.world = wd; wd.use_nodes = True
                wd.node_tree.nodes['Background'].inputs['Color'].default_value = (1, 1, 1, 1)
            sc.world.light_settings.distance = 3.0
            bpy.ops.object.bake(type='AO', target='VERTEX_COLORS')
            col = me.color_attributes['Col']
            for i, d in enumerate(aoc.data):
                a = 0.4 + 0.6 * d.color[0]
                c = col.data[i].color
                col.data[i].color = (c[0] * a, c[1] * a, c[2] * a, 1)
            me.color_attributes.remove(aoc)
            if g: bpy.data.objects.remove(g)
        me.color_attributes.active_color = me.color_attributes['Col']
        if extras: ob['floatilla'] = json.dumps(extras)
        ob.location.x = 0
        ob.hide_set(True); ob.hide_render = True  # out of the way of later bakes
        self.assets.append(ob)
        return ob

    def export(self, path):
        for o in self.assets: o.hide_set(False); o.hide_render = False
        bpy.ops.object.select_all(action='DESELECT')
        for o in self.assets: o.select_set(True)
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', export_yup=True, export_apply=True, export_colors=True,
                                  export_extras=True, export_materials='NONE', use_selection=True, export_normals=True)
        tris = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in self.assets if o.name.endswith('LOD0'))
        print('EXPORTED', path, os.path.getsize(path), 'bytes', len(self.assets), 'meshes', tris, 'LOD0 triangles')


K = Kit()


# =========================================================================================
# Houses. Footprint W (x) x D (y), wall height H, roof height Hr.
# =========================================================================================
def lod1_house(name, w, d, H, hr, ridge='X', hip=False):
    K.walls(w, d, 0, H)
    for side, u in (('F', -w * 0.22), ('F', w * 0.22)): K.box((u, -d / 2 - 0.02, H * 0.55), (1.0, 0.05, 1.1), GLASS, GLASSC)
    if hip: K.hip_roof(w, d, H, hr, oh=0.4, thick=0.1)
    else: K.gable_roof(w, d, H, hr, oh=0.4, ridge=ridge, thick=0.1)
    K.finish(name, 1, ao=False)


def house_cottage():
    w, d, H, hr = 8.0, 7.0, 3.1, 2.6
    K.plinth(w, d)
    K.walls(w, d, 0.2, H)
    K.gable_roof(w, d, H, hr, ridge='X')
    K.door('F', -1.2, w, d)
    K.window('F', 1.8, 1.55, 1.3, 1.2, w, d, shutters=hexc(0x3b5a6b))
    K.window('F', -3.0, 1.55, 0.8, 1.0, w, d)
    for u in (-1.8, 1.8): K.window('B', u, 1.55, 1.0, 1.0, w, d)
    K.window('L', 0.0, 1.55, 1.0, 1.0, w, d); K.window('R', 0.8, 1.55, 1.0, 1.0, w, d)
    # porch over the door
    K.box((-1.2, -d / 2 - 0.9, 2.55), (2.4, 1.9, 0.12), ROOF, WHITE)
    for s in (-1, 1): K.cyl((-1.2 + s * 1.05, -d / 2 - 1.7, 0.0), (-1.2 + s * 1.05, -d / 2 - 1.7, 2.5), 0.07, NEUTRAL, TRIM, n=6)
    K.chimney(w / 2 - 1.2, 0.9, H + 0.5, H + hr + 0.4)
    K.gutter(w, d, H - 0.25)
    K.finish('house_cottage', 0, {'w': w, 'd': d, 'h': H, 'roof': hr})
    lod1_house('house_cottage', w, d, H, hr)


def house_two():
    w, d, H, hr = 8.0, 8.0, 5.8, 2.8
    K.plinth(w, d)
    K.walls(w, d, 0.2, H)
    K.box((0, 0, 2.95), (w + 0.1, d + 0.1, 0.14), NEUTRAL, TRIM)       # floor band
    K.gable_roof(w, d, H, hr, ridge='X')
    K.door('F', 0.0, w, d, dw=1.05)
    K.box((0, -d / 2 - 0.5, 2.45), (1.8, 1.0, 0.1), ROOF, WHITE)       # door canopy
    for u in (-2.4, 2.4): K.window('F', u, 1.55, 1.2, 1.25, w, d, shutters=hexc(0x40553a))
    for u in (-2.4, 0.0, 2.4): K.window('F', u, 4.35, 1.0, 1.15, w, d)
    for u in (-2.0, 2.0):
        K.window('B', u, 1.55, 1.1, 1.1, w, d); K.window('B', u, 4.35, 1.0, 1.1, w, d)
    for side in 'LR':
        K.window(side, -1.5, 1.55, 0.9, 1.0, w, d); K.window(side, 1.5, 4.35, 0.9, 1.0, w, d)
    K.chimney(-w / 2 + 1.1, 1.2, H + 0.6, H + hr + 0.5)
    K.gutter(w, d, H - 0.25)
    K.finish('house_two', 0, {'w': w, 'd': d, 'h': H, 'roof': hr})
    lod1_house('house_two', w, d, H, hr)


def house_hip():
    w, d, H, hr = 9.0, 8.0, 5.6, 2.4
    K.plinth(w, d)
    K.walls(w, d, 0.2, H)
    K.hip_roof(w, d, H, hr)
    # full-width front porch with railing
    K.box((0, -d / 2 - 1.1, 0.25), (w, 2.2, 0.3), NEUTRAL, TIMBER)
    K.box((0, -d / 2 - 1.15, 2.85), (w + 0.4, 2.5, 0.14), ROOF, WHITE)
    for u in (-w / 2 + 0.2, -w / 6, w / 6, w / 2 - 0.2): K.cyl((u, -d / 2 - 2.05, 0.4), (u, -d / 2 - 2.05, 2.8), 0.08, NEUTRAL, TRIM, n=6)
    for s in (-1, 1): K.box((s * (w / 4 + 0.6), -d / 2 - 2.05, 1.25), (w / 2 - 1.6, 0.06, 0.06), NEUTRAL, TRIM)
    for s in (-1, 1):
        for k in range(9): K.box((s * (1.2 + k * 0.33), -d / 2 - 2.05, 0.85), (0.04, 0.04, 0.8), NEUTRAL, TRIM)
    K.door('F', 0.0, w, d, z0=0.4)
    for u in (-2.7, 2.7): K.window('F', u, 1.9, 1.3, 1.3, w, d)
    for u in (-2.7, 0, 2.7): K.window('F', u, 4.4, 1.0, 1.0, w, d)
    for u in (-2.5, 2.5): K.window('B', u, 1.9, 1.1, 1.1, w, d); K.window('B', u, 4.4, 1.0, 1.0, w, d)
    for side in 'LR': K.window(side, 0, 1.9, 1.0, 1.1, w, d); K.window(side, 0, 4.4, 1.0, 1.0, w, d)
    K.chimney(w / 2 - 1.6, -0.5, H + 0.6, H + hr + 0.3)
    K.finish('house_hip', 0, {'w': w, 'd': d, 'h': H, 'roof': hr})
    lod1_house('house_hip', w, d, H, hr, hip=True)


def house_bungalow():
    w, d, H, hr = 10.0, 7.5, 3.2, 1.9
    K.plinth(w, d, 0.6)
    K.walls(w, d, 0.3, H)
    K.hip_roof(w, d, H, hr, oh=0.8)
    K.door('F', -2.2, w, d, z0=0.35)
    for u in (0.6, 3.2): K.window('F', u, 1.8, 1.5, 1.2, w, d)
    K.window('F', -4.0, 1.8, 0.7, 1.0, w, d)
    for u in (-3, 0, 3): K.window('B', u, 1.8, 1.1, 1.0, w, d)
    for side in 'LR': K.window(side, 1.0, 1.8, 1.0, 1.0, w, d)
    K.box((-2.2, -d / 2 - 0.6, 0.2), (2.6, 1.2, 0.4), NEUTRAL, CONCRETE)
    K.chimney(1.5, 1.6, H + 0.6, H + hr + 0.5)
    K.finish('house_bungalow', 0, {'w': w, 'd': d, 'h': H, 'roof': hr})
    lod1_house('house_bungalow', w, d, H, hr, hip=True)


def house_gablefront():
    w, d, H, hr = 7.0, 9.5, 5.4, 3.4
    K.plinth(w, d)
    K.walls(w, d, 0.2, H)
    K.gable_roof(w, d, H, hr, ridge='Y')
    # bay window on the ground floor
    K.box((1.4, -d / 2 - 0.45, 1.2), (2.6, 0.9, 2.0), WALL, WHITE)
    K.box((1.4, -d / 2 - 0.45, 2.3), (2.8, 1.05, 0.15), ROOF, WHITE)
    K.box((1.4, -d / 2 - 0.92, 1.4), (2.0, 0.04, 1.1), GLASS, GLASSC)
    K.door('F', -1.7, w, d, dw=0.95)
    for u in (-1.4, 1.4): K.window('F', u, 4.2, 0.9, 1.1, w, d)
    K.window('F', 0.0, H + 1.3, 0.7, 0.8, w, d, sill=False)              # attic window in the gable
    for u in (-2.5, 0.5, 3.0): K.window('L', u, 1.6, 0.9, 1.0, w, d); K.window('R', u, 4.2, 0.9, 1.0, w, d)
    K.window('B', 0, 1.6, 1.2, 1.1, w, d)
    K.chimney(-1.4, 2.6, H + 1.0, H + hr + 0.3)
    K.finish('house_gablefront', 0, {'w': w, 'd': d, 'h': H, 'roof': hr})
    lod1_house('house_gablefront', w, d, H, hr, ridge='Y')


# =========================================================================================
# Shops and mid-rise
# =========================================================================================
def shop(name, storeys, pitched=False):
    w, d = 10.0, 10.0
    H = 4.2 + 3.1 * (storeys - 1)
    K.plinth(w, d, 0.3, CONCRETE)
    K.walls(w, d, 0.05, H)
    # shopfront: big glazing, stall riser, sign band, awning
    K.box((0, -d / 2 - 0.02, 1.85), (w * 0.78, 0.05, 2.5), GLASS, GLASSC)
    for u in (-w * 0.39, 0, w * 0.39): K.box((u, -d / 2 - 0.08, 1.85), (0.14, 0.14, 2.6), NEUTRAL, DARK)
    K.box((0, -d / 2 - 0.08, 0.3), (w * 0.8, 0.16, 0.5), NEUTRAL, DARK)
    K.box((0, -d / 2 - 0.12, 3.55), (w * 0.95, 0.2, 0.7), NEUTRAL, hexc(0x2b3a4a))           # sign band
    # sloped awning
    aw = w * 0.8
    K.mesh([(-aw / 2, -d / 2 - 0.05, 3.15), (aw / 2, -d / 2 - 0.05, 3.15), (aw / 2, -d / 2 - 1.6, 2.6), (-aw / 2, -d / 2 - 1.6, 2.6),
            (-aw / 2, -d / 2 - 0.1, 3.08), (aw / 2, -d / 2 - 0.1, 3.08), (aw / 2, -d / 2 - 1.6, 2.53), (-aw / 2, -d / 2 - 1.6, 2.53)],
           [(0, 1, 2, 3), (7, 6, 5, 4), (3, 2, 6, 7)], NEUTRAL, AWNING)
    for k in range(storeys - 1):
        z = 4.2 + 3.1 * k + 1.55
        for u in (-3.3, -1.1, 1.1, 3.3): K.window('F', u, z, 1.1, 1.5, w, d)
        for u in (-3.0, 0.0, 3.0): K.window('B', u, z, 1.0, 1.3, w, d)
        for u in (-2.5, 2.5): K.window('L', u, z, 1.0, 1.3, w, d); K.window('R', u, z, 1.0, 1.3, w, d)
        K.box((0, 0, 4.2 + 3.1 * k), (w + 0.12, d + 0.12, 0.12), NEUTRAL, TRIM)
    K.door('B', 2.5, w, d)
    if pitched:
        K.gable_roof(w, d, H, 2.6, ridge='X')
        hr = 2.6
    else:
        # parapet, cornice and rooftop plant
        K.box((0, 0, H + 0.1), (w + 0.4, d + 0.4, 0.2), NEUTRAL, TRIM)
        for (x, y, sx, sy) in ((0, -d / 2 + 0.1, w, 0.2), (0, d / 2 - 0.1, w, 0.2), (-w / 2 + 0.1, 0, 0.2, d), (w / 2 - 0.1, 0, 0.2, d)):
            K.box((x, y, H + 0.55), (sx, sy, 0.7), WALL, WHITE)
        K.box((0, 0, H + 0.02), (w - 0.3, d - 0.3, 0.05), NEUTRAL, hexc(0x5c5a56))
        K.box((2.0, 1.5, H + 0.6), (1.6, 1.0, 1.0), NEUTRAL, METAL)
        K.box((-2.5, 2.0, H + 0.5), (1.2, 1.2, 0.8), NEUTRAL, METAL)
        K.cyl((-2.5, 2.0, H + 0.9), (-2.5, 2.0, H + 1.4), 0.35, NEUTRAL, DARK, n=10)
        hr = 0.9
    K.finish(name, 0, {'w': w, 'd': d, 'h': H, 'roof': hr})
    # LOD1
    K.walls(w, d, 0, H)
    K.box((0, -d / 2 - 0.02, 1.85), (w * 0.78, 0.05, 2.5), GLASS, GLASSC)
    for k in range(storeys - 1): K.box((0, -d / 2 - 0.02, 4.2 + 3.1 * k + 1.55), (w * 0.8, 0.05, 1.4), GLASS, GLASSC)
    if pitched: K.gable_roof(w, d, H, 2.6, oh=0.4, ridge='X', thick=0.1)
    else: K.box((0, 0, H + 0.35), (w + 0.3, d + 0.3, 0.7), WALL, WHITE)
    K.finish(name, 1, ao=False)


# =========================================================================================
# Warehouses
# =========================================================================================
def corrugated(axis, a0, a1, fixed, z0, z1, part=WALL, color=WHITE, pitch=0.25, amp=0.05, out=-1):
    """A ribbed metal wall. axis 'X': spans x a0..a1 at y = fixed; ribs point outward (out = -1 / +1)."""
    n = max(2, int((a1 - a0) / pitch * 2))
    v, f = [], []
    for i in range(n + 1):
        a = a0 + (a1 - a0) * i / n
        o = amp * (i % 2) * out
        if axis == 'X': v += [(a, fixed + o, z0), (a, fixed + o, z1)]
        else: v += [(fixed + o, a, z0), (fixed + o, a, z1)]
        if i: f.append((2 * i - 2, 2 * i, 2 * i + 1, 2 * i - 1))
    K.mesh(v, f, part, color)


def warehouse_gable():
    w, d, H, hr = 30.0, 20.0, 8.0, 3.2
    K.box((0, 0, 0.1), (w + 0.4, d + 0.4, 0.4), NEUTRAL, CONCRETE)
    K.box((0, 0, H / 2), (w - 0.1, d - 0.1, H), WALL, WHITE)  # solid core behind the ribs
    corrugated('X', -w / 2, w / 2, -d / 2, 0.3, H, out=-1)
    corrugated('X', -w / 2, w / 2, d / 2, 0.3, H, out=1)
    corrugated('Y', -d / 2, d / 2, -w / 2, 0.3, H, out=-1)
    corrugated('Y', -d / 2, d / 2, w / 2, 0.3, H, out=1)
    K.gable_roof(w, d, H, hr, oh=0.4, ridge='X', thick=0.12)
    for u in (-8.0, 8.0):  # roller doors
        K.box((u, -d / 2 - 0.1, 2.6), (5.0, 0.08, 4.8), NEUTRAL, hexc(0x8e969c))
        for k in range(16): K.box((u, -d / 2 - 0.15, 0.4 + k * 0.3), (5.0, 0.03, 0.04), NEUTRAL, hexc(0x6d747a))
        K.box((u, -d / 2 - 0.25, 5.15), (5.4, 0.4, 0.4), NEUTRAL, DARK)
    for u in range(-12, 13, 4):  # clerestory strip
        for side, y in (('F', -d / 2), ('B', d / 2)):
            K.box((u, y + (0.06 if side == 'B' else -0.06), H - 1.0), (2.6, 0.04, 0.7), GLASS, GLASSC)
    K.door('F', 0.0, w, d, dw=0.95)
    for u in range(-12, 13, 6): K.box((u, 0, H + hr * 0.5 + 0.12), (1.5, 3.2, 0.06), GLASS, hexc(0x8fa4ad))  # skylights
    for s in (-1, 1): K.cyl((s * (w / 2 - 0.4), -d / 2 - 0.35, H), (s * (w / 2 - 0.4), -d / 2 - 0.35, 0.2), 0.08, NEUTRAL, METAL, n=6)
    K.finish('warehouse_gable', 0, {'w': w, 'd': d, 'h': H, 'roof': hr})
    K.walls(w, d, 0, H)
    for u in (-8.0, 8.0): K.box((u, -d / 2 - 0.05, 2.6), (5.0, 0.08, 4.8), NEUTRAL, hexc(0x8e969c))
    K.gable_roof(w, d, H, hr, oh=0.4, ridge='X', thick=0.1)
    K.finish('warehouse_gable', 1, ao=False)


def warehouse_brick():
    w, d, H = 30.0, 20.0, 9.0
    K.box((0, 0, 0.1), (w + 0.4, d + 0.4, 0.4), NEUTRAL, CONCRETE)
    K.walls(w, d, 0.2, H)
    # pilasters and arched-top windows rhythm
    for u in range(-15, 16, 5):
        for y in (-d / 2 - 0.12, d / 2 + 0.12): K.box((u, y, H / 2), (0.6, 0.25, H), WALL, (0.86, 0.86, 0.86))
    for u in range(-10, 11, 5):
        if u in (-5, 5): continue
        K.window('F', u + 2.5 if u < 0 else u - 2.5, 5.6, 2.2, 3.2, w, d, sill=True)
        K.window('B', u, 5.6, 2.2, 3.2, w, d)
    for u in (-6.0, 6.0):
        K.box((u, -d / 2 - 0.08, 2.4), (4.2, 0.08, 4.2), NEUTRAL, hexc(0x4d5a63))
    # loading dock and canopy
    K.box((0, -d / 2 - 1.5, 0.6), (w * 0.8, 3.0, 1.2), NEUTRAL, CONCRETE)
    K.box((0, -d / 2 - 1.8, 5.0), (w * 0.85, 3.6, 0.18), NEUTRAL, METAL)
    for u in (-11, 0, 11): K.cyl((u, -d / 2 - 3.4, 1.2), (u, -d / 2 - 3.4, 4.9), 0.1, NEUTRAL, DARK, n=6)
    K.box((0, 0, H + 0.45), (w + 0.3, d + 0.3, 0.9), WALL, (0.8, 0.8, 0.8))
    K.box((0, 0, H + 0.02), (w - 0.3, d - 0.3, 0.05), NEUTRAL, hexc(0x55534f))
    K.box((0, -d / 2 - 0.15, H - 0.8), (12, 0.1, 1.0), NEUTRAL, hexc(0xd8d0bc))  # painted name board
    K.finish('warehouse_brick', 0, {'w': w, 'd': d, 'h': H, 'roof': 0.9})
    K.walls(w, d, 0, H + 0.9)
    K.box((0, -d / 2 - 0.05, 5.6), (w * 0.7, 0.06, 3.0), GLASS, GLASSC)
    K.finish('warehouse_brick', 1, ao=False)


# =========================================================================================
# Waterfront: pier modules (deck top at Z = 0, bay 6 m along Y, 6 m wide) and quay walls
# =========================================================================================
def pier_bay(end=False):
    L, W = 6.0, 6.0
    # deck planks across the pier, small gaps
    y = -L / 2
    while y < L / 2 - 0.05:
        K.box((0, y + 0.1, -0.05), (W, 0.19, 0.1), NEUTRAL, TIMBER, jitter=0.1)
        y += 0.22
    for s in (-1, 1):
        K.box((s * (W / 2 - 0.15), 0, -0.13), (0.3, L, 0.06), NEUTRAL, TIMBER2)    # edge board
        K.box((s * 1.5, 0, -0.3), (0.25, L, 0.35), NEUTRAL, TIMBER2)               # stringers
    K.box((0, -L / 2 + 0.15, -0.55), (W + 0.4, 0.3, 0.35), NEUTRAL, TIMBER2)      # cap beam
    for s in (-1, 1):
        K.cyl((s * (W / 2 - 0.05), -L / 2 + 0.15, 0.25), (s * (W / 2 - 0.05), -L / 2 + 0.15, -12), 0.19, NEUTRAL, PILE, n=8)
    for s in (-1, 1):  # cross bracing
        K.cyl((-W / 2 + 0.1, -L / 2 + 0.15, -0.7 if s > 0 else -3.2), (W / 2 - 0.1, -L / 2 + 0.15, -3.2 if s > 0 else -0.7), 0.07, NEUTRAL, PILE, n=6)
    if end:
        for s in (-1, 1):
            K.cyl((s * (W / 2 - 0.05), L / 2 - 0.15, 0.6), (s * (W / 2 - 0.05), L / 2 - 0.15, -12), 0.19, NEUTRAL, PILE, n=8)
        K.box((0, L / 2 - 0.15, -0.55), (W + 0.4, 0.3, 0.35), NEUTRAL, TIMBER2)
        # bollards, ladder, lamp, life ring
        for s in (-1, 1):
            K.cyl((s * (W / 2 - 0.5), L / 2 - 0.8, 0), (s * (W / 2 - 0.5), L / 2 - 0.8, 0.45), 0.13, NEUTRAL, DARK, n=10)
            K.sphere((s * (W / 2 - 0.5), L / 2 - 0.8, 0.48), 0.17, NEUTRAL, DARK, n=10, m=5, squash=0.6)
        for s in (-0.3, 0.3): K.box((W / 2 + 0.1, L / 2 - 2.0 + s, -1.5), (0.06, 0.06, 3.2), NEUTRAL, METAL)
        for k in range(8): K.box((W / 2 + 0.1, L / 2 - 2.0, -2.9 + k * 0.4), (0.06, 0.6, 0.05), NEUTRAL, METAL)
        K.cyl((-W / 2 + 0.4, L / 2 - 2.5, 0), (-W / 2 + 0.4, L / 2 - 2.5, 4.2), 0.07, NEUTRAL, DARK, n=6)
        K.box((-W / 2 + 0.4, L / 2 - 2.5, 4.3), (0.35, 0.35, 0.4), LAMP, LAMPC)
        K.box((-W / 2 + 0.4, L / 2 - 2.5, 4.55), (0.5, 0.5, 0.08), NEUTRAL, DARK)
        K.cyl((-W / 2 + 0.06, L / 2 - 3.6, 1.3), (-W / 2 - 0.02, L / 2 - 3.6, 1.3), 0.3, NEUTRAL, hexc(0xe0581f), n=12)
        K.cyl((-W / 2 + 0.2, L / 2 - 3.6, 1.0), (-W / 2 + 0.2, L / 2 - 3.6, 0), 0.05, NEUTRAL, TIMBER2, n=6)
    name = 'pier_end' if end else 'pier_bay'
    K.finish(name, 0, {'w': W, 'd': L, 'h': 0}, ground=False)
    K.box((0, 0, -0.15), (W, L, 0.3), NEUTRAL, TIMBER)
    for s in (-1, 1): K.box((s * (W / 2 - 0.05), -L / 2 + 0.15, -6), (0.35, 0.35, 12), NEUTRAL, PILE)
    K.finish(name, 1, ao=False)


def quay(ladder=False):
    """8 m of stone quay wall: water side at -Y, coping top at Z = 0, paved apron to +Y 6 m."""
    L, D = 8.0, 6.0
    rows = 14
    for r in range(rows):
        z1 = -r * 0.62; z0 = z1 - 0.62
        x = -L / 2 + (0.0 if r % 2 else 0.7)
        if r % 2 == 0: K.box((-L / 2 + 0.35, -0.06, (z0 + z1) / 2), (0.69, 0.5, 0.6), NEUTRAL, STONE, jitter=0.08)
        while x < L / 2 - 0.05:
            bl = min(random.uniform(1.1, 1.8), L / 2 - x)
            K.box((x + bl / 2, -0.06 + random.uniform(-0.03, 0.03), (z0 + z1) / 2), (bl - 0.03, 0.5, 0.6), NEUTRAL, random.choice((STONE, STONE2, hexc(0x8a857c))), jitter=0.1)
            x += bl
    K.box((0, 0.25, -rows * 0.31), (L, 0.3, rows * 0.62), NEUTRAL, STONE2)   # backing
    K.box((0, 0.05, -0.12), (L + 0.02, 0.75, 0.3), NEUTRAL, hexc(0xb3ada1), jitter=0.04)    # coping, slight overhang
    # paved apron
    for i in range(5):
        for j in range(4):
            K.box((-L / 2 + 0.8 + i * 1.6, 0.45 + 0.75 + j * 1.45, -0.2), (1.56, 1.41, 0.4), NEUTRAL, random.choice((CONCRETE, hexc(0x96938c), hexc(0xaba79e))), jitter=0.05)
    K.box((0, D / 2 + 0.4, -1.6), (L, D - 0.6, 2.8), NEUTRAL, CONCRETE)              # fill under the apron
    # bollard and fenders
    K.cyl((1.2, 0.55, 0), (1.2, 0.55, 0.5), 0.15, NEUTRAL, DARK, n=10)
    K.sphere((1.2, 0.55, 0.52), 0.19, NEUTRAL, DARK, n=10, m=5, squash=0.6)
    for x in (-2.5, 2.5): K.box((x, -0.38, -1.0), (0.4, 0.25, 1.6), NEUTRAL, RUBBER)
    if ladder:
        for s in (-0.25, 0.25): K.box((-1.2 + s, -0.36, -2.6), (0.05, 0.05, 5.2), NEUTRAL, METAL)
        for k in range(12): K.box((-1.2, -0.36, -5.0 + k * 0.42), (0.5, 0.05, 0.05), NEUTRAL, METAL)
    name = 'quay_ladder' if ladder else 'quay'
    K.finish(name, 0, {'w': L, 'd': D, 'h': 0}, ground=False)
    K.box((0, D / 2 - 0.1, -4.4), (L, D + 0.2, 8.8), NEUTRAL, STONE2)
    K.box((0, 0.05, -0.12), (L, 0.75, 0.3), NEUTRAL, hexc(0xa29d92))
    K.finish(name, 1, ao=False)


# =========================================================================================
# Props
# =========================================================================================
def container():
    w, d, h = 2.44, 12.19, 2.59
    for sx in (-1, 1): corrugated('Y', -d / 2 + 0.15, d / 2 - 0.15, sx * w / 2, 0.15, h - 0.15, part=WALL, color=WHITE, pitch=0.3, amp=0.04, out=sx)
    K.box((0, 0, h / 2), (w - 0.06, d - 0.06, h - 0.02), WALL, (0.85, 0.85, 0.85))
    for (y) in (-d / 2, d / 2):  # corner posts and rails
        for sx in (-1, 1): K.box((sx * (w / 2 - 0.07), y - 0.07 * (1 if y > 0 else -1), h / 2), (0.16, 0.16, h), WALL, (0.75, 0.75, 0.75))
    for z in (0.08, h - 0.08):
        for sx in (-1, 1): K.box((sx * (w / 2 - 0.05), 0, z), (0.12, d, 0.16), WALL, (0.75, 0.75, 0.75))
    for k in range(4): K.box((-w / 2 + 0.35 + k * 0.58, d / 2 + 0.03, h / 2), (0.05, 0.05, h - 0.4), NEUTRAL, METAL)  # door lock rods
    K.box((0, d / 2 + 0.02, h / 2), (0.03, 0.03, h - 0.3), NEUTRAL, DARK)
    K.finish('container', 0, {'w': w, 'd': d, 'h': h}, ground=True)
    K.box((0, 0, h / 2), (w, d, h), WALL, WHITE)
    K.finish('container', 1, ao=False)


def car(name, van=False):
    L, W = (4.8, 1.95) if van else (4.3, 1.78)
    z0 = 0.32
    body_h = 1.5 if van else 0.62
    # lower body with chamfered ends
    v = []
    for (y, top_in) in ((-L / 2, 0.12), (L / 2, 0.1)):
        for x in (-W / 2, W / 2):
            v.append((x, y + (0.12 if y < 0 else -0.12), z0))
            v.append((x, y + (top_in if y < 0 else -top_in) * 0.5, z0 + body_h))
    # build as simple box then add cabin
    K.box((0, 0, z0 + body_h / 2), (W, L, body_h), WALL, WHITE)
    if not van:
        c = [(-W / 2 + 0.08, -0.55, z0 + body_h), (W / 2 - 0.08, -0.55, z0 + body_h), (W / 2 - 0.08, 1.3, z0 + body_h), (-W / 2 + 0.08, 1.3, z0 + body_h),
             (-W / 2 + 0.2, -0.1, z0 + body_h + 0.62), (W / 2 - 0.2, -0.1, z0 + body_h + 0.62), (W / 2 - 0.2, 1.0, z0 + body_h + 0.62), (-W / 2 + 0.2, 1.0, z0 + body_h + 0.62)]
        K.mesh(c, [(0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7), (4, 5, 6, 7)], GLASS, GLASSC)
        K.box((0, 0.45, z0 + body_h + 0.64), (W - 0.42, 1.0, 0.04), WALL, WHITE)  # roof skin
    else:
        K.box((0, -L / 2 + 0.03, z0 + body_h * 0.72), (W - 0.2, 0.06, 0.6), GLASS, GLASSC)
        for s in (-1, 1): K.box((s * (W / 2 + 0.01), -L / 2 + 0.75, z0 + body_h * 0.72), (0.04, 0.8, 0.5), GLASS, GLASSC)
    for sx in (-1, 1):
        for sy in (-1, 1):
            K.cyl((sx * (W / 2 - 0.12), sy * (L / 2 - 0.8), 0.32), (sx * (W / 2 + 0.02), sy * (L / 2 - 0.8), 0.32), 0.32, NEUTRAL, RUBBER, n=12)
    for sx in (-1, 1):
        K.box((sx * (W / 2 - 0.25), -L / 2 - 0.01, z0 + 0.42), (0.35, 0.04, 0.14), LAMP, (1.0, 1.0, 0.9))
        K.box((sx * (W / 2 - 0.25), L / 2 + 0.01, z0 + 0.42), (0.35, 0.04, 0.14), NEUTRAL, hexc(0x8a1a14))
    K.box((0, -L / 2 - 0.03, z0 + 0.15), (W, 0.08, 0.22), NEUTRAL, DARK)
    K.box((0, L / 2 + 0.03, z0 + 0.15), (W, 0.08, 0.22), NEUTRAL, DARK)
    K.finish(name, 0, {'w': W, 'd': L, 'h': z0 + body_h + (0 if van else 0.64)})
    K.box((0, 0, (z0 + body_h + (0 if van else 0.5)) / 2 + 0.1), (W, L, z0 + body_h + (0 if van else 0.5)), WALL, WHITE)
    K.finish(name, 1, ao=False)


def tree_broad():
    K.cyl((0, 0, -0.3), (0, 0, 3.6), 0.28, NEUTRAL, BARK, n=7, r1=0.18)
    for (a, l) in ((0.3, 2.0), (2.4, 1.8), (4.3, 1.7)):
        K.cyl((0, 0, 2.6), (math.cos(a) * l, math.sin(a) * l, 4.6), 0.12, NEUTRAL, BARK, n=5, r1=0.06)
    for (x, y, z, r) in ((0, 0, 5.6, 2.3), (1.4, 0.6, 4.9, 1.7), (-1.3, 0.8, 5.0, 1.6), (0.3, -1.5, 4.8, 1.6), (-0.6, -0.4, 6.6, 1.5), (0.9, -0.2, 6.2, 1.3)):
        K.sphere((x, y, z), r, LEAF, (0.85, 0.85, 0.85), n=9, m=6, squash=0.85, noise=0.18)
    K.finish('tree_broad', 0, {'w': 6, 'd': 6, 'h': 8})
    K.cyl((0, 0, -0.3), (0, 0, 3.6), 0.28, NEUTRAL, BARK, n=5)
    K.sphere((0, 0, 5.5), 2.9, LEAF, (0.85, 0.85, 0.85), n=6, m=4, squash=0.8)
    K.finish('tree_broad', 1, ao=False)


def tree_pine():
    K.cyl((0, 0, -0.3), (0, 0, 9.0), 0.24, NEUTRAL, BARK, n=6, r1=0.06)
    for k in range(6):
        z = 2.0 + k * 1.25; r = 2.3 - k * 0.33
        n = 9
        v = [(0, 0, z + 1.9)]
        for i in range(n):
            a = 2 * math.pi * i / n + k * 0.3; rr = r * (0.75 if i % 2 else 1.0)
            v.append((math.cos(a) * rr, math.sin(a) * rr, z - (0.25 if i % 2 else 0.0)))
        v.append((0, 0, z + 0.2))
        f = [(0, 1 + (i + 1) % n, 1 + i) for i in range(n)] + [(n + 1, 1 + i, 1 + (i + 1) % n) for i in range(n)]
        K.mesh(v, f, LEAF, (0.62, 0.7, 0.62))
    K.finish('tree_pine', 0, {'w': 4.6, 'd': 4.6, 'h': 10})
    K.cyl((0, 0, -0.3), (0, 0, 3.0), 0.22, NEUTRAL, BARK, n=5)
    K.mesh([(0, 0, 10.0)] + [(math.cos(2 * math.pi * i / 6) * 2.3, math.sin(2 * math.pi * i / 6) * 2.3, 1.8) for i in range(6)],
           [(0, 1 + (i + 1) % 6, 1 + i) for i in range(6)] + [tuple(range(1, 7))[::-1]], LEAF, (0.62, 0.7, 0.62))
    K.finish('tree_pine', 1, ao=False)


def lamp_post():
    K.cyl((0, 0, 0), (0, 0, 4.6), 0.07, NEUTRAL, DARK, n=8, r1=0.05)
    K.cyl((0, 0, 0), (0, 0, 0.6), 0.14, NEUTRAL, DARK, n=8)
    K.cyl((0, 0, 4.5), (0.0, -0.7, 4.75), 0.04, NEUTRAL, DARK, n=6)
    K.box((0, -0.8, 4.6), (0.32, 0.45, 0.22), NEUTRAL, DARK)
    K.box((0, -0.8, 4.47), (0.26, 0.38, 0.05), LAMP, LAMPC)
    K.finish('lamp_post', 0, {'w': 0.4, 'd': 1, 'h': 4.8})
    K.box((0, 0, 2.4), (0.1, 0.1, 4.8), NEUTRAL, DARK)
    K.finish('lamp_post', 1, ao=False)


for fn in (house_cottage, house_two, house_hip, house_bungalow, house_gablefront):
    fn()
shop('shop_two', 2); shop('shop_three', 3); shop('shop_pitched', 2, pitched=True)
warehouse_gable(); warehouse_brick()
pier_bay(False); pier_bay(True)
quay(False); quay(True)
container(); car('car_sedan'); car('car_van', van=True)
tree_broad(); tree_pine(); lamp_post()
K.export(os.path.join(OUT_DIR, 'town.glb'))

if PREV_DIR:
    # lineup render of every LOD0
    sc = K.scene
    lod0 = [o for o in K.assets if o.name.endswith('LOD0')]
    for o in K.assets: o.hide_render = not o.name.endswith('LOD0')
    x = 0.0
    for o in lod0:
        e = json.loads(o['floatilla']); o.location = (x + e['w'] / 2, 0, 0 if e['h'] else 3); x += e['w'] + 3
    sc.render.engine = 'CYCLES'; sc.cycles.samples = 24; sc.cycles.use_denoising = False
    wd = sc.world; nt = wd.node_tree
    sky = nt.nodes.new('ShaderNodeTexSky'); sky.sky_type = 'NISHITA'; sky.sun_elevation = math.radians(30); sky.sun_rotation = math.radians(200)
    nt.links.new(sky.outputs['Color'], nt.nodes['Background'].inputs['Color']); nt.nodes['Background'].inputs['Strength'].default_value = 0.35
    m = bpy.data.materials.new('vc'); m.use_nodes = True
    attr = m.node_tree.nodes.new('ShaderNodeVertexColor'); attr.layer_name = 'Col'
    m.node_tree.links.new(attr.outputs['Color'], m.node_tree.nodes['Principled BSDF'].inputs['Base Color'])
    m.node_tree.nodes['Principled BSDF'].inputs['Roughness'].default_value = 0.8
    for o in lod0: o.data.materials.clear(); o.data.materials.append(m)
    gm = bpy.data.meshes.new('gp'); gm.from_pydata([(-20, -60, 0), (x + 20, -60, 0), (x + 20, 60, 0), (-20, 60, 0)], [], [(0, 1, 2, 3)])
    go = bpy.data.objects.new('gp', gm); sc.collection.objects.link(go)
    gmat = bpy.data.materials.new('g'); gmat.use_nodes = True; gmat.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.25, 0.3, 0.22, 1); gm.materials.append(gmat)
    for i, (cx, span) in enumerate(((x * 0.22, x * 0.27), (x * 0.72, x * 0.3))):
        cd = bpy.data.cameras.new('cam'); cd.lens = 35
        cam = bpy.data.objects.new('cam', cd); sc.collection.objects.link(cam)
        cam.location = (cx, -span * 0.95, span * 0.38)
        cam.rotation_euler = (Vector((cx, 0, 3)) - cam.location).to_track_quat('-Z', 'Y').to_euler()
        sc.camera = cam
        sc.render.resolution_x, sc.render.resolution_y = 1600, 640
        sc.render.filepath = os.path.join(PREV_DIR, f'town_{i}.png')
        bpy.ops.render.render(write_still=True)
