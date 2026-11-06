import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { Sky } from 'three/addons/objects/Sky.js';
import { mulberry32, clamp, pick } from './util.js';
import { FloorMap, buildTerrain } from './terrain.js';
import { City } from './city.js';
import { Water } from './water.js';
import { Environment, DAY_SECONDS, FLOOD_PACES } from './environment.js';
import { Boat, randomDesign, KINDS } from './boat.js';
import { Person, Animal } from './people.js';
import { Fleet, RECIPES, recipeCost } from './fleet.js';
import { World } from './world.js';
import { UI } from './ui.js';
import { CameraController } from './camera.js';
import { Audio } from './audio.js';
import { Fx } from './fx.js';
import { WakeSim } from './wake.js';
import { AtmospherePass } from './atmosphere.js';
import { Overtopping } from './waterfront.js';
import { RadialMenu } from './radial.js';
import { loadModels } from './models.js';
import { Landmarks, LANDMARK_RESERVED } from './landmarks.js';
import { findSpot, waterInfo } from './terrain.js';
import { LAYER_NO_REFLECT } from './tiles.js';
import { readSave, writeSave, restore, consumeLoadFlag, requestLoadOnReload } from './save.js';

class Game {
  constructor() {
    this.rng = mulberry32(20261104);
    const renderer = (this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' }));
    // Quality: URL ?q= overrides the saved choice; default high.
    let q = new URLSearchParams(location.search).get('q');
    try { q = q || localStorage.getItem('floatilla-quality'); } catch { /* ignore */ }
    this.quality = ['low', 'medium', 'high'].includes(q) ? q : 'high';
    const low = this.quality === 'low';
    renderer.setPixelRatio(low ? 0.75 : Math.min(window.devicePixelRatio, 1.75));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.shadowMap.enabled = !low;
    this.fps = 60;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    document.getElementById('app').appendChild(renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.5, 12000);
    this.camera.layers.enable(LAYER_NO_REFLECT); // trees/cars: visible in the main view, skipped by reflections
    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight; this.camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
      if (this.composer) { this.composer.setSize(window.innerWidth, window.innerHeight); this.water.resizeReflections(renderer); }
    });

    // Shared uniforms for flood-aware materials (buildings, terrain, props).
    this.floodUniforms = { uLevel: { value: 0 }, uNight: { value: 0 }, uPower: { value: 1 } };
    this.floorMap = new FloorMap(1024);
    this.city = new City(this.scene, this.floodUniforms, this.floorMap, LANDMARK_RESERVED);
    this.landmarks = new Landmarks(this, this.scene, this.city, this.floorMap, this.floodUniforms);
    buildTerrain(this.scene, this.floodUniforms, this.city);
    this.water = new Water(this.scene, this.floorMap);
    this.water.initGPU(renderer);
    this.wake = new WakeSim(renderer, this.water.uniforms.uFloor.value, this.water.uniforms.uFloorRect.value);
    this.water.uniforms.uWake.value = this.wake.texture;
    this.water.uniforms.uWakeOrigin.value = this.wake.origin;
    this.water.uniforms.uWakeOn.value = this.wake.ok ? 1 : 0;
    this.env = new Environment(this.scene, renderer, this.rng);
    this.fx = new Fx(this.scene);
    this.applyQuality(this.quality, true);
    this.audio = new Audio();
    this.env.onThunder = () => { this.audio.thunder(); this.camCtl.shake = 0.4; };
    this.camCtl = new CameraController(this.camera, renderer.domElement);
    this.world = new World(this);
    this.fleet = new Fleet(this);
    this.ui = new UI(this);
    this.wind = new THREE.Vector2();
    this.paused = false; this.started = false; this.over = false;
    this.keys = new Set();

    this.ctx = {
      water: this.water, env: this.env, city: this.city, floorMap: this.floorMap, wind: this.wind, fx: this.fx, wake: this.wake,
      fuel: (b) => (b && !b.fleet ? 999 : this.fleet.inv.fuel),
      useFuel: (n, b) => { if (!b || b.fleet) this.fleet.inv.fuel = Math.max(0, this.fleet.inv.fuel - n); },
      warn: (m) => this.warnOnce(m),
      nearCamera: (b) => b.root.position.distanceToSquared(this.camera.position) < 250 * 250,
      canRepair: true,
      onImpact: (b, v) => { if (b === this.fleet.player) { this.audio.thud(v); this.camCtl.shake = Math.min(1, v * 0.12); } },
      onSinking: (b) => this.onSinking(b),
      onSlam: (b, e) => { if (b === this.fleet.player) { this.camCtl.shake = Math.max(this.camCtl.shake || 0, e * 0.25); if (this.audio.splash) this.audio.splash(e); } },
    };

    this.world.populateHarbour();
    this.overtopping = new Overtopping(this.city);
    const save = consumeLoadFlag() ? readSave() : null;
    this.loadedFromSave = false;
    if (save) {
      try { restore(this, save); this.loadedFromSave = true; }
      catch (err) { console.error('Save could not be restored', err); location.reload(); return; }
    } else this.setupStart();
    this.autosaveTimer = 90;
    this.searchlight = new THREE.SpotLight(0xfff4dd, 0, 140, 0.32, 0.4, 1.2);
    this.searchlight.castShadow = false;
    this.scene.add(this.searchlight, this.searchlight.target);

    this.bindInput();
    this.clock = new THREE.Clock();
    this.frame = this.frame.bind(this);
    requestAnimationFrame(this.frame);
  }

  /**
   * Quality presets, switchable at runtime from the action wheel:
   *  low    — direct render, no shadows, 0.75 pixel ratio
   *  medium — MSAA + bloom + sky environment light, 2048 shadows, no water reflections
   *  high   — medium plus planar water reflections and 4096 shadows
   */
  applyQuality(q, initial = false) {
    const r = this.renderer;
    this.quality = q;
    try { localStorage.setItem('floatilla-quality', q); } catch { /* ignore */ }
    const shadows = q !== 'low';
    this.baseRatio = q === 'low' ? 0.75 : Math.min(window.devicePixelRatio, q === 'high' ? 1.5 : 1.25);
    this.resScale = this.resScale || 1;
    r.setPixelRatio(this.baseRatio * this.resScale);
    r.setSize(window.innerWidth, window.innerHeight);
    if (q !== 'low' && !this.composer) this.setupHighQuality();
    if (this.composer) this.composer.setSize(window.innerWidth, window.innerHeight);
    const sun = this.env.sun;
    sun.shadow.camera.layers.enable(LAYER_NO_REFLECT);
    const size = q === 'high' ? 4096 : 2048;
    // shadow coverage around the camera focus: wider on high so nearby blocks and landmarks cast shadows too
    const ext = q === 'high' ? 150 : 90, sc = sun.shadow.camera;
    sc.left = -ext; sc.right = ext; sc.top = ext; sc.bottom = -ext; sc.far = 1100; sc.updateProjectionMatrix();
    this.env.shadowStep = (2 * ext) / size;
    if (sun.shadow.mapSize.x !== size) { sun.shadow.mapSize.set(size, size); if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; } }
    if (r.shadowMap.enabled !== shadows) {
      r.shadowMap.enabled = shadows;
      if (!initial) this.scene.traverse((o) => { if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => (m.needsUpdate = true)); });
    }
    this.water.reflectionsOn = q === 'high';
    this.water.uniforms.uReflOn.value = q === 'high' ? 1 : 0;
    if (q === 'high') this.water.resizeReflections(r);
    // medium/high: height fog and light shafts in screen space; low: classic linear fog
    this.scene.fog = q === 'low' ? this.env.fog : null;
    if (this.lateScene) this.env.setLate(q === 'low' ? null : this.lateScene, this.atmosphere.sceneDepth, this.atmosphere.sceneRes);
    if (q === 'low') this.scene.environment = null;
    else if (this.envRT) this.scene.environment = this.envRT.texture;
  }

  /**
   * Dynamic resolution: drop render resolution in 10% steps while the frame rate is under ~50 fps,
   * and creep back up when there is headroom. Keeps the frame rate steady instead of the image sharp.
   */
  adaptResolution(dt) {
    if (!this.started || this.paused) return;
    this.resTimer = (this.resTimer || 0) + dt;
    if (this.resTimer < 1.5) return;
    this.resTimer = 0;
    const minScale = this.quality === 'low' ? 0.8 : 0.55;
    let s = this.resScale;
    if (this.fps < 48 && s > minScale) s = Math.max(minScale, s - 0.1);
    else if (this.fps > 58 && s < 1) s = Math.min(1, s + 0.05);
    if (s === this.resScale) return;
    this.resScale = s;
    this.renderer.setPixelRatio(this.baseRatio * s);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    if (this.composer) this.composer.setSize(window.innerWidth, window.innerHeight);
    if (this.water.reflectionsOn) this.water.resizeReflections(this.renderer);
  }

  /** Builds the post-processing chain and environment light once (used by medium and high). */
  setupHighQuality() {
    const r = this.renderer;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    this.water.enableReflections(r);
    this.water.hideInReflection.push(this.fx.points, this.fx.decals, this.env.rain);
    const size = r.getDrawingBufferSize(new THREE.Vector2());
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
    rt.depthTexture = new THREE.DepthTexture(size.x, size.y); // read by the atmosphere pass
    rt.depthTexture.type = THREE.UnsignedIntType;
    this.composer = new EffectComposer(r, rt);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.atmosphere = new AtmospherePass(this.camera);
    this.composer.addPass(this.atmosphere);
    // rain and lightning, drawn over the fogged image
    this.lateScene = new THREE.Scene();
    const late = new RenderPass(this.lateScene, this.camera);
    late.clear = false; late.clearDepth = false;
    this.composer.addPass(late);
    // Safety net: replace any non-finite pixel and clamp extreme HDR values before bloom.
    this.composer.addPass(new ShaderPass({
      uniforms: { tDiffuse: { value: null } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `uniform sampler2D tDiffuse; varying vec2 vUv;
        void main(){ vec4 c = texture2D(tDiffuse, vUv);
          // comparison form also catches NaN/Inf on drivers that optimize isnan() away
          bool bad = any(isnan(c.rgb)) || any(isinf(c.rgb)) || !(abs(c.r) < 1e5) || !(abs(c.g) < 1e5) || !(abs(c.b) < 1e5);
          if (bad) c = vec4(0.0, 0.0, 0.0, 1.0);
          gl_FragColor = vec4(min(c.rgb, vec3(48.0)), c.a); }`,
    }));
    // Gentle vignette and split-tone grade (cool shadows, warm highlights), applied in linear HDR before tone mapping.
    this.gradePass = new ShaderPass({
      uniforms: { tDiffuse: { value: null } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `uniform sampler2D tDiffuse; varying vec2 vUv;
        void main(){ vec4 c = texture2D(tDiffuse, vUv);
          vec2 d = (vUv - 0.5) * vec2(1.0, 0.8);
          c.rgb *= mix(0.8, 1.0, smoothstep(0.75, 0.2, length(d)));
          float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
          c.rgb *= mix(vec3(1.0), vec3(0.95, 1.0, 1.05), smoothstep(0.35, 0.0, l) * 0.6);
          c.rgb *= mix(vec3(1.0), vec3(1.04, 1.0, 0.95), smoothstep(0.5, 2.5, l) * 0.6);
          gl_FragColor = c; }`,
    });
    this.bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.35, 0.55, 0.92);
    this.composer.addPass(this.bloom);
    this.composer.addPass(this.gradePass);
    this.composer.addPass(new OutputPass());
    // Environment lighting: a private copy of the sky, re-baked as the sun moves.
    this.pmrem = new THREE.PMREMGenerator(r);
    this.envScene = new THREE.Scene();
    this.envSky = new Sky(); this.envSky.scale.setScalar(1000);
    this.envSky.material = this.env.sky.material; // shares sun position / turbidity uniforms
    this.envScene.add(this.envSky);
    this.envTimer = 0; this.envSun = new THREE.Vector3(0, -1, 0);
  }

  updateEnvMap(dt) {
    this.envTimer -= dt;
    const sun = this.env.sunDir;
    if (this.envTimer > 0 && sun.distanceTo(this.envSun) < 0.03) return;
    this.envTimer = 4; this.envSun.copy(sun);
    const old = this.envRT;
    this.envRT = this.pmrem.fromScene(this.envScene, 0.02, 1, 3000);
    this.scene.environment = this.envRT.texture;
    if (old) old.dispose();
  }

  setupStart() {
    const rng = this.rng;
    this.water.level = 0;
    // A tired 10 m cruising sloop: room to grow into, a weak auxiliary engine and a hull that needs work.
    const d = randomDesign(rng, 'sailboat');
    Object.assign(d, { length: 10, beam: 3.3, draft: 1.1, freeboard: 0.95, engine: 8, name: 'Little Ark', hullColor: 0xe8e2d0, trimColor: 0x1f3f6b, clothColor: 0xe8dcc0 });
    // start on the bay just off the river mouth, facing the town
    const start = findSpot(-40, -150, -30, -1.5, 400, (x, z) => { const wi = waterInfo(x, z); return wi.kind === 'bay' && wi.d < -25; });
    this.startPos = start;
    const boat = new Boat(d, { x: start.x, z: start.z, heading: Math.PI, role: 'player', flagColor: 0xff7a1a, hpFrac: 0.55 });
    this.scene.add(boat.root);
    this.world.boats.push(boat);
    this.playerPerson = new Person(rng, { isPlayer: true, name: 'You' });
    this.fleet.boats.push(boat); boat.fleet = this.fleet;
    this.fleet.player = boat;
    boat.addPerson(this.playerPerson);
    boat.addAnimal(new Animal(rng, 'dog'));
    this.fleet.trail = [{ x: boat.x, z: boat.z }];
    this.camCtl.snapTo(boat);

    // A nearby abandoned rowboat and a family waiting at the end of a pier.
    const w = this.world;
    // The first discoveries: a half-sunk rowboat drifting off the quay, and one
    // person stranded on a warehouse roof in the drowned harbor district.
    this.env.update(0, new THREE.Vector3(), this.camera);
    const level = this.env.level;
    this.water.level = level;
    const rb = findSpot(start.x + 90, start.z + 60, -30, -1.5, 300, (x, z) => waterInfo(x, z).d < -15);
    w.spawnBoat('rowboat', rb.x, rb.z, 'derelict', { hpFrac: 0.3, heading: 2.5 });
    // someone waiting at the end of a pier for a boat out
    let best = null, bd = Infinity;
    for (const c of this.city.colliders) {
      if (c.kind !== 'pier' || !c.pierEnd) continue;
      const d = Math.hypot(c.pierEnd.x - start.x, c.pierEnd.z - start.z);
      if (d > 150 && d < bd) { bd = d; best = c; }
    }
    if (best) {
      const e = best.pierEnd;
      best.roof = { minx: e.x - 2, maxx: e.x + 2, minz: e.z - 2, maxz: e.z + 2, top: best.top };
      w.spawnSurvivorGroup(best, { people: 1, animal: 'cat' });
    }
    for (let i = 0; i < 3; i++) { const pk = findSpot(start.x + (rng() - 0.5) * 120, start.z + 40 + rng() * 60, -30, -1, 120); w.spawnPickup(pk.x, pk.z); }
  }

  warnOnce(m) {
    const now = performance.now();
    if (this._lastWarn === m && now - this._lastWarnT < 5000) return;
    this._lastWarn = m; this._lastWarnT = now;
    this.ui.toast(m, 'warn');
  }

  bindInput() {
    const title = document.getElementById('title');
    const cta = document.getElementById('cta-new'), cont = document.getElementById('cta-continue');
    const existing = readSave();
    const start = () => {
      title.style.display = 'none'; this.started = true; this.audio.init();
      if (this.loadedFromSave) this.ui.toast(`Voyage resumed: ${this.env.timeString()}, flood at ${this.env.level.toFixed(1)} m.`, 'good');
      else {
        this.ui.toast('Day 1. Just you, the dog and a tired old sloop. The sea is rising: by tomorrow it will be over the quays. Find people. Mend the boat.', 'info');
        this.ui.toast('W/S throttle, A/D steer. Right-click anywhere for the action wheel: sails, interact, workshop, fleet, save.', 'info');
      }
    };
    if (this.loadedFromSave) {
      cta.textContent = `Resume — ${this.env.timeString()}`;
      cont.style.display = 'none';
    } else if (existing) {
      const n = existing.boats.length;
      cont.textContent = `Continue — Day ${existing.env.day}, ${n} boat${n > 1 ? 's' : ''}`;
      cont.style.display = '';
      cont.onclick = (e) => { e.stopPropagation(); requestLoadOnReload(); };
      cta.textContent = 'New voyage (overwrites save on next save)';
    } else cont.style.display = 'none';
    cta.onclick = (e) => { e.stopPropagation(); start(); };
    window.addEventListener('keydown', (e) => {
      if (!this.started || this.over) return;
      const k = e.key.toLowerCase();
      if (k === 'tab') e.preventDefault();
      if (e.repeat) { this.keys.add(k); return; }
      this.keys.add(k);
      const f = this.fleet, pl = f.player;
      switch (k) {
        case 'c': this.ui.toggleCraft(); break;
        case 'escape': if (this.ui.craftOpen) this.ui.toggleCraft(false); else { this.toggleHelp(false); this.ui.toggleJournal(false); document.getElementById('note').style.display = 'none'; } break;
        case 'h': case '?': this.toggleHelp(); break;
        case 'p': if (!this.ui.craftOpen) this.paused = !this.paused; break;
      }
      if (this.paused) return;
      const A = this.actions;
      switch (k) {
        case 'e': A.interact(); break;
        case 'x': A.salvage(); break;
        case 'r': A.sails(); break;
        case ' ': A.stop(); break;
        case 'tab': A.switchBoat(e.shiftKey ? -1 : 1); break;
        case 'f': A.detach(); break;
        case 'g': A.hold(); break;
        case 'l': A.light(); break;
        case 't': A.time(); break;
        case 'k': A.save(); break;
        case 'j': A.journal(); break;
        case 'v': A.walk(); break;
        case 'o': A.load(); break;
        case ']': this.env.levelOffset += 1; this.ui.toast('[debug] Water +1 m'); break;
        case '[': this.env.levelOffset -= 1; this.ui.toast('[debug] Water −1 m'); break;
      }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    this.radial = new RadialMenu(this);
    window.addEventListener('blur', () => this.keys.clear());
    document.getElementById('restart').onclick = () => location.reload();
  }

  /** Every player action, shared by the hotkeys and the right-click radial menu. */
  get actions() {
    const f = this.fleet, pl = f.player, ui = this.ui;
    return {
      interact: () => this.world.interact(false),
      salvage: () => { const it = this.world.findInteraction(); if (it && it.kind === 'claim') this.world.interact(true); },
      sails: () => { if (pl.rigs.length) { pl.sailsUp = !pl.sailsUp; ui.toast(pl.sailsUp ? 'Sails up.' : 'Sails furled.'); } else ui.toast('No sails on this boat — build a Mast & Sail in the Workshop.', 'warn'); },
      stop: () => { pl.throttle = 0; },
      craft: () => ui.toggleCraft(),
      switchBoat: (dir = 1) => { const b = f.cycleLead(dir); ui.toast(b ? `You take the helm of the ${b.name}.` : 'No other boats in the floatilla yet.'); },
      detach: () => ui.toast(f.boats.length > 1 ? f.toggleDetach() : 'You have no floatilla to detach from yet.'),
      hold: () => ui.toast(f.toggleHold()),
      light: () => { if (pl.count('light')) pl.lightOn = !pl.lightOn; else ui.toast('No searchlight on this boat — build one in the Workshop.'); },
      time: () => { this.env.timeScale = this.env.timeScale === 1 ? 6 : this.env.timeScale === 6 ? 30 : 1; ui.toast(`Time ×${this.env.timeScale}`); },
      save: () => ui.toast(writeSave(this) ? `Saved (${this.env.timeString()}).` : 'Could not save.', 'good'),
      load: () => { if (readSave()) { ui.toast('Loading last save…'); setTimeout(requestLoadOnReload, 300); } else ui.toast('No save found.', 'warn'); },
      pause: () => { if (!ui.craftOpen) this.paused = !this.paused; },
      walk: () => this.setOnFoot(!this.onFoot),
      journal: () => ui.toggleJournal(),
      help: () => this.toggleHelp(),
    };
  }

  /** Items for the radial menu, built fresh each time it opens so labels reflect the current state. */
  menuItems() {
    const f = this.fleet, pl = f.player, A = this.actions;
    const it = this.world.findInteraction();
    const many = f.boats.length > 1;
    const items = [
      { icon: '✋', label: it ? it.label.replace(/\[[A-Z]\]\s*/g, '').split('·')[0].trim() : 'Interact', key: 'E', accent: !!it, disabled: !it, why: 'Nothing close enough. Bring the boat alongside survivors, a rooftop cache or another boat.', desc: 'Do it.', run: A.interact },
    ];
    if (it && it.kind === 'claim') items.push({ icon: '⚒', label: 'Salvage', key: 'X', desc: 'Strip this boat for wood, scrap, cloth and parts. It sinks.', run: A.salvage });
    items.push(
      { icon: '⛵', label: pl.sailsUp ? 'Furl sails' : 'Raise sails', key: 'R', disabled: !pl.rigs.length, why: 'This boat has no mast. Build a Mast & Sail in the Workshop.', desc: 'Sails give no drive within about 35° of the wind.', run: A.sails },
      { icon: '⏹', label: 'All stop', key: 'Space', disabled: pl.throttle === 0, why: 'Throttle is already at zero.', desc: 'Throttle to zero.', run: A.stop },
      { icon: this.onFoot ? '☸' : '🚶', label: this.onFoot ? 'Take the helm' : 'Walk the deck', key: 'V', desc: this.onFoot ? 'Back to steering.' : 'Leave the wheel and explore the boat on foot (WASD, Shift to hurry). The boat holds her course.', run: A.walk },
      { icon: '📖', label: 'Journal', key: 'J', desc: 'Landmarks you have found, notes you have read, and when the flood will open the way to the rest.', run: A.journal },
      { icon: '🔨', label: 'Workshop', key: 'C', desc: 'Repairs, upgrades and boatbuilding. Pauses the game.', run: A.craft },
      { icon: '⚓', label: f.mode === 'hold' ? 'Fleet: follow me' : 'Fleet: hold', key: 'G', disabled: !many, why: 'You have no other boats yet.', desc: f.mode === 'hold' ? 'Boats weigh anchor and follow your wake.' : 'All other boats drop anchor where they are.', run: A.hold },
      { icon: '🧭', label: f.detached ? 'Regroup' : 'Go alone', key: 'F', disabled: !many, why: 'You have no other boats yet.', desc: f.detached ? 'Call the floatilla to your position.' : 'Leave the floatilla anchored and scout ahead.', run: A.detach },
      { icon: '⇄', label: 'Switch boat', key: 'Tab', disabled: !many, why: 'You have no other boats yet.', desc: 'Take the helm of the next boat; it becomes the lead.', run: () => A.switchBoat(1) },
      { icon: '🔦', label: pl.lightOn ? 'Light off' : 'Searchlight', key: 'L', disabled: !pl.count('light'), why: 'No searchlight fitted. Build one in the Workshop.', desc: 'Lights the way at night and deters raiders.', run: A.light },
      { icon: '🌊', label: `Flood: ${this.env.paceLabel}`, desc: `How fast the water rises. Next: ${FLOOD_PACES[(FLOOD_PACES.findIndex(([v]) => v === this.env.floodPace) + 1) % FLOOD_PACES.length][1]}. Now ${(this.env.floodRate * 100).toFixed(0)} cm per game hour (a game hour is 50 s).`,
        run: () => { const i = (FLOOD_PACES.findIndex(([v]) => v === this.env.floodPace) + 1) % FLOOD_PACES.length; this.env.floodPace = FLOOD_PACES[i][0]; this.ui.toast(`Flood pace: ${FLOOD_PACES[i][1]}`); } },
      { icon: '⏩', label: `Time ×${this.env.timeScale === 1 ? 6 : this.env.timeScale === 6 ? 30 : 1}`, key: 'T', desc: `Currently ×${this.env.timeScale}.`, run: A.time },
      { icon: '🖥', label: `Quality: ${this.quality}`, desc: `Next: ${{ low: 'medium', medium: 'high', high: 'low' }[this.quality]}. High adds water reflections (the most expensive part); medium keeps glow, shadows and antialiasing; low is plain and fastest. Currently ${Math.round(this.fps)} fps.`, run: () => { const n = { low: 'medium', medium: 'high', high: 'low' }[this.quality]; this.applyQuality(n); this.ui.toast(`Quality: ${n}`); } },
      { icon: '💾', label: 'Save', key: 'K', desc: 'Save to this browser. Autosaves every 90 s.', run: A.save },
      { icon: '📂', label: 'Load', key: 'O', disabled: !readSave(), why: 'No save yet.', desc: 'Reload the last save.', run: A.load },
      { icon: '?', label: 'Help', key: 'H', desc: 'All controls.', run: A.help },
    );
    return items;
  }

  toggleHelp(v) {
    const el = document.getElementById('help');
    const show = v !== undefined ? v : el.style.display !== 'block';
    el.style.display = show ? 'block' : 'none';
  }

  craft(id, boat) {
    const r = RECIPES.find((x) => x.id === id); const f = this.fleet;
    if (!r) return;
    const cost = recipeCost(r, boat);
    if (!f.canAfford(cost)) return;
    if (r.module) { if (boat.canAdd(r.module)) return; f.pay(cost); boat.addModule(r.module); this.ui.toast(`${r.label} fitted to the ${boat.name}.`, 'good'); }
    else if (r.id === 'patch') { f.pay(cost); boat.hp = Math.min(boat.maxHp, boat.hp + 20); this.ui.toast('Hull patched.', 'good'); }
    else if (r.id === 'lengthen') { f.pay(cost); boat.design.lengthened = (boat.design.lengthened || 0) + 1; boat.lengthen(1.5); this.ui.toast(`The ${boat.name} is now ${boat.L.toFixed(1)} m.`, 'good'); }
    else if (r.gives) { f.pay(cost); for (const [k, v] of Object.entries(r.gives)) f.give(k, v); this.ui.toast(`${r.label}: +${Object.entries(r.gives).map(([k, v]) => `${v} ${k}`).join(', ')}`, 'good'); }
    else if (r.newBoat) {
      const donorBoat = f.boats.find((b) => b.crew.some((p) => !p.isPlayer));
      if (!donorBoat) return;
      const donor = donorBoat.crew.find((p) => !p.isPlayer);
      f.pay(cost);
      const pl = f.player;
      const side = { x: Math.cos(pl.heading) * (pl.B + 4), z: -Math.sin(pl.heading) * (pl.B + 4) };
      const nb = this.world.spawnBoat(r.newBoat, pl.x + side.x, pl.z + side.z, 'derelict', { heading: pl.heading });
      donorBoat.removePerson(donor); nb.addPerson(donor);
      f.add(nb); f.stats.boatsJoined++;
      this.ui.toast(`Launched the ${nb.name}! ${donor.name} takes her.`, 'good');
    }
    this.audio.blip(800);
  }

  onSinking(b) {
    const f = this.fleet;
    if (!f.boats.includes(b)) { if (b.role === 'raider') { this.ui.toast('The raider boat is going down!', 'good'); for (let i = 0; i < 3; i++) this.world.spawnPickup(b.x + (Math.random() - 0.5) * 6, b.z + (Math.random() - 0.5) * 6); } return; }
    this.ui.toast(`The ${b.name} is sinking!`, 'bad');
    f.remove(b);
    const others = f.boats.filter((x) => !x.sinking);
    const isPlayer = b === f.player;
    for (const p of [...b.crew]) {
      b.removePerson(p);
      const dest = others.filter((x) => x.freeBerths > 0 || p.isPlayer).sort((a, c) => Math.hypot(a.x - b.x, a.z - b.z) - Math.hypot(c.x - b.x, c.z - b.z))[0];
      if (dest && Math.hypot(dest.x - b.x, dest.z - b.z) < 400) { if (!p.isPlayer) dest.addPerson(p); }
      else if (!p.isPlayer) { f.stats.lost++; this.ui.toast(`${p.name} was lost with the ${b.name}.`, 'bad'); }
    }
    for (const a of [...b.animals]) { b.removeAnimal(a); const dest = others[0]; if (dest) dest.addAnimal(a); }
    if (isPlayer) {
      f.player = null;
      const next = others.sort((a, c) => Math.hypot(a.x - b.x, a.z - b.z) - Math.hypot(c.x - b.x, c.z - b.z))[0];
      if (next && Math.hypot(next.x - b.x, next.z - b.z) < 400) {
        this.playerPerson.boat = null;
        f.setPlayerBoat(next);
        this.ui.toast(`You swim to the ${next.name} and take command.`, 'warn');
      } else this.gameOver('Your boat went down and there was no one near enough to pull you out.');
    }
  }

  gameOver(reason) {
    if (this.over) return;
    this.over = true;
    this.ui.showGameOver(reason);
  }

  setOnFoot(on) {
    const p = this.playerPerson, b = p.boat;
    if (!b) return;
    this.onFoot = on;
    p.manual = on;
    if (on) {
      p.walkY = b.deckY;
      this.footDist = this.footDist || 6;
      this.boatDist = this.camCtl.dist; this.camCtl.dist = this.footDist;
      b.rudder = 0;
      this.ui.toast('On foot. WASD to walk, Shift to hurry. The boat holds her course and speed. V (or the wheel) to take the helm again.');
    } else {
      this.footDist = this.camCtl.dist; this.camCtl.dist = this.boatDist || 22;
      b.taskTimer = 0;
      this.ui.toast('You take the helm.');
    }
  }

  /** Walk the player character around the deck of their boat, in camera-relative directions. */
  walk(dt) {
    const p = this.playerPerson, b = p.boat, k = this.keys;
    if (!b || !b.obstacles) return;
    b.rudder += (0 - b.rudder) * Math.min(1, dt * 3);
    let fwd = 0, side = 0;
    if (k.has('w') || k.has('arrowup')) fwd += 1;
    if (k.has('s') || k.has('arrowdown')) fwd -= 1;
    if (k.has('d') || k.has('arrowright')) side += 1;
    if (k.has('a') || k.has('arrowleft')) side -= 1;
    const yaw = this.camCtl.yaw;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw), rx = -fz, rz = fx;
    let mx = fx * fwd + rx * side, mz = fz * fwd + rz * side;
    const len = Math.hypot(mx, mz), moving = len > 0.01;
    const r = 0.22;
    if (moving) {
      mx /= len; mz /= len;
      const ch = Math.cos(b.heading), sh = Math.sin(b.heading);
      const lx = mx * ch - mz * sh, lz = mx * sh + mz * ch; // world -> boat-local
      const step = (k.has('shift') ? 3.0 : 1.5) * dt;
      let nx = p.local.x + lx * step, nz = p.local.z + lz * step;
      nz = clamp(nz, b.walkZ[0], b.walkZ[1]);
      const da = b.deckAt(nz);
      nx = clamp(nx, -(da.w - 0.25), da.w - 0.25);
      for (const o of b.obstacles) {
        if (o.top <= p.walkY + 0.6) continue; // climbable
        const inNew = nx > o.minx - r && nx < o.maxx + r && nz > o.minz - r && nz < o.maxz + r;
        if (!inNew) continue;
        const inOldX = p.local.x > o.minx - r && p.local.x < o.maxx + r;
        const inOldZ = p.local.z > o.minz - r && p.local.z < o.maxz + r;
        if (inOldX && inOldZ) continue; // started inside (spawned in a cabin): let them walk out
        if (!inOldX) nx = p.local.x;
        if (!inOldZ) nz = p.local.z;
      }
      p.local.x = nx; p.local.z = nz;
      p.mesh.rotation.y = Math.atan2(lx, lz);
    }
    let standY = b.deckAt(p.local.z).y;
    for (const o of b.obstacles) {
      if (p.local.x > o.minx && p.local.x < o.maxx && p.local.z > o.minz && p.local.z < o.maxz && o.top <= p.walkY + 0.6) standY = Math.max(standY, o.top);
    }
    p.walkY = standY > p.walkY ? standY : Math.max(standY, p.walkY - 6 * dt);
    p.mesh.position.set(p.local.x, p.walkY, p.local.z);
    p.animate(dt, moving ? 'walk' : 'idle');
  }

  playerControls(dt) {
    const b = this.fleet.player, k = this.keys;
    if (!b || this.ui.craftOpen) return;
    if (this.onFoot) { if (this.playerPerson.boat === b) return this.walk(dt); this.setOnFoot(false); }
    if (k.has('w') || k.has('arrowup')) b.throttle = Math.min(1, b.throttle + dt * 0.8);
    if (k.has('s') || k.has('arrowdown')) b.throttle = Math.max(-0.5, b.throttle - dt * 0.8);
    let r = 0;
    if (k.has('a') || k.has('arrowleft')) r += 1;
    if (k.has('d') || k.has('arrowright')) r -= 1;
    b.rudder += (r - b.rudder) * Math.min(1, dt * 5);
  }

  collideBoats() {
    const all = this.world.boats.filter((b) => !b.sunk && !b.sinking);
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
      const a = all[i], b = all[j];
      const dx = b.x - a.x, dz = b.z - a.z;
      if (dx * dx + dz * dz > ((a.L + b.L) * 0.5 + 1) ** 2) continue;
      // nearest pair of keel circles
      let best = null;
      const circles = (q) => { const n = Math.max(1, Math.round(q.L / q.B)); const fx = Math.sin(q.heading), fz = Math.cos(q.heading); const out = []; for (let k = 0; k < n; k++) { const t = n === 1 ? 0 : -q.L / 2 + q.B / 2 + (q.L - q.B) * k / (n - 1); out.push([q.x + fx * t, q.z + fz * t, q.B * 0.55]); } return out; };
      for (const ca of circles(a)) for (const cb of circles(b)) {
        const ex = cb[0] - ca[0], ez = cb[1] - ca[1], d = Math.hypot(ex, ez), pen = ca[2] + cb[2] - d;
        if (pen > 0 && (!best || pen > best.pen)) best = { nx: ex / (d || 1), nz: ez / (d || 1), pen };
      }
      if (!best) continue;
      const ma = a.mass, mb = b.mass, tot = ma + mb;
      a.x -= best.nx * best.pen * mb / tot; a.z -= best.nz * best.pen * mb / tot;
      b.x += best.nx * best.pen * ma / tot; b.z += best.nz * best.pen * ma / tot;
      const rv = (b.vx - a.vx) * best.nx + (b.vz - a.vz) * best.nz;
      if (rv < 0) {
        const jimp = -(1.3) * rv / (1 / ma + 1 / mb);
        a.vx -= jimp * best.nx / ma; a.vz -= jimp * best.nz / ma;
        b.vx += jimp * best.nx / mb; b.vz += jimp * best.nz / mb;
        const impact = -rv;
        if (impact > 1.5) {
          a.hurt((impact - 1.5) * 5 * mb / tot * 2, this.ctx); b.hurt((impact - 1.5) * 5 * ma / tot * 2, this.ctx);
          if (a === this.fleet.player || b === this.fleet.player) { this.audio.thud(impact); this.camCtl.shake = Math.min(1, impact * 0.1); }
        }
      }
    }
  }

  frame() {
    requestAnimationFrame(this.frame);
    const rawDt = Math.min(this.clock.getDelta(), 0.05);
    const dt = this.started && !this.paused && !this.over ? rawDt : 0;
    const env = this.env, f = this.fleet;
    const focus = f.player ? new THREE.Vector3(f.player.x, f.player.y, f.player.z) : this.camCtl.target;
    if (dt > 0) this.playerControls(dt);
    env.update(dt, focus, this.camera);
    this.wind.set(Math.cos(env.windAngle), Math.sin(env.windAngle)).multiplyScalar(env.windSpeed);
    // the ocean follows the sustained weather wind, not momentary gusts
    this.water.setSeaState(0.35 + env.cur.wind / 7, env.windAngle, env.cur.wind, env.rainAmt);
    const u = this.water.uniforms;
    u.uSunDir.value.copy(env.sunDir.y > -0.05 ? env.sunDir : env.moonDir);
    u.uSunColor.value.copy(env.sunDir.y > -0.05 ? env.sunColor : new THREE.Color(0.5, 0.55, 0.7));
    u.uSunInt.value = (env.sunDir.y > -0.05 ? env.dayFactor : 0.25 * (1 - env.night * 0)) * (1 - env.cur.cloud * 0.85);
    u.uSkyColor.value.copy(env.skyTop); u.uHorizon.value.copy(env.horizon);
    u.uLight.value = env.lightLevel ?? 1; u.uRain.value = env.rainAmt; u.uFlash.value = env.flash;
    u.uWind.value.set(this.wind.x, this.wind.y).multiplyScalar(0.1);
    this.water.update(dt, env.level, this.camera.position);
    this.water.simulate();
    this.floodUniforms.uLevel.value = env.level;
    this.city.currentLevel = env.level; // bridges become barriers as the water nears their underside
    this.floodUniforms.uNight.value = env.night;
    this.floodUniforms.uPower.value = clamp(1 - env.elapsedDays / 6, 0, 1) * 0.85 + 0.15;

    if (dt > 0 && f.player) {
      const gameHours = dt * env.timeScale * 24 / DAY_SECONDS;
      this.ctx.canRepair = f.inv.wood > 0.5 || f.inv.scrap > 0.5;
      f.update(dt, this.ctx, gameHours);
      for (const b of [...f.boats]) b.update(dt, this.ctx);
      this.collideBoats();
      this.autosaveTimer -= dt;
      if (this.autosaveTimer <= 0) { this.autosaveTimer = 90; writeSave(this); }
      this.world.update(dt, this.ctx);
      this.landmarks.update(dt, this.ctx);
      for (const b of [...this.world.boats]) if (b.sunk && b.fleet === null && !f.boats.includes(b)) this.world.removeBoat(b);
      // people health
      for (const b of f.boats) for (const p of [...b.crew]) {
        if (p.health > 0) continue;
        if (p.isPlayer) { this.gameOver('You succumbed to hunger and thirst.'); break; }
        b.removePerson(p); f.stats.lost++; this.ui.toast(`${p.name} has died.`, 'bad');
      }
      if (f.player && this.onFoot && this.playerPerson.boat) {
        const wp = this.playerPerson.mesh.getWorldPosition(new THREE.Vector3());
        this.camCtl.update(dt, { x: wp.x, y: wp.y - 0.4, z: wp.z, heading: f.player.heading, speed: 0, L: 0 }, this.water);
      } else if (f.player) this.camCtl.update(dt, f.player, this.water);
    } else if (f.player && !this.started) {
      // idle title-screen orbit
      this.camCtl.yaw += rawDt * 0.05; this.camCtl.update(rawDt, f.player, this.water);
      f.player.update(0.0001, this.ctx);
    }
    // hulls press on the wake field around the focus
    if (this.wake.ok) {
      // nearest hulls first: the field takes 16
      const near = this.world.boats.filter((b) => !b.sunk && this.wake.covers(b.x, b.z, -20))
        .sort((a, b) => Math.hypot(a.x - focus.x, a.z - focus.z) - Math.hypot(b.x - focus.x, b.z - focus.z));
      for (const b of near) {
        const d = b.design;
        this.wake.addBoat(b.x, b.z, b.heading, d.length * 0.5, d.beam * 0.5, Math.min(1.2, d.draft * 0.45 + 0.1), Math.hypot(b.vx, b.vz));
      }
      this.wake.update(dt, focus, env.level);
    }
    // spindrift: in a strong blow, spray is torn off the crests and carried downwind
    if (dt > 0 && env.windSpeed > 11) {
      const n = (env.windSpeed - 11) * 9 * dt;
      const wx = Math.cos(env.windAngle), wz = Math.sin(env.windAngle);
      for (let i = 0; i < n + (Math.random() < n % 1 ? 1 : 0); i++) {
        const a = Math.random() * Math.PI * 2, r = 6 + Math.random() * 55;
        const x = focus.x + Math.cos(a) * r, z = focus.z + Math.sin(a) * r;
        if (this.water.depthAt(x, z) < 1) continue;
        const s = env.windSpeed * (0.45 + Math.random() * 0.35);
        this.fx.emit(x, this.water.heightFast(x, z) + 0.2, z, wx * s, 0.8 + Math.random() * 1.6, wz * s, 0.9 + Math.random() * 0.9, 0.3 + Math.random() * 0.5, 1);
      }
    }
    this.overtopping.update(dt, this.ctx, this.camera.position, this.audio);
    this.fx.update(dt, this.water, 0.3 + 0.7 * (env.lightLevel ?? 1));
    this.city.update(dt, env.night, performance.now() / 1000, this.camera.position);

    // searchlight follows the lead boat
    const pl = f.player;
    if (pl && pl.lightOn && pl.lightHead) {
      const p = pl.lightHead.localToWorld(new THREE.Vector3(0, 1.7, 0.3));
      this.searchlight.position.copy(p);
      this.searchlight.target.position.copy(pl.lightHead.localToWorld(new THREE.Vector3(0, -1, 40)));
      this.searchlight.intensity = 400;
    } else this.searchlight.intensity = 0;

    if (pl) this.audio.update({ wind: env.windSpeed, rain: env.rainAmt, sea: this.water.sea, speed: pl.speed, engine: pl.engineOn, throttle: pl.throttle, power: pl.enginePower });
    if (this.started) this.ui.update(rawDt);
    this.fps += (1 / Math.max(rawDt, 1e-3) - this.fps) * 0.05;
    this.adaptResolution(rawDt);
    // Shadows refresh every other frame: halves the cost of the shadow pass, imperceptible at sailing speeds.
    this.frameNo = (this.frameNo || 0) + 1;
    this.renderer.shadowMap.autoUpdate = false;
    if (this.renderer.shadowMap.enabled && this.frameNo % 2 === 0) this.renderer.shadowMap.needsUpdate = true;
    if (this.composer && this.quality !== 'low') {
      this.updateEnvMap(rawDt);
      if (this.water.reflectionsOn) {
        // reflections have no depth pass of their own: give them linear fog so distant shores fade there too
        this.scene.fog = this.env.fog;
        this.water.renderReflection(this.renderer, this.scene, this.camera);
        this.scene.fog = null;
      }
      this.atmosphere.setFrom(env, this.camera);
      this.composer.render();
    } else this.renderer.render(this.scene, this.camera);
  }
}

// Authored models load first (the title screen is already showing), then the world is built.
loadModels().finally(() => { window.game = new Game(); });
