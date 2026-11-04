// Shared GLSL injected into MeshStandardMaterials: flood tint below the water
// line, a wet stain band just above it, and (optionally) procedural windows
// that light up at night while the city still has power.

export const GLSL_HASH = /* glsl */`
float fhash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
`;

export function patchFloodMaterial(mat, uniforms, windows) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uLevel = uniforms.uLevel;
    shader.uniforms.uNight = uniforms.uNight;
    shader.uniforms.uPower = uniforms.uPower;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
varying vec3 vFWP; varying vec3 vFWN;
${windows ? 'attribute float aStyle; varying float vStyle;' : ''}`)
      .replace('#include <fog_vertex>', `#include <fog_vertex>
vec4 fwp = vec4(transformed, 1.0);
vec3 fwn = objectNormal;
#ifdef USE_INSTANCING
fwp = instanceMatrix * fwp; fwn = mat3(instanceMatrix) * fwn;
#endif
fwp = modelMatrix * fwp;
vFWP = fwp.xyz; vFWN = normalize(mat3(modelMatrix) * fwn);
${windows ? 'vStyle = aStyle;' : ''}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform float uLevel; uniform float uNight; uniform float uPower;
varying vec3 vFWP; varying vec3 vFWN;
${windows ? 'varying float vStyle;' : ''}
${GLSL_HASH}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
float fLit = 0.0; float fWin = 0.0;
${windows ? `
{
  vec3 n = normalize(vFWN);
  if (vStyle > 0.5 && abs(n.y) < 0.5) {
    vec2 t2 = vec2(-n.z, n.x);
    float hc = dot(vFWP.xz, t2);
    float fh = vStyle < 1.5 ? 3.5 : (vStyle < 2.5 ? 3.0 : 5.5);
    float fw = vStyle < 1.5 ? 1.7 : (vStyle < 2.5 ? 3.2 : 7.0);
    vec2 cell = vec2(hc / fw, (vFWP.y + 0.6) / fh);
    vec2 f = fract(cell); vec2 id = floor(cell);
    float mx = vStyle < 1.5 ? 0.09 : 0.32;
    float my = vStyle < 1.5 ? 0.22 : 0.3;
    float win = step(mx, f.x) * step(f.x, 1.0 - mx) * step(my, f.y) * step(f.y, 1.0 - my);
    if (vStyle > 2.5) win *= step(0.55, f.y);
    float r = fhash12(id + floor(vFWP.xz * 0.013) * 7.13);
    vec3 glass = vStyle < 1.5 ? vec3(0.09, 0.13, 0.17) : vec3(0.07, 0.08, 0.09);
    diffuseColor.rgb = mix(diffuseColor.rgb, glass, win * 0.85);
    fWin = win * (vStyle < 1.5 ? 1.0 : 0.7) * step(uLevel, vFWP.y);
    fLit = win * step(1.0 - 0.3 * uPower, r) * step(uLevel + 2.0, vFWP.y) * (0.5 + fhash12(id * 1.37));
  }
}` : ''}
float fUnder = clamp((uLevel - vFWP.y) / 5.0, 0.0, 1.0);
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.06, 0.11, 0.1), fUnder * 0.85);
float fStain = (1.0 - step(uLevel + 1.6, vFWP.y)) * step(uLevel, vFWP.y) * smoothstep(uLevel + 1.6, uLevel, vFWP.y);
diffuseColor.rgb *= 1.0 - fStain * 0.4;`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor = mix(roughnessFactor, 0.06, fWin);`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
metalnessFactor = mix(metalnessFactor, 0.55, fWin);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
totalEmissiveRadiance += vec3(1.0, 0.72, 0.4) * fLit * smoothstep(0.3, 0.9, uNight) * 1.3;`);
  };
  mat.customProgramCacheKey = () => (windows ? 'flood-win' : 'flood');
  if (windows) mat.defines = { ...(mat.defines || {}), FLOOD_WINDOWS: '' };
}
