// Draws the trading screen (price chart, trade markers, toasts) onto a canvas texture.
import * as THREE from 'three';

export const CANVAS_W = 1600;
export const CANVAS_H = 900;
const AREA = { x0: 90, x1: 1510, y0: 200, y1: 640 };
const COLORS = { up: '#2fe38b', down: '#ff4d6d', grid: 'rgba(120,150,220,0.13)', text: '#dfe8ff', muted: '#7d8bb0', veto: '#ffae3c' };

const money = (v, digits = 2) =>
  Number(v).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });

const mid = (ev) => (Number(ev?.quote?.bid) + Number(ev?.quote?.ask)) / 2;
const samePrice = (a, b) => Math.abs(a - b) < 1e-3;

// Maps event ticks onto market-history indices. The history comes from the ledger,
// which commits a tick (and its price) a few seconds before events.jsonl gets the row,
// so index = end - (ledgerTick - tick), confirmed against the event's quoted mid price.
// Returns the series cut at `upToTick` and markers for events up to `markersTo`.
export function alignSeries({ history, ledgerTick, events, upToTick, markersTo = upToTick }) {
  const shown = events.filter((e) => e.tick <= upToTick);
  const lastEv = shown[shown.length - 1];
  if (!history?.length) {
    // No ledger history: fall back to the events' own mid prices.
    const priced = shown.filter((e) => Number.isFinite(mid(e)));
    return {
      values: priced.map(mid),
      markers: priced.map((e, i) => ({ ev: e, i })).filter(({ ev }) => ev.tick <= markersTo),
    };
  }
  const n = history.length;
  const gap = Number.isFinite(Number(ledgerTick)) && lastEv ? Math.max(0, Number(ledgerTick) - lastEv.tick) : 0;
  const locate = (ev, expected) => {
    const price = mid(ev);
    if (!Number.isFinite(price)) return expected;
    for (const d of [0, -1, 1, -2, 2]) {
      const i = expected + d;
      if (i >= 0 && i < n && samePrice(history[i], price)) return i;
    }
    return expected;
  };
  // Events entirely older than the retained history: show the history, no markers.
  if (!lastEv || n - 1 - gap < 0) return { values: history.slice(), markers: [] };
  const end = locate(lastEv, n - 1 - gap);
  const markers = [];
  for (const ev of shown) {
    if (ev.tick > markersTo) continue;
    const i = ev === lastEv ? end : locate(ev, end - (lastEv.tick - ev.tick));
    if (i >= 0 && i <= end) markers.push({ ev, i });
  }
  return { values: history.slice(0, end + 1), markers };
}

export class ChartScreen {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = CANVAS_W;
    this.canvas.height = CANVAS_H;
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 8;
    this.product = 'BTC-USDC';
    this.values = [];
    this.markers = [];
    this.settling = false;
    this.wasBusy = false;
    this.growth = 1; // 0..1 progress drawing the newest segment
    this.lo = null;
    this.hi = null;
    this.toastInfo = null;
    this.highlight = null;
    this.animatingUntil = 0;
    this.lastPoint = { x: AREA.x1, y: (AREA.y0 + AREA.y1) / 2 };
    this.trend = 0;
    this.draw(0);
  }

  // markers: [{ ev, i }] with i an index into values (see alignSeries).
  setData({ product, values, markers }, animate, now) {
    const grew = animate && this.values.length > 0 && values.length > 1;
    this.product = product || this.product;
    this.values = values.filter(Number.isFinite);
    this.markers = markers || [];
    if (grew) {
      this.growth = 0;
      this.animatingUntil = now + 1.2;
    } else {
      this.growth = 1;
      this.lo = this.hi = null;
    }
    this.dirty = true;
  }

  setMarkers(markers) {
    this.markers = markers || [];
    this.dirty = true;
  }

  toast(text, color, now, seconds = 4.5) {
    this.toastInfo = { text, color, start: now, until: now + seconds };
    this.animatingUntil = Math.max(this.animatingUntil, now + seconds);
  }

  update(dt, now) {
    if (this.growth < 1) this.growth = Math.min(1, this.growth + dt / 0.9);
    // Keep drawing until growth and axis easing have converged (a slow frame rate must
    // not freeze them half-way), plus one final frame so a fading toast leaves no ghost.
    const busy = this.growth < 1 || this.settling || now < this.animatingUntil;
    if (this.dirty || busy || this.wasBusy) {
      this.draw(now, dt);
      this.dirty = false;
    }
    this.wasBusy = busy;
  }

  draw(now, dt = 0) {
    const { ctx } = this;
    const bg = ctx.createLinearGradient(0, 0, 0, CANVAS_H);
    bg.addColorStop(0, '#0b1430');
    bg.addColorStop(1, '#040814');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    this.drawGrid();
    const v = this.values;
    this.settling = false;
    if (v.length >= 2) {
      this.drawHeader(v);
      this.drawSeries(v, dt);
      this.drawMarkers();
    } else {
      this.points = null;
      this.trend = 0;
      ctx.fillStyle = COLORS.muted;
      ctx.font = '500 48px Rubik, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Waiting for market data…', CANVAS_W / 2, 420);
    }
    this.drawConsole();
    this.drawToast(now);
    this.texture.needsUpdate = true;
  }

  drawGrid() {
    const { ctx } = this;
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 2;
    for (let i = 0; i <= 12; i++) {
      const x = AREA.x0 + ((AREA.x1 - AREA.x0) * i) / 12;
      ctx.beginPath(); ctx.moveTo(x, AREA.y0); ctx.lineTo(x, AREA.y1); ctx.stroke();
    }
    for (let i = 0; i <= 5; i++) {
      const y = AREA.y0 + ((AREA.y1 - AREA.y0) * i) / 5;
      ctx.beginPath(); ctx.moveTo(AREA.x0, y); ctx.lineTo(AREA.x1, y); ctx.stroke();
    }
  }

  drawHeader(v) {
    const { ctx } = this;
    const last = v[v.length - 1];
    const prev = v[v.length - 2];
    const first = v[0];
    // Arrow/price colour follow the latest move; the window change gets its own colour.
    const up = last >= prev;
    this.trend = up ? 1 : -1;
    const change = first ? ((last - first) / first) * 100 : 0;

    ctx.textAlign = 'left';
    ctx.fillStyle = COLORS.text;
    ctx.font = '700 58px "JetBrains Mono", monospace';
    ctx.fillText(this.product, AREA.x0, 105);
    ctx.fillStyle = COLORS.muted;
    ctx.font = '500 30px Rubik, sans-serif';
    ctx.fillText(`last ${v.length} observations · mid price`, AREA.x0, 150);

    ctx.textAlign = 'right';
    ctx.fillStyle = up ? COLORS.up : COLORS.down;
    ctx.font = '700 88px "JetBrains Mono", monospace';
    ctx.fillText(`${up ? '▲' : '▼'} $${money(last)}`, AREA.x1, 110);
    ctx.font = '500 34px "JetBrains Mono", monospace';
    ctx.fillStyle = change >= 0 ? COLORS.up : COLORS.down;
    ctx.fillText(`${change >= 0 ? '+' : ''}${change.toFixed(3)}% window`, AREA.x1, 155);
  }

  scale(v, dt) {
    let lo = Math.min(...v);
    let hi = Math.max(...v);
    const pad = Math.max((hi - lo) * 0.12, Math.abs(hi) * 0.0004, 1e-6);
    lo -= pad; hi += pad;
    if (this.lo === null) { this.lo = lo; this.hi = hi; }
    // Ease the axis (time-based) so a new extreme doesn't make the chart jump.
    const k = 1 - Math.exp(-dt * 9);
    this.lo += (lo - this.lo) * k;
    this.hi += (hi - this.hi) * k;
    if (Math.abs(this.lo - lo) < (hi - lo) * 1e-4 && Math.abs(this.hi - hi) < (hi - lo) * 1e-4) { this.lo = lo; this.hi = hi; }
    this.settling = this.lo !== lo || this.hi !== hi;
    return { lo: this.lo, hi: this.hi };
  }

  point(i, value, n, lo, hi) {
    return {
      x: AREA.x0 + ((AREA.x1 - AREA.x0) * i) / (n - 1),
      y: AREA.y1 - ((value - lo) / (hi - lo)) * (AREA.y1 - AREA.y0),
    };
  }

  drawSeries(v, dt) {
    const { ctx } = this;
    const n = v.length;
    const { lo, hi } = this.scale(v, dt);
    const pts = v.map((value, i) => this.point(i, value, n, lo, hi));
    // Partially draw the newest segment while it "grows" in.
    const a = pts[n - 2];
    const b = pts[n - 1];
    const tip = { x: a.x + (b.x - a.x) * this.growth, y: a.y + (b.y - a.y) * this.growth };
    const drawn = [...pts.slice(0, n - 1), tip];

    ctx.textAlign = 'left';
    ctx.fillStyle = COLORS.muted;
    ctx.font = '500 24px "JetBrains Mono", monospace';
    ctx.fillText(`$${money(hi)}`, AREA.x0 + 8, AREA.y0 + 28);
    ctx.fillText(`$${money(lo)}`, AREA.x0 + 8, AREA.y1 - 12);

    const up = v[n - 1] >= v[0];
    const fill = ctx.createLinearGradient(0, AREA.y0, 0, AREA.y1);
    fill.addColorStop(0, up ? 'rgba(47,227,139,0.28)' : 'rgba(255,77,109,0.28)');
    fill.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.beginPath();
    ctx.moveTo(drawn[0].x, AREA.y1);
    drawn.forEach((p) => ctx.lineTo(p.x, p.y));
    ctx.lineTo(tip.x, AREA.y1);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();

    ctx.lineWidth = 6;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (let i = 1; i < drawn.length; i++) {
      ctx.strokeStyle = drawn[i].y <= drawn[i - 1].y ? COLORS.up : COLORS.down;
      ctx.beginPath();
      ctx.moveTo(drawn[i - 1].x, drawn[i - 1].y);
      ctx.lineTo(drawn[i].x, drawn[i].y);
      ctx.stroke();
    }
    this.points = pts;
    this.lastPoint = tip;
  }

  drawMarkers() {
    const { ctx } = this;
    if (!this.points) return;
    for (const { ev, i } of this.markers) {
      const side = ev.neural?.side;
      const status = ev.execution?.status;
      if (side !== 'BUY' && side !== 'SELL') continue;
      const p = this.points[i];
      if (!p) continue;
      const up = side === 'BUY';
      const color = status === 'FILLED' ? (up ? COLORS.up : COLORS.down) : COLORS.veto;
      const dy = up ? 34 : -34;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y + dy * 0.45);
      ctx.lineTo(p.x - 16, p.y + dy * 1.25);
      ctx.lineTo(p.x + 16, p.y + dy * 1.25);
      ctx.closePath();
      if (status === 'FILLED') {
        ctx.fillStyle = color;
        ctx.fill();
      } else {
        ctx.strokeStyle = color;
        ctx.lineWidth = 4;
        ctx.stroke();
      }
    }
  }

  drawConsole() {
    const { ctx } = this;
    ctx.fillStyle = 'rgba(10,18,40,0.9)';
    ctx.fillRect(0, 680, CANVAS_W, CANVAS_H - 680);
    ctx.strokeStyle = 'rgba(122,162,255,0.35)';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(0, 680); ctx.lineTo(CANVAS_W, 680); ctx.stroke();
    ctx.fillStyle = COLORS.muted;
    ctx.textAlign = 'center';
    ctx.font = '500 26px "JetBrains Mono", monospace';
    ctx.fillText('NEURAL DECISION CONSOLE · DNp20 R−L ≥ 2 Hz + DNpe017 gate', CANVAS_W / 2, 716);
  }

  drawToast(now) {
    const t = this.toastInfo;
    if (!t || now > t.until) return;
    const { ctx } = this;
    const fadeIn = Math.min(1, (now - t.start) / 0.25);
    const fadeOut = Math.min(1, (t.until - now) / 0.6);
    ctx.globalAlpha = Math.max(0, Math.min(fadeIn, fadeOut));
    const lines = this.toastLines(t.text);
    const lineH = lines.size * 1.25;
    const w = Math.min(CANVAS_W - 120, Math.max(...lines.map((l) => ctx.measureText(l).width)) + 80);
    const h = lines.length * lineH + 40;
    const x = CANVAS_W / 2 - w / 2;
    const y = 410 - h / 2;
    ctx.fillStyle = 'rgba(4,8,20,0.88)';
    ctx.strokeStyle = t.color;
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 22);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = t.color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    lines.forEach((l, i) => ctx.fillText(l, CANVAS_W / 2, y + 20 + lineH * (i + 0.5), w - 40));
    ctx.textBaseline = 'alphabetic';
    ctx.globalAlpha = 1;
  }

  // Shrinks the font, then wraps onto two lines, so long VETO reasons stay legible.
  // Leaves ctx.font set; returns the lines with the chosen font size attached.
  toastLines(text) {
    const { ctx } = this;
    const max = CANVAS_W - 200;
    const font = (px) => { ctx.font = `700 ${px}px "JetBrains Mono", monospace`; };
    for (const px of [46, 40, 34]) {
      font(px);
      if (ctx.measureText(text).width <= max) return Object.assign([text], { size: px });
    }
    const words = text.split(' ');
    let best = [text, ''];
    for (let k = 1; k < words.length; k++) {
      const pair = [words.slice(0, k).join(' '), words.slice(k).join(' ')];
      const worst = Math.max(...pair.map((l) => ctx.measureText(l).width));
      if (worst < Math.max(...best.map((l) => ctx.measureText(l).width))) best = pair;
    }
    return Object.assign(best.filter(Boolean), { size: 34 });
  }
}
