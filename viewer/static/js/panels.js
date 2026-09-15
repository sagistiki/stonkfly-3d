// DOM side panels: portfolio, brain readout, fly vision, top bar.
const $ = (id) => document.getElementById(id);

const STATUS_TEXT = {
  running: 'הזבוב רץ',
  idle: 'לא פעיל (אין טיקים חדשים)',
  stopped: 'נעצר — קובץ STOP',
  halted: 'הופסק',
  waiting: 'ממתין לזבוב',
  disconnected: 'אין חיבור לשרת',
};

// Rows come from local files, but older rows can miss fields: never print NaN.
const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));
const fmt = (v, d = 2) => (Number.isFinite(num(v)) ? num(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—');
const usd = (v, d = 2) => (Number.isFinite(num(v)) ? `$${fmt(v, d)}` : '—');
const int = (v) => (Number.isFinite(num(v)) ? Math.round(num(v)).toLocaleString('en-US') : '—');
const hz = (v) => (Number.isFinite(num(v)) ? String(Math.round(num(v) * 100) / 100) : '—');
const signed = (v, text) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${text}`;
// Left-to-right isolate, so formulas and numbers keep their order inside Hebrew text.
const ltr = (s) => `\u2066${s}\u2069`;

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// Skips identical rewrites so hover tooltips and transitions are not reset every poll.
function setHtml(el, html) {
  if (el.dataset.html !== html) {
    el.dataset.html = html;
    el.innerHTML = html;
  }
}

function sparkline(svg, values, { color, zeroBand } = {}) {
  values = values.filter(Number.isFinite);
  if (values.length < 2) { setHtml(svg, ''); return; }
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (zeroBand) { lo = Math.min(lo, -zeroBand * 2); hi = Math.max(hi, zeroBand * 2); }
  if (hi - lo < 1e-9) { hi += 1; lo -= 1; }
  const x = (i) => (i / (values.length - 1)) * 300;
  const y = (v) => 56 - ((v - lo) / (hi - lo)) * 52;
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const band = zeroBand
    ? `<rect x="0" y="${y(zeroBand).toFixed(1)}" width="300" height="${Math.max(0, y(-zeroBand) - y(zeroBand)).toFixed(1)}" fill="rgba(122,162,255,.16)"/>
       <line x1="0" x2="300" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}" stroke="rgba(255,255,255,.25)" stroke-dasharray="3 3"/>`
    : '';
  setHtml(svg, `${band}<path d="${d}" fill="none" stroke="${escapeHtml(color)}" stroke-width="2" vector-effect="non-scaling-stroke"/>`);
}

export function renderStatus(state, connected) {
  const pill = $('status');
  const key = connected ? state?.status || 'waiting' : 'disconnected';
  pill.className = `pill ${key}`;
  pill.textContent = STATUS_TEXT[key] || key;
  if (state?.portfolio?.mode) $('mode').textContent = String(state.portfolio.mode).toUpperCase();
  const overlay = $('overlay');
  overlay.hidden = connected && key !== 'waiting';
  $('overlay-text').textContent = connected
    ? `ממתין לזבוב… הרץ את העובד כדי להתחיל (${state?.run_dir || ''})`
    : 'אין חיבור לשרת הצפייה — מנסה שוב…';
}

export function renderCountdown(lastEventTime, status) {
  const el = $('countdown');
  if (!lastEventTime || status !== 'running') { el.textContent = ''; return; }
  const remaining = Math.round(lastEventTime + 60 - Date.now() / 1000);
  el.innerHTML = remaining > 0
    ? `החלטה הבאה בעוד <b class="num">~${Math.min(remaining, 60)}s</b>`
    : '<b>המוח מעבד תצפית…</b>';
}

export function renderTick(tick) {
  $('tick').textContent = int(tick);
}

// Equity from the ledger (cash + holdings at the latest event bid, after this tick's
// trade and fees). Pass portfolio = null to refresh only the event-derived parts.
export function renderPortfolio(portfolio, events) {
  const last = events[events.length - 1];
  if (!last) {
    for (const id of ['tick', 'equity', 'pnl', 'cash', 'btc', 'btc-value', 'initial']) $(id).textContent = '—';
    $('pnl').className = 'num';
    setHtml($('trades'), '');
    setHtml($('equity-spark'), '');
    return;
  }
  renderTick(last.tick);
  renderTrades(events);

  if (portfolio) {
    const bidOf = (product) => {
      for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i];
        const bid = num(e.quote?.bid);
        if ((e.product || 'BTC-USDC') === product && Number.isFinite(bid) && bid > 0) return bid;
      }
      return NaN;
    };
    const cash = num(portfolio.cash);
    const positions = portfolio.positions || {};
    const btc = num(positions['BTC-USDC'] ?? 0);
    const equity = cash + Object.entries(positions).reduce((sum, [product, q]) => sum + (num(q) ? num(q) * bidOf(product) : 0), 0);
    const initial = num(portfolio.initial_cash);
    const pnl = equity - initial;
    const flat = Math.abs(pnl) < 0.0005; // shows as $0.000: no sign, no colour

    $('equity').textContent = usd(equity);
    const pnlEl = $('pnl');
    if (Number.isFinite(pnl) && initial > 0) {
      pnlEl.textContent = `${signed(flat ? 0 : pnl, usd(Math.abs(pnl), 3))} (${signed(flat ? 0 : pnl, `${Math.abs((pnl / initial) * 100).toFixed(3)}%`)})`;
      pnlEl.className = `num ${flat ? '' : pnl > 0 ? 'up' : 'down'}`;
    } else {
      pnlEl.textContent = '—';
      pnlEl.className = 'num';
    }
    $('cash').textContent = usd(cash);
    $('btc').textContent = fmt(btc, 8);
    $('btc-value').textContent = usd(btc * bidOf('BTC-USDC'));
    $('initial').textContent = usd(initial);
    $('equity-spark').dataset.trend = pnl < 0 && !flat ? 'down' : 'up';
  }

  const trend = $('equity-spark').dataset.trend;
  sparkline($('equity-spark'), events.map((e) => num(e.equity_usdc)), { color: trend === 'down' ? '#ff4d6d' : '#2fe38b' });
}

function renderTrades(events) {
  setHtml($('trades'), events.slice(-8).reverse().map((e) => {
    const side = String(e.neural?.side || '—');
    const status = String(e.execution?.status || '—');
    const ex = e.execution || {};
    const price = num(ex.quote) / num(ex.base);
    const detail = status === 'FILLED'
      ? (Number.isFinite(price) ? `${usd(ex.quote)} @ ${usd(price)}` : '')
      : status === 'VETO' ? String(ex.reason || '') : '';
    const full = status === 'FILLED' && Number.isFinite(price)
      ? `${fmt(ex.base, 8)} BTC @ ${usd(price)} · fee ${usd(ex.fee, 4)}`
      : detail;
    const s = escapeHtml(side);
    const st = escapeHtml(status);
    return `<li><span class="num muted">#${escapeHtml(int(e.tick))}</span><span class="chip small ${s}">${s}</span>
      <span class="reason" title="${escapeHtml(`${status} ${full}`.trim())}"><b class="status-${st}">${st}</b> ${escapeHtml(detail)}</span></li>`;
  }).join(''));
}

// While thinking, only the stimulus (an input to this tick) is shown; the decoded
// readouts keep the previous tick's values, dimmed, until the decision is revealed.
export function renderBrain(ev, events, threshold = 2, { thinking = false } = {}) {
  const panel = $('brain');
  panel.classList.toggle('thinking', thinking);
  if (!ev) {
    $('side').textContent = '—';
    $('side').className = 'chip';
    $('why').textContent = '—';
    return;
  }
  const n = ev.neural || {};
  threshold = Number.isFinite(num(threshold)) ? num(threshold) : 2;
  renderStimulus(ev);
  const chip = $('side');
  if (thinking) {
    chip.textContent = '…';
    chip.className = 'chip';
    $('why').textContent = 'מאחד את הפעילות העצבית של התצפית…';
    return;
  }
  const side = ['BUY', 'SELL', 'HOLD'].includes(n.side) ? n.side : '';
  chip.textContent = side || '—';
  chip.className = `chip ${side}`;

  const left = num(n.left_hz);
  const right = num(n.right_hz);
  let diff = num(n.difference_hz);
  if (!Number.isFinite(diff)) diff = right - left;
  const gate = num(n.gate_spikes);
  const known = Number.isFinite(diff) && Number.isFinite(gate);
  const diffText = Number.isFinite(diff) ? `${diff > 0 ? '+' : ''}${hz(diff)}` : '—';
  $('why').textContent = !known
    ? (side ? `החלטה: ${side}` : '—')
    : !gate
      ? `השער לא נורה ← ${side}`
      : Math.abs(diff) < threshold
        ? `${ltr(`|R−L| = ${hz(Math.abs(diff))} Hz < ${threshold}`)} ← ${side}`
        : `${ltr(`R−L = ${diffText} Hz`)} והשער נורה ← ${side}`;

  // Tug-of-war bar: ±20 Hz full scale, band shows the HOLD threshold.
  const scale = 20;
  const pct = (v) => 50 + (Math.max(-scale, Math.min(scale, v)) / scale) * 50;
  const band = $('band');
  band.style.left = `${pct(-threshold)}%`;
  band.style.width = `${pct(threshold) - pct(-threshold)}%`;
  const d = Number.isFinite(diff) ? diff : 0;
  const fill = $('tug-fill');
  const a = pct(Math.min(0, d));
  const b = pct(Math.max(0, d));
  fill.style.left = `${a}%`;
  fill.style.width = `${Math.max(0.6, b - a)}%`;
  fill.style.background = d >= threshold ? 'var(--buy)' : d <= -threshold ? 'var(--sell)' : 'var(--hold)';
  $('left-hz').textContent = hz(left);
  $('right-hz').textContent = hz(right);
  $('diff-hz').textContent = diffText;

  const g = Number.isFinite(gate) ? Math.max(0, gate) : 0;
  const dots = Math.min(g, 12);
  setHtml($('gate-dots'), Array.from({ length: Math.max(dots, 3) }, (_, i) => `<i class="${i < dots ? '' : 'off'}"></i>`).join(''));
  $('gate-text').textContent = !Number.isFinite(gate) ? '—' : gate ? `${int(gate)} קוצים · פתוח` : 'סגור';

  sparkline($('diff-spark'), events.map((e) => {
    const m = e.neural || {};
    const v = num(m.difference_hz);
    return Number.isFinite(v) ? v : num(m.right_hz) - num(m.left_hz);
  }), { color: '#9fb8ff', zeroBand: threshold });

  const mem = n.memory || {};
  $('spikes').textContent = int(n.total_spikes);
  $('kc').textContent = int(n.KC_spikes);
  $('plastic').textContent = mem.changed_edges != null ? `${int(mem.changed_edges)} / ${int(mem.plastic_edges)}` : '—';
  $('efficacy').textContent = fmt(mem.mean_efficacy, 4);
  $('brain-ms').textContent = Number.isFinite(num(n.brain_ms)) ? `${fmt(num(n.brain_ms) / 1000, 1)}s` : '—';
  $('compute').textContent = Number.isFinite(num(n.compute_seconds)) ? `${fmt(n.compute_seconds, 2)}s` : '—';
}

// The dopamine pulse is an engineered input chosen from the equity change since the
// previous observation; it is not modeled pain or pleasure.
function renderStimulus(ev) {
  const n = ev.neural || {};
  const kind = ['reward', 'aversive'].includes(n.stimulus) ? n.stimulus : 'none';
  const ms = Number.isFinite(num(n.stimulus_ms)) && num(n.stimulus_ms) > 0 ? ` ${ltr(`${Math.round(num(n.stimulus_ms))}\u00a0ms`)}` : '';
  const delta = num(ev.pnl_delta_usdc);
  const change = Number.isFinite(delta) ? ` ${ltr(`(Δ\u00a0${signed(delta, usd(Math.abs(delta), 4))})`)}` : '';
  const stim = $('stimulus');
  stim.className = `stimulus ${kind}`;
  stim.textContent = kind === 'reward'
    ? `אות תגמול מהונדס: פולס${ms} ל-15 תאי הדופמין PAM11 — ההון עלה מאז התצפית הקודמת${change}`
    : kind === 'aversive'
      ? `אות אברסיבי מהונדס (לא כאב): פולס${ms} ל-2 תאי הדופמין PPL101 — ההון ירד מאז התצפית הקודמת${change}`
      : n.stimulus === undefined
        ? 'אין נתוני גירוי בשורה הזו'
        : `ללא פולס דופמין — שינוי ההון קטן מסף הגירוי${change}`;
}

export function renderVision(version) {
  if (!version) return;
  const img = $('input');
  const src = `/api/input.png?v=${encodeURIComponent(version)}`;
  if (img.dataset.src !== src) {
    img.dataset.src = src;
    img.src = src;
  }
}
