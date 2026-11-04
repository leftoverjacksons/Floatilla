import { RESOURCES, RES_LABEL, RECIPES, recipeCost } from './fleet.js';
import { MODULES, KINDS } from './boat.js';
import { clamp } from './util.js';

const $ = (id) => document.getElementById(id);

export class UI {
  constructor(game) {
    this.game = game;
    this.toasts = $('toasts');
    this.prompt = $('prompt');
    this.mm = $('minimap'); this.mmCtx = this.mm.getContext('2d');
    this.mapCanvas = document.createElement('canvas');
    this.mapLevel = -999;
    this.t = 0;
    this.craftOpen = false;
    this.craftBoat = null;
    $('craft-close').onclick = () => this.toggleCraft(false);
    $('note-close').onclick = () => ($('note').style.display = 'none');
    $('journal-close').onclick = () => this.toggleJournal(false);
  }

  toast(msg, kind = 'info') {
    const el = document.createElement('div');
    el.className = `toast ${kind}`; el.textContent = msg;
    this.toasts.prepend(el);
    while (this.toasts.children.length > 6) this.toasts.lastChild.remove();
    setTimeout(() => el.classList.add('fade'), 6000);
    setTimeout(() => el.remove(), 7000);
  }

  // ------------------------------------------------------------- HUD
  update(dt) {
    this.t += dt;
    const g = this.game, env = g.env, fleet = g.fleet, b = fleet.player;
    if (!b) return;
    const it = g.world.findInteraction();
    this.prompt.textContent = it ? it.label : '';
    this.prompt.style.opacity = it ? 1 : 0;
    if (this.t < 0.12) return;
    this.t = 0;

    const kn = (b.forwardSpeed * 1.944).toFixed(1);
    const rate = env.floodRate;
    $('hud-env').innerHTML = `
      <div class="big">${env.timeString()}</div>
      <div>${env.label} · wind ${env.windSpeed.toFixed(1)} m/s ${dirName(env.windAngle)}</div>
      <div>Flood level <b>${(env.level).toFixed(1)} m</b> <span class="dim">(+${(rate * 100).toFixed(0)} cm/h)</span></div>
      <div class="dim">${Math.round(g.fps)} fps · ${g.quality} quality</div>
      ${env.timeScale > 1 ? `<div class="warn">TIME ×${env.timeScale}</div>` : ''}
      ${g.paused ? '<div class="warn">PAUSED</div>' : ''}`;

    const hpF = b.hp / b.maxHp;
    const sails = b.rigs.length ? (b.sailsUp ? (b.sailDrive < 0.05 ? 'UP · luffing (in irons)' : `UP · drive ${(b.sailDrive * 100).toFixed(0)}%`) : 'furled') : '—';
    const prop = b.engineOn ? `engine ${b.enginePower} hp` : b.rowing ? 'rowing' : b.enginePower ? `engine ${b.enginePower} hp (idle)` : 'oars';
    $('hud-boat').innerHTML = `
      <div class="big">${b.name} <span class="dim">· ${b.design.label} ${b.L.toFixed(1)} m</span></div>
      <div class="bar"><div style="width:${hpF * 100}%;background:${hpF > 0.5 ? '#6fbf73' : hpF > 0.25 ? '#e0b040' : '#e05040'}"></div><span>Hull ${Math.round(b.hp)}/${b.maxHp}</span></div>
      <div class="bar"><div style="width:${Math.abs(b.throttle) * 100}%;background:${b.throttle < 0 ? '#c07040' : '#5fa8d8'}"></div><span>Throttle ${b.throttle < 0 ? 'astern ' : ''}${Math.round(Math.abs(b.throttle) * 100)}%</span></div>
      <div>${kn} kn · ${prop}</div>
      <div>Sails: ${sails}</div>
      <div>Crew ${b.crew.length}/${b.maxCrew} · slots ${b.usedSlots}/${b.slots}${b.anchored ? ' · anchored' : ''}${b.grounded ? ' · <span class="warn">AGROUND</span>' : ''}</div>
      ${b.waterlogged > 0.05 ? `<div class="warn">Waterlogged ${Math.round(b.waterlogged * 100)}% — repair the hull to regain speed</div>` : ''}`;

    const cap = fleet.capacity, load = fleet.load;
    $('hud-res').innerHTML = `<div class="big">Stores <span class="dim">${Math.round(load)}/${cap}</span></div>` +
      RESOURCES.map((r) => {
        const v = fleet.inv[r];
        const low = (r === 'food' || r === 'water') && v < fleet.people.length * 1.5;
        return `<div class="res ${low ? 'warn' : ''}"><span>${RES_LABEL[r]}</span><b>${v < 10 ? v.toFixed(1) : Math.floor(v)}</b></div>`;
      }).join('') +
      `<div class="res"><span>Morale</span><b>${Math.round(fleet.morale)}</b></div>` +
      (fleet.thirsty ? '<div class="warn">Out of water — crew are suffering!</div>' : fleet.starving ? '<div class="warn">Out of food — crew are weakening!</div>' : '');

    const people = fleet.people;
    const pp = g.playerPerson;
    $('hud-fleet').innerHTML = `<div class="big">Floatilla · ${fleet.boats.length} boat${fleet.boats.length > 1 ? 's' : ''} · ${people.length} people · ${fleet.animals.length} animals</div>
      <div class="dim">${fleet.detached ? 'DETACHED — fleet anchored (F to recall)' : fleet.mode === 'hold' ? 'Holding position (G)' : 'Following your lead'}</div>
      <div>You: health ${Math.round(pp.health)}</div>` +
      fleet.boats.slice(0, 9).map((x) => {
        const d = Math.hypot(x.x - b.x, x.z - b.z);
        return `<div class="fb ${x === b ? 'lead' : ''}"><span>${x === b ? '★ ' : ''}${x.name}</span><span class="dim">${x.design.label}</span><span>${x.crew.length}/${x.maxCrew}</span><span style="color:${x.hp / x.maxHp > 0.5 ? '#9fd' : '#f96'}">${Math.round(x.hp / x.maxHp * 100)}%</span><span class="dim">${x === b ? '' : Math.round(d) + 'm'}</span></div>`;
      }).join('') + (fleet.boats.length > 9 ? `<div class="dim">+${fleet.boats.length - 9} more</div>` : '');
    this.drawMinimap();
    if (this.craftOpen) this.renderCraft();
  }

  // ------------------------------------------------------------- minimap
  rebuildMap() {
    const g = this.game, fm = g.floorMap, lvl = g.env.level;
    const N = 512, step = fm.N / N;
    this.mapCanvas.width = this.mapCanvas.height = N;
    const ctx = this.mapCanvas.getContext('2d');
    const img = ctx.createImageData(N, N);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const k = Math.floor(j * step) * fm.N + Math.floor(i * step);
      const fl = fm.floor[k], gr = fm.ground[k];
      let r, gg, b;
      if (fl > lvl + 0.2) {
        if (fl - gr > 1.5) { const s = clamp(120 + (fl - lvl) * 0.6, 120, 200); r = gg = s; b = s + 8; }
        else { const h = fl - lvl; r = 70 + h; gg = 100 + h * 0.5; b = 60; }
      } else {
        const d = lvl - fl;
        const t = clamp(d / 25, 0, 1);
        r = 40 - 25 * t; gg = 90 - 40 * t; b = 110 - 20 * t;
        if (fl - gr > 1.5) { r += 20; gg += 20; b += 20; }
      }
      const o = (j * N + i) * 4;
      img.data[o] = r; img.data[o + 1] = gg; img.data[o + 2] = b; img.data[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    this.mapLevel = lvl;
  }

  drawMinimap() {
    const g = this.game, fm = g.floorMap, pl = g.fleet.player;
    if (Math.abs(g.env.level - this.mapLevel) > 0.4) this.rebuildMap();
    const c = this.mmCtx, W = this.mm.width;
    const span = 900; // metres across
    const N = this.mapCanvas.width, mPerPx = fm.rect.size / N;
    const sx = (pl.x - span / 2 - fm.rect.minx) / mPerPx, sz = (pl.z - span / 2 - fm.rect.minz) / mPerPx;
    c.fillStyle = '#123'; c.fillRect(0, 0, W, W);
    c.imageSmoothingEnabled = false;
    c.drawImage(this.mapCanvas, sx, sz, span / mPerPx, span / mPerPx, 0, 0, W, W);
    const toS = (x, z) => [(x - pl.x + span / 2) / span * W, (z - pl.z + span / 2) / span * W];
    const dot = (x, z, col, r) => { const [a, b] = toS(x, z); if (a < 0 || b < 0 || a > W || b > W) return; c.fillStyle = col; c.beginPath(); c.arc(a, b, r, 0, Math.PI * 2); c.fill(); };
    const w = g.world, env = g.env;
    // Only what the crew has actually spotted appears on the chart. Spotted things stay marked.
    const lookouts = g.fleet.boats.reduce((a, b) => a + (b.taskCounts?.lookout || 0), 0);
    const sight = 320 * (1 + Math.min(2, lookouts) * 0.25) * (1 - env.night * 0.55) * clamp(env.cur.fog / 900, 0.3, 1);
    this.sight = sight;
    const seen = (e, range) => {
      let s = e.seen;
      for (const b of g.fleet.boats) if (!s && Math.hypot(e.x - b.x, e.z - b.z) < range) s = true;
      return (e.seen = s);
    };
    for (const p of w.pickups) if (seen(p, Math.min(sight, 140))) dot(p.x, p.z, '#e8d070', 1.6);
    for (const k of w.caches) if (seen(k, sight)) dot(k.x, k.z, '#60b0ff', 3);
    const pulse = 3 + Math.sin(performance.now() * 0.006) * 1.2;
    // survivors with a flag (or a flare at night) are visible from further away
    for (const s of w.groups) if (seen(s, sight * (s.people.length ? 1.6 : 0.8))) dot(s.x, s.z, s.state === 'swim' ? '#ff3030' : '#ff7050', s.people.length ? pulse : 2.5);
    for (const b of w.boats) if (!b.fleet && seen(b, sight * 1.2)) dot(b.x, b.z, b.role === 'raider' ? '#000' : b.role === 'npc' ? '#fff' : '#9a9a9a', 3.5);
    // landmarks once sighted: diamond + name
    c.font = '10px sans-serif';
    for (const lm of g.landmarks.list) {
      if (!lm.discovered) continue;
      let [a, b2] = toS(lm.x, lm.z);
      const off = a < 4 || b2 < 4 || a > W - 4 || b2 > W - 4;
      a = clamp(a, 6, W - 6); b2 = clamp(b2, 6, W - 6);
      c.save(); c.translate(a, b2); c.rotate(Math.PI / 4);
      c.fillStyle = lm.visited ? '#b8a07a' : '#ffcf8a'; c.strokeStyle = '#000'; c.lineWidth = 1;
      c.fillRect(-4, -4, 8, 8); c.strokeRect(-4, -4, 8, 8); c.restore();
      if (!off) { c.fillStyle = '#f4ead8'; c.fillText(lm.name.split(' (')[0], Math.min(a + 7, W - 90), b2 + 3); }
    }
    // sight radius ring
    c.strokeStyle = 'rgba(255,255,255,0.15)'; c.lineWidth = 1; c.beginPath(); c.arc(W / 2, W / 2, sight / span * W, 0, Math.PI * 2); c.stroke();
    for (const b of g.fleet.boats) if (b !== pl) dot(b.x, b.z, '#ff8a2a', 3.5);
    // player arrow
    c.save(); c.translate(W / 2, W / 2); c.rotate(-pl.heading + Math.PI);
    c.fillStyle = '#fff'; c.beginPath(); c.moveTo(0, -8); c.lineTo(5, 6); c.lineTo(-5, 6); c.closePath(); c.fill(); c.restore();
    // wind arrow
    const wa = g.env.windAngle;
    c.save(); c.translate(W - 22, 22);
    c.strokeStyle = '#cde'; c.lineWidth = 2; c.beginPath(); c.arc(0, 0, 16, 0, Math.PI * 2); c.stroke();
    c.rotate(wa - Math.PI / 2);
    c.fillStyle = '#9cf'; c.beginPath(); c.moveTo(0, 12); c.lineTo(5, -8); c.lineTo(-5, -8); c.closePath(); c.fill();
    c.restore();
    c.fillStyle = '#cde'; c.font = '10px sans-serif'; c.fillText('WIND', W - 35, 50);
    c.fillText('N', W / 2 - 3, 10);
  }

  // ------------------------------------------------------------- crafting
  toggleCraft(force) {
    this.craftOpen = force !== undefined ? force : !this.craftOpen;
    $('craft').style.display = this.craftOpen ? 'block' : 'none';
    this.game.paused = this.craftOpen;
    if (this.craftOpen) { this.craftBoat = this.game.fleet.player; this.renderCraft(true); }
  }

  renderCraft(force) {
    const g = this.game, fleet = g.fleet;
    if (!fleet.boats.includes(this.craftBoat)) this.craftBoat = fleet.player;
    const b = this.craftBoat;
    const key = JSON.stringify([b.design.seed, b.modules, Object.values(fleet.inv).map(Math.floor), b.hp | 0, fleet.boats.length]);
    if (!force && key === this.craftKey) return;
    this.craftKey = key;
    const tabs = fleet.boats.map((x, i) => `<button class="tab ${x === b ? 'on' : ''}" data-boat="${i}">${x === fleet.player ? '★ ' : ''}${x.name}</button>`).join('');
    const mods = b.modules.length ? b.modules.map((m) => MODULES[m].label).join(', ') : 'none';
    const spare = fleet.boats.some((x) => x.crew.some((p) => !p.isPlayer)) ;
    const rows = RECIPES.map((r) => {
      let why = null;
      if (r.module) why = b.canAdd(r.module);
      if (r.id === 'patch' && b.hp >= b.maxHp - 1) why = 'Hull intact';
      if (r.id === 'lengthen') { const K = KINDS[b.design.kind]; if (b.design.kind === 'raft') why = 'Rafts can’t be lengthened'; else if (b.L > K.L[1] * 1.5) why = 'Hull at max length'; }
      if (r.newBoat && !spare) why = 'Needs a spare crew member';
      const rc = recipeCost(r, b);
      const afford = fleet.canAfford(rc);
      const cost = Object.entries(rc).map(([k, v]) => `<span class="${fleet.inv[k] >= v ? '' : 'short'}">${v} ${k}</span>`).join(' ');
      return `<div class="recipe ${why || !afford ? 'off' : ''}"><div><b>${r.label}</b><div class="dim">${r.desc}</div></div>
        <div class="cost">${cost}</div><button data-recipe="${r.id}" ${why || !afford ? 'disabled' : ''}>${why || (afford ? 'Build' : 'Need more')}</button></div>`;
    }).join('');
    $('craft-body').innerHTML = `<div class="tabs">${tabs}</div>
      <div class="boatinfo"><b>${b.name}</b> — ${b.design.label}, ${b.L.toFixed(1)} m × ${b.B.toFixed(1)} m · engine ${b.enginePower} hp · sail ${b.rigs.reduce((a, r) => a + r.area, 0).toFixed(0)} m² · berths ${b.maxCrew} · cargo +${b.capacity} · slots ${b.usedSlots}/${b.slots}<br><span class="dim">Modules: ${mods}</span></div>
      <div class="recipes">${rows}</div>`;
    for (const el of document.querySelectorAll('#craft-body [data-boat]')) el.onclick = () => { this.craftBoat = fleet.boats[+el.dataset.boat]; this.renderCraft(true); };
    for (const el of document.querySelectorAll('#craft-body [data-recipe]')) el.onclick = () => { g.craft(el.dataset.recipe, this.craftBoat); this.renderCraft(true); };
  }

  showNote(title, text) {
    $('note-title').textContent = title; $('note-text').textContent = text;
    $('note').style.display = 'block';
  }

  toggleJournal(force) {
    const el = $('journal');
    const show = force !== undefined ? force : el.style.display !== 'block';
    el.style.display = show ? 'block' : 'none';
    if (!show) return;
    const L = this.game.landmarks, env = this.game.env;
    const found = L.list.filter((l) => l.discovered);
    const rows = found.map((lm) => {
      let status;
      if (!L.reachable(lm)) {
        const day = L.dayForLevel(lm.reachLevel);
        status = `<span class="warn">Out of reach</span> — the boats can get in once the flood reaches ${lm.reachLevel.toFixed(1)} m (now ${env.level.toFixed(1)} m)${day ? `, around day ${day}` : ''}.`;
      } else status = lm.visited ? 'Explored.' : '<span class="warn">Reachable — not yet explored.</span>';
      if (lm.group) status += lm.rescued ? ' Its people are accounted for.' : ' Someone may still be there.';
      if (lm.action && lm.visited) status += ` <span class="dim">${lm.action.desc}</span>`;
      const note = lm.visited ? `<div class="jnote"><b>${lm.note.title}</b><p>${lm.note.text}</p></div>` : '';
      return `<div class="jentry"><div class="big">${lm.name}</div><div>${status}</div>${note}</div>`;
    }).join('');
    const unknown = L.list.length - found.length;
    $('journal-body').innerHTML = (rows || '<p class="dim">Nothing yet. Tall things on the skyline are worth sailing toward.</p>') +
      (unknown ? `<p class="dim">${unknown} more landmark${unknown > 1 ? 's' : ''} somewhere out there.</p>` : '');
  }

  showGameOver(reason) {
    const f = this.game.fleet, env = this.game.env;
    $('gameover').style.display = 'flex';
    $('go-text').innerHTML = `${reason}<br><br>You survived until ${env.timeString()} with the water at ${env.level.toFixed(1)} m.<br>
      Survivors rescued: ${f.stats.rescued} · Animals saved: ${f.stats.animals} · Boats in the floatilla: ${f.boats.length}`;
  }
}

function dirName(a) {
  // a = direction the wind blows toward; report where it comes FROM (compass, north = -z)
  const from = Math.atan2(-Math.cos(a), Math.sin(a)); // bearing: 0 = north, clockwise
  const deg = ((from * 180 / Math.PI) + 360) % 360;
  const names = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return 'from ' + names[Math.round(deg / 45) % 8];
}
