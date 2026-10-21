// Procedural TSL materials. No image textures: every surface is built from
// noise so detail holds up at any distance and resolution.
import * as THREE from 'three/webgpu';
import {
  Fn, uniform, float, vec2, vec3, vec4, color, uv,
  positionLocal, positionWorld, positionView, normalView, normalLocal,
  cameraPosition, transformNormalToView, varying, attribute,
  sin, cos, mix, smoothstep, step, pow, exp, abs, fract, max, min, dot, normalize, length, clamp, saturate, fwidth,
  mx_fractal_noise_float, mx_worley_noise_float, mx_worley_noise_vec2, mx_noise_float, mx_noise_vec3, fog,
} from 'three/tsl';

export const uTime = uniform(0);
export const uFogDensity = uniform(0.028);
export const MOON_DIR = new THREE.Vector3(-0.18, 0.26, -1).normalize();
export const uMoonDir = uniform(MOON_DIR.clone());
export const uGlow = uniform(1);

const FOG_BASE = vec3(0.016, 0.022, 0.027);
const MOON_TINT = vec3(0.26, 0.31, 0.36);

// ---------------------------------------------------------------- helpers

// Mikkelsen screen-space bump from an arbitrary procedural height node.
export const bump = Fn(([height, scale, baseNormal]) => {
  const dHdx = height.dFdx().mul(scale);
  const dHdy = height.dFdy().mul(scale);
  const sX = positionView.dFdx().normalize();
  const sY = positionView.dFdy().normalize();
  const R1 = sY.cross(baseNormal);
  const R2 = baseNormal.cross(sX);
  const det = sX.dot(R1);
  const grad = det.sign().mul(dHdx.mul(R1).add(dHdy.mul(R2)));
  return det.abs().mul(baseNormal).sub(grad).normalize();
});

const fbm = (p, oct = 4) => mx_fractal_noise_float(p, oct, 2.0, 0.5).mul(0.5).add(0.5);

// 0 on Voronoi cell borders (cracks), 1 elsewhere; border wobbles with noise.
const crackMask = (p, width) => {
  const f = mx_worley_noise_vec2(p.add(mx_noise_vec3(p.mul(2.0)).mul(0.25)));
  return smoothstep(0.0, width, f.y.sub(f.x));
};

// Shared atmosphere colour: dark sea-fog that glows toward the moon.
export const atmosphereColor = Fn(([dir]) => {
  const m = saturate(dot(dir, uMoonDir));
  // broad side-glow, tighter halo, and a hot core right around the disc
  const glow = pow(m, 5).mul(0.12).add(pow(m, 32).mul(0.35)).add(pow(m, 400).mul(1.4));
  return FOG_BASE.add(MOON_TINT.mul(glow).mul(uGlow));
});

// Patchy, low-lying fog. Thicker near the water, drifting with time.
export function setupFog(scene) {
  const factor = Fn(() => {
    const dist = length(positionWorld.sub(cameraPosition));
    const h = max(positionWorld.y, 0);
    const heightFall = exp(h.mul(-0.07)).mul(0.75).add(0.25);
    const drift = vec3(uTime.mul(0.35), 0, uTime.mul(0.12));
    const patch = fbm(positionWorld.mul(0.035).add(drift), 3).mul(1.1).add(0.45);
    const d = uFogDensity.mul(heightFall).mul(patch);
    return float(1).sub(exp(dist.mul(d).negate())).clamp(0, 0.985);
  });
  const viewDir = normalize(positionWorld.sub(cameraPosition));
  scene.fogNode = fog(atmosphereColor(viewDir), factor());
}

// ---------------------------------------------------------------- ocean
// Same wave set is mirrored on the CPU (waveHeight) so floating props sit on it.
export const WAVES = [
  { d: [0.8, 0.6], a: 0.16, f: 0.32, s: 0.55, p: 0.0 },
  { d: [-0.3, 0.95], a: 0.1, f: 0.55, s: 0.8, p: 1.7 },
  { d: [0.95, -0.2], a: 0.05, f: 1.1, s: 1.3, p: 4.1 },
  { d: [-0.7, -0.7], a: 0.025, f: 2.1, s: 1.9, p: 2.3 },
];

export function waveHeight(x, z, t) {
  let h = 0;
  for (const w of WAVES) h += w.a * Math.sin((w.d[0] * x + w.d[1] * z) * w.f + t * w.s + w.p);
  return h;
}

export function waveSlope(x, z, t) {
  let dx = 0, dz = 0;
  for (const w of WAVES) {
    const c = w.a * w.f * Math.cos((w.d[0] * x + w.d[1] * z) * w.f + t * w.s + w.p);
    dx += c * w.d[0];
    dz += c * w.d[1];
  }
  return [dx, dz];
}

export function oceanMaterial() {
  const m = new THREE.MeshStandardNodeMaterial();
  const p = positionLocal;
  let h = float(0), dx = float(0), dz = float(0);
  for (const w of WAVES) {
    const ph = p.x.mul(w.d[0]).add(p.z.mul(w.d[1])).mul(w.f).add(uTime.mul(w.s)).add(w.p);
    h = h.add(sin(ph).mul(w.a));
    const c = cos(ph).mul(w.a * w.f);
    dx = dx.add(c.mul(w.d[0]));
    dz = dz.add(c.mul(w.d[1]));
  }
  m.positionNode = vec3(p.x, h, p.z);
  const waveN = varying(normalize(vec3(dx.negate(), 1, dz.negate())));

  // fine ripples in the fragment stage
  const rp = positionWorld.xz;
  const ripple = fbm(vec3(rp.mul(1.8), uTime.mul(0.6)), 3)
    .add(fbm(vec3(rp.mul(5.5).add(17.0), uTime.mul(1.1)), 2).mul(0.35));
  const nView = bump(ripple, float(0.9), transformNormalToView(waveN));
  m.normalNode = nView;

  const viewDir = normalize(positionWorld.sub(cameraPosition));
  const fres = pow(float(1).sub(saturate(dot(viewDir.negate(), vec3(0, 1, 0)))), 5);
  const reflDir = vec3(viewDir.x, abs(viewDir.y), viewDir.z);
  m.colorNode = vec3(0.004, 0.009, 0.011);
  m.emissiveNode = atmosphereColor(reflDir).mul(fres.mul(0.9).add(0.04));
  m.roughnessNode = float(0.2).add(ripple.mul(0.12));
  m.metalnessNode = float(0);
  return m;
}

// ---------------------------------------------------------------- sky

export function skyMaterial() {
  const m = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false });
  m.fog = false;
  m.colorNode = Fn(() => {
    const dir = normalize(positionLocal);
    const base = atmosphereColor(dir);
    const up = saturate(dir.y);
    const zenith = vec3(0.004, 0.006, 0.009);
    let col = mix(base, zenith, smoothstep(0.02, 0.5, up));

    // moon disc + halo
    const md = saturate(dot(dir, uMoonDir));
    const disc = smoothstep(0.99978, 0.99987, md);
    const crater = fbm(dir.mul(380), 3);
    col = col.add(vec3(0.95, 0.97, 1.0).mul(disc).mul(crater.mul(0.5).add(0.8)).mul(3.5));

    // clouds projected on a dome
    const cuv = dir.xz.div(up.add(0.12)).mul(1.6).add(vec2(uTime.mul(0.006), uTime.mul(0.002)));
    const c = fbm(vec3(cuv, uTime.mul(0.01)), 5);
    const cover = smoothstep(0.42, 0.72, c).mul(smoothstep(0.0, 0.18, up));
    const lit = pow(md, 12).mul(0.6).add(0.03);
    const cloudCol = vec3(0.05, 0.06, 0.07).mul(lit.mul(4).add(0.2));
    col = mix(col, cloudCol, cover.mul(0.92));

    // faint stars between clouds
    const sp = dir.mul(420);
    const star = smoothstep(0.92, 1.0, float(1).sub(mx_worley_noise_float(sp)));
    col = col.add(vec3(0.6).mul(star).mul(float(1).sub(cover)).mul(up));
    return col;
  })();
  return m;
}

// ---------------------------------------------------------------- wood (boat, posts)

export function woodMaterial({ paint = true, planks = 9, axis = 'uv' } = {}) {
  const m = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide });
  const q = axis === 'uv' ? uv() : vec2(positionLocal.y.mul(0.5), positionLocal.x.add(positionLocal.z));
  const plankV = q.y.mul(planks);
  const seam = smoothstep(0.0, 0.06, fract(plankV)).mul(smoothstep(1.0, 0.94, fract(plankV)));
  const id = plankV.floor();
  const grainP = vec3(q.x.mul(2.0), q.y.mul(planks * 8.0), id.mul(3.1));
  const grain = fbm(grainP.mul(vec3(1, 1, 1)), 4);
  const rings = fract(grain.mul(9.0));
  const rot = fbm(positionLocal.mul(3.3), 4);

  let base = mix(vec3(0.06, 0.04, 0.025), vec3(0.16, 0.11, 0.07), grain);
  base = base.mul(rings.mul(0.25).add(0.8));
  if (paint) {
    // flaking oxblood paint
    const flake = smoothstep(0.48, 0.56, fbm(positionLocal.mul(6.5), 5));
    base = mix(base, vec3(0.24, 0.045, 0.03).mul(grain.mul(0.4).add(0.7)), flake.mul(0.9));
  }
  base = base.mul(seam.mul(0.7).add(0.3)).mul(rot.mul(0.5).add(0.6));

  // wet line
  const wet = smoothstep(0.35, -0.1, positionWorld.y);
  m.colorNode = base.mul(mix(1.0, 0.45, wet));
  m.roughnessNode = mix(float(0.85).sub(grain.mul(0.15)), float(0.25), wet);
  const height = seam.mul(0.6).add(grain.mul(0.3)).add(rings.mul(0.08));
  m.normalNode = bump(height, float(0.8), normalView);
  return m;
}

// ---------------------------------------------------------------- burlap sack masks

export function burlapMaterial(tint = vec3(0.42, 0.33, 0.21)) {
  const m = new THREE.MeshStandardNodeMaterial();
  const p = positionLocal.mul(95);
  const weave = sin(p.x.add(p.z)).mul(sin(p.y.mul(1.0))).mul(0.5).add(0.5);
  const fibers = fbm(positionLocal.mul(vec3(40, 220, 40)), 3);
  const grime = fbm(positionLocal.mul(5.0), 4);
  const stain = smoothstep(0.55, 0.75, fbm(positionLocal.mul(3.0).add(9.0), 3));
  let col = tint.mul(weave.mul(0.35).add(0.7)).mul(fibers.mul(0.4).add(0.75));
  col = col.mul(grime.mul(0.6).add(0.55));
  col = mix(col, vec3(0.12, 0.03, 0.02), stain.mul(0.7)); // old dried stains
  m.colorNode = col;
  m.roughnessNode = float(0.95);
  m.normalNode = bump(weave.mul(0.7).add(fibers.mul(0.3)), float(0.5), normalView);
  return m;
}

// ---------------------------------------------------------------- cloth (coats, cloak)

export function clothMaterial(tint, { tatter = false } = {}) {
  const m = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide });
  const p = positionLocal;
  const weave = sin(p.x.mul(260)).mul(sin(p.y.mul(260))).mul(0.5).add(0.5);
  const wear = fbm(p.mul(4.0), 5);
  const folds = fbm(p.mul(vec3(2.0, 0.6, 2.0)), 3);
  m.colorNode = tint.mul(wear.mul(0.7).add(0.5)).mul(weave.mul(0.06).add(0.97));
  m.roughnessNode = float(0.95);
  m.normalNode = bump(folds.mul(0.8).add(weave.mul(0.1)), float(1.2), normalView);
  if (tatter) {
    // ragged holes and frayed hem: alpha test on noise, stronger toward bottom
    const q = uv();
    const holes = fbm(p.mul(vec3(3.5, 1.4, 3.5)), 4);
    const bottom = smoothstep(0.0, 0.5, q.y);
    const side = smoothstep(0.0, 0.3, min(q.x, float(1).sub(q.x)));
    m.opacityNode = step01(holes.mul(1.2).add(bottom.mul(0.5)).add(side.mul(0.4)).sub(1.05));
    m.alphaTest = 0.5;
  }
  return m;
}

const step01 = (x) => smoothstep(0.0, 0.02, x);

// ---------------------------------------------------------------- stone

export function stoneMaterial() {
  const m = new THREE.MeshStandardNodeMaterial();
  const p = positionWorld;
  const big = fbm(p.mul(0.35), 5);
  const fine = fbm(p.mul(4.0), 3);
  const cracks = crackMask(p.mul(1.4), 0.05);
  const streaks = fbm(vec3(p.x.mul(3.0), p.y.mul(0.25), p.z.mul(3.0)), 4); // rain streaks
  const moss = smoothstep(0.55, 0.75, big.add(smoothstep(3.0, 0.0, p.y).mul(0.35)).add(normalLocal.y.mul(0.2)));
  let col = mix(vec3(0.16, 0.16, 0.15), vec3(0.33, 0.32, 0.29), big);
  col = col.mul(fine.mul(0.35).add(0.75)).mul(streaks.mul(0.7).add(0.5));
  col = mix(col, vec3(0.05, 0.075, 0.035), moss.mul(0.85));
  col = col.mul(mix(0.25, 1.0, cracks));
  m.colorNode = col;
  m.roughnessNode = mix(float(0.9), float(0.75), moss);
  m.normalNode = bump(big.mul(0.6).add(fine.mul(0.25)).add(cracks.mul(0.25)), float(1.6), normalView);
  return m;
}

export function rockMaterial() {
  const m = stoneMaterial();
  const p = positionWorld;
  const wet = smoothstep(1.2, 0.0, p.y);
  const base = m.colorNode;
  m.colorNode = base.mul(mix(1.0, 0.35, wet));
  m.roughnessNode = mix(float(0.88), float(0.18), wet);
  return m;
}

export function groundMaterial() {
  const m = new THREE.MeshStandardNodeMaterial();
  const p = positionWorld;
  const n = fbm(p.mul(0.08), 5);
  const n2 = fbm(p.mul(1.3), 4);
  const slope = saturate(float(1).sub(normalLocal.y));
  const rock = smoothstep(0.35, 0.6, slope.add(n.mul(0.3)));
  const grass = mix(vec3(0.03, 0.035, 0.02), vec3(0.07, 0.065, 0.04), n2); // dead grass
  const mud = vec3(0.035, 0.03, 0.025).mul(n2.mul(0.5).add(0.7));
  const stone = vec3(0.13, 0.13, 0.12).mul(n2.mul(0.5).add(0.6));
  const shore = smoothstep(1.4, 0.2, p.y);
  let col = mix(grass, stone, rock);
  col = mix(col, mud, shore);
  m.colorNode = col;
  m.roughnessNode = mix(float(0.95), float(0.3), shore);
  m.normalNode = bump(n.mul(0.4).add(n2.mul(0.6)), float(1.0), normalView);
  return m;
}

// Dead, salt-burnt grass: dry straw at the tips, dark and damp at the root.
export function grassMaterial() {
  const m = new THREE.MeshStandardNodeMaterial();
  const tip = smoothstep(0.0, 0.45, positionLocal.y);
  const n = fbm(positionWorld.mul(0.7), 3);
  m.colorNode = mix(vec3(0.025, 0.024, 0.016), mix(vec3(0.11, 0.095, 0.06), vec3(0.16, 0.14, 0.09), n), tip);
  m.roughnessNode = float(0.85);
  return m;
}

// ---------------------------------------------------------------- iron

export function ironMaterial() {
  const m = new THREE.MeshStandardNodeMaterial();
  const p = positionWorld;
  const rust = smoothstep(0.42, 0.68, fbm(p.mul(2.2), 5));
  const pit = fbm(p.mul(18.0), 3);
  m.colorNode = mix(vec3(0.03, 0.03, 0.03), vec3(0.2, 0.07, 0.025).mul(pit.mul(0.6).add(0.6)), rust);
  m.metalnessNode = mix(float(0.85), float(0.1), rust);
  m.roughnessNode = mix(float(0.45), float(0.95), rust);
  m.normalNode = bump(pit.mul(0.3).add(rust.mul(0.4)), float(0.6), normalView);
  return m;
}

// ---------------------------------------------------------------- bark

export function barkMaterial() {
  const m = new THREE.MeshStandardNodeMaterial();
  const p = positionLocal;
  const ridges = fbm(vec3(p.x.mul(14), p.y.mul(1.4), p.z.mul(14)), 4);
  const fine = fbm(p.mul(25), 2);
  m.colorNode = vec3(0.045, 0.04, 0.035).mul(ridges.mul(0.8).add(0.5)).mul(fine.mul(0.3).add(0.85));
  m.roughnessNode = float(0.92);
  m.normalNode = bump(ridges.add(fine.mul(0.2)), float(2.0), normalView);
  return m;
}

// ---------------------------------------------------------------- creature

export function fleshMaterial() {
  const m = new THREE.MeshPhysicalNodeMaterial();
  const p = positionLocal;
  const sinew = fbm(vec3(p.x.mul(5), p.y.mul(0.9), p.z.mul(5)), 5); // long vertical striations
  const ribs = sin(p.y.mul(9.0)).mul(0.5).add(0.5).mul(smoothstep(2.0, 3.5, p.y)).mul(smoothstep(5.0, 4.0, p.y));
  const blotch = fbm(p.mul(1.6).add(4.0), 4);
  const crev = smoothstep(0.62, 0.35, sinew);
  let col = mix(vec3(0.05, 0.042, 0.036), vec3(0.11, 0.085, 0.07), blotch);
  col = mix(col, vec3(0.09, 0.012, 0.01), crev.mul(0.55)); // raw, bloody crevices
  m.colorNode = col;
  m.roughnessNode = mix(float(0.22), float(0.6), sinew); // wet
  m.clearcoatNode = float(0.4);
  m.clearcoatRoughnessNode = float(0.3);
  m.normalNode = bump(sinew.mul(0.7).add(ribs.mul(0.5)).add(blotch.mul(0.2)), float(1.6), normalView);
  return m;
}

export function boneMaterial() {
  const m = new THREE.MeshStandardNodeMaterial();
  const p = positionLocal;
  const porous = fbm(p.mul(14), 3);
  const cracks = crackMask(p.mul(3.2), 0.035);
  const dirt = smoothstep(0.45, 0.8, fbm(p.mul(2.4), 4));
  let col = mix(vec3(0.62, 0.57, 0.46), vec3(0.42, 0.37, 0.28), porous);
  col = mix(col, vec3(0.1, 0.07, 0.05), dirt.mul(0.75));
  col = col.mul(mix(0.2, 1.0, cracks));
  m.colorNode = col;
  m.roughnessNode = float(0.7).add(porous.mul(0.2));
  m.normalNode = bump(porous.mul(0.3).add(cracks.mul(0.5)).add(dirt.mul(0.2)), float(0.9), normalView);
  return m;
}

export function hornMaterial() {
  const m = new THREE.MeshStandardNodeMaterial();
  const ring = sin(uv().x.mul(160)).mul(0.5).add(0.5);
  const n = fbm(positionLocal.mul(6), 4);
  m.colorNode = mix(vec3(0.07, 0.06, 0.05), vec3(0.24, 0.2, 0.15), n).mul(ring.mul(0.3).add(0.75));
  m.roughnessNode = float(0.6);
  m.normalNode = bump(ring.mul(0.6).add(n.mul(0.4)), float(1.2), normalView);
  return m;
}

// ---------------------------------------------------------------- the guardian (see guardian.js)

// White woven linen with a white-on-white pattern, worn but kept white: faint water marks, a
// little dust where the hem meets the ground, softly frayed edges. The cloth meshes move every
// frame, so nothing here reads the vertex position: uv is in metres across (x) and along (y)
// the cloth, and the `edgeInfo` attribute holds (metres to the nearest free edge, metres along
// that edge), so marks and border bands stay printed on the cloth and follow hems and edges.
// mud: 0..1 how far dust and damp climb from the hem. fray: 0..1 how ragged the edges are.
export function linenMaterial({ motif = 1, border = 1, tone = 1, mud = 0, fray = 0.4 } = {}) {
  const m = new THREE.MeshPhysicalNodeMaterial({ side: THREE.DoubleSide });
  const q = uv();
  const e = attribute('edgeInfo', 'vec2');
  // plain weave, faded out before it can shimmer
  const wq = q.mul(1100);
  const weave = sin(wq.x).mul(sin(wq.y)).mul(0.5).add(0.5).mul(smoothstep(1.2, 0.4, fwidth(wq.x)));
  // allover diamond lattice, woven in a slightly greyer thread
  const g = q.div(0.034);
  const f = fract(g).sub(0.5);
  const dia = abs(f.x).add(abs(f.y));
  const latticeVis = smoothstep(0.45, 0.12, fwidth(g.x).add(fwidth(g.y)));
  const lattice = smoothstep(0.07, 0.0, abs(dia.sub(0.34))).add(smoothstep(0.1, 0.03, dia).mul(0.7)).mul(latticeVis).mul(motif);
  // border: two rails with a running double chevron between them
  const d = e.x;
  const b = d.sub(0.014).div(0.04);
  const zig = abs(fract(e.y.div(0.03)).sub(0.5)).mul(2);
  const inBand = step(0.0, b).mul(step(b, 1.0));
  const chevron = max(
    smoothstep(0.13, 0.03, abs(b.sub(zig.mul(0.8).add(0.1)))),
    smoothstep(0.13, 0.03, abs(b.sub(float(0.9).sub(zig.mul(0.8))))),
  );
  const rails = smoothstep(0.0028, 0.0008, abs(d.sub(0.009))).add(smoothstep(0.0028, 0.0008, abs(d.sub(0.06))));
  const borderVis = smoothstep(0.03, 0.008, fwidth(d));
  // the woven pattern has worn away unevenly
  const worn = smoothstep(0.3, 0.7, fbm(vec3(q.x.mul(9), q.y.mul(6), 4.0), 3)).mul(0.6).add(0.25);
  const thread = lattice.mul(0.6).add(chevron.mul(inBand).add(rails).mul(borderVis).mul(border)).mul(worn);
  // hand-woven unevenness: white, but never one flat white
  const slub = fbm(vec3(q.x.mul(5), q.y.mul(1.6), 2.0), 3);
  const age = fbm(vec3(q.x.mul(1.8), q.y.mul(1.2), 5.0), 4);
  let col = mix(vec3(0.76, 0.755, 0.735), vec3(0.7, 0.69, 0.66), smoothstep(0.35, 0.75, age)).mul(tone);
  col = col.mul(slub.mul(0.08).add(0.95));
  col = col.mul(float(1).sub(thread.mul(0.13))).mul(weave.mul(0.05).add(0.975));
  // faint water marks with soft tide lines
  const tide = fbm(vec3(q.x.mul(3.4), q.y.mul(3.0), 11.0), 4);
  col = mix(col, col.mul(vec3(0.95, 0.94, 0.9)), smoothstep(0.6, 0.68, tide).mul(0.6));
  col = col.mul(float(1).sub(smoothstep(0.02, 0.0, abs(tide.sub(0.6))).mul(0.07)));
  // dust and damp climbing a little from the hem, ragged rather than a straight line
  const ragged = fbm(vec3(e.y.mul(7), d.mul(3), 21.0), 3).sub(0.5);
  const dusty = smoothstep(0.3, 0.02, d.add(ragged.mul(0.12))).mul(mud);
  const damp = smoothstep(0.4, 0.04, d.add(ragged.mul(0.15))).mul(mud);
  col = col.mul(float(1).sub(damp.mul(0.12)));
  col = mix(col, vec3(0.5, 0.49, 0.46).mul(fbm(vec3(q.x.mul(30), q.y.mul(30), 3.0), 3).mul(0.4).add(0.8)), dusty.mul(0.45));
  m.colorNode = col;
  m.roughnessNode = mix(float(0.9), float(0.7), damp);
  m.sheenNode = float(0.55);
  m.sheenRoughnessNode = float(0.5);
  m.sheenColorNode = vec3(0.86, 0.87, 0.88);
  m.normalNode = bump(thread.mul(0.25).add(weave.mul(0.04)).add(slub.mul(0.2)), float(0.6), normalView);
  // frayed edges: the last centimetre or two comes apart into loose threads
  if (fray > 0) {
    const strands = fbm(vec3(e.y.mul(280), d.mul(40), 3.0), 2);
    const gaps = fbm(vec3(e.y.mul(18), 7.0, 1.0), 2);
    m.opacityNode = smoothstep(0.0, 0.02, d.div(0.018 * fray).add(strands.mul(0.9)).add(gaps.mul(0.5)).sub(0.95));
    m.alphaTest = 0.5;
  }
  return m;
}

// Snow-white skin, a breath of cool grey in the creases, with a little light of its own so the
// hands stay pale in the dark.
export function skinMaterial({ tone = 1 } = {}) {
  const m = new THREE.MeshPhysicalNodeMaterial();
  const n = fbm(positionLocal.mul(60), 2);
  const blotch = fbm(positionLocal.mul(14).add(3.0), 3);
  const col = mix(vec3(0.87, 0.865, 0.85), vec3(0.8, 0.8, 0.8), blotch).mul(tone).mul(n.mul(0.04).add(0.98));
  m.colorNode = col;
  m.emissiveNode = col.mul(0.035);
  m.roughnessNode = float(0.55).add(n.mul(0.15));
  m.sheenNode = float(0.3);
  m.sheenColorNode = vec3(0.8, 0.8, 0.82);
  m.normalNode = bump(n.mul(0.3).add(blotch.mul(0.2)), float(0.4), normalView);
  return m;
}

// The face: pale and softly blurred, with only a small gentle mouth. The head has a real face's
// soft masses (brow, cheeks, chin, lips), but it is lit with a heavily smoothed normal (the
// `softNormal` attribute) and a little inner light, so the features melt into an indistinct
// pale oval; a faint veil shell (faceVeilMaterial) softens it further. The mouth is drawn in
// the head's own space (the mesh is centred on the skull), so it moves, turns and scales with
// the head and never with the scarf, and it is kept crisp: the blur is local to the face.
// uSmile 0..1: resting -> gentle smile (the corners rise and draw back, the cheeks lift).
// uOpen 0..1: the jaw opens, for speech. The two are separate: a smile never opens the mouth.
const mouthShape = ({ p, mouthY, uSmile, uOpen }) => {
  const sq = (x) => x.mul(x); // pow() is undefined for negative bases in WGSL
  const halfW = float(0.0175).add(uSmile.mul(0.003));
  const k = p.x.div(halfW); // -1..1 corner to corner
  const k2 = sq(k);
  const y = p.y.sub(mouthY);
  const lift = uSmile.mul(0.0042).add(0.0011); // the corners turn up
  const lipLine = k2.mul(lift);
  const gap = uOpen.mul(0.011).add(uSmile.mul(0.0012)).mul(float(1).sub(k2).max(0));
  const upper = lipLine.add(gap.mul(0.35));
  const lower = lipLine.sub(gap.mul(0.65));
  const thick = float(0.0007).mul(float(1).sub(k2.mul(0.6)));
  const dist = max(lower.sub(thick).sub(y), y.sub(upper).sub(thick)); // < 0 inside the mouth
  const across = smoothstep(1.06, 0.88, abs(k));
  return { k, y, gap, upper, dist, across, lift, sq };
};

export function faceMaterial({ mouthY, uSmile, uOpen }) {
  const m = new THREE.MeshPhysicalNodeMaterial();
  const rest = attribute('position', 'vec3'); // head-centred metres, before the face moves
  // jaw: everything below the mouth drops and tucks back a little; a smile lifts the cheeks
  // beside the mouth and draws the corners back
  const sqn = (x) => x.mul(x);
  const jaw = smoothstep(mouthY + 0.004, mouthY - 0.02, rest.y).mul(smoothstep(-0.02, 0.05, rest.z));
  const drop = uOpen.mul(0.009).mul(jaw);
  const cheek = exp(sqn(abs(rest.x).sub(0.024).div(0.012)).add(sqn(rest.y.sub(mouthY + 0.012).div(0.012))).negate()).mul(uSmile);
  m.positionNode = positionLocal.add(vec3(0, drop.negate().add(cheek.mul(0.0015)), drop.mul(-0.35).add(cheek.mul(0.0012))));

  const front = smoothstep(0.035, 0.06, rest.z);
  const { y, gap, upper, dist, across, lift, k, sq } = mouthShape({ p: rest, mouthY, uSmile, uOpen });
  const aa = fwidth(y).add(0.00025);
  const slit = smoothstep(aa, aa.negate(), dist).mul(across).mul(front);
  // a sliver of teeth under the upper lip only once the jaw opens
  const teeth = smoothstep(0.0018, 0.003, gap).mul(smoothstep(upper.sub(gap.mul(0.55)), upper.sub(gap.mul(0.3)), y)).mul(slit);
  const lips = exp(sq(dist.div(0.0035)).negate()).mul(across).mul(front);
  const dimple = exp(sq(abs(k).sub(1.12).div(0.12)).add(sq(y.sub(lift).div(0.003))).negate()).mul(uSmile).mul(front);

  // indistinct: soft, low-contrast pale shading, a gentle fall-off toward the edges of the face
  const soft = transformNormalToView(attribute('softNormal', 'vec3'));
  m.normalNode = normalize(mix(normalView, soft, 0.65));
  const facing = smoothstep(-0.3, 0.95, normalLocal.z).mul(0.16).add(0.84);
  let col = vec3(0.88, 0.875, 0.86).mul(facing);
  col = col.mul(float(1).sub(lips.mul(0.1)).sub(dimple.mul(0.1))).add(vec3(0.02, 0.004, 0.004).mul(lips));
  col = mix(col, vec3(0.13, 0.08, 0.08), slit);
  col = mix(col, vec3(0.7, 0.68, 0.65), teeth);
  m.colorNode = col;
  m.emissiveNode = col.mul(0.09).mul(float(1).sub(slit));
  m.roughnessNode = float(0.75);
  m.sheenNode = float(0.6);
  m.sheenRoughnessNode = float(0.6);
  m.sheenColorNode = vec3(0.92, 0.92, 0.94);
  return m;
}

// A pale veil a few millimetres off the face that softens its forms like a long exposure, thin
// over the mouth so the smile stays readable. Drawn only over the face, never the scarf.
export function faceVeilMaterial({ mouthY }) {
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
  const p = positionLocal;
  const sq = (x) => x.mul(x);
  const front = smoothstep(0.02, 0.07, p.z);
  const mouth = exp(sq(p.x.div(0.03)).add(sq(p.y.sub(mouthY).div(0.012))).negate());
  const edge = pow(saturate(dot(normalView, normalize(positionView).negate())), 0.8);
  m.colorNode = vec3(0.86, 0.87, 0.89);
  m.opacityNode = front.mul(edge).mul(float(1).sub(mouth.mul(0.9))).mul(0.38);
  return m;
}

// Soft, dark, matte leather for the flat shoes; `sole` is the thin worn sole.
export function leatherMaterial({ sole = false } = {}) {
  const m = new THREE.MeshStandardNodeMaterial();
  const p = positionLocal;
  const creases = fbm(p.mul(vec3(90, 160, 60)), 3);
  const grain = fbm(p.mul(420), 2);
  const base = sole ? vec3(0.11, 0.09, 0.07) : vec3(0.075, 0.062, 0.05);
  // the hand-stitched seam where the upper meets the sole
  const seam = sole ? float(0) : smoothstep(0.0018, 0.0006, abs(p.y.sub(0.012)));
  m.colorNode = base.mul(creases.mul(0.4).add(0.75)).mul(grain.mul(0.2).add(0.9)).mul(float(1).sub(seam.mul(0.4)));
  m.roughnessNode = float(sole ? 0.9 : 0.72).add(grain.mul(0.1));
  m.normalNode = bump(creases.mul(0.5).add(grain.mul(0.2)).add(seam.mul(0.3)), float(0.5), normalView);
  return m;
}

// ---------------------------------------------------------------- light-ish things

// Fake volumetric beam: additive cone, soft edges, fog wisps scrolling through.
export function beamMaterial(uIntensity) {
  const m = new THREE.MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
  });
  m.fog = false;
  const v = uv().y; // 1 at source, 0 at far end
  const viewDir = normalize(positionWorld.sub(cameraPosition));
  const edge = pow(abs(dot(normalView, normalize(positionView).negate())), 1.6);
  const wisps = fbm(positionWorld.mul(0.12).add(vec3(uTime.mul(0.4), 0, uTime.mul(0.2))), 4);
  const fall = pow(v, 1.8);
  m.colorNode = vec3(0.75, 0.82, 0.9).mul(edge).mul(fall).mul(wisps.mul(1.3).add(0.15)).mul(uIntensity).mul(0.32);
  void viewDir;
  return m;
}

// A ring of disturbed water spreading from where an oar went in: a bright crest, a broken
// inner ring and a little foam at the centre, all fading with uAlpha.
export function rippleMaterial(uAlpha, seed = 0) {
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const q = uv().sub(0.5).mul(2);
  const r = length(q);
  const broken = fbm(vec3(q.mul(6), seed * 3.1), 3);
  const crest = smoothstep(0.78, 0.9, r).mul(smoothstep(1.0, 0.9, r));
  const inner = smoothstep(0.5, 0.58, r).mul(smoothstep(0.66, 0.58, r)).mul(0.45);
  const foam = smoothstep(0.3, 0.0, r).mul(broken).mul(0.6);
  m.colorNode = vec3(0.55, 0.62, 0.7).mul(crest.add(inner).add(foam).mul(broken.mul(0.8).add(0.4))).mul(uAlpha).mul(0.35);
  return m;
}

// Lantern glass: thin, sooty toward the top, glowing amber from the flame behind it rather than
// being a solid light itself.
export function lanternGlassMaterial(uIntensity) {
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
  const p = positionLocal;
  const soot = smoothstep(0.02, 0.1, p.y).mul(0.7).add(fbm(p.mul(60), 3).mul(0.25));
  const edge = pow(float(1).sub(abs(dot(normalView, normalize(positionView).negate()))), 2.0);
  m.colorNode = vec3(1.0, 0.58, 0.24).mul(float(1).sub(soot.mul(0.75))).mul(uIntensity).mul(0.55);
  m.opacityNode = saturate(edge.mul(0.5).add(0.22).add(soot.mul(0.3)));
  return m;
}

export function glowMaterial(col, uIntensity) {
  const m = new THREE.MeshBasicNodeMaterial();
  m.colorNode = col.mul(uIntensity);
  return m;
}

export { vec3, vec4, color, float };
