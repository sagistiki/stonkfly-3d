// Wires live run state to the 3D scene and panels.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { createStage, SCREEN } from './scene.js';
import { alignSeries } from './chart.js';
import { createFly, FlyActor } from './fly.js';
import { updateTweens, wait } from './tween.js';
import * as panels from './panels.js';

const POLL_MS = 2000;
const MAX_EVENTS = 300;

// ---------- renderer & scene ----------
const canvas = document.getElementById('stage');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 200);
camera.position.set(5.5, 6.4, 23);
const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 5.0, 1);
controls.enableDamping = true;
controls.minDistance = 6;
controls.maxDistance = 34;
controls.maxPolarAngle = Math.PI * 0.49;

const stage = createStage(scene, renderer);
const fly = createFly();
scene.add(fly.root);
const HOME = new THREE.Vector3(1.4, 4.0, 5.2);
const actor = new FlyActor(fly, HOME);

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.55, 0.45, 0.82);
composer.addPass(bloom);
composer.addPass(new OutputPass());

// Frame the giant screen inside the area the fixed panels leave free, so side panels
// never cover the chart (a narrower window pulls the camera back, never closer than
// the designed view) and centre it there with a view offset.
const DESIGN_DISTANCE = camera.position.distanceTo(controls.target);
const SCREEN_CORNERS = [-1, 1].flatMap((sx) => [-1, 1].flatMap((sy) => [0.45, -0.5].map((z) =>
  new THREE.Vector3(sx * (SCREEN.w / 2 + 0.35), SCREEN.cy + sy * (SCREEN.h / 2 + 0.35), z))));

function freeArea(w, h) {
  const area = { left: 0, right: w, top: 0, bottom: h };
  const fixed = (el) => el && getComputedStyle(el).position === 'fixed';
  const topbar = document.querySelector('.topbar');
  if (fixed(topbar)) area.top = topbar.getBoundingClientRect().bottom;
  for (const el of document.querySelectorAll('.column, .panel')) {
    if (!fixed(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.left + r.width / 2 < w / 2) area.left = Math.max(area.left, r.right);
    else area.right = Math.min(area.right, r.left);
  }
  const caption = document.querySelector('.caption');
  if (fixed(caption)) area.bottom = Math.min(area.bottom, caption.getBoundingClientRect().top);
  const pad = 14;
  return { left: area.left + pad, right: area.right - pad, top: area.top + pad, bottom: area.bottom - pad };
}

function projectedBox(w, h) {
  camera.lookAt(controls.target); // as OrbitControls will on its next update
  camera.updateMatrixWorld();
  const box = { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity };
  for (const corner of SCREEN_CORNERS) {
    const p = corner.clone().project(camera);
    const x = ((p.x + 1) / 2) * w;
    const y = ((1 - p.y) / 2) * h;
    box.left = Math.min(box.left, x); box.right = Math.max(box.right, x);
    box.top = Math.min(box.top, y); box.bottom = Math.max(box.bottom, y);
  }
  return box;
}

function fitCamera(w, h) {
  const free = freeArea(w, h);
  const fw = free.right - free.left;
  const fh = free.bottom - free.top;
  camera.clearViewOffset();
  if (fw < 80 || fh < 80) return;
  const dir = camera.position.clone().sub(controls.target).normalize();
  let distance = DESIGN_DISTANCE;
  for (let i = 0; i < 5; i++) {
    camera.position.copy(controls.target).addScaledVector(dir, distance);
    const box = projectedBox(w, h);
    const need = Math.max((box.right - box.left) / fw, (box.bottom - box.top) / fh);
    distance = Math.max(DESIGN_DISTANCE, distance * need);
  }
  camera.position.copy(controls.target).addScaledVector(dir, distance);
  controls.maxDistance = Math.max(34, distance * 1.4);
  const box = projectedBox(w, h);
  const dx = (box.left + box.right) / 2 - (free.left + free.right) / 2;
  const dy = (box.top + box.bottom) / 2 - (free.top + free.bottom) / 2;
  camera.setViewOffset(w, h, dx, dy, w, h);
}

function resize() {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  renderer.setSize(w, h, false);
  composer.setSize(w, h);
  bloom.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  fitCamera(w, h);
}
window.addEventListener('resize', resize);
resize();

const clock = new THREE.Clock();
function frame() {
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;
  updateTweens(dt);
  stage.update(dt, t);
  actor.lookAt(stage.beaconPosition().x);
  actor.update(dt, t);
  controls.update();
  composer.render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
// Canvas text is drawn with whatever font is loaded at that moment: redraw once the web
// fonts arrive, and refit because the top bar height can change with them.
document.fonts?.addEventListener?.('loadingdone', () => { stage.chart.dirty = true; resize(); });
document.fonts?.ready.then(() => { stage.chart.dirty = true; resize(); });

// ---------- live data ----------
let events = [];
let state = null;
let connected = false;
let pollFailed = false;
let initialized = false;
let generation = 0; // bumped when the run is replaced; stale animations stop rendering
let chartKey = '';
const queue = [];
let playing = false;

const threshold = () => state?.decoder_threshold_hz ?? 2;

// Chart series for one moment: history cut at `upToTick`, markers up to `markersTo`.
function series({ history, ledgerTick }, seen, upToTick, markersTo = upToTick) {
  const product = seen[seen.length - 1]?.product || 'BTC-USDC';
  return { product, ...alignSeries({ history: history?.[product], ledgerTick, events: seen, upToTick, markersTo }) };
}

function showChart(data, animate) {
  const v = data.values;
  const key = [data.product, v.length, v[0], v[v.length - 1], data.markers.map((m) => `${m.ev.tick}@${m.i}`).join(',')].join('|');
  if (!animate && key === chartKey) return;
  chartKey = key;
  stage.chart.setData(data, animate, clock.elapsedTime);
}

function snapshot(next = state) {
  return { history: next.history, ledgerTick: next.portfolio?.tick, portfolio: next.portfolio };
}

// Renders the latest known state without animation.
function showInstant({ first = false } = {}) {
  const last = events[events.length - 1];
  showChart(series(snapshot(), events, last?.tick ?? Infinity), false);
  // The ledger can commit the next tick's trade seconds before its event row exists;
  // keep the previous figures until that row arrives (the first render shows it anyway).
  const ahead = last && Number(state.portfolio?.tick) > last.tick;
  panels.renderPortfolio(first || !ahead ? state.portfolio : null, events);
  panels.renderBrain(last, events, threshold());
  panels.renderVision(state.input_version);
}

function resetRun() {
  generation++;
  events = [];
  queue.length = 0;
  initialized = false;
  chartKey = '';
  stage.chart.setData({ values: [], markers: [] }, false, clock.elapsedTime);
  panels.renderPortfolio(null, []);
  panels.renderBrain(null, [], threshold());
}

async function playTick({ ev, snap }) {
  const mine = generation;
  const live = () => mine === generation;
  const seen = events.filter((e) => e.tick <= ev.tick);
  const side = ev.neural?.side;
  const status = ev.execution?.status;

  // 1. The screen updates with the new observation; the brain integrates it.
  //    This tick's trade marker stays hidden until the decision is shown.
  showChart(series(snap, seen, ev.tick, ev.tick - 1), true);
  panels.renderTick(ev.tick);
  panels.renderVision(state.input_version);
  panels.renderBrain(ev, seen, threshold(), { thinking: true });
  await wait(1.1);
  if (!live()) return;

  // 2. The decoded decision.
  panels.renderBrain(ev, seen, threshold());
  const button = stage.buttons[side];
  if (side === 'HOLD') {
    await Promise.all([button.hum(2.4), actor.groom(2.2)]);
  } else if (!button) {
    await wait(1.5); // unknown side in the row: nothing to press
  } else {
    await actor.flyTo(button.approach, 1.3);
    await Promise.all([actor.press(), wait(0.45).then(() => button.press())]);
    const now = clock.elapsedTime;
    const ex = ev.execution || {};
    if (live()) {
      showChart(series(snap, seen, ev.tick), false);
      if (status === 'FILLED') {
        const price = Number(ex.quote) / Number(ex.base);
        const detail = Number.isFinite(price)
          ? ` · ${Number(ex.base).toFixed(8)} BTC @ $${price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
          : '';
        stage.chart.toast(`${side} FILLED${detail}`, side === 'BUY' ? '#2fe38b' : '#ff4d6d', now);
      } else if (status === 'VETO') {
        stage.chart.toast(`${side} VETO · ${ex.reason || 'rejected by risk guard'}`, '#ffae3c', now);
      } else {
        stage.chart.toast(`${side} · ${status || 'no execution record'}`, '#7d8bb0', now);
      }
    }
    if (status === 'FILLED') await button.result(status);
    else if (status === 'VETO') await Promise.all([button.result(status), actor.shake()]);
    await actor.flyTo(HOME, 1.4);
  }
  if (!live()) return;
  // Ledger figures only when that snapshot belongs to exactly this tick.
  panels.renderPortfolio(Number(snap.portfolio?.tick) === ev.tick ? snap.portfolio : null, seen);
}

// Derived from state every time so no failed step can leave it stuck.
function syncReplay() {
  document.getElementById('replay').disabled = playing || !initialized || !events.length;
}

async function drain() {
  if (playing) return;
  playing = true;
  syncReplay();
  try {
    while (queue.length) {
      const item = queue.shift();
      try {
        await playTick(item);
      } catch (err) {
        console.error(`animation of tick ${item.ev?.tick} failed`, err);
      }
    }
  } finally {
    playing = false;
    // Land on the latest state right away (several ticks may have arrived meanwhile).
    if (initialized) {
      try { showInstant(); } catch (err) { console.error('render failed', err); }
    }
    syncReplay();
  }
}

async function fetchState(since) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 8000);
  try {
    const res = await fetch(`/api/state?since=${since}`, { cache: 'no-store', signal: abort.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function poll() {
  let delay = POLL_MS;
  try {
    // Ask from one tick back so the newest row we hold comes back too.
    const known = events[events.length - 1];
    const next = await fetchState(known ? Math.max(0, known.tick - 1) : 0);
    // An unreadable ledger reads as "waiting" with no history; keep the last ledger
    // view for the chart and portfolio instead of flashing an events-only chart.
    if (next.status === 'waiting' && known && state?.portfolio?.mode) {
      Object.assign(next, { history: state.history, portfolio: state.portfolio });
    }
    connected = true;
    state = next;

    let fresh = next.events || [];
    if (known) {
      // If that row is gone or different, the run directory was replaced or truncated
      // (or too many rows arrived to overlap): reload the run without animating history.
      const at = fresh.findIndex((e) => e.tick === known.tick && e.wall_time === known.wall_time);
      if (at < 0) {
        console.info('run changed on disk, reloading');
        resetRun();
        delay = 0;
        return;
      }
      fresh = fresh.slice(at + 1).filter((e) => e.tick > known.tick);
    }
    if (fresh.length) {
      events = [...events, ...fresh].slice(-MAX_EVENTS);
      if (initialized) {
        // Animate at most the latest three; the rest is already in `events`.
        for (const ev of fresh.slice(-3)) queue.push({ ev, snap: snapshot(next) });
        queue.splice(0, Math.max(0, queue.length - 3));
        drain();
      }
    }
    panels.renderVision(next.input_version);
    if (!initialized && next.status !== 'waiting') {
      // Only mark initialized once the first render succeeded; otherwise retry next poll.
      try {
        showInstant({ first: true });
        initialized = true;
      } catch (err) {
        console.error('initial render failed, retrying', err);
      }
    } else if (initialized && !playing) {
      showInstant();
    }
  } catch (err) {
    if (connected || !pollFailed) console.error('poll failed', err); // once per outage
    pollFailed = true;
    connected = false;
  } finally {
    panels.renderStatus(state, connected);
    syncReplay();
    setTimeout(poll, delay);
  }
}

setInterval(() => panels.renderCountdown(connected ? state?.last_event_time : null, state?.status), 1000);

document.getElementById('replay').addEventListener('click', () => {
  const last = events[events.length - 1];
  if (!last || playing || !initialized) return;
  queue.push({ ev: last, snap: snapshot() });
  drain();
});

poll();
