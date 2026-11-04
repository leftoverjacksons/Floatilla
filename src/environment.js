import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { clamp, lerp, smoothstep, damp, fbm, rand } from './util.js';

export const DAY_SECONDS = 1200; // real seconds per in-game day at 1x (20 minutes)

const WEATHER = {
  clear: { cloud: 0.12, rain: 0, wind: 6.0, fog: 2400, label: 'Clear' },
  cloudy: { cloud: 0.6, rain: 0, wind: 8.5, fog: 1700, label: 'Overcast' },
  fog: { cloud: 0.45, rain: 0, wind: 3.0, fog: 170, label: 'Fog' },
  rain: { cloud: 0.88, rain: 0.6, wind: 10.5, fog: 750, label: 'Rain' },
  storm: { cloud: 1.0, rain: 1.0, wind: 18.5, fog: 380, label: 'Storm' },
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
    this.sun.shadow.bias = -0.0006; this.sun.shadow.normalBias = 0.04;
    scene.add(this.sun, this.sun.target);
    this.hemi = new THREE.HemisphereLight(0xbfd8ff, 0x3a4a3a, 0.8);
    scene.add(this.hemi);
    this.flashLight = new THREE.DirectionalLight(0xc8d4ff, 0);
    scene.add(this.flashLight);

    scene.fog = new THREE.Fog(0xaabbcc, 50, 2400);

    // Rain streaks around the camera.
    this.rainCount = 5000;
    const rp = new Float32Array(this.rainCount * 6);
    this.rainSeed = new Float32Array(this.rainCount * 3);
    for (let i = 0; i < this.rainCount; i++) {
      this.rainSeed[i * 3] = rand(rng, -70, 70); this.rainSeed[i * 3 + 1] = rand(rng, 0, 60); this.rainSeed[i * 3 + 2] = rand(rng, -70, 70);
    }
    const rg = new THREE.BufferGeometry(); rg.setAttribute('position', new THREE.BufferAttribute(rp, 3));
    this.rainMat = new THREE.LineBasicMaterial({ color: 0xaab8c8, transparent: true, opacity: 0, depthWrite: false });
    this.rain = new THREE.LineSegments(rg, this.rainMat); this.rain.frustumCulled = false; scene.add(this.rain);

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
    for (const key of ['cloud', 'rain', 'wind', 'fog']) this.cur[key] = lerp(this.cur[key], tgt[key], k);
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
        this.pendingThunder.push(rand(this.rng, 0.4, 3.5));
      }
    }
    for (let i = this.pendingThunder.length - 1; i >= 0; i--) {
      this.pendingThunder[i] -= dt;
      if (this.pendingThunder[i] <= 0) { this.pendingThunder.splice(i, 1); this.onThunder && this.onThunder(); }
    }

    const sceneFog = this.scene.fog;
    sceneFog.color.copy(this.fogColor).lerp(new THREE.Color(0.7, 0.75, 0.85), this.flash * 0.5);
    sceneFog.far = this.cur.fog; sceneFog.near = Math.min(40, this.cur.fog * 0.1);
    this.hazeMat.uniforms.uColor.value.copy(sceneFog.color);
    this.hazeMat.uniforms.uAmount.value = smoothstep(0.5, 1.0, cloud) * 0.85 + smoothstep(600, 150, this.cur.fog) + this.flash * 0.2;
    this.renderer.toneMappingExposure = lerp(0.42, 0.62, day) * (1 - cloud * 0.12);

    // Lights.
    const lightDir = elev > -0.05 ? this.sunDir : this.moonDir;
    this.sun.position.copy(focus).addScaledVector(lightDir, 300);
    this.sun.target.position.copy(focus);
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
    this.rainMat.opacity = r * 0.45;
    this.rain.visible = r > 0.02;
    if (!this.rain.visible) return;
    const pos = this.rain.geometry.attributes.position.array;
    const wx = Math.cos(this.windAngle) * this.windSpeed * 0.06, wz = Math.sin(this.windAngle) * this.windSpeed * 0.06;
    const fall = 22 * dt;
    const n = Math.floor(this.rainCount * r);
    for (let i = 0; i < this.rainCount; i++) {
      let y = this.rainSeed[i * 3 + 1] - fall;
      if (y < 0) y += 60;
      this.rainSeed[i * 3 + 1] = y;
      const o = i * 6;
      if (i >= n) { pos[o] = pos[o + 3] = 0; pos[o + 1] = pos[o + 4] = -9999; pos[o + 2] = pos[o + 5] = 0; continue; }
      const x = cp.x + this.rainSeed[i * 3], z = cp.z + this.rainSeed[i * 3 + 2];
      const yy = cp.y - 25 + y;
      pos[o] = x; pos[o + 1] = yy; pos[o + 2] = z;
      pos[o + 3] = x + wx; pos[o + 4] = yy + 1.1; pos[o + 5] = z + wz;
    }
    this.rain.geometry.attributes.position.needsUpdate = true;
  }

  timeString() {
    const h = Math.floor(this.hours), m = Math.floor((this.hours - h) * 60);
    return `Day ${this.day}  ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
}
