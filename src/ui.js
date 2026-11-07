import { RESOURCES, RES_LABEL, RECIPES, recipeCost } from './fleet.js';
import { MODULES, KINDS } from './boat.js';
import { clamp } from './util.js';
import { TRAITS, portraitImg, crewTrait } from './crew.js';
import { LEVELS, edgeDistance, levelBridges } from './levels.js';

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
    this.modalOpen = false; this.crewOpen = false;
  }

  // ------------------------------------------------------------- modal panels (pause the game)
  openModal(html, cls = '') {
    const el = $('modal');
    el.className = `panel ${cls}`; el.innerHTML = html; el.style.display = 'block';
    this.modalOpen = true; this.game.paused = true;
    return el;
  }
  closeModal() {
    $('modal').style.display = 'none';
    this.modalOpen = false; this.crewOpen = false; this.inspecting = null;
    if (!this.craftOpen) this.game.paused = false;
  }

  /** What a route's bridges mean for this boat: one line, with a warning if she cannot get through. */
  routeNote(key, boat) {
    if (key === 'end') return '';
    const br = levelBridges(LEVELS[key], this.game.city);
    if (!br.length) return 'No bridges on this stretch.';
    const low = Math.min(...br.map((b) => b.clearance));
    let s = `${br.length} bridge${br.length > 1 ? 's' : ''}; the lowest leaves about ${low.toFixed(1)} m.`;
    if (boat.airUp < low - 0.2) s += ` The ${boat.name} (${boat.airUp.toFixed(1)} m) fits under all of them.`;
    else if (boat.canStrike && boat.airDown < low - 0.2) s += ` The ${boat.name} will have to strike her mast.`;
    else s += ` <span class="warn">The ${boat.name} stands ${boat.airDown.toFixed(1)} m${boat.canStrike ? ' even with the mast struck' : ''} and will not get under: you would need a lower boat there.</span>`;
    return s;
  }

  showLevelCard(L, depth, count, boat) {
    const exits = L.exits.map((e) => `<li><b>${e.label}</b> → ${e.to === 'end' ? 'the end of the voyage' : `${LEVELS[e.to].name} (water ${LEVELS[e.to].water} m)`}<div class="dim">${e.blurb} ${this.routeNote(e.to, boat)}</div></li>`).join('');
    const here = levelBridges(L, this.game.city);
    const hereNote = here.length ? ` There ${here.length > 1 ? 'are' : 'is'} ${here.length} bridge${here.length > 1 ? 's' : ''} here, the lowest with ${Math.min(...here.map((b) => b.clearance)).toFixed(1)} m beneath it.` : '';
    const el = this.openModal(`<div class="kicker">Level ${depth} of ${count}</div><h2>${L.name}</h2>
      <div class="dim">Water ${L.water.toFixed(1)} m above the old tide line.${hereNote}</div>
      <p class="prose">${L.intro}</p>
      <div class="big">Ways on</div><ul class="exits">${exits}</ul>
      <p class="dim">Ways out are marked by buoys burning orange flares. Your ${boat.design.label.toLowerCase()} draws ${boat.design.draft.toFixed(1)} m and stands ${boat.airDraft.toFixed(1)} m above the water${boat.canStrike ? ` (${boat.airDown.toFixed(1)} m with the mast struck)` : ''}.</p>
      <div class="ctas"><button class="cta" id="lc-go">Cast off</button></div>`, 'card-level');
    el.querySelector('#lc-go').onclick = () => this.closeModal();
    if (depth === 1) {
      this.toast('W/S throttle, A/D steer, R sails, M strike the mast, E interact, Tab crew. Right-click for the action wheel.', 'info');
    }
  }

  openExit(e) {
    const g = this.game, b = g.fleet.player;
    const next = e.to === 'end' ? null : LEVELS[e.to];
    const el = this.openModal(`<h2>${e.label}</h2><p class="prose">${e.blurb}</p>
      ${next ? `<p>Next: <b>${next.name}</b>, with the water at ${next.water} m. ${this.routeNote(e.to, b)}</p><p class="dim">Whatever is left here stays here: the boats, the roofs you did not reach.</p>` : '<p>This is the end of the voyage.</p>'}
      <p class="dim">Aboard the ${b.name}: ${b.crew.length} ${b.crew.length === 1 ? 'person' : 'people'}${b.animals.length ? `, ${b.animals.map((a) => `a ${a.type}`).join(', ')}` : ''}. Hull ${Math.round(b.hp)}/${b.maxHp}.</p>
      <div class="ctas"><button class="cta" id="ex-go">${next ? 'Set out' : 'Make for the camp'}</button><button class="cta alt" id="ex-no">Not yet</button></div>`);
    el.querySelector('#ex-go').onclick = () => { this.closeModal(); g.leaveLevel(e); };
    el.querySelector('#ex-no').onclick = () => this.closeModal();
  }

  showEnd(e, b, f, run) {
    const people = b.crew;
    const el = this.openModal(`<div class="kicker">The end of the voyage</div><h2>${e.label}</h2>
      <p class="prose">The ${b.name} comes in under the ridge with ${people.length === 1 ? 'only you aboard' : `${people.length} aboard`}. Someone on the shore is waving a lamp.</p>
      <p>Route: ${run.path.map((k) => LEVELS[k].name).join(' → ')} · rescued ${f.stats.rescued} · lost ${f.stats.lost} · boats swapped ${f.stats.swaps || 0}</p>
      <div class="cards">${people.map((p) => this.cardHTML(p)).join('')}</div>
      <div class="ctas"><button class="cta" id="end-new">New voyage</button></div>`, 'card-wide');
    el.querySelector('#end-new').onclick = () => document.getElementById('restart-new').click();
  }

  // ------------------------------------------------------------- crew cards
  cardHTML(p) {
    const c = p.card;
    const traits = c.traits.map((t) => TRAITS[t]).filter(Boolean).map((t) => `<div class="trait ${t.bad ? 'bad' : ''} ${t.earned ? 'earned' : ''}" title="${t.desc}"><b>${t.name}</b> <span class="dim">${t.desc}</span></div>`).join('');
    const hist = c.history.length ? `<ul class="hist">${c.history.slice(-4).map((h) => `<li>${h}</li>`).join('')}</ul>` : '';
    const task = p.isPlayer ? 'at the helm' : p.task && p.task !== 'idle' ? p.task : 'resting';
    return `<div class="crewcard">${portraitImg(p)}<div class="cc-body">
      <div class="big">${p.name}</div><div class="dim">${c.roleName} · ${task} · health ${Math.round(p.health)}</div>
      <p class="bio">${c.bio}</p>${traits}${hist}</div></div>`;
  }
  toggleCrew(force) {
    const show = force !== undefined ? force : !this.crewOpen;
    if (!show) { this.closeModal(); return; }
    const b = this.game.fleet.player;
    const el = this.openModal(`<button class="close" id="crew-close">Close (Tab)</button><h2>Crew of the ${b.name}</h2>
      <div class="dim">${b.crew.length} of ${b.maxCrew} berths${b.animals.length ? ` · ${b.animals.map((a) => `a ${a.type}`).join(', ')}` : ''}</div>
      <div class="cards">${b.crew.map((p) => this.cardHTML(p)).join('')}</div>`, 'card-wide');
    this.crewOpen = true;
    el.querySelector('#crew-close').onclick = () => this.closeModal();
  }

  // ------------------------------------------------------------- another boat alongside
  boatStats(b) {
    const sail = b.rigs.length ? `${b.rigs.reduce((a, r) => a + r.area, 0).toFixed(0)} m² of sail` : 'no sail';
    return `<table class="stats">
      <tr><td>Hull</td><td>${b.design.label}, ${b.L.toFixed(1)} × ${b.B.toFixed(1)} m</td></tr>
      <tr><td>Draft</td><td>${b.design.draft.toFixed(1)} m</td></tr>
      <tr><td>Height</td><td>${b.airUp.toFixed(1)} m${b.canStrike ? ` · ${b.airDown.toFixed(1)} m mast struck` : ''}</td></tr>
      <tr><td>Drive</td><td>${b.enginePower ? `${b.enginePower} hp engine` : 'no engine'} · ${sail}</td></tr>
      <tr><td>Condition</td><td>${Math.round(b.hp)}/${b.maxHp}</td></tr>
      <tr><td>Berths</td><td>${b.maxCrew}</td></tr>
      <tr><td>Deck slots</td><td>${b.usedSlots}/${b.slots}</td></tr>
      <tr><td>Cargo</td><td>${b.capacity}</td></tr></table>`;
  }
  openInspect(other) {
    const g = this.game, mine = g.fleet.player;
    this.inspecting = other;
    const gear = (from, to, dir) => from.modules.length ? from.modules.map((m, i) => {
      if (from.modules.indexOf(m) !== i) return '';
      const n = from.count(m), why = to.canAdd(m);
      return `<div class="gear"><span><b>${MODULES[m].label}</b>${n > 1 ? ` ×${n}` : ''}<div class="dim">${MODULES[m].desc}</div></span><button data-move="${dir}" data-mod="${m}" ${why ? `disabled title="${why}"` : ''}>${dir === 'take' ? '← Take' : 'Give →'}</button></div>`;
    }).join('') : '<div class="dim">No gear.</div>';
    const room = other.maxCrew >= mine.crew.length;
    const el = this.openModal(`<button class="close" id="in-close">Close</button><h2>Alongside the ${other.name}</h2>
      <div class="dim">${other.crew.length ? `${other.crew.length} aboard` : 'Nobody aboard'}. Move gear across, or take her and leave the ${mine.name} at anchor.</div>
      <div class="cmp"><div><div class="big">${mine.name} <span class="dim">(yours)</span></div>${this.boatStats(mine)}<div class="big">Gear</div>${gear(mine, other, 'give')}</div>
      <div><div class="big">${other.name}</div>${this.boatStats(other)}<div class="big">Gear</div>${gear(other, mine, 'take')}</div></div>
      <div class="ctas"><button class="cta" id="in-swap" ${room ? '' : 'disabled'}>${room ? `Take the ${other.name}` : `She sleeps ${other.maxCrew}; you are ${mine.crew.length}`}</button>
      <button class="cta alt" id="in-strip">Strip her for materials</button></div>`, 'card-wide');
    el.querySelector('#in-close').onclick = () => this.closeModal();
    el.querySelector('#in-swap').onclick = () => { if (g.swapBoat(other)) this.closeModal(); };
    el.querySelector('#in-strip').onclick = () => { this.closeModal(); g.world.salvage(other); };
    for (const btn of el.querySelectorAll('[data-move]')) btn.onclick = () => {
      const take = btn.dataset.move === 'take';
      if (g.moveGear(take ? other : mine, take ? mine : other, btn.dataset.mod)) { g.audio.blip(700); this.openInspect(other); }
    };
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
    $('hud-env').innerHTML = `
      <div class="big">${env.timeString()}</div>
      <div>${env.label} · wind ${env.windSpeed.toFixed(1)} m/s ${dirName(env.windAngle)}</div>
      <div><b>${g.level.name}</b> <span class="dim">· level ${g.run.path.length} of 3</span></div>
      <div>Water <b>${(env.level).toFixed(1)} m</b> <span class="dim">(holding; tide and surge ±)</span></div>
      <div class="dim">${Math.round(g.fps)} fps · ${g.quality} quality · ${Math.round((g.resScale || 1) * 100)}% resolution</div>
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
      <div>Draft ${b.design.draft.toFixed(1)} m · height ${b.airDraft.toFixed(1)} m${b.canStrike ? (b.mastT >= 1 ? ' <span class="dim">(mast struck)</span>' : b.mastT > 0 ? ` <span class="warn">(${b.mastDown ? 'striking' : 'raising'} mast ${Math.round((b.mastDown ? b.mastT : 1 - b.mastT) * 100)}%)</span>` : '') : ''}</div>
      ${this.navLine(b)}
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

    $('hud-fleet').innerHTML = `<div class="big">Crew of the ${b.name} <span class="dim">· ${b.crew.length}/${b.maxCrew} · Tab for cards</span></div><div class="strip">` +
      b.crew.map((p) => `<div class="mini">${portraitImg(p, 'mini-p')}<div><b>${p.name}</b><div class="dim">${p.card.roleName}</div><div class="hbar"><i style="width:${p.health}%"></i></div></div></div>`).join('') +
      `</div>${b.animals.length ? `<div class="dim">Also aboard: ${b.animals.map((a) => `a ${a.type}`).join(', ')}</div>` : ''}`;
    this.drawMinimap();
    if (this.craftOpen) this.renderCraft();
  }

  /**
   * Depth under the keel and the clearance of bridges ahead. Anyone notices a bridge close up; a pilot,
   * sharp eyes or a depth sounder give the numbers early.
   */
  navLine(b) {
    const g = this.game, level = g.env.level, city = g.city;
    const keen = b.count('sounder') || crewTrait(b, 'pilot') || crewTrait(b, 'eyes');
    const out = [];
    const fx = Math.sin(b.heading), fz = Math.cos(b.heading);
    if (b.count('sounder') || crewTrait(b, 'pilot')) {
      const bow = g.floorMap.floorAt(b.x + fx * b.L * 0.45, b.z + fz * b.L * 0.45);
      const under = level - Math.max(bow, city.topAt(b.x + fx * b.L * 0.45, b.z + fz * b.L * 0.45)) - b.design.draft;
      out.push(`<span class="${under < 0.6 ? 'warn' : ''}">${under.toFixed(1)} m under the keel</span>`);
    }
    const reach = keen ? 110 : 40;
    let bridge = null;
    for (let d = 10; d <= reach && !bridge; d += 10) {
      const x = b.x + fx * d, z = b.z + fz * d;
      city.forEachNear(x, z, 6, (c) => { if (!bridge && c.kind === 'bridge') { const [lx, lz] = city.local(c, x, z); if (Math.abs(lx) < c.hx + 4 && Math.abs(lz) < c.hz + 4) bridge = { c, d }; } });
    }
    if (bridge) {
      const clr = bridge.c.bottom - level;
      const fits = clr > b.airDraft + 0.2, fitsStruck = b.canStrike && clr > b.airDown + 0.2;
      out.push(`<span class="${fits ? '' : 'warn'}">Bridge ${Math.round(bridge.d)} m ahead: ${clr.toFixed(1)} m clearance${fits ? '' : fitsStruck ? ' — strike the mast (M)' : ' — she will not fit'}</span>`);
    }
    return out.length ? `<div>${out.join(' · ')}</div>` : '';
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
      if (g.level) {
        const wx = fm.rect.minx + (i + 0.5) / N * fm.rect.size, wz = fm.rect.minz + (j + 0.5) / N * fm.rect.size;
        const ed = edgeDistance(g.level, wx, wz);
        if (ed > 0) { const k = ed > 40 ? 0.3 : 0.55; r *= k; gg *= k; b = b * k + 18; }
      }
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
    const eyes = crewTrait(pl, 'eyes') ? 1.4 : 1;
    const sight = 320 * eyes * (1 + Math.min(2, lookouts) * 0.25) * (1 - env.night * 0.55) * clamp(env.cur.fog * env.edgeFog / 900, 0.3, 1);
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
    // ways out: always on the chart
    for (const e of g.exits || []) {
      let [a, b2] = toS(e.x, e.z);
      const off = a < 6 || b2 < 6 || a > W - 6 || b2 > W - 6;
      a = clamp(a, 7, W - 7); b2 = clamp(b2, 7, W - 7);
      c.fillStyle = '#ff9a40'; c.strokeStyle = '#000'; c.beginPath(); c.moveTo(a, b2 - 6); c.lineTo(a + 5, b2 + 4); c.lineTo(a - 5, b2 + 4); c.closePath(); c.fill(); c.stroke();
      if (!off) { c.fillStyle = '#ffd8a8'; c.fillText(e.label, Math.min(a + 8, W - 80), b2 + 3); }
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
        status = `<span class="warn">Out of reach</span> at this water level: a boat could get in with the water at ${lm.reachLevel.toFixed(1)} m (now ${env.level.toFixed(1)} m).`; void day;
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
    $('go-text').innerHTML = `${reason}<br><br>${this.game.level.name}, ${env.timeString()}, the water at ${env.level.toFixed(1)} m.<br>
      Survivors rescued: ${f.stats.rescued} · lost: ${f.stats.lost}<br><br>Retry starts this level again with what you had when you arrived.`;
  }
}

function dirName(a) {
  // a = direction the wind blows toward; report where it comes FROM (compass, north = -z)
  const from = Math.atan2(-Math.cos(a), Math.sin(a)); // bearing: 0 = north, clockwise
  const deg = ((from * 180 / Math.PI) + 360) % 360;
  const names = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return 'from ' + names[Math.round(deg / 45) % 8];
}
