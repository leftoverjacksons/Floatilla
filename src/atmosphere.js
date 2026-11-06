import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

/**
 * Screen-space atmosphere, applied to the HDR scene before bloom:
 *  - height fog: density ρ(y) = ρ0·exp(−(y − sea level)/H), integrated analytically along each view ray
 *    from the depth buffer, so fog pools on the water and masts and hills rise out of it;
 *  - in-scattered light: ambient fog colour plus a forward-scattering lobe toward the sun;
 *  - fog banks: the optical depth is modulated by drifting noise;
 *  - light shafts: bright sky radially blurred toward the sun, occluded by geometry.
 */
export class AtmospherePass extends Pass {
  constructor(camera) {
    super();
    this.camera = camera;
    this.uniforms = {
      tDiffuse: { value: null }, tDepth: { value: null },
      uProjInv: { value: new THREE.Matrix4() }, uViewInv: { value: new THREE.Matrix4() },
      uCam: { value: new THREE.Vector3() }, uLevel: { value: 0 },
      uDensity: { value: 0.002 }, uFalloff: { value: 1 / 200 },
      uFogColor: { value: new THREE.Color() }, uSunColor: { value: new THREE.Color() }, uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uGlow: { value: 1 }, uBank: { value: 0 }, uBankOffset: { value: new THREE.Vector2() },
      uSunScreen: { value: new THREE.Vector2(0.5, 0.5) }, uShafts: { value: 0 }, uFlash: { value: 0 }, uAspect: { value: 1 },
    };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: FRAG,
      depthTest: false, depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.material);
    // shared with materials drawn after this pass (rain, lightning) so they can depth-test against the scene
    this.sceneDepth = { value: null };
    this.sceneRes = { value: new THREE.Vector2(1, 1) };
  }

  /** Per-frame parameters from the environment. */
  setFrom(env, camera) {
    const u = this.uniforms, c = env.cur;
    u.uLevel.value = env.level;
    // sea-level visibility V (2 % contrast) → extinction ρ0 = 3.9 / V
    u.uDensity.value = 3.9 / Math.max(60, c.fog);
    u.uFalloff.value = 1 / Math.max(8, c.fogH);
    u.uBank.value = c.bank;
    u.uFogColor.value.copy(env.fogColor);
    const day = env.dayFactor;
    u.uSunColor.value.copy(env.sunColor).multiplyScalar(day * (1 - c.cloud * 0.75) * 0.8);
    u.uSunDir.value.copy(env.sunDir);
    u.uFlash.value = env.flash;
    // fog banks drift with the wind
    u.uBankOffset.value.x -= Math.cos(env.windAngle) * env.windSpeed * 0.016 * 0.35;
    u.uBankOffset.value.y -= Math.sin(env.windAngle) * env.windSpeed * 0.016 * 0.35;
    // sun position on screen for the shafts
    const p = new THREE.Vector3().copy(env.sunDir).multiplyScalar(5000).add(camera.position).project(camera);
    const inFront = camera.getWorldDirection(new THREE.Vector3()).dot(env.sunDir) > 0.05;
    u.uSunScreen.value.set(p.x * 0.5 + 0.5, p.y * 0.5 + 0.5);
    const onScreen = inFront ? 1 - THREE.MathUtils.smoothstep(Math.max(Math.abs(p.x), Math.abs(p.y)), 1.0, 1.6) : 0;
    const haze = THREE.MathUtils.clamp(900 / Math.max(c.fog, 100), 0.15, 1);
    u.uShafts.value = onScreen * day * (1 - c.cloud * 0.55) * (0.35 + 0.65 * haze) * THREE.MathUtils.smoothstep(env.sunDir.y, -0.02, 0.08);
  }

  render(renderer, writeBuffer, readBuffer) {
    const u = this.uniforms, cam = this.camera;
    u.tDiffuse.value = readBuffer.texture;
    u.tDepth.value = readBuffer.depthTexture;
    this.sceneDepth.value = readBuffer.depthTexture;
    this.sceneRes.value.set(readBuffer.width, readBuffer.height);
    u.uProjInv.value.copy(cam.projectionMatrixInverse);
    u.uViewInv.value.copy(cam.matrixWorld);
    u.uCam.value.setFromMatrixPosition(cam.matrixWorld);
    u.uAspect.value = readBuffer.width / Math.max(1, readBuffer.height);
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }

  dispose() { this.material.dispose(); this.quad.dispose(); }
}

const FRAG = /* glsl */`
uniform sampler2D tDiffuse, tDepth;
uniform mat4 uProjInv, uViewInv;
uniform vec3 uCam, uFogColor, uSunColor, uSunDir;
uniform float uLevel, uDensity, uFalloff, uGlow, uBank, uShafts, uFlash, uAspect;
uniform vec2 uBankOffset, uSunScreen;
varying vec2 vUv;
float h21(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vn(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(h21(i), h21(i+vec2(1,0)), u.x), mix(h21(i+vec2(0,1)), h21(i+vec2(1,1)), u.x), u.y); }
float fbm(vec2 p){ float s = 0.0, a = 0.5; for (int i = 0; i < 4; i++){ s += a * vn(p); p = p * 2.03 + 7.1; a *= 0.5; } return s; }
vec3 viewPos(vec2 uv, float d){ vec4 v = uProjInv * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0); return v.xyz / v.w; }
void main(){
  vec4 src = texture2D(tDiffuse, vUv);
  float d = texture2D(tDepth, vUv).x;
  bool sky = d >= 0.99999;
  vec3 vp = viewPos(vUv, sky ? 0.5 : d);
  vec3 dir = normalize((uViewInv * vec4(vp, 0.0)).xyz);
  float dist = sky ? 6000.0 : length(vp);
  vec3 wp = uCam + dir * dist;

  // ∫ ρ0·exp(−k(y−L)) ds along the ray, closed form
  float k = uFalloff;
  float hc = max(uCam.y - uLevel, 0.0);
  float dy = (wp.y - uCam.y) * k;
  float F = abs(dy) < 1e-3 ? 1.0 - dy * 0.5 : (1.0 - exp(-dy)) / dy;
  float tau = uDensity * exp(-hc * k) * dist * F;
  // banks: thicker and thinner patches drifting with the wind
  vec2 bp = (uCam.xz + dir.xz * min(dist, 1200.0)) * 0.0032 + uBankOffset * 0.0032;
  float bank = fbm(bp);
  tau *= mix(1.0, smoothstep(0.2, 0.75, bank) * 1.9 + 0.12, uBank);
  float T = exp(-min(tau, 40.0));

  // in-scattering: ambient fog colour plus a forward lobe toward the sun (Henyey–Greenstein-like)
  float mu = max(dot(dir, uSunDir), 0.0);
  float lobe = pow(mu, 12.0) * 1.0 + pow(mu, 4.0) * 0.15;
  vec3 inscat = uFogColor * (1.0 + uFlash * 0.9) + uSunColor * lobe * uGlow;
  vec3 col = src.rgb * T + inscat * (1.0 - T);

  // light shafts: march toward the sun gathering bright, unoccluded sky
  if (uShafts > 0.001) {
    vec2 delta = (uSunScreen - vUv) / 28.0;
    vec2 uv = vUv + delta * h21(gl_FragCoord.xy);   // jitter hides banding
    float acc = 0.0, w = 1.0;
    for (int i = 0; i < 28; i++) {
      uv += delta;
      if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) break;
      float s = texture2D(tDepth, uv).x >= 0.99999 ? 1.0 : 0.0;
      vec3 c = texture2D(tDiffuse, uv).rgb;
      acc += s * smoothstep(0.6, 3.0, dot(c, vec3(0.333))) * w;
      w *= 0.96;
    }
    vec2 dd = (vUv - uSunScreen) * vec2(uAspect, 1.0);
    float fall = 1.0 / (1.0 + dot(dd, dd) * 6.0);
    col += uSunColor * acc / 28.0 * uShafts * fall * 0.9;
  }
  gl_FragColor = vec4(col, src.a);
}`;
