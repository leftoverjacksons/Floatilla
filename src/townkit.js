import * as THREE from 'three';
import { patchFloodMaterial } from './shaders.js';
import { TILE, LAYER_NO_REFLECT } from './tiles.js';

/**
 * Town kit (tools/blender/build_town.py): houses, shops, warehouses, pier and quay modules, containers,
 * cars, trees and lamps. Each asset has a detailed and a distant mesh. Vertex colours carry the base
 * colour with baked ambient occlusion; a per-vertex part id (from TEXCOORD_0.x) says what may be tinted
 * per instance (walls, roofs, foliage), what is glass (lit at night while the town has power) and what
 * is a lamp.
 */
export const KIT = {};
export let KIT_OK = false;

export function registerTownKit(gltf) {
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    const m = /^(\w+)_LOD([01])$/.exec(o.name);
    if (!m) return;
    const geo = o.geometry.clone().applyMatrix4(o.matrixWorld);
    const uv = geo.getAttribute('uv');
    const part = new Float32Array(geo.attributes.position.count);
    for (let i = 0; i < part.length; i++) part[i] = uv ? Math.floor(uv.getX(i)) : 0;
    geo.setAttribute('aPart', new THREE.BufferAttribute(part, 1));
    geo.deleteAttribute('uv');
    geo.computeBoundingSphere();
    const a = KIT[m[1]] || (KIT[m[1]] = { lod: [null, null], info: null });
    a.lod[+m[2]] = geo;
    if (o.userData && o.userData.floatilla) a.info = JSON.parse(o.userData.floatilla);
  });
  KIT_OK = ['house_cottage', 'shop_two', 'pier_bay', 'quay', 'tree_broad'].every((k) => KIT[k] && KIT[k].lod[0] && KIT[k].lod[1] && KIT[k].info);
}

let townMat = null;
/** One material for the whole kit: vertex colours, per-instance tints, glass and lamps, flood staining. */
export function townMaterial(uniforms) {
  if (townMat) return townMat;
  townMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0.02 });
  patchFloodMaterial(townMat, uniforms, false, (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute float aPart; attribute vec3 iWall; attribute vec3 iRoof;
varying float vPart; varying vec3 vTint;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vPart = aPart;
vTint = (aPart > 0.5 && aPart < 1.5) || aPart > 4.5 ? iWall : (aPart > 1.5 && aPart < 2.5 ? iRoof : vec3(1.0));`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying float vPart; varying vec3 vTint;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
diffuseColor.rgb *= vTint;
float kGlass = step(2.5, vPart) * step(vPart, 3.5);
float kLamp = step(3.5, vPart) * step(vPart, 4.5);`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor = mix(roughnessFactor, 0.12, kGlass);`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
metalnessFactor = mix(metalnessFactor, 0.35, kGlass);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
{
  float dry = step(uLevel + 0.3, vFWP.y);
  float night = smoothstep(0.3, 0.9, uNight);
  float lit = step(1.0 - 0.38 * uPower, fhash12(floor(vFWP.xz * 0.55) + floor(vFWP.y * 0.4) * 7.31));
  totalEmissiveRadiance += vec3(1.0, 0.72, 0.42) * kGlass * lit * dry * night * 1.4;
  totalEmissiveRadiance += vec3(1.0, 0.86, 0.62) * kLamp * dry * mix(0.15, 4.0 * uPower, night);
}`);
  }, 'town');
  return townMat;
}

const tiles = []; // { x, z, r, lod: [mesh0, mesh1] }
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);

/**
 * Instance an asset. items: { x, y, z, ang, sx, sy, sz, wall?, roof? } (y = asset origin height, ang = yaw).
 * Returns a Group of tiles; each tile shows the detailed mesh within `lodDist` of the camera.
 */
export function placeKit(scene, uniforms, asset, items, { lodDist = 420, noReflect = false, shadow = true } = {}) {
  const a = KIT[asset];
  if (!a || !items.length) return null;
  const mat = townMaterial(uniforms);
  const map = new Map();
  for (const it of items) {
    const k = `${Math.floor(it.x / TILE)},${Math.floor(it.z / TILE)}`;
    let l = map.get(k); if (!l) map.set(k, (l = [])); l.push(it);
  }
  const group = new THREE.Group();
  const col = new THREE.Color();
  for (const list of map.values()) {
    const wall = new Float32Array(list.length * 3), roof = new Float32Array(list.length * 3);
    list.forEach((it, i) => {
      col.setHex(it.wall ?? 0xffffff); wall[i * 3] = col.r; wall[i * 3 + 1] = col.g; wall[i * 3 + 2] = col.b;
      col.setHex(it.roof ?? 0xffffff); roof[i * 3] = col.r; roof[i * 3 + 1] = col.g; roof[i * 3 + 2] = col.b;
    });
    const t = { x: 0, z: 0, lodDist, lod: [] };
    for (const it of list) { t.x += it.x / list.length; t.z += it.z / list.length; }
    for (let L = 0; L < 2; L++) {
      const src = a.lod[L];
      const geo = new THREE.BufferGeometry();
      for (const [n, attr] of Object.entries(src.attributes)) geo.setAttribute(n, attr);
      geo.setIndex(src.index);
      geo.setAttribute('iWall', new THREE.InstancedBufferAttribute(wall, 3));
      geo.setAttribute('iRoof', new THREE.InstancedBufferAttribute(roof, 3));
      const mesh = new THREE.InstancedMesh(geo, mat, list.length);
      list.forEach((it, i) => {
        _q.setFromAxisAngle(_up, it.ang || 0); _p.set(it.x, it.y, it.z); _s.set(it.sx ?? 1, it.sy ?? 1, it.sz ?? 1);
        _m.compose(_p, _q, _s); mesh.setMatrixAt(i, _m);
      });
      mesh.computeBoundingSphere();
      mesh.castShadow = shadow && L === 0; mesh.receiveShadow = true;
      if (noReflect) mesh.layers.set(LAYER_NO_REFLECT);
      mesh.visible = L === 1;
      group.add(mesh); t.lod.push(mesh);
    }
    tiles.push(t);
  }
  scene.add(group);
  return group;
}

/** Detailed meshes near the camera, simple ones beyond. */
export function updateKitLOD(cam) {
  for (const t of tiles) {
    const near = Math.hypot(t.x - cam.x, t.z - cam.z) < t.lodDist + TILE * 0.5;
    t.lod[0].visible = near; t.lod[1].visible = !near;
  }
}
