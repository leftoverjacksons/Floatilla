"""
Shared Blender helpers for Floatilla boat models.

Conventions: Blender +X = port (game +x), bow toward Blender -Y (game +z), Z up,
waterline at Z = 0, metres. Gameplay data is exported in GAME coordinates
(x, y, z) = (X, Z, -Y) as JSON in the root node's "floatilla" extra.
"""
import bpy, bmesh, math, json, os, random
from mathutils import Vector, Matrix


class Build:
    def __init__(self, name, L, B, seed=7):
        bpy.ops.wm.read_factory_settings(use_empty=True)
        random.seed(seed)
        self.scene = bpy.context.scene
        self.L, self.B, self.name = L, B, name
        self.root = bpy.data.objects.new(name, None)
        self.scene.collection.objects.link(self.root)
        self.parts = []
        self.M = {}
        self.obstacles = []

    # ---- coordinates -----------------------------------------------------------
    def Y(self, s):  # s: 0 = transom, 1 = stem
        return (0.5 - s) * self.L

    def G(self, x, y, z):
        return [round(x, 3), round(z, 3), round(-y, 3)]

    # ---- materials -------------------------------------------------------------------
    def mat(self, key, name, color, rough=0.5, metal=0.0, image=None, double=False):
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
        self.M[key] = m
        return m

    def plank_image(self, name, base, tones=(0.75, 1.1), seam=(0.035, 0.03, 0.025), N=256, planks=8):
        img = bpy.data.images.new(name, N, N, alpha=False)
        px = [0.0] * (N * N * 4)
        pw = N // planks
        joints = [random.randint(0, N - 1) for _ in range(planks)]
        tone = [random.uniform(*tones) for _ in range(planks)]
        for y in range(N):
            for x in range(N):
                p = x // pw; lx = x - p * pw
                k = tone[p] * (1 + 0.06 * math.sin(lx * 0.9 + 6 * math.sin(y * 0.03 + p)) + 0.04 * math.sin(y * 0.15 + lx * 0.3 + p * 3))
                r, g, b = base[0] * k, base[1] * k, base[2] * k
                if lx < 2 or abs(y - joints[p]) < 2: r, g, b = seam
                i = (y * N + x) * 4
                px[i:i + 4] = (r, g, b, 1.0)
        img.pixels = px
        img.pack()
        return img

    # ---- mesh helpers -------------------------------------------------------------------
    def make_obj(self, name, verts, faces, materials, face_mats=None, smooth=True, parent=None, uv=None, recalc=True):
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
        if recalc:
            bm = bmesh.new(); bm.from_mesh(me)
            bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
            bm.to_mesh(me); bm.free(); me.update()
        ob = bpy.data.objects.new(name, me)
        self.scene.collection.objects.link(ob)
        ob.parent = parent or self.root
        self.parts.append(ob)
        return ob

    @staticmethod
    def grid_faces(rows, cols, closed=False):
        f = []
        for i in range(rows - 1):
            for j in range(cols - (0 if closed else 1)):
                j2 = (j + 1) % cols
                f.append((i * cols + j, (i + 1) * cols + j, (i + 1) * cols + j2, i * cols + j2))
        return f

    def box(self, name, c, size, mat, rot=None, parent=None, smooth=False):
        cx, cy, cz = c; sx, sy, sz = size[0] / 2, size[1] / 2, size[2] / 2
        v = [(cx + x * sx, cy + y * sy, cz + z * sz) for x in (-1, 1) for y in (-1, 1) for z in (-1, 1)]
        f = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
        if rot is not None:
            R = Matrix.Rotation(rot[0], 4, rot[1]); C = Vector(c)
            v = [tuple(C + (R @ (Vector(p) - C))) for p in v]
        return self.make_obj(name, v, f, [mat], smooth=smooth, parent=parent)

    @staticmethod
    def frame(points, i):
        p = Vector(points[i])
        t = (Vector(points[min(i + 1, len(points) - 1)]) - Vector(points[max(i - 1, 0)])).normalized()
        up = Vector((0, 0, 1)) if abs(t.z) < 0.9 else Vector((1, 0, 0))
        n = t.cross(up).normalized(); b = n.cross(t).normalized()
        return p, n, b

    def sweep(self, name, points, profile, mat, closed=True, smooth=True, parent=None):
        verts, k = [], len(profile)
        for i in range(len(points)):
            p, n, b = self.frame(points, i)
            for (u, v) in profile: verts.append(tuple(p + n * u + b * v))
        faces = self.grid_faces(len(points), k, closed)
        if closed:
            faces.append(tuple(range(k - 1, -1, -1)))
            faces.append(tuple((len(points) - 1) * k + j for j in range(k)))
        return self.make_obj(name, verts, faces, [mat], smooth=smooth, parent=parent)

    @staticmethod
    def circle(r, n=10):
        return [(r * math.cos(2 * math.pi * i / n), r * math.sin(2 * math.pi * i / n)) for i in range(n)]

    @staticmethod
    def rect(w, h):
        return [(-w / 2, -h / 2), (w / 2, -h / 2), (w / 2, h / 2), (-w / 2, h / 2)]

    def tube(self, name, pts, r, mat, n=10, parent=None):
        return self.sweep(name, pts, self.circle(r, n), mat, parent=parent)

    def rod(self, name, a, b, r, mat, n=8, parent=None):
        return self.tube(name, [a, b], r, mat, n, parent=parent)

    def cyl(self, name, c, r, h, mat, axis='Z', n=20, parent=None):
        cx, cy, cz = c
        a, b = {'Z': ((cx, cy, cz - h / 2), (cx, cy, cz + h / 2)), 'X': ((cx - h / 2, cy, cz), (cx + h / 2, cy, cz)), 'Y': ((cx, cy - h / 2, cz), (cx, cy + h / 2, cz))}[axis]
        return self.rod(name, a, b, r, mat, n, parent=parent)

    def ellipsoid(self, name, c, r, mat, n=16, m=10, parent=None):
        verts = []
        for i in range(m + 1):
            th = math.pi * i / m
            for j in range(n):
                ph = 2 * math.pi * j / n
                verts.append((c[0] + r[0] * math.sin(th) * math.cos(ph), c[1] + r[1] * math.cos(th), c[2] + r[2] * math.sin(th) * math.sin(ph)))
        return self.make_obj(name, verts, self.grid_faces(m + 1, n, True), [mat], parent=parent)

    def torus(self, name, c, R, r, mat, axis='X', n=24, parent=None):
        pts = []
        for i in range(n + 1):
            a = 2 * math.pi * i / n
            if axis == 'X': pts.append((c[0], c[1] + R * math.cos(a), c[2] + R * math.sin(a)))
            elif axis == 'Y': pts.append((c[0] + R * math.cos(a), c[1], c[2] + R * math.sin(a)))
            else: pts.append((c[0] + R * math.cos(a), c[1] + R * math.sin(a), c[2]))
        return self.tube(name, pts, r, mat, 8, parent=parent)

    def empty(self, name, loc, parent=None):
        e = bpy.data.objects.new(name, None)
        self.scene.collection.objects.link(e); e.parent = parent or self.root; e.location = loc
        return e

    def foil(self, name, y_le, chord_root, chord_tip, z_root, z_tip, thick, sweepback, mat):
        prof = []
        for k in range(12):
            u = k / 11
            yt = 5 * thick * (0.2969 * math.sqrt(u) - 0.126 * u - 0.3516 * u * u + 0.2843 * u ** 3 - 0.1036 * u ** 4)
            prof.append((u, yt))
        ring = prof + [(u, -y) for u, y in reversed(prof[1:-1])]
        verts, rows = [], 8
        for r in range(rows):
            v = r / (rows - 1)
            z = z_root + (z_tip - z_root) * v; c = chord_root + (chord_tip - chord_root) * v; y0 = y_le + sweepback * v
            for (u, t) in ring: verts.append((t * c, y0 + u * c, z))
        n = len(ring)
        faces = self.grid_faces(rows, n, True) + [tuple(range(n - 1, -1, -1)), tuple((rows - 1) * n + j for j in range(n))]
        return self.make_obj(name, verts, faces, [mat])

    # ---- AO bake, extras, export --------------------------------------------------------
    def bake_ao(self, skip=('WaterMask',), thin=('Rigging', 'Stainless', 'Rubber', 'Rope')):
        sc = self.scene
        sc.render.engine = 'CYCLES'; sc.cycles.device = 'CPU'; sc.cycles.samples = 20
        world = bpy.data.worlds.new('W'); sc.world = world; world.use_nodes = True
        world.node_tree.nodes['Background'].inputs['Color'].default_value = (1, 1, 1, 1)
        for ob in self.parts:
            if ob.name.split('.')[0] in skip: ob.hide_render = True
        for ob in self.parts:
            me = ob.data
            if not me.color_attributes: me.color_attributes.new('Col', 'BYTE_COLOR', 'CORNER')
            me.color_attributes.active_color = me.color_attributes[0]
            if ob.name.split('.')[0] in skip or len(me.vertices) < 24 or (me.materials and me.materials[0].name.startswith(thin)):
                for d in me.color_attributes[0].data: d.color = (1, 1, 1, 1)
                continue
            bpy.ops.object.select_all(action='DESELECT')
            ob.select_set(True); bpy.context.view_layer.objects.active = ob
            try: bpy.ops.object.bake(type='AO', target='VERTEX_COLORS')
            except Exception as e:
                print('bake failed', ob.name, e)
                for d in me.color_attributes[0].data: d.color = (1, 1, 1, 1)
        for ob in self.parts:
            for d in ob.data.color_attributes[0].data:
                v = 0.45 + 0.55 * d.color[0]; d.color = (v, v, v, 1)

    def obstacle(self, x0, x1, s0, s1, top):
        zs = sorted([-self.Y(s0), -self.Y(s1)])
        xs = sorted([x0, x1])
        self.obstacles.append({'minx': round(xs[0], 3), 'maxx': round(xs[1], 3), 'minz': round(zs[0], 3), 'maxz': round(zs[1], 3), 'top': round(top, 3)})

    def export(self, path, extras, preview=None, cam=(9.5, -11.0, 5.2), target=(0, -0.5, 2.0)):
        extras = {'floatilla': 1, 'length': self.L, 'beam': self.B, 'obstacles': self.obstacles, **extras}
        self.root['floatilla'] = json.dumps(extras)
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        bpy.ops.object.select_all(action='SELECT')
        bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', export_yup=True, export_apply=True, export_colors=True,
                                  export_extras=True, export_image_format='JPEG', export_image_quality=88, export_materials='EXPORT', use_selection=False)
        print('EXPORTED', path, os.path.getsize(path), 'bytes', len(self.parts), 'parts', sum(len(o.data.polygons) for o in self.parts), 'faces')
        if preview:
            world = self.scene.world
            sky = world.node_tree.nodes.new('ShaderNodeTexSky'); sky.sky_type = 'NISHITA'; sky.sun_elevation = math.radians(28); sky.sun_rotation = math.radians(130)
            world.node_tree.links.new(sky.outputs['Color'], world.node_tree.nodes['Background'].inputs['Color'])
            world.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.25
            sea = bpy.data.meshes.new('sea'); sea.from_pydata([(-80, -80, 0), (80, -80, 0), (80, 80, 0), (-80, 80, 0)], [], [(0, 1, 2, 3)])
            so = bpy.data.objects.new('sea', sea); self.scene.collection.objects.link(so)
            sea.materials.append(self.mat('_sea', '_Sea', (0.02, 0.07, 0.09), 0.08))
            cd = bpy.data.cameras.new('cam'); cd.lens = 35
            c = bpy.data.objects.new('cam', cd); self.scene.collection.objects.link(c)
            c.location = cam
            c.rotation_euler = (Vector(target) - Vector(cam)).to_track_quat('-Z', 'Y').to_euler()
            self.scene.camera = c
            self.scene.render.resolution_x, self.scene.render.resolution_y = 960, 600
            self.scene.cycles.samples = 40; self.scene.cycles.use_denoising = False
            self.scene.render.filepath = preview
            bpy.ops.render.render(write_still=True)


class Hull:
    """Parametric hull: smooth lofted sections, paint lines on exact rows."""

    def __init__(self, b, FB, D, cmax=0.44, transom=0.62, bow=0.0, bowp=2.1, sheer_bow=0.24, sheer_stern=0.07,
                 xexp=0.55, zexp=1.55, flat=False, bot_ends=0.04):
        self.b, self.L, self.B = b, b.L, b.B
        self.FB, self.D, self.cmax, self.transom, self.bow, self.bowp = FB, D, cmax, transom, bow, bowp
        self.sheer_bow, self.sheer_stern, self.xexp, self.zexp, self.flat, self.bot_ends = sheer_bow, sheer_stern, xexp, zexp, flat, bot_ends

    def half_beam(self, s):
        c = self.cmax
        if s <= c:
            t = (c - s) / c
            return self.B / 2 * (1 - (1 - self.transom) * t ** 2.2)
        t = (s - c) / (1 - c)
        if self.bow > 0:  # blunt (barge, punt, houseboat)
            return self.B / 2 * (1 - (1 - self.bow) * t ** 2.4)
        return self.B / 2 * max(0.0, 1 - t ** self.bowp) ** 0.95

    def sheer(self, s):
        return self.FB + self.sheer_bow * s ** 2.6 + self.sheer_stern * (1 - s) ** 2

    def bottom(self, s):
        if self.flat:  # flat-bottomed with raked ends
            ramp = min(1.0, s / 0.08, (1 - s) / 0.14)
            return -self.D * max(0.15, ramp)
        return -self.D * max(0.0, math.sin(math.pi * min(1.0, s * 0.97 + self.bot_ends))) ** 0.55

    def point(self, s, t):
        w, top, bot = self.half_beam(s), self.sheer(s), self.bottom(s)
        a = t * math.pi / 2
        return w * max(math.cos(a), 0.0) ** self.xexp, top - (top - bot) * math.sin(a) ** self.zexp

    def t_at_z(self, s, zt):
        if self.point(s, 1.0)[1] > zt: return 1.0
        lo, hi = 0.0, 1.0
        for _ in range(40):
            mid = (lo + hi) / 2
            if self.point(s, mid)[1] > zt: lo = mid
            else: hi = mid
        return (lo + hi) / 2

    def deck_z(self, s, drop=0.045):
        return self.sheer(s) - drop

    def deck_hw(self, s, inset=0.035):
        return max(0.0, self.half_beam(s) - inset)

    def build(self, mats, cove=0.12, boot=(0.1, -0.03), NS=72, segs=(2, 8, 2, 10), double=False):
        """mats: dict cove/topsides/boot/antifoul -> material. Returns the hull object."""
        b = self.b
        names = ['cove', 'topsides', 'boot', 'antifoul']
        MS = sum(segs)
        row_mat = []
        for k, n in enumerate(segs): row_mat += [k] * n
        hv = []
        for i in range(NS + 1):
            s = 0.004 + 0.992 * i / NS
            tc, tb, tw = self.t_at_z(s, self.sheer(s) - cove), self.t_at_z(s, boot[0]), self.t_at_z(s, boot[1])
            tb = max(tb, tc + 1e-3); tw = max(tw, tb + 1e-3)
            bounds = [0.0, tc, tb, min(tw, 0.999), 1.0]
            ts = [0.0]
            for k, n in enumerate(segs):
                a0, a1 = bounds[k], max(bounds[k + 1], bounds[k] + 1e-4)
                ts += [a0 + (a1 - a0) * (q + 1) / n for q in range(n)]
            for j in range(2 * MS + 1):
                t = ts[j] if j <= MS else ts[2 * MS - j]
                x, z = self.point(s, t)
                hv.append((x if j <= MS else -x, b.Y(s), z))
        hf = b.grid_faces(NS + 1, 2 * MS + 1)
        hfm = []
        for f in hf:
            j = f[0] % (2 * MS + 1)
            hfm.append(row_mat[j] if j < MS else row_mat[2 * MS - j - 1])
        hf.append(tuple(range(0, 2 * MS + 1))); hfm.append(1)  # transom
        if self.bow > 0:  # blunt bow plate
            base = NS * (2 * MS + 1)
            hf.append(tuple(reversed(range(base, base + 2 * MS + 1)))); hfm.append(1)
        return b.make_obj('Hull', hv, hf, [mats[n] for n in names], hfm, recalc=False)

    def deck(self, mat, holes=(), drop=0.045, camber=0.05, DS=60, DK=12, uv_scale=(0.9, 3.2)):
        b = self.b
        dv, df = [], []
        for i in range(DS + 1):
            s = 0.012 + 0.975 * i / DS
            for j in range(DK + 1):
                u = -1 + 2 * j / DK
                dv.append((u * self.deck_hw(s), b.Y(s), self.deck_z(s, drop) + camber * (1 - u * u)))
        for i in range(DS):
            s = 0.012 + 0.975 * (i + 0.5) / DS
            for j in range(DK):
                u = -1 + 2 * (j + 0.5) / DK
                xm = u * self.deck_hw(s)
                if any(s0 < s < s1 and abs(xm) < hw for (s0, s1, hw) in holes): continue
                a, c = i * (DK + 1) + j, (i + 1) * (DK + 1) + j
                df.append((a, c, c + 1, a + 1))
        return b.make_obj('Deck', dv, df, [mat], uv=lambda co: (co.x / uv_scale[0], co.y / uv_scale[1]), recalc=False)

    def bulwark(self, mat, height, s0=0.01, s1=0.99, inset=0.0):
        """Solid raised sides above the sheer (trawlers, tugs)."""
        b = self.b
        for side in (1, -1):
            pts = [(side * (self.half_beam(s) - inset - 0.04), b.Y(s), self.sheer(s) + height / 2) for s in [s0 + (s1 - s0) * i / 50 for i in range(51)]]
            b.sweep('Bulwark', pts, b.rect(0.08, height), mat)

    def rail(self, mat, s0=0.004, s1=0.996, offset=0.012, dz=-0.06, prof=(0.04, 0.06)):
        b = self.b
        for side in (1, -1):
            pts = [(side * (self.half_beam(s) + offset), b.Y(s), self.sheer(s) + dz) for s in [s0 + (s1 - s0) * i / 60 for i in range(61)]]
            b.sweep('Rubrail', pts, b.rect(*prof), mat)

    def water_mask(self, mat, top_offset=-0.02):
        b = self.b
        mv = []
        for i in range(41):
            s = 0.004 + 0.992 * i / 40
            mv += [(self.half_beam(s), b.Y(s), self.sheer(s) + top_offset), (-self.half_beam(s), b.Y(s), self.sheer(s) + top_offset)]
        mf = [(2 * i, 2 * i + 1, 2 * i + 3, 2 * i + 2) for i in range(40)]
        return b.make_obj('WaterMask', mv, mf, [mat], smooth=False, recalc=False)

    def walk(self, y_fn, s0=0.04, s1=0.96, inset=0.15, n=30):
        out = []
        for i in range(n + 1):
            s = s0 + (s1 - s0) * i / n
            out.append([round(-self.b.Y(s), 3), round(max(0.1, self.deck_hw(s) - inset), 3), round(y_fn(s), 3)])
        return out
