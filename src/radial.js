// Right-click radial menu. Hold or click the right mouse button to open it at
// the cursor; hover an item to see what it does; click (or release the right
// button over an item) to use it. Esc or right-click elsewhere closes it.
export class RadialMenu {
  constructor(game) {
    this.game = game;
    this.el = document.getElementById('radial');
    this.center = document.getElementById('radial-center');
    this.open = false;
    this.items = [];
    this.hover = -1;
    const canvas = game.renderer.domElement;
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('mousedown', (e) => {
      if (e.button !== 2 || !game.started || game.over) return;
      if (this.open) this.close(); else this.show(e.clientX, e.clientY);
      this.openedAt = performance.now();
    });
    window.addEventListener('mouseup', (e) => {
      // press-drag-release selection: releasing the right button over an item uses it
      if (e.button === 2 && this.open && this.hover >= 0 && performance.now() - this.openedAt > 180) this.choose(this.hover);
    });
    window.addEventListener('mousemove', (e) => { if (this.open) this.track(e.clientX, e.clientY); });
    window.addEventListener('keydown', (e) => { if (this.open && e.key === 'Escape') this.close(); });
  }

  show(x, y) {
    const items = this.game.menuItems();
    this.items = items;
    const R = items.length > 9 ? 168 : 132;
    const pad = R + 52;
    x = Math.min(Math.max(x, pad), window.innerWidth - pad);
    y = Math.min(Math.max(y, pad), window.innerHeight - pad);
    this.cx = x; this.cy = y; this.R = R;
    this.el.style.left = `${x}px`; this.el.style.top = `${y}px`;
    this.el.querySelectorAll('.ritem').forEach((n) => n.remove());
    items.forEach((it, i) => {
      const a = -Math.PI / 2 + (i / items.length) * Math.PI * 2;
      it.angle = a;
      const b = document.createElement('button');
      b.className = `ritem ${it.disabled ? 'off' : ''} ${it.accent ? 'accent' : ''}`;
      b.style.left = `${Math.cos(a) * R}px`; b.style.top = `${Math.sin(a) * R}px`;
      b.innerHTML = `<span class="ri">${it.icon}</span><span class="rl">${it.label}</span>${it.key ? `<span class="rk">${it.key}</span>` : ''}`;
      b.onmouseenter = () => this.setHover(i);
      b.onclick = (e) => { e.stopPropagation(); this.choose(i); };
      this.el.appendChild(b);
    });
    this.el.style.display = 'block';
    this.open = true;
    this.setHover(-1);
  }

  track(x, y) {
    const dx = x - this.cx, dy = y - this.cy, r = Math.hypot(dx, dy);
    if (r < 40) { this.setHover(-1); return; }
    let a = Math.atan2(dy, dx);
    let best = -1, bd = Infinity;
    this.items.forEach((it, i) => {
      let d = Math.abs(a - it.angle); if (d > Math.PI) d = Math.PI * 2 - d;
      if (d < bd) { bd = d; best = i; }
    });
    this.setHover(best);
  }

  setHover(i) {
    this.hover = i;
    this.el.querySelectorAll('.ritem').forEach((n, k) => n.classList.toggle('hot', k === i));
    const it = this.items[i];
    this.center.innerHTML = it ? `<b>${it.label}</b><span>${it.disabled ? it.why || 'Not available' : it.desc || ''}</span>` : '<span class="dim">Choose an action</span>';
  }

  choose(i) {
    const it = this.items[i];
    if (!it || it.disabled) return;
    this.close();
    it.run();
  }

  close() { this.el.style.display = 'none'; this.open = false; this.hover = -1; }
}
