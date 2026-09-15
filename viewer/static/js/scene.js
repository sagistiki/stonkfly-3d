// The trading room: giant screen with the chart, BUY/HOLD/SELL buttons, floor and lights.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { ChartScreen, CANVAS_W, CANVAS_H } from './chart.js';
import { tween, ease } from './tween.js';

export const SCREEN = { w: 16, h: 9, cy: 5.6 };

const BUTTONS = [
  { side: 'BUY', x: -5, color: 0x2fe38b },
  { side: 'HOLD', x: 0, color: 0x7aa2ff },
  { side: 'SELL', x: 5, color: 0xff4d6d },
];

const VETO_COLOR = new THREE.Color(0xffae3c);
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const FLASH_OFFSET = new THREE.Vector3(0, 1.4, 2.4);

// Canvas pixel -> world position on the screen surface.
export function screenToWorld(cx, cy, z = 0.02) {
  return new THREE.Vector3((cx / CANVAS_W - 0.5) * SCREEN.w, SCREEN.cy + (0.5 - cy / CANVAS_H) * SCREEN.h, z);
}

function labelTexture(text, color) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 160;
  const g = c.getContext('2d');
  g.fillStyle = color;
  g.font = '700 104px "JetBrains Mono", monospace';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 256, 86);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.6)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

class DecisionButton {
  constructor(spec, flash) {
    this.side = spec.side;
    this.baseColor = new THREE.Color(spec.color);
    this.group = new THREE.Group();
    const anchor = screenToWorld(((spec.x / SCREEN.w) + 0.5) * CANVAS_W, 800, 0);
    this.group.position.copy(anchor);

    const housing = new THREE.Mesh(
      new RoundedBoxGeometry(3.6, 1.3, 0.3, 4, 0.12),
      new THREE.MeshStandardMaterial({ color: 0x0c1226, metalness: 0.6, roughness: 0.35 }),
    );
    housing.position.z = 0.15;
    this.group.add(housing);

    this.material = new THREE.MeshStandardMaterial({
      color: this.baseColor.clone().multiplyScalar(0.35), emissive: this.baseColor, emissiveIntensity: 0.35,
      metalness: 0.2, roughness: 0.3,
    });
    this.cap = new THREE.Mesh(new RoundedBoxGeometry(3.2, 1.0, 0.36, 4, 0.14), this.material);
    this.cap.position.z = 0.42;
    this.cap.castShadow = true;
    this.group.add(this.cap);

    const label = new THREE.Mesh(
      new THREE.PlaneGeometry(2.6, 0.81),
      new THREE.MeshBasicMaterial({ map: labelTexture(spec.side, '#07101f'), transparent: true, toneMapped: false }),
    );
    label.position.z = 0.185;
    this.cap.add(label);

    // Halo ring around the cap: carries the bright glow so the label itself stays readable.
    this.rimMaterial = new THREE.MeshBasicMaterial({ color: this.baseColor, transparent: true, opacity: 0, toneMapped: false });
    const rim = new THREE.Mesh(new RoundedBoxGeometry(3.5, 1.3, 0.06, 4, 0.2), this.rimMaterial);
    rim.position.z = 0.33;
    this.group.add(rim);
    this.restZ = this.cap.position.z;
    this.flash = flash; // light shared by all buttons, lit by whichever one glows
    this.glow = 0.35;
  }

  // Where the fly hovers so its front feet (POSES.reach in fly.js) rest on the top of the cap face.
  get approach() {
    const p = new THREE.Vector3();
    this.cap.getWorldPosition(p);
    return p.add(new THREE.Vector3(0, 1.35, 1.04));
  }

  setGlow(v, color = this.baseColor) {
    this.glow = v;
    this.material.emissive.copy(color);
    this.material.emissiveIntensity = Math.min(v, 0.75);
    this.rimMaterial.color.copy(color).multiplyScalar(1 + v);
    this.rimMaterial.opacity = clamp01((v - 0.35) * 1.2);
    if (v > 0.4 || this.flash.userData.owner === this) {
      this.flash.userData.owner = v > 0.4 ? this : null;
      this.group.getWorldPosition(this.flash.position).add(FLASH_OFFSET);
      this.flash.color.copy(color);
      this.flash.intensity = Math.max(0, v - 0.35) * 9;
    }
  }

  async press() {
    await tween(0.12, (p) => { this.cap.position.z = this.restZ - 0.2 * p; this.setGlow(0.35 + 0.85 * p); }, ease.out);
    await tween(0.35, (p) => { this.cap.position.z = this.restZ - 0.2 * (1 - p); }, ease.outBack);
  }

  async result(status) {
    if (status === 'VETO') {
      await tween(1.2, (_, raw) => {
        const on = Math.sin(raw * Math.PI * 6) > 0;
        this.setGlow(on ? 1.1 : 0.4, on ? VETO_COLOR : this.baseColor);
      }, ease.linear);
    } else {
      await tween(1.4, (p) => this.setGlow(1.5 - 1.15 * p), ease.out);
    }
    this.setGlow(0.35);
  }

  async hum(seconds) {
    await tween(seconds, (_, raw) => this.setGlow(0.35 + Math.sin(raw * Math.PI) * 0.75), ease.linear);
    this.setGlow(0.35);
  }
}

export function createStage(scene, renderer) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.background = new THREE.Color(0x03050b);
  scene.fog = new THREE.Fog(0x03050b, 22, 60);

  scene.add(new THREE.HemisphereLight(0x8fa8ff, 0x0a0a14, 0.55));
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(6, 14, 12);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  Object.assign(key.shadow.camera, { left: -12, right: 12, top: 12, bottom: -4, near: 1, far: 40 });
  scene.add(key);

  const screenLight = new THREE.PointLight(0x5f8cff, 30, 16, 1.6);
  screenLight.position.set(0, SCREEN.cy, 2.5);
  scene.add(screenLight);

  // Floor
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(120, 120),
    new THREE.MeshStandardMaterial({ color: 0x070a14, metalness: 0.4, roughness: 0.55 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);
  const grid = new THREE.GridHelper(120, 120, 0x1b2a55, 0x0e1630);
  grid.position.y = 0.005;
  grid.material.transparent = true;
  grid.material.opacity = 0.5;
  scene.add(grid);

  // Screen frame, stand and display surface
  const metal = new THREE.MeshStandardMaterial({ color: 0x151b2e, metalness: 0.75, roughness: 0.3 });
  const frame = new THREE.Mesh(new RoundedBoxGeometry(SCREEN.w + 0.7, SCREEN.h + 0.7, 0.5, 5, 0.2), metal);
  frame.position.set(0, SCREEN.cy, -0.27);
  frame.castShadow = true;
  scene.add(frame);
  for (const x of [-5.5, 5.5]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.5, SCREEN.cy - SCREEN.h / 2, 0.4), metal);
    leg.position.set(x, (SCREEN.cy - SCREEN.h / 2) / 2, -0.45);
    scene.add(leg);
  }
  const base = new THREE.Mesh(new RoundedBoxGeometry(14, 0.25, 3, 3, 0.1), metal);
  base.position.set(0, 0.125, -0.4);
  base.receiveShadow = true;
  scene.add(base);

  const chart = new ChartScreen();
  const display = new THREE.Mesh(
    new THREE.PlaneGeometry(SCREEN.w, SCREEN.h),
    new THREE.MeshBasicMaterial({ map: chart.texture, toneMapped: false }),
  );
  display.position.set(0, SCREEN.cy, 0.001);
  scene.add(display);

  const flash = new THREE.PointLight(0xffffff, 0, 7, 1.8);
  scene.add(flash);
  const buttons = {};
  for (const spec of BUTTONS) {
    const b = new DecisionButton(spec, flash);
    buttons[spec.side] = b;
    scene.add(b.group);
  }

  // Pulsing beacon on the newest price point.
  const beacon = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: 0x9fe8ff, transparent: true, depthWrite: false, toneMapped: false, blending: THREE.AdditiveBlending }));
  scene.add(beacon);

  // Dust drifting through the screen light.
  const dustCount = 500;
  const dustPos = new Float32Array(dustCount * 3);
  for (let i = 0; i < dustCount; i++) {
    dustPos.set([(Math.sin(i * 12.9898) * 43758.5453 % 1) * 24, ((i * 0.618) % 1) * 11 + 0.3, ((i * 0.3819) % 1) * 12 + 0.5], i * 3);
  }
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
  const dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({ color: 0x8fb4ff, size: 0.035, transparent: true, opacity: 0.45, depthWrite: false }));
  scene.add(dust);

  const trendColor = new THREE.Color();
  const colors = { up: new THREE.Color(0x3cf0a0), down: new THREE.Color(0xff5a7a), flat: new THREE.Color(0x5f8cff) };

  return {
    chart,
    buttons,
    beaconPosition: () => beacon.position,
    update(dt, t) {
      chart.update(dt, t);
      const lp = chart.lastPoint;
      beacon.position.copy(screenToWorld(lp.x, lp.y, 0.06));
      const s = 0.55 + Math.sin(t * 4) * 0.15;
      beacon.scale.set(s, s, 1);
      trendColor.copy(chart.trend > 0 ? colors.up : chart.trend < 0 ? colors.down : colors.flat);
      screenLight.color.lerp(trendColor, Math.min(1, dt * 2));
      beacon.material.color.lerp(trendColor, Math.min(1, dt * 2));
      dust.rotation.y = Math.sin(t * 0.05) * 0.05;
      dust.position.y = Math.sin(t * 0.2) * 0.2;
    },
  };
}
