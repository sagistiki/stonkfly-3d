// Procedural 3D fruit fly (Drosophila-like) plus its fly / press / groom / shake animations.
// The fly faces -Z (towards the screen); the whole model is scaled by FLY_SCALE.
import * as THREE from 'three';
import { tween, ease } from './tween.js';

export const FLY_SCALE = 1.15;
const { lerp, clamp, smoothstep } = THREE.MathUtils;
const DEG = Math.PI / 180;

// Leg poses in degrees: [swing (+ forward), splay (0 = straight down, 90 = sideways), knee bend, ankle bend,
// twist of the knee's bend plane about the femur (optional)].
const POSES = {
  hover: { front: [45, 74, 72, -30], mid: [0, 80, 82, -34], hind: [-45, 76, 74, -28] },
  flight: { front: [34, 40, 52, -10], mid: [-40, 40, 40, -10], hind: [-64, 34, 30, -8] },
  reach: [83, 98, 64, -40], // front feet on the cap: see DecisionButton.approach
  brace: { mid: [-72, 72, 128, 30], hind: [-86, 62, 118, 20] }, // folded back so the label stays visible
  rub: [37, 32, -61, -30, 91], // front feet meet below the proboscis (body pitched up 0.22)
};
const PRESS_PITCH = -0.45; // nose down while pushing the cap
const FACE_VIEWER = -2.25; // yaw that turns the fly's face towards the default camera

function mixPose(out, a, b, p) {
  for (let i = 0; i < 5; i++) out[i] = lerp(a[i] ?? 0, b[i] ?? 0, p);
}

function mixAngle(a, b, p) {
  const d = Math.atan2(Math.sin(b - a), Math.cos(b - a));
  return a + d * p;
}

function abdomenTexture() {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#b58a55';
  g.fillRect(0, 0, 128, 256);
  // Dark tergite bands on the dorsal side only (u = 0.5 is the top); canvas top = abdomen tip.
  const shade = g.createLinearGradient(0, 0, 128, 0);
  shade.addColorStop(0.12, 'rgba(36,24,14,0)');
  shade.addColorStop(0.32, 'rgba(36,24,14,0.95)');
  shade.addColorStop(0.68, 'rgba(36,24,14,0.95)');
  shade.addColorStop(0.88, 'rgba(36,24,14,0)');
  g.fillStyle = shade;
  for (const [y, h] of [[8, 30], [56, 24], [100, 20], [144, 17], [186, 14]]) g.fillRect(0, y, 128, h);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function facetTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, 256, 256);
  g.fillStyle = '#fff';
  for (let y = 0; y < 256; y += 8) {
    for (let x = (y / 8) % 2 ? 4 : 0; x < 256; x += 8) {
      g.beginPath(); g.arc(x, y, 3.2, 0, Math.PI * 2); g.fill();
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(3, 3);
  return tex;
}

// Paddle-shaped wing in the XZ plane: +X along the span, -Z leading edge.
function wingGeometry() {
  const s = new THREE.Shape();
  s.moveTo(0, -0.03);
  s.bezierCurveTo(0.3, -0.13, 0.95, -0.2, 1.32, -0.12);
  s.bezierCurveTo(1.56, -0.05, 1.58, 0.24, 1.34, 0.31);
  s.bezierCurveTo(1.0, 0.42, 0.48, 0.36, 0.2, 0.15);
  s.bezierCurveTo(0.09, 0.07, 0.02, 0.03, 0, -0.03);
  const geo = new THREE.ShapeGeometry(s, 20);
  geo.rotateX(Math.PI / 2); // (x, y) -> (x, 0, y)
  const outline = s.getSpacedPoints(64);
  const lines = [];
  for (let i = 0; i < outline.length - 1; i++) lines.push(outline[i], outline[i + 1]);
  // Longitudinal veins and the two cross veins.
  for (const [x0, y0, x1, y1] of [[0.05, -0.04, 1.45, -0.02], [0.1, 0, 1.52, 0.14], [0.14, 0.05, 1.3, 0.3], [0.2, 0.12, 0.95, 0.38], [0.62, -0.02, 0.66, 0.1], [0.9, 0.11, 0.86, 0.33]]) {
    lines.push(new THREE.Vector2(x0, y0), new THREE.Vector2(x1, y1));
  }
  const veins = new THREE.BufferGeometry().setFromPoints(lines.map((p) => new THREE.Vector3(p.x, 0.002, p.y)));
  return { geo, veins };
}

// Short dark bristles over the top of the thorax.
function bristles(material) {
  const geo = new THREE.ConeGeometry(0.01, 0.11, 4);
  geo.translate(0, 0.055, 0);
  const rows = [[-0.09, 5], [0.09, 5], [-0.2, 4], [0.2, 4], [-0.28, 3], [0.28, 3]];
  const count = rows.reduce((n, [, k]) => n + k, 0);
  const mesh = new THREE.InstancedMesh(geo, material, count);
  const dummy = new THREE.Object3D();
  const up = new THREE.Vector3(0, 1, 0);
  let i = 0;
  for (const [x, k] of rows) {
    for (let j = 0; j < k; j++) {
      const z = -0.3 + (0.55 * j) / Math.max(1, k - 1);
      const y = 0.34 * Math.sqrt(Math.max(0.05, 1 - (x / 0.36) ** 2 - (z / 0.44) ** 2));
      dummy.position.set(x, y - 0.01, z);
      dummy.quaternion.setFromUnitVectors(up, new THREE.Vector3(x * 1.5, 0.8, 0.7).normalize());
      dummy.updateMatrix();
      mesh.setMatrixAt(i++, dummy.matrix);
    }
  }
  return mesh;
}

function capsule(radius, length) {
  const geo = new THREE.CapsuleGeometry(radius, length, 3, 8);
  geo.translate(0, -length / 2, 0);
  return geo;
}

export function createFly() {
  const root = new THREE.Group();
  root.scale.setScalar(FLY_SCALE);
  const body = new THREE.Group();
  root.add(body);

  const chitin = new THREE.MeshPhysicalMaterial({
    color: 0x8c6238, roughness: 0.5, metalness: 0.05, clearcoat: 0.3, clearcoatRoughness: 0.5,
    sheen: 0.25, sheenColor: 0xc9a06a,
  });
  const dark = new THREE.MeshStandardMaterial({ color: 0x2b1f15, roughness: 0.55 });

  const thorax = new THREE.Mesh(new THREE.SphereGeometry(0.4, 36, 24), chitin);
  thorax.scale.set(0.9, 0.85, 1.1);
  body.add(thorax);
  const scutellum = new THREE.Mesh(new THREE.SphereGeometry(0.17, 20, 12), chitin);
  scutellum.scale.set(1.2, 0.55, 0.9);
  scutellum.position.set(0, 0.2, 0.36);
  body.add(scutellum, bristles(dark));

  // Abdomen: egg-shaped lathe body (widest 40% back, rounded tip) so the bands wrap around it as rings.
  const profile = [];
  for (let i = 0; i <= 20; i++) {
    const s = i / 20;
    const u = (s - 0.4) / (s < 0.4 ? 0.55 : 0.6);
    profile.push(new THREE.Vector2(0.37 * Math.sqrt(Math.max(0, 1 - u * u)), s));
  }
  const abdomenGeo = new THREE.LatheGeometry(profile, 36);
  abdomenGeo.rotateX(Math.PI / 2); // lathe axis +Y -> +Z (backwards)
  const abdomen = new THREE.Mesh(abdomenGeo, new THREE.MeshPhysicalMaterial({
    map: abdomenTexture(), roughness: 0.45, clearcoat: 0.45, clearcoatRoughness: 0.45, sheen: 0.3,
  }));
  abdomen.scale.set(1, 0.82, 1);
  abdomen.position.set(0, -0.08, 0.26);
  body.add(abdomen);

  const head = new THREE.Group();
  head.position.set(0, 0.06, -0.5);
  body.add(head);
  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.24, 28, 20), chitin);
  skull.scale.set(1.2, 1.0, 0.8);
  head.add(skull);

  const eyeMat = new THREE.MeshPhysicalMaterial({
    color: 0xc21d14, emissive: 0x3a0503, roughness: 0.25, clearcoat: 1, clearcoatRoughness: 0.08,
    bumpMap: facetTexture(), bumpScale: 0.5,
  });
  const eyeGeo = new THREE.SphereGeometry(0.21, 32, 24);
  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(eyeGeo, eyeMat);
    eye.scale.set(0.74, 1.05, 1.0);
    eye.position.set(side * 0.2, 0.03, -0.04);
    head.add(eye);

    const antenna = new THREE.Mesh(new THREE.SphereGeometry(0.04, 10, 8), chitin);
    antenna.scale.set(0.8, 1.2, 0.8);
    antenna.position.set(side * 0.06, 0.02, -0.2);
    head.add(antenna);
    const arista = new THREE.Mesh(new THREE.ConeGeometry(0.008, 0.13, 5), dark);
    arista.geometry.translate(0, 0.065, 0);
    arista.position.set(side * 0.07, 0.04, -0.22);
    arista.rotation.set(-1.0, 0, side * -0.6);
    head.add(arista);
  }
  const proboscis = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.05, 0.14, 10), dark);
  proboscis.position.set(0, -0.2, -0.06);
  proboscis.rotation.x = 0.3;
  head.add(proboscis);

  // Wings: hinge on top of the thorax; `live` beats, the ghosts show the blurred stroke.
  const wingMat = new THREE.MeshPhysicalMaterial({
    color: 0xe4eeff, transparent: true, opacity: 0.34, roughness: 0.35, metalness: 0,
    iridescence: 0.7, iridescenceIOR: 1.3, side: THREE.DoubleSide, depthWrite: false,
  });
  const ghostMat = new THREE.MeshBasicMaterial({ color: 0xcfe0ff, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false });
  const veinMat = new THREE.LineBasicMaterial({ color: 0x5a4632, transparent: true, opacity: 0.75 });
  const { geo: wingGeo, veins } = wingGeometry();
  const wings = [-1, 1].map((side) => {
    const base = new THREE.Group();
    base.position.set(side * 0.13, 0.28, -0.06);
    const live = new THREE.Group();
    live.rotation.order = 'ZXY'; // roll about the span first, then stroke about the body axis
    const holder = new THREE.Group();
    holder.scale.x = side; // mirror the left wing
    holder.add(new THREE.Mesh(wingGeo, wingMat), new THREE.LineSegments(veins, veinMat));
    live.add(holder);
    base.add(live);
    for (const elevation of [-0.3, 0.3, 0.9]) {
      const ghost = new THREE.Group();
      ghost.rotation.order = 'ZXY';
      ghost.rotation.set(-0.9, 0, side * elevation);
      const mesh = new THREE.Mesh(wingGeo, ghostMat);
      mesh.scale.x = side;
      ghost.add(mesh);
      base.add(ghost);
    }
    body.add(base);
    return { base, live, side };
  });

  // Legs: hip (swing + splay) -> femur -> knee -> tibia -> ankle -> tarsus -> foot.
  const footGeo = new THREE.SphereGeometry(0.03, 8, 6);
  const LEGS = {
    front: { hip: [0.12, -0.2, -0.24], len: [0.34, 0.36, 0.26] },
    mid: { hip: [0.16, -0.25, -0.02], len: [0.38, 0.42, 0.28] },
    hind: { hip: [0.14, -0.22, 0.2], len: [0.42, 0.46, 0.3] },
  };
  const legs = {};
  for (const [name, { hip: at, len: [femurLen, tibiaLen, tarsusLen] }] of Object.entries(LEGS)) {
    const femurGeo = capsule(0.032, femurLen);
    const tibiaGeo = capsule(0.021, tibiaLen);
    const tarsusGeo = capsule(0.013, tarsusLen);
    legs[name] = [-1, 1].map((side) => {
      const hip = new THREE.Group();
      hip.rotation.order = 'YZX';
      hip.position.set(side * at[0], at[1], at[2]);
      const twist = new THREE.Group();
      twist.add(new THREE.Mesh(femurGeo, dark));
      hip.add(twist);
      const knee = new THREE.Group();
      knee.position.y = -femurLen;
      knee.add(new THREE.Mesh(tibiaGeo, dark));
      twist.add(knee);
      const ankle = new THREE.Group();
      ankle.position.y = -tibiaLen;
      ankle.add(new THREE.Mesh(tarsusGeo, dark));
      knee.add(ankle);
      const foot = new THREE.Mesh(footGeo, dark);
      foot.position.y = -tarsusLen;
      ankle.add(foot);
      body.add(hip);
      return { hip, twist, knee, ankle, foot, side, name, pose: [...POSES.hover[name], 0] };
    });
  }

  root.traverse((o) => { if (o.isMesh && o.material !== wingMat && o.material !== ghostMat) o.castShadow = true; });
  return { root, body, head, wings, ghostMat, legs };
}

function applyLeg(leg, sway) {
  const [swing, splay, knee, ankle, twist] = leg.pose;
  leg.hip.rotation.set(0, leg.side * swing * DEG, leg.side * splay * DEG);
  leg.twist.rotation.y = leg.side * twist * DEG;
  leg.knee.rotation.z = -leg.side * (knee + sway) * DEG;
  leg.ankle.rotation.z = -leg.side * (ankle + sway * 0.6) * DEG;
}

export class FlyActor {
  constructor(fly, home) {
    this.fly = fly;
    this.home = home.clone();
    this.buzzing = true;
    this.bobbing = true;
    this.flap = 1;
    this.gaze = 0;
    this.shakeYaw = 0;
    this.idleYaw = 0;
    this.yawLock = null; // heading held by an animation; null = face the newest price
    this.turnRate = 5;
    this.allLegs = Object.values(fly.legs).flat();
    fly.root.position.copy(home);
  }

  update(dt, t) {
    const { fly } = this;
    // Wing beat: blurred buzz while airborne, folded back over the abdomen when perched.
    this.flap += ((this.buzzing ? 1 : 0) - this.flap) * Math.min(1, dt * 10);
    const f = this.flap;
    const beat = Math.sin(t * 170);
    for (const w of fly.wings) {
      w.base.rotation.y = -w.side * lerp(1.38, 0.32, f);
      w.live.rotation.z = w.side * lerp(0.05, 0.3 + 0.6 * beat, f);
      w.live.rotation.x = lerp(0, -0.9 + 0.25 * beat, f);
    }
    fly.ghostMat.opacity = 0.1 * f;
    fly.ghostMat.visible = f > 0.05;

    if (this.bobbing) {
      fly.body.position.y = Math.sin(t * 2.2) * 0.07 * f;
      fly.body.rotation.z = Math.sin(t * 1.3) * 0.04 * f;
    }
    const yaw = this.yawLock ?? this.idleYaw;
    fly.root.rotation.y = mixAngle(fly.root.rotation.y, yaw, Math.min(1, dt * this.turnRate));
    const gaze = this.yawLock === null ? this.gaze : 0;
    fly.head.rotation.y += (gaze + this.shakeYaw - fly.head.rotation.y) * Math.min(1, dt * 8);

    // Legs dangle with a slow sway; animations edit leg.pose.
    for (const [i, leg] of this.allLegs.entries()) applyLeg(leg, Math.sin(t * 1.7 + i * 1.3) * 4 * f);
  }

  // Turn body and head towards the newest price point on the screen.
  lookAt(worldX) {
    const { root } = this.fly;
    const toward = Math.atan2(-(worldX - root.position.x), Math.max(1, root.position.z));
    this.idleYaw = clamp(toward, -0.75, 0.75);
    this.gaze = clamp(toward - root.rotation.y, -0.45, 0.45);
  }

  blendLegs(from, to, p) {
    this.allLegs.forEach((leg, i) => mixPose(leg.pose, from[i], to[leg.name], p));
  }

  async flyTo(target, seconds) {
    const { root, body } = this.fly;
    const from = root.position.clone();
    const to = target.clone();
    const goingHome = to.distanceToSquared(this.home) < 1e-6;
    const mid = from.clone().lerp(to, 0.5);
    mid.y += 0.7 + from.distanceTo(to) * 0.08;
    mid.z += 1.6; // bow out towards the viewer, away from the screen
    const curve = new THREE.QuadraticBezierCurve3(from, mid, to);
    const startYaw = root.rotation.y;
    const legsFrom = this.allLegs.map((l) => [...l.pose]);
    const flightLegs = this.allLegs.map((l) => POSES.flight[l.name]);
    const y0 = body.position.y;
    this.buzzing = true;
    this.bobbing = false;
    this.turnRate = 14;
    await tween(seconds, (p, raw) => {
      root.position.copy(curve.getPoint(p));
      const tan = curve.getTangent(clamp(p, 0.02, 0.98));
      const travel = Math.atan2(-tan.x, -tan.z);
      // Turn into the flight path, then settle on the final heading.
      const endYaw = goingHome ? this.idleYaw : 0;
      this.yawLock = mixAngle(mixAngle(startYaw, travel, smoothstep(raw, 0, 0.22)), endYaw, smoothstep(raw, 0.62, 0.95));
      const cruise = Math.sin(Math.PI * raw);
      body.rotation.x = -0.3 * cruise;
      body.rotation.z *= 0.9;
      body.position.y = y0 * (1 - raw);
      // Legs trail during the flight and come back down for the arrival.
      if (raw < 0.5) this.blendLegs(legsFrom, POSES.flight, smoothstep(raw, 0, 0.25));
      else this.blendLegs(flightLegs, POSES.hover, smoothstep(raw, 0.7, 1));
    });
    body.rotation.x = 0;
    this.yawLock = goingHome ? null : 0;
    this.turnRate = 5;
    this.bobbing = true;
  }

  async press() {
    const { body } = this.fly;
    this.bobbing = false;
    const y0 = body.position.y;
    const z0 = body.rotation.z;
    const from = this.allLegs.map((l) => [...l.pose]);
    const target = { ...POSES.brace, front: POSES.reach };
    // Tip nose-down, tuck the other legs and plant both front feet on the cap.
    await tween(0.42, (p) => {
      body.position.y = y0 * (1 - p);
      body.rotation.z = z0 * (1 - p);
      body.rotation.x = PRESS_PITCH * p;
      this.blendLegs(from, target, p);
    });
    // Push in together with the cap (0.2 world units), then ride it back out.
    const push = 0.2 / FLY_SCALE;
    await tween(0.13, (p) => { body.position.z = -push * p; }, ease.out);
    await tween(0.36, (p) => { body.position.z = -push * (1 - p); }, ease.out);
    const pressed = this.allLegs.map((l) => [...l.pose]);
    await tween(0.35, (p) => {
      body.rotation.x = PRESS_PITCH * (1 - p);
      this.blendLegs(pressed, POSES.hover, p);
    });
    this.bobbing = true;
  }

  // Turn towards the viewer and rub the front legs together.
  async groom(seconds) {
    const { body } = this.fly;
    const front = this.fly.legs.front;
    const from = front.map((l) => [...l.pose]);
    const rubbing = Math.max(0.4, seconds - 0.8);
    this.yawLock = FACE_VIEWER;
    await tween(0.4, (p) => {
      body.rotation.x = 0.22 * p;
      front.forEach((l, i) => mixPose(l.pose, from[i], POSES.rub, p));
    });
    await tween(rubbing, (_, raw) => {
      const phase = Math.sin(raw * rubbing * 17);
      front.forEach((l) => {
        l.pose[0] = POSES.rub[0] + 9 * phase * l.side;
        l.pose[2] = POSES.rub[2] - 10 * phase * l.side;
      });
    }, ease.linear);
    const end = front.map((l) => [...l.pose]);
    this.yawLock = null;
    await tween(0.4, (p) => {
      body.rotation.x = 0.22 * (1 - p);
      front.forEach((l, i) => mixPose(l.pose, end[i], POSES.hover.front, p));
    });
  }

  // "No": back off from the button with a head shake and body wiggle (readable from behind).
  async shake() {
    const { root, body } = this.fly;
    this.bobbing = false;
    const z0 = root.position.z;
    await tween(0.9, (_, raw) => {
      const s = Math.sin(raw * Math.PI * 7) * (1 - raw * 0.85);
      root.position.z = z0 + 0.5 * ease.out(Math.min(1, raw * 2.5));
      this.shakeYaw = s * 0.7;
      body.rotation.y = s * 0.42;
      body.rotation.z = s * 0.2;
    }, ease.linear);
    this.shakeYaw = 0;
    body.rotation.y = 0;
    body.rotation.z = 0;
    this.bobbing = true;
  }
}
