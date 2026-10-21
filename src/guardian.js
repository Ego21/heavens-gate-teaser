// The keeper of the gate: a gentle guardian who walks lost children through the afterworld.
// Built from output/character-concepts/gothic_ink-v5.png: a knee-length white woven poncho with
// no front opening, a separate white headscarf over his head, shoulders and chest, loose white
// shirt sleeves with wide open ends, white trousers, flat closed leather shoes, snow-white hands,
// and a pale, softly blurred face with nothing discernible on it but a small gentle mouth.
//
// Cloth. Every frame the poncho, scarf, sleeves and trousers are re-shaped on the CPU from their
// rest shape as a pure function of time. There is no simulation state, so scrubbing, Remotion
// and the offline renderer all get the same frame at the same t, whatever the frame rate.
// One wind (direction, strength, gusts) blows on everything. Each piece of cloth feels it
// through its own damped spring (heavy cloth answers later and slower, light cloth sooner),
// with a delay that travels from where the cloth is held toward its free edge, so it lags,
// overshoots and settles. Simple body shapes keep it out of the legs, arms, hands and face.
import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import * as M from './materials.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const clamp01 = (x) => Math.min(1, Math.max(0, x));
const smoothstep = (a, b, x) => { const k = clamp01((x - a) / (b - a)); return k * k * (3 - 2 * k); };
const lerp = (a, b, k) => a + (b - a) * k;
const gauss = (x, w) => Math.exp(-(x * x) / (w * w));
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const ellipseR = (phi, ax, az) => 1 / Math.hypot(Math.sin(phi) / ax, Math.cos(phi) / az);

// deterministic value noise
function hash(n) { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); }
function noise1(x) { const i = Math.floor(x), f = x - i; return lerp(hash(i), hash(i + 1), f * f * (3 - 2 * f)); }
function noise2(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const h = (a, b) => hash(a * 57 + b * 113);
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  return lerp(lerp(h(xi, yi), h(xi + 1, yi), u), lerp(h(xi, yi + 1), h(xi + 1, yi + 1), u), v);
}

// ---------------------------------------------------------------- body layout
// Metres, in his own space: y up, he faces +z, his right hand side is -x.

const HEAD_PIVOT = V(0, 1.7, -0.012); // top of the neck: the head tilts about this point
const HEAD_C = V(0, 1.82, 0); // centre of the skull (the smile shot frames root + (0, 1.82, 0.1))
const HEAD_R = V(0.082, 0.112, 0.097);
const MOUTH_Y = -0.066; // below the skull centre, in the head's own space
const NECK_Y = 1.595; // where the poncho's neckline sits

const ARMS = {
  // reaching out, palm up, toward the child in front of him
  right: { S: V(-0.185, 1.47, -0.01), E: V(-0.3, 1.235, 0.09), W: V(-0.45, 1.13, 0.33), fingers: V(-0.5, -0.1, 0.86), palm: V(0.12, 0.98, 0.1), thumb: 1, curl: 0.22 },
  // hanging relaxed at his side
  left: { S: V(0.185, 1.47, -0.01), E: V(0.29, 1.18, 0.0), W: V(0.36, 0.93, 0.07), fingers: V(0.12, -1, 0.1), palm: V(-1, 0, 0.1), thumb: -1, curl: 0.45 },
};
const LEGS = {
  right: { H: V(-0.095, 0.97, 0), K: V(-0.11, 0.5, 0.045), A: V(-0.12, 0.07, 0.075), yaw: -0.18 },
  left: { H: V(0.095, 0.97, 0), K: V(0.105, 0.5, -0.015), A: V(0.115, 0.07, -0.045), yaw: 0.32 },
};

// where the poncho rests on the raised right forearm, and where the left arm hangs under it
const R_ARM_MID = ARMS.right.E.clone().lerp(ARMS.right.W, 0.55);
const R_ARM_PHI = Math.atan2(R_ARM_MID.x, R_ARM_MID.z);
const R_ARM_SUPPORT = { r: Math.hypot(R_ARM_MID.x, R_ARM_MID.z), y: R_ARM_MID.y + 0.065 };
const L_ARM_MID = ARMS.left.E.clone().lerp(ARMS.left.W, 0.5);
const L_ARM_PHI = Math.atan2(L_ARM_MID.x, L_ARM_MID.z);

// ---------------------------------------------------------------- wind

// World space: blowing toward +x (screen right in the sting), a little away from the camera.
const WIND_DIR = Math.atan2(-0.3, 1);
const GUSTS = Array.from({ length: 48 }, (_, i) => ({
  t: 46 + i * 1.9 + hash(i + 7) * 1.6,
  a: 0.25 + hash(i + 31) * 0.55,
  rise: 0.45 + hash(i + 53) * 0.5,
  fall: 0.9 + hash(i + 71) * 1.3,
}));

// A slow swell, a restless middle, and gusts at irregular times. Returns the wind vector (x, z).
export function windAt(t) {
  let s = 0.5 + 0.16 * Math.sin(t * 0.29 + 1.3) + 0.1 * Math.sin(t * 0.67 + 0.4) + 0.22 * (noise1(t * 0.55) - 0.5);
  for (const g of GUSTS) {
    const x = t - g.t;
    if (x <= 0 || x > g.rise + g.fall * 6) continue;
    s += g.a * (x < g.rise ? smoothstep(0, g.rise, x) : Math.exp(-(x - g.rise) / g.fall));
  }
  s = Math.max(0.05, s);
  const ang = WIND_DIR + 0.22 * Math.sin(t * 0.13 + 0.7) + 0.12 * (noise1(t * 0.31 + 9) - 0.5);
  return { x: Math.cos(ang) * s, z: Math.sin(ang) * s };
}

// How one kind of cloth feels the wind: a damped spring (natural frequency in Hz, damping ratio)
// applied to the wind's recent history, worked out at a few delays (0 .. maxLag seconds) so the
// response can travel from the held edge to the free one.
function windSection({ freq, zeta, maxLag, levels = 6 }) {
  const w = 2 * Math.PI * freq, wd = w * Math.sqrt(1 - zeta * zeta);
  const span = Math.min(4, 5 / (zeta * w));
  const taps = 36;
  const tau = new Float32Array(taps), wt = new Float32Array(taps);
  let sum = 0;
  for (let k = 0; k < taps; k++) {
    const x = ((k + 0.5) * span) / taps;
    tau[k] = x;
    wt[k] = Math.exp(-zeta * w * x) * Math.sin(wd * x);
    sum += wt[k];
  }
  for (let k = 0; k < taps; k++) wt[k] /= sum;
  return { tau, wt, maxLag, R: Array.from({ length: levels }, () => new THREE.Vector3()) };
}

function hearWind(sec, t, toLocal) {
  const L = sec.R.length - 1;
  for (let l = 0; l <= L; l++) {
    const t0 = t - (l / L) * sec.maxLag;
    let x = 0, z = 0;
    for (let k = 0; k < sec.tau.length; k++) {
      const w = windAt(t0 - sec.tau[k]);
      x += w.x * sec.wt[k];
      z += w.z * sec.wt[k];
    }
    sec.R[l].set(x, 0, z).applyQuaternion(toLocal);
  }
}

// ---------------------------------------------------------------- collision shapes
// Each one pushes a point out of a body part with a soft margin, so cloth slides over the body
// instead of snapping onto it.

const SOFT = 0.012;
function pushOut(d, R, s) {
  if (d >= R + s) return d;
  if (d <= R - s) return R;
  const k = R + s - d;
  return d + (k * k) / (4 * s);
}

// tapered capsule from a (radius ra) to b (radius rb)
function capsule(a, b, ra, rb) {
  const ax = a.x, ay = a.y, az = a.z;
  const abx = b.x - ax, aby = b.y - ay, abz = b.z - az;
  const inv = 1 / (abx * abx + aby * aby + abz * abz);
  const pad = Math.max(ra, rb) + SOFT;
  const y0 = Math.min(ay, b.y) - pad, y1 = Math.max(ay, b.y) + pad;
  return (p) => {
    if (p.y < y0 || p.y > y1) return;
    const px = p.x - ax, py = p.y - ay, pz = p.z - az;
    const h = clamp01((px * abx + py * aby + pz * abz) * inv);
    const dx = px - abx * h, dy = py - aby * h, dz = pz - abz * h;
    const R = ra + (rb - ra) * h;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 >= (R + SOFT) * (R + SOFT) || d2 < 1e-12) return;
    const d = Math.sqrt(d2);
    const k = pushOut(d, R, SOFT) / d;
    p.set(ax + abx * h + dx * k, ay + aby * h + dy * k, az + abz * h + dz * k);
  };
}

// The same capsule, but always left outward, away from the body's axis. Cloth is re-shaped from
// its rest shape every frame, so a gust can carry a point deep into an arm; pushing it out by
// the nearest way would flip it to the far side as it crosses the arm's middle. Leaving along
// one fixed direction keeps the answer continuous.
function capsuleOutward(a, b, ra, rb) {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
  const inv = 1 / (abx * abx + aby * aby + abz * abz);
  const pad = Math.max(ra, rb) + SOFT;
  const y0 = Math.min(a.y, b.y) - pad, y1 = Math.max(a.y, b.y) + pad;
  const excess = (x, y, z) => {
    const px = x - a.x, py = y - a.y, pz = z - a.z;
    const h = clamp01((px * abx + py * aby + pz * abz) * inv);
    return ra + (rb - ra) * h + 0.006 - Math.hypot(px - abx * h, py - aby * h, pz - abz * h);
  };
  return (p) => {
    if (p.y < y0 || p.y > y1 || excess(p.x, p.y, p.z) <= 0) return;
    const r = Math.hypot(p.x, p.z) || 1, dx = p.x / r, dz = p.z / r;
    let lo = 0, hi = 0.02;
    while (hi < 0.6 && excess(p.x + dx * hi, p.y, p.z + dz * hi) > 0) { lo = hi; hi += 0.02; }
    for (let k = 0; k < 8; k++) {
      const m = (lo + hi) / 2;
      if (excess(p.x + dx * m, p.y, p.z + dz * m) > 0) lo = m; else hi = m;
    }
    p.x += dx * hi;
    p.z += dz * hi;
  };
}

// the torso as an elliptical column between two heights
function torso(y0, y1, ax, az) {
  return (p) => {
    const w = smoothstep(y0 - 0.04, y0 + 0.02, p.y) * smoothstep(y1 + 0.04, y1 - 0.02, p.y);
    if (w <= 0) return;
    const rho = Math.hypot(p.x / ax, p.z / az);
    if (rho < 1e-6) return;
    const target = pushOut(rho, 1, 0.08);
    if (target === rho) return;
    const k = lerp(1, target / rho, w);
    p.x *= k;
    p.z *= k;
  };
}

function rotateZAbout(p, c, a) {
  if (!a) return;
  const s = Math.sin(a), co = Math.cos(a);
  const x = p.x - c.x, y = p.y - c.y;
  p.x = c.x + x * co - y * s;
  p.y = c.y + x * s + y * co;
}

// the skull, in the head's own (possibly tilted) frame
function headShape(rig) {
  const r = HEAD_R.clone().addScalar(0.014);
  return (p) => {
    rotateZAbout(p, HEAD_PIVOT, -rig.tilt);
    const qx = (p.x - HEAD_C.x) / r.x, qy = (p.y - HEAD_C.y) / r.y, qz = (p.z - HEAD_C.z) / r.z;
    const L = Math.hypot(qx, qy, qz);
    if (L < 1.1 && L > 1e-6) {
      const k = pushOut(L, 1, 0.1) / L;
      p.set(HEAD_C.x + qx * k * r.x, HEAD_C.y + qy * k * r.y, HEAD_C.z + qz * k * r.z);
    }
    rotateZAbout(p, HEAD_PIVOT, rig.tilt);
  };
}

// ---------------------------------------------------------------- cloth

// A grid of cloth vertices plus what the wind needs to know about each one. `point(u, v, i, j)`
// returns the rest position and: out (direction the cloth faces away from what it hangs on),
// F (0 = held, 1 = free), q (0..1 how far the wind's delay has travelled), s (metres from where
// it is held), hemDist (metres to the hem), sideEdges (first/last column are free edges),
// attach (0..1 how much it is carried by the head).
class Cloth {
  constructor(nu, nv, point, { material, section, push, lift, billow = 0, ripple, k1, w1, k2, w2, seed = 0 }) {
    Object.assign(this, { nu, nv, section, push, lift, billow, ripple, k1, w1, k2, w2, seed });
    const n = (nu + 1) * (nv + 1);
    this.rest = new Float32Array(n * 3);
    this.out = new Float32Array(n * 3);
    this.F = new Float32Array(n);
    this.q = new Float32Array(n);
    this.s = new Float32Array(n);
    this.attach = new Float32Array(n);
    this.lat = new Float32Array(n);
    const hemDist = new Float32Array(n);
    const sideEdges = new Uint8Array(n);
    for (let j = 0; j <= nv; j++) {
      for (let i = 0; i <= nu; i++) {
        const v = j * (nu + 1) + i;
        const o = point(i / nu, j / nv, i, j);
        this.rest.set([o.x, o.y, o.z], v * 3);
        this.out.set([o.ox, o.oy ?? 0, o.oz], v * 3);
        this.F[v] = o.F;
        this.q[v] = o.q;
        this.s[v] = o.s;
        this.attach[v] = o.attach ?? 0;
        hemDist[v] = o.hemDist;
        sideEdges[v] = o.sideEdges ? 1 : 0;
      }
    }
    this._hemDist = hemDist;
    this._sideEdges = sideEdges;
    const index = [];
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        const a = j * (nu + 1) + i, b = a + 1, c = a + nu + 1, d = c + 1;
        index.push(a, c, b, b, c, d);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setIndex(index);
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.rest.slice(), 3));
    this.geo = geo;
    this.mesh = new THREE.Mesh(geo, material);
    this.collide = [];
  }

  // Resolve the rest shape against the body once, then derive the pattern coordinates from it.
  settle() {
    const p = new THREE.Vector3();
    const { rest, nu, nv } = this;
    for (let v = 0; v < this.F.length; v++) {
      p.fromArray(rest, v * 3);
      for (let pass = 0; pass < 2; pass++) for (const c of this.collide) c(p, v);
      p.toArray(rest, v * 3);
      // noise coordinate taken from the rest position, so seams and poles stay closed
      this.lat[v] = p.x * 2.3 + p.z * 1.1 + p.y * 0.4;
    }
    // cloth lying on something (the scarf on the shoulders) barely slides: it lifts at the edges
    for (const c of this.collide) {
      const lying = c.freeze?.(rest);
      if (lying) for (let v = 0; v < this.F.length; v++) this.F[v] *= 1 - 0.85 * lying[v];
    }
    // uv in metres along rows (x) and columns (y)
    const uvs = new Float32Array(this.F.length * 2);
    const len = (a, b) => Math.hypot(rest[a * 3] - rest[b * 3], rest[a * 3 + 1] - rest[b * 3 + 1], rest[a * 3 + 2] - rest[b * 3 + 2]);
    for (let j = 0; j <= nv; j++) {
      for (let i = 1; i <= nu; i++) {
        const v = j * (nu + 1) + i;
        uvs[v * 2] = uvs[(v - 1) * 2] + len(v, v - 1);
      }
    }
    for (let j = 1; j <= nv; j++) {
      for (let i = 0; i <= nu; i++) {
        const v = j * (nu + 1) + i;
        uvs[v * 2 + 1] = uvs[(v - nu - 1) * 2 + 1] + len(v, v - nu - 1);
      }
    }
    const edge = new Float32Array(this.F.length * 2);
    for (let j = 0; j <= nv; j++) {
      const rowLen = uvs[(j * (nu + 1) + nu) * 2];
      for (let i = 0; i <= nu; i++) {
        const v = j * (nu + 1) + i;
        const um = uvs[v * 2], vm = uvs[v * 2 + 1];
        const side = this._sideEdges[v] ? Math.min(um, rowLen - um) : 1e3;
        const hem = this._hemDist[v];
        edge[v * 2] = Math.min(side, hem);
        edge[v * 2 + 1] = side < hem ? vm : um;
      }
    }
    this.geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    this.geo.setAttribute('edgeInfo', new THREE.Float32BufferAttribute(edge, 2));
    this.geo.attributes.position.array.set(rest);
    this.geo.computeVertexNormals();
    this.geo.computeBoundingSphere();
    this.geo.boundingSphere.radius += 0.35; // room for the wind
    // vertices that share a rest position (seams, the crown of the scarf) share a normal
    const groups = new Map();
    for (let v = 0; v < this.F.length; v++) {
      const key = `${Math.round(rest[v * 3] * 1e5)},${Math.round(rest[v * 3 + 1] * 1e5)},${Math.round(rest[v * 3 + 2] * 1e5)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(v);
    }
    this.welds = [...groups.values()].filter((g) => g.length > 1);
    this.weld();
    delete this._hemDist;
    delete this._sideEdges;
    return this;
  }

  weld() {
    const nrm = this.geo.attributes.normal.array;
    for (const g of this.welds) {
      let x = 0, y = 0, z = 0;
      for (const v of g) { x += nrm[v * 3]; y += nrm[v * 3 + 1]; z += nrm[v * 3 + 2]; }
      const l = Math.hypot(x, y, z) || 1;
      for (const v of g) nrm.set([x / l, y / l, z / l], v * 3);
    }
  }

  update(t, rig) {
    const { rest, out, F, q, s, lat, attach, push, lift, billow, ripple, k1, w1, k2, w2, seed } = this;
    const R = this.section.R, L = R.length - 1;
    const pos = this.geo.attributes.position.array;
    const p = this._p || (this._p = new THREE.Vector3());
    for (let v = 0, n = F.length; v < n; v++) {
      const i3 = v * 3;
      p.set(rest[i3], rest[i3 + 1], rest[i3 + 2]);
      // the part of the scarf that sits on the head turns with the head
      if (attach[v] > 0 && rig.tilt) rotateZAbout(p, HEAD_PIVOT, rig.tilt * attach[v]);
      const f = F[v];
      if (f > 0) {
        const lv = q[v] * L, l0 = Math.min(L - 1, Math.floor(lv)), fr = lv - l0;
        const rx = R[l0].x + (R[l0 + 1].x - R[l0].x) * fr;
        const rz = R[l0].z + (R[l0 + 1].z - R[l0].z) * fr;
        const mag = Math.hypot(rx, rz);
        const ox = out[i3], oy = out[i3 + 1], oz = out[i3 + 2];
        const lee = mag > 1e-5 ? (ox * rx + oz * rz) / mag : 0; // +1 on the side the wind leaves from
        const fp = Math.pow(f, 1.4);
        // carried downwind; the leeward side fills out; free edges lift in the gusts
        p.x += rx * push * fp + ox * billow * fp * mag * Math.max(0, lee);
        p.z += rz * push * fp + oz * billow * fp * mag * Math.max(0, lee);
        p.y += lift * f * f * mag * (0.55 + 0.45 * lee);
        // ripples running away from where the cloth is held, never quite repeating
        const la = lat[v];
        const ph1 = k1 * s[v] - w1 * t + 2.4 * noise2(la * 3 + seed, t * 0.21);
        const ph2 = k2 * s[v] + 7 * la - w2 * t + 1.9 * noise2(la * 5 + 40 + seed, t * 0.33 + 5);
        const rip = ripple * f * (0.25 + mag) * (0.62 * Math.sin(ph1) + 0.38 * Math.sin(ph2));
        p.x += ox * rip;
        p.y += oy * rip;
        p.z += oz * rip;
      }
      for (const c of this.collide) c(p, v);
      pos[i3] = p.x;
      pos[i3 + 1] = p.y;
      pos[i3 + 2] = p.z;
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.computeVertexNormals();
    this.weld();
    this.frame = t; // lets other cloth know this one has moved
  }
}

// ---------------------------------------------------------------- poncho
// One continuous sheet from the neckline: over the shoulders, over the raised right forearm like
// a wing, and down to the knees. Its sides ride up where the arms come out from under it.

const PON = { nu: 180, nv: 96 };

function ponchoColumn(phi) {
  const sp = Math.sin(phi), cp = Math.cos(phi);
  const gR = gauss(wrapAngle(phi - R_ARM_PHI), 0.5);
  const gL = gauss(wrapAngle(phi - L_ARM_PHI), 0.42);
  const rN = ellipseR(phi, 0.118, 0.104);
  let rS = ellipseR(phi, 0.255, 0.175), yS = 1.5 - 0.03 * sp * sp;
  rS = lerp(rS, R_ARM_SUPPORT.r, gR);
  yS = lerp(yS, R_ARM_SUPPORT.y, gR);
  const n = noise2(cp * 1.3 + 3, sp * 1.3 + 7) - 0.5;
  let yH = 0.585 - 0.03 * Math.cos(2 * phi) + 0.04 * n;
  yH = lerp(yH, yS - 0.02, smoothstep(0.35, 0.95, gR));
  yH = lerp(yH, 1.04, smoothstep(0.3, 0.95, gL));
  const rH = rS + lerp(lerp(0.11, 0.07, sp * sp), 0.02, gR) + 0.03 * gL;
  // profile in (radius, height): a rounded shoulder, then the drop
  const prof = [];
  const cR = rS * 0.7, cY = NECK_Y + 0.004;
  for (let k = 0; k <= 20; k++) {
    const t = k / 20, a = (1 - t) * (1 - t), b = 2 * (1 - t) * t, c = t * t;
    prof.push([a * rN + b * cR + c * rS, a * NECK_Y + b * cY + c * yS]);
  }
  for (let k = 1; k <= 60; k++) {
    const t = k / 60;
    prof.push([lerp(rS, rH, t) + 0.022 * Math.sin(Math.PI * t) * (1 - gR), lerp(yS, yH, t)]);
  }
  const arc = [0];
  for (let k = 1; k < prof.length; k++) arc.push(arc[k - 1] + Math.hypot(prof[k][0] - prof[k - 1][0], prof[k][1] - prof[k - 1][1]));
  return { prof, arc, total: arc[arc.length - 1], support: arc[20], gR, gL, sp, cp };
}

function ponchoPoint(col, phi, v) {
  const { prof, arc, total, support, gR, gL, sp, cp } = col;
  const s = v * total;
  let k = 1;
  while (k < arc.length - 1 && arc[k] < s) k++;
  const f = (s - arc[k - 1]) / (arc[k] - arc[k - 1] || 1);
  let r = lerp(prof[k - 1][0], prof[k][0], f);
  let y = lerp(prof[k - 1][1], prof[k][1], f);
  const sd = s - support; // metres below where the cloth is held
  const drop = Math.max(0.05, total - support);
  const dropFrac = clamp01(sd / drop);
  // folds falling from the shoulders, deeper toward the hem, uneven around the body
  const A = 0.046 * Math.pow(dropFrac, 0.8) * clamp01(drop / 0.8) * (1 - 0.6 * Math.max(gR, gL));
  const fph = 9 * phi + 2.6 * (noise2(cp * 2.1 + 11, sp * 2.1 + 5) - 0.5) * 2 + Math.max(0, sd) * 1.2;
  const deep = 0.6 + 0.8 * noise2(cp * 3.3 + 1, sp * 3.3 + 2); // some folds deeper than others
  r += A * deep * Math.sin(fph) + 0.026 * dropFrac * Math.sin(3 * phi + 1.1) + 0.012 * dropFrac * Math.sin(5 * phi + 2.3);
  y += 0.35 * A * Math.cos(fph) * dropFrac;
  return {
    x: sp * r, y, z: cp * r, ox: sp, oy: 0, oz: cp,
    F: smoothstep(0, 0.75, sd), q: clamp01(sd / 0.8), s: Math.max(0, sd), hemDist: total - s, sideEdges: false,
  };
}

function buildPoncho(material, section) {
  const cols = [];
  const cloth = new Cloth(PON.nu, PON.nv, (u, v, i) => {
    const phi = -Math.PI + u * 2 * Math.PI;
    cols[i] ??= ponchoColumn(phi);
    return ponchoPoint(cols[i], phi, v);
  }, { material, section, push: 0.17, lift: 0.08, billow: 0.06, ripple: 0.028, k1: 9, w1: 3.1, k2: 17, w2: 4.7, seed: 1 });
  // the row where each column stops resting on the shoulder (or the raised arm) and hangs
  cloth.supportRow = cols.map((c) => Math.round((c.support / c.total) * PON.nv));
  return cloth;
}

// The scarf has to stay outside the poncho. Once per poncho update the poncho is tabulated per
// column two ways: its radius at each centimetre of height (where it hangs), and its height at
// each half centimetre of radius over the shoulders (where it lies nearly flat). Each scarf point
// keeps the relation it has at rest: if it lies on a shoulder it is held on top, if it hangs
// beside the poncho it is held outside. (Choosing per frame by whichever exit is nearer makes
// points pushed deep by a gust flip between the two and jump.) Both tables are read with
// bilinear interpolation so the answer changes smoothly.
const TAB_DY = 0.01, TAB_N = 70; // radius table: from the neckline down 70 cm
const TAB_R0 = 0.1, TAB_DR = 0.005, TAB_NR = 80; // shoulder table: radius 10 .. 50 cm
const MARGIN = 0.012;
function outsidePoncho(poncho) {
  const { nu, nv } = PON;
  const radius = new Float32Array((nu + 1) * TAB_N), coverage = new Float32Array((nu + 1) * TAB_N);
  const top = new Float32Array((nu + 1) * TAB_NR);
  const ringR = new Float32Array(nu + 1), edgeR = new Float32Array(nu + 1);
  const mode = new Float32Array(1 << 16).fill(-1); // per scarf vertex: 1 lies on top, 0 hangs outside
  let built = -1;
  function build() {
    const pos = poncho.geo.attributes.position.array;
    const P = (i, j) => (j * (nu + 1) + i) * 3;
    for (let i = 0; i <= nu; i++) {
      let j = 1;
      for (let l = 0; l < TAB_N; l++) {
        const y = NECK_Y - l * TAB_DY;
        while (j <= nv && pos[P(i, j) + 1] > y) j++;
        let r, c = 1;
        if (j <= nv) {
          const a = P(i, j - 1), b = P(i, j);
          const f = clamp01((pos[a + 1] - y) / (pos[a + 1] - pos[b + 1] || 1));
          r = lerp(Math.hypot(pos[a], pos[a + 2]), Math.hypot(pos[b], pos[b + 2]), f);
        } else {
          // below this column's hem: the cloth fades out over a few centimetres, so a hem
          // lifting past a scarf point lets go of it smoothly
          const h = P(i, nv);
          r = Math.hypot(pos[h], pos[h + 2]);
          c = smoothstep(0.04, 0, pos[h + 1] - y);
        }
        radius[i * TAB_N + l] = r;
        coverage[i * TAB_N + l] = c;
      }
      // over the shoulders: from the neckline out to where the cloth stops moving outward
      // (the shoulder's edge). Inside the neckline it reads as a flat lid; past the edge it
      // falls away steeply, so a point blown off the shoulder slides down instead of jumping.
      const ring = Math.hypot(pos[P(i, 0)], pos[P(i, 0) + 2]);
      // the shoulder's edge is the row the poncho was built to rest on there, always the same
      // row: re-finding it on the moving poncho would make it hop and the scarf jump with it
      const e = poncho.supportRow[i];
      const rEdge = Math.hypot(pos[P(i, e)], pos[P(i, e) + 2]), yEdge = pos[P(i, e) + 1];
      ringR[i] = ring;
      edgeR[i] = rEdge;
      j = 1;
      for (let l = 0; l < TAB_NR; l++) {
        const r = TAB_R0 + l * TAB_DR;
        let y;
        if (r <= ring) y = NECK_Y;
        else if (r >= rEdge) y = yEdge - (r - rEdge) * 3;
        else {
          while (j < e && Math.hypot(pos[P(i, j)], pos[P(i, j) + 2]) < r) j++;
          const a = P(i, j - 1), b = P(i, j);
          const ra = Math.hypot(pos[a], pos[a + 2]), rb = Math.hypot(pos[b], pos[b + 2]);
          y = lerp(pos[a + 1], pos[b + 1], clamp01((r - ra) / (rb - ra || 1)));
        }
        top[i * TAB_NR + l] = y;
      }
    }
    built = poncho.frame;
  }
  // bilinear read; NaN where any corner has no data (a negative entry)
  const bilerp = (tab, n, i0, fu, fl) => {
    const l0 = Math.floor(fl), fv = fl - l0;
    const a = tab[i0 * n + l0], b = tab[(i0 + 1) * n + l0], c = tab[i0 * n + l0 + 1], d = tab[(i0 + 1) * n + l0 + 1];
    if (a < 0 || b < 0 || c < 0 || d < 0) return NaN;
    return lerp(lerp(a, b, fu), lerp(c, d, fu), fv);
  };
  const where = (p) => {
    const rr = Math.hypot(p.x, p.z);
    const fi = ((Math.atan2(p.x, p.z) + Math.PI) / (2 * Math.PI)) * nu;
    const i0 = Math.min(nu - 1, Math.floor(fi)), fu = fi - i0;
    const flr = clamp01((rr - TAB_R0) / TAB_DR / (TAB_NR - 1.001)) * (TAB_NR - 1.001);
    return { rr, i0, fu, yTop: bilerp(top, TAB_NR, i0, fu, flr) };
  };
  const collide = (p, v) => {
    if (built !== poncho.frame) build();
    const { rr, i0, fu, yTop } = where(p);
    if (rr < 1e-6) return;
    let w = mode[v];
    if (w < 0) {
      // while the rest shape is still settling: leave by the nearer way
      const fl = (NECK_Y - p.y) / TAB_DY;
      const rp = fl >= 0 && fl < TAB_N - 1 ? bilerp(radius, TAB_N, i0, fu, fl) + MARGIN : 0;
      w = smoothstep(-0.006, 0.006, (rp - rr) - (yTop + MARGIN - p.y)) * smoothstep(lerp(ringR[i0], ringR[i0 + 1], fu), lerp(ringR[i0], ringR[i0 + 1], fu) + 0.015, rr);
    }
    // lying on top: keep above the shoulder
    let ny = p.y;
    if (w > 0 && p.y < yTop + MARGIN + 0.01) ny = yTop + MARGIN + pushOut(p.y - yTop - MARGIN + 1, 1, 0.008) - 1;
    // hanging: keep outside the drape (fading in just under the neckline, where the hole for the neck is)
    let nr = rr;
    const fl = (NECK_Y - p.y) / TAB_DY;
    if (w < 1 && fl >= 0 && fl < TAB_N - 1) {
      // below the poncho's hem (it rides up by the arms, and lifts in the wind) the push fades
      // with how much poncho is really there, instead of jumping
      const cover = bilerp(coverage, TAB_N, i0, fu, fl);
      if (cover > 1e-4) {
        const rp = bilerp(radius, TAB_N, i0, fu, fl) + MARGIN;
        if (rr < rp + 0.01) nr = lerp(rr, pushOut(rr, rp, 0.01), smoothstep(NECK_Y, NECK_Y - 0.03, p.y) * cover);
      }
    }
    const k = lerp(nr, rr, w) / rr;
    p.x *= k;
    p.z *= k;
    p.y = lerp(p.y, ny, w);
  };
  // once the scarf has settled: which of its points lie on a shoulder, which hang beside it
  collide.freeze = (rest) => {
    const p = new THREE.Vector3();
    for (let v = 0; v < rest.length / 3; v++) {
      p.fromArray(rest, v * 3);
      const { rr, i0, fu, yTop } = where(p);
      const ring = lerp(ringR[i0], ringR[i0 + 1], fu), edge = lerp(edgeR[i0], edgeR[i0 + 1], fu);
      mode[v] = smoothstep(ring, ring + 0.015, rr) * smoothstep(edge + 0.01, edge - 0.01, rr) * smoothstep(yTop - 0.02, yTop + 0.005, p.y);
    }
    return mode;
  };
  return collide;
}

// ---------------------------------------------------------------- headscarf
// A separate square of cloth laid over the head: it follows the skull down to about the jaw,
// leaves an opening for the face, then falls free over the shoulders, chest and back. The
// two front ends hang to points on the chest, his left one longer.

const SC = { nu: 136, nv: 110, headRows: 30 };
const SC_C = V(0, 1.828, -0.006);
const SC_R = V(0.1, 0.13, 0.116);
const SC_RM = 0.118; // metres of cloth per radian on the dome
const BROW_E = 0.36; // elevation of the front edge over the brow
const FACE_PHI = 0.8; // half-width of the face opening, radians around the head
const V_BROW = (Math.PI / 2 - BROW_E) * SC_RM;
const V_HEAD = V_BROW + 0.06; // rows above this are shared by every column
const contactE = (phi) => lerp(-0.3, -0.58, (1 + Math.cos(phi)) / 2); // where it leaves the head
// how low each part of the hem hangs (u: 0 his left front edge, around the back, 1 his right
// front edge): long pointed ends down the chest, his left one to the waist, and a long back
const SCARF_HEM = [[0, 1.1], [0.05, 0.96], [0.15, 1.12], [0.27, 1.17], [0.5, 1.02], [0.73, 1.17], [0.85, 1.12], [0.95, 1.05], [1, 1.13]];

function keyed(keys, x) {
  for (let i = 0; i < keys.length - 1; i++) {
    if (x <= keys[i + 1][0]) return lerp(keys[i][1], keys[i + 1][1], smoothstep(keys[i][0], keys[i + 1][0], x));
  }
  return keys[keys.length - 1][1];
}

function scarfShell(phi, e, out) {
  const ce = Math.cos(e), se = Math.sin(e), sp = Math.sin(phi), cp = Math.cos(phi);
  const puff = 1 + 0.035 * (noise2(cp * 1.7 + 3, sp * 1.7 + e * 2.2) - 0.5);
  const brim = 0.01 * Math.pow(Math.max(0, cp), 6) * gauss(e - BROW_E - 0.05, 0.22); // stands off the brow
  return out.set(SC_C.x + SC_R.x * ce * sp * puff, SC_C.y + SC_R.y * se * puff, SC_C.z + SC_R.z * ce * cp * puff + brim);
}

// Cloth length of one column: over the head to where it leaves it, then as far along its
// drape over the shoulders as it takes to reach that column's hem height.
function scarfLength(u) {
  const phi = FACE_PHI + u * (2 * Math.PI - 2 * FACE_PHI);
  const ec = contactE(phi);
  const c = scarfShell(phi, ec, new THREE.Vector3());
  let az = Math.atan2(c.x, c.z);
  az *= 1 - 0.4 * Math.pow(Math.max(0, Math.cos(az)), 1.5);
  const rc = Math.hypot(c.x, c.z), target = keyed(SCARF_HEM, u);
  // ...but never past the shoulder: over the raised right arm it stops where the shoulder ends
  // instead of running out along the forearm
  const overArm = gauss(wrapAngle(az - R_ARM_PHI), 0.5) > 0.45;
  let h = 0.02;
  for (; h < 1.2; h += 0.005) {
    const [r, y] = alongDrape(az, rc, c.y, h);
    if (y <= target || (overArm && r >= 0.3)) break;
  }
  return (Math.PI / 2 - ec) * SC_RM + h;
}

// Below the head the scarf lies on the poncho: this is the poncho's profile at one azimuth,
// lifted off it by the cloth's thickness, as (radius, height) points from the neckline down.
const SC_OFF = 0.018;
const drapeCache = new Map();
function drapeProfile(phi) {
  const key = Math.round(wrapAngle(phi) * 200);
  let Q = drapeCache.get(key);
  if (Q) return Q;
  const { prof } = ponchoColumn(key / 200);
  Q = prof.map(([r, y], k) => {
    const a = prof[Math.max(0, k - 1)], b = prof[Math.min(prof.length - 1, k + 1)];
    const tr = b[0] - a[0], ty = b[1] - a[1], l = Math.hypot(tr, ty) || 1;
    return [r - (ty / l) * SC_OFF, y + (tr / l) * SC_OFF];
  });
  drapeCache.set(key, Q);
  return Q;
}

// Where cloth that leaves the head at (rc, yc) is after falling h metres: straight down until it
// meets the poncho (or over the neckline's lip, if it starts inside the neck opening), then along
// the poncho's surface, and straight down again past its hem.
function alongDrape(phi, rc, yc, h) {
  const Q = drapeProfile(phi);
  let entry = null, ek = 0;
  if (rc <= Q[0][0]) entry = Q[0];
  else {
    for (let k = 0; k < Q.length - 1; k++) {
      const [r0, y0] = Q[k], [r1, y1] = Q[k + 1];
      if ((r0 - rc) * (r1 - rc) <= 0 && r1 !== r0) {
        const f = (rc - r0) / (r1 - r0), ye = y0 + (y1 - y0) * f;
        if (ye <= yc) { entry = [rc, ye]; ek = k; }
        break;
      }
    }
  }
  if (!entry) return [rc, yc - h];
  const first = Math.hypot(entry[0] - rc, entry[1] - yc);
  if (h <= first) { const f = h / (first || 1); return [lerp(rc, entry[0], f), lerp(yc, entry[1], f)]; }
  let left = h - first, cur = entry;
  for (let k = ek; k < Q.length - 1; k++) {
    const nxt = Q[k + 1], seg = Math.hypot(nxt[0] - cur[0], nxt[1] - cur[1]);
    if (seg >= left) { const f = left / (seg || 1); return [lerp(cur[0], nxt[0], f), lerp(cur[1], nxt[1], f)]; }
    left -= seg;
    cur = nxt;
  }
  return [cur[0], cur[1] - left];
}

function buildScarf(material, section) {
  const c = new THREE.Vector3();
  return new Cloth(SC.nu, SC.nv, (u, v, i, j) => {
    const Lm = scarfLength(u);
    const vm = j <= SC.headRows ? (j / SC.headRows) * V_HEAD : V_HEAD + ((j - SC.headRows) / (SC.nv - SC.headRows)) * (Lm - V_HEAD);
    const open = smoothstep(V_BROW - 0.035, V_BROW + 0.025, vm) * FACE_PHI;
    const phi = open + u * (2 * Math.PI - 2 * open);
    const ec = contactE(phi);
    const e = Math.PI / 2 - vm / SC_RM;
    const h = Math.max(0, (ec - e) * SC_RM); // metres hanging below where it leaves the head
    scarfShell(phi, Math.max(e, ec), c);
    let az = Math.atan2(c.x, c.z);
    if (h > 0) {
      // falls onto the poncho; the front ends close in under the chin toward the chest
      const front = Math.pow(Math.max(0, Math.cos(az)), 1.5);
      az *= 1 - 0.4 * front * smoothstep(0, 0.1, h);
      const [r, y] = alongDrape(az, Math.hypot(c.x, c.z), c.y, h);
      c.set(Math.sin(az) * r, y, Math.cos(az) * r);
    }
    const sp = Math.sin(az), cp = Math.cos(az);
    return {
      x: c.x, y: c.y, z: c.z, ox: sp, oy: 0, oz: cp,
      F: smoothstep(0, 0.3, h), q: clamp01(h / 0.75), s: h, attach: 1 - smoothstep(0, 0.1, h),
      hemDist: Lm - vm, sideEdges: open > 0.005,
    };
  }, { material, section, push: 0.1, lift: 0.04, billow: 0.03, ripple: 0.016, k1: 15, w1: 5.3, k2: 26, w2: 7.9, seed: 5 });
}

// ---------------------------------------------------------------- sleeves
// Loose shirt sleeves: anchored at the shoulder, widening to a wide open end at the wrist,
// the spare cloth hanging below the arm.

function sleeveFrames(arm) {
  const fwd = arm.W.clone().sub(arm.E).normalize();
  const end = arm.W.clone().addScaledVector(fwd, -0.005);
  const curve = new THREE.CatmullRomCurve3([arm.S, arm.E, end], false, 'centripetal');
  const len = curve.getLength();
  const at = (s) => {
    const c = curve.getPointAt(s), T = curve.getTangentAt(s);
    const down = V(0, -1, 0).addScaledVector(T, T.y); // gravity, across the arm
    if (down.lengthSq() < 0.04) down.set(0, 0, 1).addScaledVector(T, -T.z);
    const N1 = down.normalize(), N2 = new THREE.Vector3().crossVectors(T, N1);
    const r = 0.058 + 0.012 * s + 0.055 * Math.pow(smoothstep(0.45, 1, s), 1.3);
    const armR = lerp(0.05, 0.034, s);
    const sag = (r - armR) * 0.8 * Math.sqrt(1 - T.y * T.y); // a hanging arm's sleeve barely sags
    return { c, N1, N2, r, sag, centre: c.clone().addScaledVector(N1, sag) };
  };
  return { at, len };
}

function buildSleeve(arm, material, section, seed) {
  const { at, len } = sleeveFrames(arm);
  const frames = [];
  const cloth = new Cloth(36, 44, (u, v, i, j) => {
    const fr = (frames[j] ??= at(v));
    const a = u * Math.PI * 2;
    const r = fr.r * (1 + 0.07 * v * Math.sin(a * 5 + v * 6 + seed));
    const ox = fr.N1.x * Math.cos(a) + fr.N2.x * Math.sin(a);
    const oy = fr.N1.y * Math.cos(a) + fr.N2.y * Math.sin(a);
    const oz = fr.N1.z * Math.cos(a) + fr.N2.z * Math.sin(a);
    const bottom = (1 + Math.cos(a)) / 2; // the hanging underside is freest
    return {
      x: fr.centre.x + ox * r, y: fr.centre.y + oy * r, z: fr.centre.z + oz * r, ox, oy, oz,
      F: Math.pow(smoothstep(0.15, 1, v), 1.2) * (0.55 + 0.45 * bottom), q: v, s: v * len, hemDist: (1 - v) * len, sideEdges: false,
    };
  }, { material, section, push: 0.035, lift: 0.012, billow: 0.012, ripple: 0.008, k1: 20, w1: 6.1, k2: 31, w2: 8.3, seed });
  // what the poncho has to stay outside of
  // what the poncho has to stay outside of (hull), and the same for the scarf's free ends,
  // which are pushed outward only (hullOutward, see capsuleOutward)
  const hull = [], hullOutward = [];
  const ss = [0, 0.3, 0.6, 0.8, 1];
  for (let k = 0; k < ss.length - 1; k++) {
    const a = at(ss[k]), b = at(ss[k + 1]);
    hull.push(capsule(a.centre, b.centre, a.r * 1.07 + 0.006, b.r * 1.07 + 0.006));
    hullOutward.push(capsuleOutward(a.centre, b.centre, a.r * 1.07, b.r * 1.07));
  }
  return { cloth, hull, hullOutward };
}

// ---------------------------------------------------------------- trousers

function buildTrouser(leg, material, section, seed) {
  const curve = new THREE.CatmullRomCurve3([leg.H, leg.K, leg.A.clone().setY(0.05)], false, 'centripetal');
  const len = curve.getLength();
  const fwd = V(Math.sin(leg.yaw), 0, Math.cos(leg.yaw));
  const frames = [];
  return new Cloth(30, 44, (u, v, i, j) => {
    const fr = (frames[j] ??= (() => {
      const c = curve.getPointAt(v), T = curve.getTangentAt(v);
      const N1 = fwd.clone().addScaledVector(T, -fwd.dot(T)).normalize();
      return { c, N1, N2: new THREE.Vector3().crossVectors(T, N1) };
    })());
    const a = u * Math.PI * 2;
    const ox = fr.N1.x * Math.cos(a) + fr.N2.x * Math.sin(a);
    const oy = fr.N1.y * Math.cos(a) + fr.N2.y * Math.sin(a);
    const oz = fr.N1.z * Math.cos(a) + fr.N2.z * Math.sin(a);
    // loose and straight, a soft crease at the knee and a break over the shoe
    let r = lerp(0.092, 0.079, v) * (1 + 0.035 * Math.sin(a * 4 + v * 5 + seed));
    r *= 1 + 0.02 * Math.sin(v * 60) * gauss(v - 0.5, 0.08) + 0.04 * Math.sin(a * 3 + seed) * smoothstep(0.85, 1, v);
    const back = (1 - Math.cos(a)) / 2; // the hem dips at the heel
    return {
      x: fr.c.x + ox * r, y: fr.c.y + oy * r - 0.015 * back * smoothstep(0.95, 1, v), z: fr.c.z + oz * r, ox, oy, oz,
      F: smoothstep(0.35, 1, v) * 0.8, q: v, s: v * len, hemDist: (1 - v) * len, sideEdges: false,
    };
  }, { material, section, push: 0.012, lift: 0.004, billow: 0.008, ripple: 0.003, k1: 25, w1: 7.3, k2: 40, w2: 9.7, seed });
}

// ---------------------------------------------------------------- hands, shoes, body

// Tube along a curve with radius radiusFn(u).
function tube(points, radiusFn, tubular = 12, radial = 8) {
  const curve = new THREE.CatmullRomCurve3(points);
  const geo = new THREE.TubeGeometry(curve, tubular, 1, radial, false);
  const pos = geo.attributes.position;
  const c = new THREE.Vector3(), v = new THREE.Vector3();
  for (let i = 0; i <= tubular; i++) {
    curve.getPointAt(i / tubular, c);
    for (let j = 0; j <= radial; j++) {
      const k = i * (radial + 1) + j;
      v.fromBufferAttribute(pos, k).sub(c).multiplyScalar(radiusFn(i / tubular)).add(c);
      pos.setXYZ(k, v.x, v.y, v.z);
    }
  }
  geo.computeVertexNormals();
  return geo;
}

// A hand in its own frame: wrist at the origin, fingers along +y, palm facing +z, thumb on the
// +x side (thumb = 1) or the -x side (thumb = -1). curl 0..1 bends the fingers into the palm.
function handGeometry(thumb, curl) {
  const parts = [];
  const palm = new THREE.SphereGeometry(1, 20, 14);
  palm.scale(0.04, 0.052, 0.014).translate(0, 0.05, 0);
  parts.push(palm);
  const wrist = new THREE.CylinderGeometry(0.023, 0.025, 0.07, 14, 1, true);
  wrist.scale(1, 1, 0.7).translate(0, -0.012, 0);
  parts.push(wrist);
  // index nearest the thumb
  [[0.026, 0.078, 0.0088], [0.009, 0.086, 0.0092], [-0.009, 0.081, 0.009], [-0.026, 0.065, 0.0082]].forEach(([x, L, r], k) => {
    const pts = [V(x * thumb, 0.088, 0.002)];
    let dir = V(x * thumb * 0.6, 1, 0).normalize();
    const bend = curl * (0.5 + k * 0.08);
    for (const seg of [0.45, 0.3, 0.25]) {
      dir.applyAxisAngle(V(1, 0, 0), bend).normalize(); // rotates +y toward +z: into the palm
      pts.push(pts[pts.length - 1].clone().addScaledVector(dir, L * seg));
    }
    parts.push(tube(pts, (u) => r * (1 - u * 0.35), 10, 7));
  });
  const tb = V(0.03 * thumb, 0.022, 0.008);
  const td = V(0.75 * thumb, 0.62, 0.3).normalize();
  const tpts = [tb, tb.clone().addScaledVector(td, 0.028)];
  td.applyAxisAngle(V(0, 1, 0), -0.4 * thumb * curl).add(V(0, 0, 0.2 * curl)).normalize();
  tpts.push(tpts[1].clone().addScaledVector(td, 0.03));
  parts.push(tube(tpts, (u) => 0.0115 * (1 - u * 0.35), 10, 7));
  return mergeGeometries(parts.map((g) => g.toNonIndexed()));
}

function placeHand(arm, skin) {
  const Y = arm.fingers.clone().normalize();
  const Z = arm.palm.clone().addScaledVector(Y, -arm.palm.dot(Y)).normalize();
  const X = new THREE.Vector3().crossVectors(Y, Z);
  const hand = new THREE.Mesh(handGeometry(arm.thumb, arm.curl), skin);
  hand.matrixAutoUpdate = false;
  hand.matrix.makeBasis(X, Y, Z).setPosition(arm.W);
  return { hand, tip: arm.W.clone().addScaledVector(Y, 0.16) };
}

// Ancient-style closed slip-on shoe: one thin flat sole, toe to heel, no heel block, no laces.
function shoe(leg, upperMat, soleMat, groundY) {
  const g = new THREE.Group();
  const HALF_L = 0.135, HALF_W = 0.05, SOLE = 0.008;
  const taper = (x, z) => x * (1 - (z > 0 ? 0.28 : 0.1) * (z / HALF_L) ** 2);
  const sole = new THREE.CylinderGeometry(1, 1, SOLE, 48, 1);
  const sp = sole.attributes.position;
  for (let i = 0; i < sp.count; i++) {
    const z = sp.getZ(i) * HALF_L;
    sp.setXYZ(i, taper(sp.getX(i) * (HALF_W + 0.003), z), sp.getY(i) + SOLE / 2, z * 1.02);
  }
  sole.computeVertexNormals();
  const upper = new THREE.SphereGeometry(1, 48, 20, 0, Math.PI * 2, 0, Math.PI / 2);
  const up = upper.attributes.position;
  for (let i = 0; i < up.count; i++) {
    const zn = up.getZ(i), z = zn * HALF_L;
    const h = 0.072 * (1 - 0.62 * smoothstep(0.05, 1, zn)) * (1 - 0.15 * smoothstep(0.3, 1, -zn));
    up.setXYZ(i, taper(up.getX(i) * HALF_W, z), SOLE + up.getY(i) * h, z);
  }
  upper.computeVertexNormals();
  g.add(new THREE.Mesh(sole, soleMat), new THREE.Mesh(upper, upperMat));
  g.children.forEach((m) => { m.position.z = 0.065; }); // heel just behind the ankle
  g.position.set(leg.A.x, groundY, leg.A.z);
  g.rotation.y = leg.yaw;
  return g;
}

function buildBody(skin, shirtMat) {
  const body = new THREE.Group();
  // shirt torso under the poncho
  const lathe = new THREE.LatheGeometry([[0.15, 0.9], [0.155, 1.05], [0.15, 1.2], [0.17, 1.38], [0.185, 1.48], [0.13, 1.56], [0.06, 1.6]].map(([r, y]) => new THREE.Vector2(r, y)), 40);
  lathe.scale(1, 1, 0.7);
  plainCloth(lathe, 1.0, 0.7);
  body.add(new THREE.Mesh(lathe, shirtMat));
  // soft rolled shirt collar, and the neck, mostly in the shadow of the chin
  const collar = new THREE.TorusGeometry(0.056, 0.013, 10, 40).rotateX(Math.PI / 2);
  collar.scale(1, 1.3, 0.92).translate(0, 1.618, -0.006);
  plainCloth(collar, 0.36, 0.08);
  body.add(new THREE.Mesh(collar, shirtMat));
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.056, 0.18, 20), M.skinMaterial({ tone: 0.6 }));
  neck.position.set(0, 1.66, -0.012);
  body.add(neck);
  // forearms, seen inside the wide sleeves
  for (const arm of [ARMS.right, ARMS.left]) body.add(new THREE.Mesh(tube([arm.E, arm.W], (u) => lerp(0.036, 0.027, u), 8, 10), skin));
  return body;
}

// uv in metres and no free edges, for meshes the linen material is used on outside the cloth grids
function plainCloth(geo, w, h) {
  const uvs = geo.attributes.uv;
  for (let i = 0; i < uvs.count; i++) uvs.setXY(i, uvs.getX(i) * w, uvs.getY(i) * h);
  geo.setAttribute('edgeInfo', new THREE.Float32BufferAttribute(new Float32Array(uvs.count * 2).fill(1), 2));
}

// The head, centred on the skull. The face has a real face's soft masses (brow, cheeks, chin,
// lips) but no eyes and no nose; the `softNormal` attribute is the plain skull's normal, which
// the face material leans on so those masses read only as soft pale shading.
function headGeometry() {
  const geo = new THREE.SphereGeometry(1, 96, 72);
  const pos = geo.attributes.position;
  const soft = new Float32Array(pos.count * 3);
  const g2 = (dx, dy, wx, wy) => Math.exp(-(dx * dx) / (wx * wx) - (dy * dy) / (wy * wy));
  const p = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    const nx = pos.getX(i), ny = pos.getY(i), nz = pos.getZ(i);
    let x = nx * HEAD_R.x, y = ny * HEAD_R.y, z = nz * HEAD_R.z;
    const low = smoothstep(0.15, -0.95, ny); // 0 above the cheekbones, 1 at the chin
    x *= 1 - 0.3 * low * low; // the jaw narrows to the chin
    y -= 0.008 * low * low;
    if (nz > 0) z *= 1 - 0.1 * nz ** 4 * (1 - low); // the face is flatter than the skull
    else z *= 1 + 0.08 * smoothstep(-0.3, 0.5, ny) * -nz; // back of the skull
    // the plain form's normal, before the face's masses are added
    p.set(x / (HEAD_R.x * HEAD_R.x), y / (HEAD_R.y * HEAD_R.y), z / (HEAD_R.z * HEAD_R.z)).normalize();
    soft.set([p.x, p.y, p.z], i * 3);
    if (nz > 0) {
      const ax = Math.abs(x), f = nz * nz;
      z += f * (0.003 * Math.exp(-(((y - 0.03) / 0.01) ** 2)) * Math.exp(-((x / 0.05) ** 4)) // brow
        + 0.003 * g2(ax - 0.04, y + 0.012, 0.018, 0.016) // cheeks
        + 0.0018 * g2(x, y - (MOUTH_Y + 0.005), 0.02, 0.004) + 0.0022 * g2(x, y - (MOUTH_Y - 0.007), 0.018, 0.005) // lips
        - 0.0014 * g2(x, y - (MOUTH_Y - 0.016), 0.018, 0.004) // under the lower lip
        + 0.008 * g2(x, y + 0.092, 0.024, 0.016)); // chin
    }
    pos.setXYZ(i, x, y, z);
  }
  geo.setAttribute('softNormal', new THREE.Float32BufferAttribute(soft, 3));
  geo.computeVertexNormals();
  return geo;
}


// ---------------------------------------------------------------- assemble

// groundAt(x, z): ground height under a point of his own space, relative to his feet, so each
// shoe sits on the terrain.
export function buildGuardian({ groundAt = () => 0 } = {}) {
  const root = new THREE.Group();
  const rig = { tilt: 0 };
  const skin = M.skinMaterial();
  const uSmile = uniform(0), uOpen = uniform(0);

  // head: tilts about the top of the neck; the face (and its mouth) and the veil over it are
  // part of it
  const head = new THREE.Group();
  head.position.copy(HEAD_PIVOT);
  const headGeo = headGeometry();
  const face = new THREE.Mesh(headGeo, M.faceMaterial({ mouthY: MOUTH_Y, uSmile, uOpen }));
  const veil = new THREE.Mesh(headGeo, M.faceVeilMaterial({ mouthY: MOUTH_Y }));
  veil.scale.setScalar(1.035);
  veil.renderOrder = 3;
  for (const m of [face, veil]) {
    m.position.copy(HEAD_C).sub(HEAD_PIVOT);
    head.add(m);
  }
  root.add(head);

  const shirtMat = M.linenMaterial({ motif: 0.45, border: 0.7, fray: 0 });
  root.add(buildBody(skin, shirtMat));

  const hands = [ARMS.right, ARMS.left].map((arm) => placeHand(arm, skin));
  hands.forEach((h) => root.add(h.hand));

  const leather = M.leatherMaterial(), soleLeather = M.leatherMaterial({ sole: true });
  for (const leg of [LEGS.right, LEGS.left]) root.add(shoe(leg, leather, soleLeather, groundAt(leg.A.x, leg.A.z)));

  // one wind, felt differently by each kind of cloth
  const sections = {
    poncho: windSection({ freq: 0.55, zeta: 0.35, maxLag: 0.5 }), // heavy woven wool-linen
    scarf: windSection({ freq: 0.9, zeta: 0.3, maxLag: 0.35 }),
    sleeve: windSection({ freq: 0.8, zeta: 0.32, maxLag: 0.3 }),
    trouser: windSection({ freq: 1.4, zeta: 0.42, maxLag: 0.15 }),
  };

  // collision shapes
  const legShapes = [LEGS.right, LEGS.left].map((l) => [capsule(l.H, l.K, 0.063, 0.052), capsule(l.K, l.A, 0.052, 0.042)]);
  const trouserHull = [LEGS.right, LEGS.left].map((l) => capsule(l.H, l.K, 0.1, 0.09));
  const footShapes = [LEGS.right, LEGS.left].map((l) => {
    const f = V(Math.sin(l.yaw), 0, Math.cos(l.yaw));
    const a = V(l.A.x, 0.045, l.A.z).addScaledVector(f, -0.04);
    return capsule(a, a.clone().addScaledVector(f, 0.21), 0.045, 0.04);
  });
  const handShapes = [ARMS.right, ARMS.left].map((arm, k) => capsule(arm.W, hands[k].tip, 0.034, 0.03));
  const armShapes = [ARMS.right, ARMS.left].map((a) => [capsule(a.S, a.E, 0.05, 0.04), capsule(a.E, a.W, 0.038, 0.03)]);

  const linen = M.linenMaterial({ mud: 0.25, fray: 0.5 });
  const poncho = buildPoncho(linen, sections.poncho);
  const sleeves = [ARMS.right, ARMS.left].map((arm, k) => buildSleeve(arm, M.linenMaterial({ motif: 0.6, border: 0.8, fray: 0.4 }), sections.sleeve, 3 + k * 4));
  sleeves.forEach((sl, k) => {
    sl.cloth.collide.push(...armShapes[k], handShapes[k]);
    sl.cloth.settle();
  });
  poncho.collide.push(torso(0.92, 1.5, 0.185, 0.13), ...trouserHull, ...sleeves.flatMap((sl) => sl.hull), ...handShapes);
  poncho.settle();
  const scarf = buildScarf(M.linenMaterial({ motif: 0.8, border: 1.5, tone: 1.06, fray: 0.4 }), sections.scarf);
  // the long ends must also stay off the sleeves and hands
  const handsOutward = [ARMS.right, ARMS.left].map((arm, k) => capsuleOutward(arm.W, hands[k].tip, 0.034, 0.03));
  scarf.collide.push(outsidePoncho(poncho), ...sleeves.flatMap((sl) => sl.hullOutward), ...handsOutward, capsule(V(0, 1.55, -0.012), V(0, 1.75, -0.005), 0.062, 0.058), headShape(rig));
  scarf.settle();
  const trousers = [LEGS.right, LEGS.left].map((leg, k) => {
    const c = buildTrouser(leg, M.linenMaterial({ motif: 0.5, border: 0.5, tone: 0.97, mud: 0.6, fray: 0.35 }), sections.trouser, 11 + k * 3);
    c.collide.push(...legShapes[k], legShapes[1 - k][0], legShapes[1 - k][1], footShapes[k]);
    return c.settle();
  });

  // update order matters: the scarf reads where the poncho is this frame
  const cloth = [poncho, ...sleeves.map((sl) => sl.cloth), ...trousers, scarf];
  cloth.forEach((c) => root.add(c.mesh));

  root.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  return { root, head, rig, cloth, sections: Object.values(sections), uSmile, uOpen };
}

const _q = new THREE.Quaternion();

// Call every frame he is visible. smile 0..1 (resting to gentle smile), tilt: head tilt in
// radians, open 0..1: jaw open. Nothing in the project speaks for him yet, so open stays 0.
export function updateGuardian(g, t, { smile = 0, tilt = 0, open = 0 } = {}) {
  g.uSmile.value = smile;
  g.uOpen.value = open;
  g.head.rotation.z = tilt;
  g.rig.tilt = tilt;
  // read the wind in his own space, so the cloth answers the same however he is turned
  g.root.updateWorldMatrix(true, false);
  g.root.getWorldQuaternion(_q).invert();
  for (const sec of g.sections) hearWind(sec, t, _q);
  for (const c of g.cloth) c.update(t, g.rig);
}
