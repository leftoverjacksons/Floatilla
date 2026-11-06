import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { clamp, lerp, smoothstep, damp, fbm, rand } from './util.js';

export const DAY_SECONDS = 1200; // real seconds per in-game day at 1x (20 minutes)

const WEATHER = {
  // fog: sea-level visibility (m); fogH: how quickly the fog thins with height (m); bank: patchiness
  clear: { cloud: 0.12, rain: 0, wind: 6.0, fog: 9000, fogH: 160, bank: 0.15, label: 'Clear' },
  cloudy: { cloud: 0.6, rain: 0, wind: 8.5, fog: 4500, fogH: 140, bank: 0.2, label: 'Overcast' },
  fog: { cloud: 0.45, rain: 0, wind: 3.0, fog: 170, fogH: 22, bank: 0.85, label: 'Fog' },
  rain: { cloud: 0.88, rain: 0.6, wind: 10.5, fog: 900, fogH: 110, bank: 0.35, label: 'Rain' },
  storm: { cloud: 1.0, rain: 1.0, wind: 18.5, fog: 650, fogH: 90, bank: 0.4, label: 'Storm' },
};
const NEXT = {
  clear: [['clear', 2], ['cloudy', 3], ['fog', 1]],
  cloudy: [['clear', 2], ['rain', 3], ['cloudy', 1], ['fog', 1]],
  fog: [['clear', 2], ['cloudy', 2]],
  rain: [['cloudy', 3], ['storm', 2], ['rain', 1]],
  storm: [['rain', 3], ['cloudy', 1]],
};

/** Flood curve: metres above the starting sea level after `days` game days. */
export function floodLevel(days) {
  // Starts with the low harbor district already under ~4 m, then creeps up over ~two months.
  const t = clamp(days / 60, 0, 1);
  return 4 + 71 * (0.15 * t + 0.85 * t * t * (3 - 2 * t));
}

export class Environment {
  constructor(scene, renderer, rng) {
    this.scene = scene; this.rng = rng; this.renderer = renderer;
    this.hours = 7.0; this.day = 1; this.elapsedDays = 0; // game time since start
    this.timeScale = 1;
    this.levelOffset = 0;
    this.state = 'clear';
    this.stateTimer = 5;
    this.cur = { ...WEATHER.clear };
    this.windAngle = -Math.PI / 2 + 0.6; // direction the wind blows TOWARD
    this.windSpeed = 4;
    this.gust = 0;
    this.flash = 0; this.nextLightning = 5; this.pendingThunder = [];
    this.sunDir = new THREE.Vector3(); this.moonDir = new THREE.Vector3();
    this.level = 0;
    this.onThunder = null;

    this.sky = new Sky(); this.sky.scale.setScalar(10000); scene.add(this.sky);
    // The analytic sun disc reaches values far beyond half-float range (65504) in HDR render
    // targets; clamp so it cannot become Inf and poison bloom with black blocks.
    this.sky.material.fragmentShader = this.sky.material.fragmentShader.replace(
      'gl_FragColor = vec4( retColor, 1.0 );', 'gl_FragColor = vec4( clamp( retColor, 0.0, 60.0 ), 1.0 );');
    this.sky.material.needsUpdate = true;
    const su = this.sky.material.uniforms;
    su.turbidity.value = 6; su.rayleigh.value = 1.6; su.mieCoefficient.value = 0.004; su.mieDirectionalG.value = 0.85;

    // Haze dome blends the horizon into the fog colour (and greys out the sky in storms).
    this.hazeMat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color() }, uAmount: { value: 0 } },
      vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform vec3 uColor; uniform float uAmount; varying vec3 vDir;
        void main(){ float a = clamp(smoothstep(0.32, -0.02, vDir.y) + uAmount, 0.0, 1.0); gl_FragColor = vec4(uColor, a);
        #include <colorspace_fragment>
        }`,
      side: THREE.BackSide, transparent: true, depthWrite: false, fog: false,
    });
    this.haze = new THREE.Mesh(new THREE.SphereGeometry(4500, 32, 16), this.hazeMat);
    this.haze.renderOrder = -2; scene.add(this.haze);

    // Cloud layer.
    this.cloudMat = new THREE.ShaderMaterial({
      uniforms: { uCover: { value: 0.2 }, uOffset: { value: new THREE.Vector2() }, uLit: { value: new THREE.Color(1, 1, 1) },
        uDark: { value: new THREE.Color(0.4, 0.4, 0.45) }, uCam: { value: new THREE.Vector3() }, uFlash: { value: 0 } },
      vertexShader: `varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: `uniform float uCover, uFlash; uniform vec2 uOffset; uniform vec3 uLit, uDark, uCam; varying vec3 vW;
        float h(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
        float n(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.0-2.0*f);
          return mix(mix(h(i),h(i+vec2(1,0)),u.x), mix(h(i+vec2(0,1)),h(i+vec2(1,1)),u.x), u.y); }
        float fbm(vec2 p){ float s=0.0, a=0.5; for(int i=0;i<5;i++){ s+=a*n(p); p*=2.07; a*=0.5; } return s; }
        void main(){
          vec2 p = (vW.xz + uOffset) * 0.0011;
          float d = fbm(p);
          float c = smoothstep(1.0 - uCover - 0.05, 1.0 - uCover + 0.35, d + 0.2 * uCover);
          float shade = fbm(p * 1.7 + 4.0);
          vec3 col = mix(uLit, uDark, clamp(shade * 0.9 + uCover * 0.5, 0.0, 1.0)) + uFlash * 0.8;
          float dist = length(vW.xz - uCam.xz);
          float fade = 1.0 - smoothstep(2500.0, 4200.0, dist);
          gl_FragColor = vec4(col, c * fade * 0.97);
          #include <colorspace_fragment>
        }`,
      transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide,
    });
    this.clouds = new THREE.Mesh(new THREE.PlaneGeometry(9000, 9000), this.cloudMat);
    this.clouds.rotation.x = -Math.PI / 2; this.clouds.renderOrder = -1; scene.add(this.clouds);
    this.cloudOffset = new THREE.Vector2();

    // Stars and moon.
    const starPos = [];
    for (let i = 0; i < 1600; i++) {
      const u = rng() * 2 - 1, th = rng() * Math.PI * 2, r = Math.sqrt(1 - u * u);
      if (u < 0.02) continue;
      starPos.push(r * Math.cos(th) * 4000, u * 4000, r * Math.sin(th) * 4000);
    }
    const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.Float32BufferAttribute(starPos, 3));
    this.starMat = new THREE.PointsMaterial({ color: 0xffffff, size: 2.2, sizeAttenuation: false, transparent: true, opacity: 0, depthWrite: false, fog: false });
    this.stars = new THREE.Points(sg, this.starMat); this.stars.renderOrder = -3; scene.add(this.stars);
    this.moon = new THREE.Mesh(new THREE.SphereGeometry(70, 16, 12), new THREE.MeshBasicMaterial({ color: 0xe8ecff, fog: false, transparent: true }));
    scene.add(this.moon);

    // Lights.
    this.sun = new THREE.DirectionalLight(0xffffff, 2.5);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera; sc.left = -70; sc.right = 70; sc.top = 70; sc.bottom = -70; sc.near = 1; sc.far = 600;
    this.sun.shadow.bias = -0.0004; this.sun.shadow.normalBias = 0.09; // larger normal bias removes acne on thin double-sided hulls
    scene.add(this.sun, this.sun.target);
    this.hemi = new THREE.HemisphereLight(0xbfd8ff, 0x3a4a3a, 0.8);
    scene.add(this.hemi);
    this.flashLight = new THREE.DirectionalLight(0xc8d4ff, 0);
    scene.add(this.flashLight);

    // Linear fog for the low preset and for reflections; medium/high use the screen-space atmosphere.
    this.fog = new THREE.Fog(0xaabbcc, 50, 2400);
    scene.fog = this.fog;

    // Rain: thin motion-blurred streaks animated entirely on the GPU in a box that wraps around the camera.
    this.rainCount = 16000;
    const rg = new THREE.InstancedBufferGeometry();
    rg.setAttribute('position', new THREE.Float32BufferAttribute([-1, 0, 0, 1, 0, 0, -1, 1, 0, 1, 1, 0], 3));
    rg.setIndex([0, 1, 2, 2, 1, 3]);
    const seeds = new Float32Array(this.rainCount * 4);
    for (let i = 0; i < seeds.length; i++) seeds[i] = rng();
    rg.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
    rg.instanceCount = 0;
    this.rainMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uCam: { value: new THREE.Vector3() }, uWind: { value: new THREE.Vector2() },
        uColor: { value: new THREE.Color() }, uOpacity: { value: 0 }, uFlash: { value: 0 },
        tDepth: { value: null }, uRes: { value: new THREE.Vector2(1, 1) }, uUseDepth: { value: 0 } },
      vertexShader: RAIN_VERT, fragmentShader: RAIN_FRAG,
      transparent: true, depthWrite: false, blending: THREE.NormalBlending,
    });
    this.rain = new THREE.Mesh(rg, this.rainMat); this.rain.frustumCulled = false; this.rain.renderOrder = 3; scene.add(this.rain);
    this.rainTime = 0;

    // Lightning bolts: jagged, branching lines far off, visible for a flicker.
    this.boltMat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(14, 15, 22) }, uOpacity: { value: 0 }, tDepth: { value: null }, uRes: { value: new THREE.Vector2(1, 1) }, uUseDepth: { value: 0 } },
      vertexShader: 'void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `uniform vec3 uColor; uniform float uOpacity;
        ${DEPTH_TEST}
        void main(){ sceneOcclude(); gl_FragColor = vec4(uColor * uOpacity, 1.0); }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.bolt = new THREE.LineSegments(new THREE.BufferGeometry(), this.boltMat); this.bolt.frustumCulled = false; this.bolt.visible = false;
    scene.add(this.bolt);
    this.boltLife = 0;

    this.fogColor = new THREE.Color(); this.skyTop = new THREE.Color(); this.horizon = new THREE.Color(); this.sunColor = new THREE.Color();
  }

  get label() { return WEATHER[this.state].label; }
  get rainAmt() { return this.cur.rain; }
  get windVec() { return new THREE.Vector2(Math.cos(this.windAngle), Math.sin(this.windAngle)).multiplyScalar(this.windSpeed); }
  get night() { return 1 - smoothstep(-0.12, 0.12, this.sunDir.y); }
  get dayFactor() { return smoothstep(-0.05, 0.3, this.sunDir.y); }
  get floodRate() { return (floodLevel(this.elapsedDays + 1 / 24) - floodLevel(this.elapsedDays)); } // m per game hour

  pickNext() {
    const opts = NEXT[this.state].map(([s, w]) => [s, s === 'storm' ? w * (1 + this.elapsedDays * 0.25) : w]);
    const total = opts.reduce((a, b) => a + b[1], 0);
    let r = this.rng() * total;
    for (const [s, w] of opts) { if ((r -= w) <= 0) return s; }
    return opts[0][0];
  }

  update(dt, focus, camera) {
    const gameHours = dt * this.timeScale * 24 / DAY_SECONDS;
    this.hours += gameHours; this.elapsedDays += gameHours / 24;
    if (this.hours >= 24) { this.hours -= 24; this.day++; }

    // Weather state machine (durations in game hours).
    this.stateTimer -= gameHours;
    if (this.stateTimer <= 0) { this.state = this.pickNext(); this.stateTimer = rand(this.rng, 3, 9); }
    const tgt = WEATHER[this.state];
    const k = damp(0.25 * this.timeScale, dt);
    for (const key of ['cloud', 'rain', 'wind', 'fogH', 'bank']) this.cur[key] = lerp(this.cur[key], tgt[key], k);
    this.cur.fog = Math.exp(lerp(Math.log(this.cur.fog), Math.log(tgt.fog), k)); // visibility eases geometrically
    const t = this.elapsedDays * 24;
    this.windAngle += fbm(t * 0.15, 3.3, 2, 11) * 0.02 * gameHours * 24 + (this.state === 'storm' ? 0.03 : 0) * gameHours;
    this.gust = fbm(performance.now() * 0.0003, 1.7, 2, 4);
    this.windSpeed = Math.max(0.5, this.cur.wind * (1 + this.gust * 0.35));

    // Flood + tide (+ storm surge).
    const tide = 0.6 * Math.sin(t / 12.42 * Math.PI * 2);
    this.level = floodLevel(this.elapsedDays) + tide + this.cur.rain * 0.4 + this.levelOffset;

    // Sun & moon.
    const a = (this.hours - 6) / 24 * Math.PI * 2;
    this.sunDir.set(Math.cos(a), Math.sin(a) * 0.92, -0.32).normalize();
    this.moonDir.set(-Math.cos(a), -Math.sin(a) * 0.85, 0.3).normalize();
    const elev = this.sunDir.y;
    const day = this.dayFactor, night = this.night, cloud = this.cur.cloud;
    const su = this.sky.material.uniforms;
    su.sunPosition.value.copy(this.sunDir);
    su.turbidity.value = 4 + cloud * 12; su.rayleigh.value = 1.2 + cloud * 2.5;

    this.sunColor.setRGB(1, lerp(0.55, 0.96, smoothstep(0, 0.4, elev)), lerp(0.3, 0.9, smoothstep(0, 0.45, elev)));
    const light = (0.22 + 0.78 * day) * (1 - cloud * 0.45);
    // Fog / horizon colour.
    const dayHorizon = new THREE.Color(0.68, 0.76, 0.84).lerp(new THREE.Color(0.5, 0.53, 0.56), cloud);
    const dusk = new THREE.Color(0.85, 0.55, 0.38);
    const nightC = new THREE.Color(0.06, 0.08, 0.13).multiplyScalar(1 - cloud * 0.5);
    const duskAmt = (1 - smoothstep(0.0, 0.3, Math.abs(elev))) * (1 - cloud * 0.7);
    this.horizon.copy(nightC).lerp(dayHorizon, day).lerp(dusk, duskAmt * 0.6);
    this.fogColor.copy(this.horizon);
    this.skyTop.copy(new THREE.Color(0.04, 0.06, 0.12)).lerp(new THREE.Color(0.25, 0.45, 0.75).lerp(new THREE.Color(0.42, 0.44, 0.47), cloud), day);

    this.flash = Math.max(0, this.flash - dt * 4);
    if (this.state === 'storm' && this.cur.rain > 0.7) {
      this.nextLightning -= dt;
      if (this.nextLightning <= 0) {
        this.flash = 1; this.nextLightning = rand(this.rng, 3, 14);
        this.makeBolt(camera.position);
        this.pendingThunder.push(rand(this.rng, 0.4, 3.5));
      }
    }
    for (let i = this.pendingThunder.length - 1; i >= 0; i--) {
      this.pendingThunder[i] -= dt;
      if (this.pendingThunder[i] <= 0) { this.pendingThunder.splice(i, 1); this.onThunder && this.onThunder(); }
    }

    const sceneFog = this.fog;
    sceneFog.color.copy(this.fogColor).lerp(new THREE.Color(0.7, 0.75, 0.85), this.flash * 0.5);
    sceneFog.far = Math.max(120, Math.min(this.cur.fog * 0.6, 3000)); sceneFog.near = Math.min(40, sceneFog.far * 0.1);
    this.hazeMat.uniforms.uColor.value.copy(sceneFog.color);
    this.hazeMat.uniforms.uAmount.value = smoothstep(0.5, 1.0, cloud) * 0.85 + smoothstep(600, 150, this.cur.fog) + this.flash * 0.2;
    this.renderer.toneMappingExposure = lerp(0.42, 0.62, day) * (1 - cloud * 0.12);

    // Lights.
    const lightDir = elev > -0.05 ? this.sunDir : this.moonDir;
    // Snap the shadow focus to the shadow-map texel grid so shadow edges don't crawl as the boat moves.
    const st = this.shadowStep || 0.07;
    const fx = Math.round(focus.x / st) * st, fz = Math.round(focus.z / st) * st;
    this.sun.target.position.set(fx, focus.y, fz);
    this.sun.position.set(fx, focus.y, fz).addScaledVector(lightDir, 500);
    if (elev > -0.05) { this.sun.color.copy(this.sunColor); this.sun.intensity = 3.2 * smoothstep(-0.05, 0.15, elev) * (1 - cloud * 0.7); }
    else { this.sun.color.setRGB(0.6, 0.7, 1.0); this.sun.intensity = 0.6 * (1 - cloud * 0.8); }
    this.hemi.color.copy(new THREE.Color(0.35, 0.42, 0.62)).lerp(this.skyTop, day).lerp(new THREE.Color(0.75, 0.82, 0.9), 0.4 * day);
    this.hemi.groundColor.setRGB(0.12, 0.14, 0.12).multiplyScalar(0.4 + day);
    this.hemi.intensity = (0.55 + 1.1 * day * (1 - cloud * 0.25)) * (this.scene.environment ? 0.55 : 1);
    // Sky-baked environment light: dimmed under cloud (the baked sky has no clouds) and at night.
    this.scene.environmentIntensity = (0.15 + 0.75 * day) * (1 - cloud * 0.6);
    this.flashLight.intensity = this.flash * 4;
    this.flashLight.position.copy(focus).add(new THREE.Vector3(30, 200, -40));

    // Sky decorations follow the camera.
    const cp = camera.position;
    this.sky.position.copy(cp); this.haze.position.copy(cp); this.stars.position.copy(cp);
    this.starMat.opacity = night * (1 - cloud * 0.9);
    this.moon.position.copy(cp).addScaledVector(this.moonDir, 3800);
    this.moon.material.opacity = smoothstep(-0.05, 0.1, this.moonDir.y) * (1 - cloud * 0.8);
    this.moon.visible = this.moon.material.opacity > 0.01;
    this.cloudOffset.x -= Math.cos(this.windAngle) * this.windSpeed * dt * 2.5;
    this.cloudOffset.y -= Math.sin(this.windAngle) * this.windSpeed * dt * 2.5;
    const cu = this.cloudMat.uniforms;
    cu.uCover.value = 0.25 + cloud * 0.75; cu.uOffset.value.copy(this.cloudOffset); cu.uCam.value.copy(cp);
    cu.uFlash.value = this.flash;
    cu.uLit.value.copy(this.sunColor).multiplyScalar(0.25 + 0.75 * day).lerp(this.horizon, 0.3);
    cu.uDark.value.copy(this.horizon).multiplyScalar(0.55);
    this.clouds.position.set(cp.x, 650, cp.z);

    this.updateRain(dt, cp);
    this.lightLevel = light;
  }

  updateRain(dt, cp) {
    const r = this.cur.rain;
    this.rain.visible = r > 0.02;
    this.rain.geometry.instanceCount = this.rain.visible ? Math.floor(this.rainCount * Math.min(1, r * 1.15)) : 0;
    const u = this.rainMat.uniforms;
    this.rainTime = (this.rainTime + dt) % 1000;
    u.uTime.value = this.rainTime; u.uCam.value.copy(cp);
    u.uWind.value.set(Math.cos(this.windAngle), Math.sin(this.windAngle)).multiplyScalar(this.windSpeed * 0.8);
    u.uColor.value.copy(this.fogColor).lerp(new THREE.Color(1, 1, 1), 0.35).multiplyScalar(0.9 + this.flash * 3);
    u.uOpacity.value = 0.45 + r * 0.3;
    // lightning bolt flicker
    if (this.boltLife > 0) {
      this.boltLife -= dt;
      const t = 0.45 - this.boltLife;
      const vis = Math.exp(-(this.boltDist || 600) * 1.6 / Math.max(this.cur.fog, 100));
      this.boltMat.uniforms.uOpacity.value = Math.max(0, this.boltLife / 0.45) * (Math.sin(t * 70) > -0.3 ? 1 : 0.15) * (0.15 + 0.85 * vis);
      this.bolt.visible = this.boltLife > 0;
    }
  }

  /**
   * With post-processing, rain and lightning are drawn after the atmosphere pass (so the fog does not
   * swallow them) and test occlusion against the scene depth by hand; otherwise they stay in the scene.
   */
  setLate(lateScene, depthUniform, resUniform) {
    for (const [obj, mat] of [[this.rain, this.rainMat], [this.bolt, this.boltMat]]) {
      obj.removeFromParent();
      (lateScene || this.scene).add(obj);
      mat.uniforms.uUseDepth.value = lateScene ? 1 : 0;
      mat.depthTest = !lateScene;
      if (depthUniform) { mat.uniforms.tDepth = depthUniform; mat.uniforms.uRes = resUniform; }
      mat.needsUpdate = true;
    }
  }

  /** A forked bolt from the cloud base to the sea, 450–1100 m from the camera. */
  makeBolt(cp) {
    const rng = this.rng, a = rng() * Math.PI * 2, d = 450 + rng() * 650;
    const x0 = cp.x + Math.cos(a) * d, z0 = cp.z + Math.sin(a) * d, top = 620, bottom = this.level;
    const pts = [];
    const strike = (x, y, z, len, depth) => {
      let px = x, py = y, pz = z;
      const steps = Math.ceil(len / 14);
      for (let i = 0; i < steps && py > bottom; i++) {
        const nx = px + (rng() - 0.5) * 22, ny = py - 8 - rng() * 14, nz = pz + (rng() - 0.5) * 22;
        pts.push(px, py, pz, nx, Math.max(ny, bottom), nz);
        if (depth < 2 && rng() < 0.07) strike(nx, ny, nz, len * 0.25, depth + 1);
        px = nx; py = ny; pz = nz;
      }
    };
    strike(x0, top, z0, top - bottom + 200, 0);
    this.bolt.geometry.dispose();
    this.bolt.geometry = new THREE.BufferGeometry();
    this.bolt.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.boltLife = 0.45; this.bolt.visible = true; this.boltDist = d;
    this.boltPos = new THREE.Vector3(x0, 300, z0);
  }

  timeString() {
    const h = Math.floor(this.hours), m = Math.floor((this.hours - h) * 60);
    return `Day ${this.day}  ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
}

const DEPTH_TEST = /* glsl */`
uniform sampler2D tDepth; uniform vec2 uRes; uniform float uUseDepth;
void sceneOcclude(){
  if (uUseDepth > 0.5 && gl_FragCoord.z > texture2D(tDepth, gl_FragCoord.xy / uRes).x) discard;
}`;
// Each streak: instance seed (x, y, z, length jitter) placed in a 70 m × 34 m box that wraps around the
// camera, falling at ~9 m/s and drifting with the wind; a thin camera-facing quad stretched along its motion.
const RAIN_VERT = /* glsl */`
attribute vec4 aSeed;
uniform float uTime; uniform vec3 uCam; uniform vec2 uWind;
varying float vAlong; varying float vAcross; varying float vFade;
void main(){
  const float B = 35.0, H = 34.0, FALL = 9.0;
  vec3 v = vec3(uWind.x, -FALL, uWind.y);
  vec3 p0 = vec3(aSeed.x * 2.0 * B, aSeed.y * H, aSeed.z * 2.0 * B) + v * uTime;
  vec3 p;
  p.x = p0.x - 2.0 * B * floor((p0.x - uCam.x + B) / (2.0 * B));
  p.z = p0.z - 2.0 * B * floor((p0.z - uCam.z + B) / (2.0 * B));
  p.y = p0.y - H * floor((p0.y - (uCam.y - H * 0.45)) / H);
  vec3 dir = normalize(v);
  vec3 toCam = normalize(cameraPosition - p);
  vec3 side = normalize(cross(dir, toCam));
  float dist = length(cameraPosition - p);
  float w = max(0.006, dist * 0.0009);            // never thinner than ~1 pixel
  float len = (0.55 + aSeed.w * 0.5) * (0.6 + 0.4 * smoothstep(2.0, 12.0, dist));
  vec3 wp = p + side * position.x * w - dir * position.y * len;
  vAlong = position.y; vAcross = position.x;
  vFade = (0.006 / w) * smoothstep(0.8, 3.0, dist) * (1.0 - smoothstep(B * 0.7, B, length(p.xz - uCam.xz)));
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;
const RAIN_FRAG = /* glsl */`
uniform vec3 uColor; uniform float uOpacity;
varying float vAlong; varying float vAcross; varying float vFade;
${DEPTH_TEST}
void main(){
  sceneOcclude();
  float a = (1.0 - abs(vAcross)) * sin(vAlong * 3.14159) * uOpacity * min(1.0, vFade * 3.0);
  if (a < 0.003) discard;
  gl_FragColor = vec4(uColor, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
