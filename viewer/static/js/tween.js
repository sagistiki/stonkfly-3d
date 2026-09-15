// Minimal promise-based tweens driven by the render loop.
const active = [];

export const ease = {
  linear: (p) => p,
  inOut: (p) => (p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2),
  out: (p) => 1 - (1 - p) ** 3,
  outBack: (p) => 1 + 2.7 * (p - 1) ** 3 + 1.7 * (p - 1) ** 2,
};

export function tween(duration, fn, easing = ease.inOut) {
  return new Promise((resolve) => active.push({ t: 0, duration, fn, easing, resolve }));
}

export function wait(seconds) {
  return tween(seconds, () => {});
}

export function updateTweens(dt) {
  for (let i = active.length - 1; i >= 0; i--) {
    const tw = active[i];
    tw.t += dt;
    const p = Math.min(1, tw.t / tw.duration);
    tw.fn(tw.easing(p), p);
    if (p >= 1) {
      active.splice(i, 1);
      tw.resolve();
    }
  }
}
