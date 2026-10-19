// Procedural TSL materials. No image textures: every surface is built from
// noise so detail holds up at any distance and resolution.
import * as THREE from 'three/webgpu';
import {
  Fn, uniform, float, vec2, vec3, vec4, color, uv,
  positionLocal, positionWorld, positionView, normalView, normalLocal,
  cameraPosition, transformNormalToView, varying,
  sin, cos, mix, smoothstep, pow, exp, abs, fract, max, min, dot, normalize, length, clamp, saturate,
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

// ---------------------------------------------------------------- the white shroud

// Heavy, crumpled linen. `face` describes the hood opening in the parametric uv
// space of the shroud so its edge can be torn away with noise.
export function shroudMaterial({ height, faceY, faceH, faceW }) {
  const m = new THREE.MeshPhysicalNodeMaterial({ side: THREE.DoubleSide });
  const p = positionLocal;
  const q = uv();
  const creases = fbm(vec3(p.x.mul(7), p.y.mul(1.3), p.z.mul(7)), 5);
  // fine crinkles: ridged noise stretched along the hang of the cloth
  const rn = mx_noise_float(p.mul(vec3(26, 9, 26)));
  const crinkle = float(1).sub(abs(rn)).pow(3);
  const weave = sin(q.x.mul(2600)).mul(sin(q.y.mul(1500))).mul(0.5).add(0.5);
  const grime = smoothstep(0.35, 0.0, p.y).mul(fbm(p.mul(3.0), 3).mul(0.6).add(0.4));
  const yq = q.y.mul(height);
  const dTheta = q.x.sub(0.25).mul(Math.PI * 2);
  const ellipse = dTheta.div(faceW).pow(2).add(yq.sub(faceY).div(faceH).pow(2));
  let col = mix(vec3(0.42, 0.41, 0.385), vec3(0.7, 0.69, 0.655), creases);
  // cloth falls into shadow as it turns into the hood
  col = col.mul(mix(0.12, 1.0, smoothstep(1.0, 2.6, ellipse)));
  col = col.mul(crinkle.mul(0.1).add(0.92)).mul(weave.mul(0.06).add(0.97));
  col = mix(col, vec3(0.16, 0.14, 0.12), grime.mul(0.7));
  m.colorNode = col;
  m.roughnessNode = float(0.93);
  m.sheenNode = float(0.6);
  m.sheenRoughnessNode = float(0.5);
  m.sheenColorNode = vec3(0.8, 0.82, 0.85);
  m.normalNode = bump(creases.mul(0.8).add(crinkle.mul(0.12)).add(weave.mul(0.03)), float(2.2), normalView);

  // ragged hole for the face + frayed hem
  const y = yq;
  const tear = fbm(vec3(dTheta.mul(4), y.mul(18), 3.0), 3).sub(0.5).mul(0.55);
  const keepFace = smoothstep(0.98, 1.0, ellipse.add(tear));
  const hemNoise = fbm(vec3(q.x.mul(90), y.mul(25), 7.0), 3);
  const keepHem = smoothstep(0.0, 0.02, hemNoise.add(y.div(0.07)).sub(0.85));
  m.opacityNode = keepFace.mul(keepHem);
  m.alphaTest = 0.5;
  return m;
}

export function toothMaterial(uGlow) {
  const m = new THREE.MeshStandardNodeMaterial();
  const n = fbm(positionLocal.mul(400), 2);
  const tip = smoothstep(-0.004, 0.012, positionLocal.y); // tips paler, roots stained
  m.colorNode = mix(mix(vec3(0.3, 0.22, 0.13), vec3(0.62, 0.57, 0.44), tip), vec3(0.45, 0.38, 0.26), n.mul(0.4));
  m.emissiveNode = mix(vec3(0.25, 0.18, 0.1), vec3(0.7, 0.66, 0.55), tip).mul(uGlow);
  m.roughnessNode = float(0.35);
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

export function glowMaterial(col, uIntensity) {
  const m = new THREE.MeshBasicNodeMaterial();
  m.colorNode = col.mul(uIntensity);
  return m;
}

export { vec3, vec4, color, float };
