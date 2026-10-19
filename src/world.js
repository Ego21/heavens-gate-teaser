// Scene construction: sea, island, gate, lighthouse, boat, children, creature.
import * as THREE from 'three/webgpu';
import { uniform, vec3 } from 'three/tsl';
import { ParametricGeometry } from 'three/addons/geometries/ParametricGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import * as M from './materials.js';
import { BOAT } from './shots.js';

// ---------------------------------------------------------------- CPU noise

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PERM = (() => {
  const r = rng(1337);
  const p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  return p.concat(p);
})();

function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const h = (a, b) => PERM[(PERM[a & 255] + b) & 255] / 255;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = h(xi, yi), b = h(xi + 1, yi), c = h(xi, yi + 1), d = h(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function fbm2(x, y, oct = 5) {
  let s = 0, a = 0.5, f = 1;
  for (let i = 0; i < oct; i++) {
    s += a * vnoise(x * f, y * f);
    f *= 2.03;
    a *= 0.5;
  }
  return s;
}

function displace(geo, amount, freq, seed = 0) {
  const pos = geo.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const n = fbm2(v.x * freq + seed, v.y * freq + v.z * freq * 0.7 + seed * 2.1, 4) - 0.5;
    const len = v.length() || 1;
    v.addScaledVector(v.clone().divideScalar(len), n * amount);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  return geo;
}

// Tube with radius following radiusFn(u), u in [0,1] along the path.
function taperedTube(points, radiusFn, tubular = 48, radial = 12) {
  const curve = new THREE.CatmullRomCurve3(points);
  const geo = new THREE.TubeGeometry(curve, tubular, 1, radial, false);
  const pos = geo.attributes.position;
  const c = new THREE.Vector3(), v = new THREE.Vector3();
  for (let i = 0; i <= tubular; i++) {
    const u = i / tubular;
    curve.getPointAt(u, c);
    const r = radiusFn(u);
    for (let j = 0; j <= radial; j++) {
      const k = i * (radial + 1) + j;
      v.fromBufferAttribute(pos, k).sub(c).multiplyScalar(r).add(c);
      pos.setXYZ(k, v.x, v.y, v.z);
    }
  }
  geo.computeVertexNormals();
  return geo;
}

function shadowed(obj, cast = true, receive = true) {
  obj.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = cast;
      o.receiveShadow = receive;
    }
  });
  return obj;
}

// ---------------------------------------------------------------- terrain

export const SHORE_Z = -56;

export function terrainHeight(x, z) {
  const dz = z + 112, dx = x * 0.8;
  const d = Math.sqrt(dx * dx + dz * dz);
  const dome = Math.max(0, 1 - d / 68);
  let h = Math.pow(dome, 1.4) * 26 - 3.0;
  h += (fbm2(x * 0.04 + 3, z * 0.04, 5) - 0.5) * 9 * dome;
  h += (fbm2(x * 0.3, z * 0.3, 3) - 0.5) * 0.6;
  // flattened landing in front of the gate
  const g = Math.exp(-((x * x) / 220 + ((z + 62) * (z + 62)) / 60));
  h = h * (1 - g) + 1.0 * g;
  return h;
}

function buildTerrain() {
  const geo = new THREE.PlaneGeometry(240, 150, 240, 150);
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, 0, -110);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    pos.setY(i, terrainHeight(pos.getX(i), pos.getZ(i)));
  }
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, M.groundMaterial());
  mesh.receiveShadow = true;
  mesh.castShadow = true;
  return mesh;
}

// ---------------------------------------------------------------- dead trees

function branch(geos, start, dir, len, rad, depth, r) {
  const end = start.clone().addScaledVector(dir, len);
  const mid = start.clone().lerp(end, 0.5).add(new THREE.Vector3((r() - 0.5) * len * 0.2, 0, (r() - 0.5) * len * 0.2));
  geos.push(taperedTube([start, mid, end], (u) => rad * (1 - u * 0.65), 8, 7));
  if (depth <= 0) return;
  const n = depth > 2 ? 2 + Math.floor(r() * 2) : 2;
  for (let i = 0; i < n; i++) {
    const nd = dir.clone().add(new THREE.Vector3((r() - 0.5) * 1.6, r() * 0.5 - 0.05, (r() - 0.5) * 1.6)).normalize();
    branch(geos, end, nd, len * (0.62 + r() * 0.15), rad * 0.6, depth - 1, r);
  }
}

function buildTree(seed, scale = 1) {
  const r = rng(seed);
  const geos = [];
  branch(geos, new THREE.Vector3(0, -0.5, 0), new THREE.Vector3((r() - 0.5) * 0.3, 1, (r() - 0.5) * 0.3).normalize(), 4.2, 0.38, 4, r);
  const geo = mergeGeometries(geos);
  const mesh = new THREE.Mesh(geo, M.barkMaterial());
  mesh.scale.setScalar(scale);
  return shadowed(mesh);
}

// ---------------------------------------------------------------- the gate

function buildGate(ironMat, stoneMat) {
  const gate = new THREE.Group();
  const pillarGeo = displace(new THREE.BoxGeometry(1.7, 10, 1.7, 6, 30, 6), 0.12, 1.3, 2);
  const capGeo = displace(new THREE.BoxGeometry(2.3, 0.7, 2.3, 6, 3, 6), 0.08, 2.0, 5);
  const orbGeo = displace(new THREE.IcosahedronGeometry(0.75, 4), 0.12, 2.5, 9);
  const W = 3.4; // half the opening width
  for (const s of [-1, 1]) {
    const p = new THREE.Mesh(pillarGeo, stoneMat);
    p.position.set(s * (W + 0.85), 5, 0);
    p.rotation.z = s * 0.012;
    const cap = new THREE.Mesh(capGeo, stoneMat);
    cap.position.set(s * (W + 0.85), 10.3, 0);
    const orb = new THREE.Mesh(orbGeo, stoneMat);
    orb.position.set(s * (W + 0.85), 11.3, 0);
    gate.add(p, cap, orb);
    // broken wall stubs running off into the fog
    for (let i = 0; i < 5; i++) {
      const h = 3.2 - i * 0.55 + Math.sin(i * 7.1) * 0.4;
      const block = new THREE.Mesh(displace(new THREE.BoxGeometry(2.4, h, 1.0, 5, 6, 3), 0.1, 1.8, i + s * 3), stoneMat);
      block.position.set(s * (W + 2.9 + i * 2.35), h / 2 - 0.2, Math.sin(i * 1.3) * 0.25);
      block.rotation.y = Math.sin(i * 3.3) * 0.08;
      gate.add(block);
    }
  }

  // wrought-iron leaves; each pivots on its pillar
  const leafGeos = [];
  const barR = 0.045;
  const leafW = W - 0.05;
  for (let i = 0; i <= 13; i++) {
    const x = (i / 13) * leafW;
    const top = 6.6 + Math.sin((x / leafW) * Math.PI * 0.5) * 1.6; // rising toward centre
    const bar = new THREE.CylinderGeometry(barR, barR, top, 6);
    bar.translate(x, top / 2, 0);
    const tip = new THREE.ConeGeometry(0.11, 0.42, 6);
    tip.translate(x, top + 0.2, 0);
    leafGeos.push(bar, tip);
  }
  for (const y of [0.5, 3.0, 5.8]) {
    const rail = new THREE.BoxGeometry(leafW, 0.09, 0.07);
    rail.translate(leafW / 2, y, 0);
    leafGeos.push(rail);
  }
  for (let i = 0; i < 5; i++) {
    const ring = new THREE.TorusGeometry(0.28, 0.03, 6, 20);
    ring.translate(0.45 + i * 0.62, 4.4, 0);
    leafGeos.push(ring);
  }
  const leafGeo = mergeGeometries(leafGeos);
  const left = new THREE.Group();
  left.position.set(-W, 0, 0);
  left.add(new THREE.Mesh(leafGeo, ironMat));
  const right = new THREE.Group();
  right.position.set(W, 0, 0);
  const rm = new THREE.Mesh(leafGeo, ironMat);
  rm.scale.x = -1;
  right.add(rm);
  gate.add(left, right);

  // arch across the top
  const arch = taperedTube(
    [new THREE.Vector3(-W - 0.2, 9.2, 0), new THREE.Vector3(-W * 0.5, 10.7, 0), new THREE.Vector3(0, 11.2, 0), new THREE.Vector3(W * 0.5, 10.7, 0), new THREE.Vector3(W + 0.2, 9.2, 0)],
    () => 0.07, 40, 6,
  );
  gate.add(new THREE.Mesh(arch, ironMat));

  shadowed(gate);
  return { gate, left, right };
}

// ---------------------------------------------------------------- lighthouse

function buildTower(stoneMat, ironMat) {
  const tower = new THREE.Group();
  const body = displace(new THREE.CylinderGeometry(1.7, 2.9, 22, 28, 40), 0.15, 0.9, 11);
  const m = new THREE.Mesh(body, stoneMat);
  m.position.y = 11;
  tower.add(m);
  const gallery = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 2.6, 0.3, 28), ironMat);
  gallery.position.y = 22.2;
  tower.add(gallery);
  const lampRoom = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.4, 2.4, 16, 1, true), ironMat);
  lampRoom.position.y = 23.5;
  tower.add(lampRoom);
  const roof = new THREE.Mesh(new THREE.ConeGeometry(1.9, 2.4, 16), ironMat);
  roof.position.y = 25.9;
  tower.add(roof);
  tower.rotation.z = 0.06; // crooked
  tower.rotation.x = -0.03;
  shadowed(tower);
  return tower;
}

// ---------------------------------------------------------------- boat

function buildBoat(woodMat) {
  const { L, B, D } = BOAT;
  const hull = new ParametricGeometry((u, v, target) => {
    const s = u * 2 - 1; // -1 stern .. +1 bow
    const w = s < 0 ? B * (1 - 0.45 * s * s) : B * (1 - Math.pow(s, 1.7));
    const d = s < 0 ? D * (1 - 0.25 * s * s) : D * (1 - 0.55 * Math.pow(s, 2));
    const th = v * Math.PI;
    const sheer = 0.12 * Math.pow(Math.abs(s), 2.2); // ends rise
    target.set(Math.cos(th) * w, -Math.sin(th) * d + sheer, -s * L * 0.5);
  }, 64, 24);
  hull.computeVertexNormals();
  const boat = new THREE.Group();
  const hm = new THREE.Mesh(hull, woodMat);
  boat.add(hm);

  const plankMat = M.woodMaterial({ paint: false, planks: 3, axis: 'local' });
  const transom = new THREE.Mesh(new THREE.CircleGeometry(1, 24, 0, Math.PI), plankMat);
  transom.scale.set(B * 0.55, D * 0.75, 1);
  transom.rotation.z = Math.PI;
  transom.position.set(0, 0.03, L * 0.5);
  boat.add(transom);
  for (const z of [-0.65, 0.25, 1.05]) {
    const seat = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.05, 0.26), plankMat);
    seat.position.set(0, -0.14, z);
    boat.add(seat);
  }
  // gunwale rim
  const rimPts = [];
  for (let i = 0; i <= 40; i++) {
    const s = 1 - (i / 40) * 2;
    const w = s < 0 ? B * (1 - 0.45 * s * s) : B * (1 - Math.pow(s, 1.7));
    rimPts.push(new THREE.Vector3(w, 0.12 * Math.pow(Math.abs(s), 2.2), -s * L * 0.5));
  }
  for (const side of [1, -1]) {
    const pts = rimPts.map((p) => new THREE.Vector3(p.x * side, p.y, p.z));
    boat.add(new THREE.Mesh(taperedTube(pts, () => 0.035, 60, 6), plankMat));
  }
  // Water mask: the sea is one flat sheet that would otherwise show through the open top of the
  // hull and make the boat look flooded. This invisible lid is drawn after the hull but before
  // the sea and writes only depth, so the sea fails its depth test everywhere inside the hull.
  // It sits a little above the real waterline so passing ripples cannot poke through it.
  const lidY = -(D - BOAT.waterlineAboveKeel) + 0.14;
  const lidShape = new THREE.Shape();
  const outline = [];
  for (let i = 0; i <= 40; i++) {
    const s = 1 - (i / 40) * 2; // bow to stern
    const w = s < 0 ? B * (1 - 0.45 * s * s) : B * (1 - Math.pow(s, 1.7));
    const d = s < 0 ? D * (1 - 0.25 * s * s) : D * (1 - 0.55 * Math.pow(s, 2));
    const sheer = 0.12 * Math.pow(Math.abs(s), 2.2);
    const sinTh = THREE.MathUtils.clamp((sheer - lidY) / d, 0, 0.999);
    outline.push([Math.sqrt(1 - sinTh * sinTh) * w * 0.97, -s * L * 0.5]);
  }
  lidShape.moveTo(outline[0][0], outline[0][1]);
  outline.forEach(([x, z]) => lidShape.lineTo(x, z));
  for (let i = outline.length - 1; i >= 0; i--) lidShape.lineTo(-outline[i][0], outline[i][1]);
  const lid = new THREE.Mesh(
    new THREE.ShapeGeometry(lidShape),
    new THREE.MeshBasicNodeMaterial({ colorWrite: false, depthWrite: true, side: THREE.DoubleSide }),
  );
  lid.rotation.x = Math.PI / 2; // shape is built in x/y; lay it flat with y -> z
  lid.position.y = lidY;
  lid.renderOrder = 1;
  boat.add(lid);

  // dirty bilge water inside
  const bilge = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 2.2), new THREE.MeshStandardNodeMaterial({ color: 0x050505, roughness: 0.05 }));
  bilge.rotation.x = -Math.PI / 2;
  bilge.position.y = -0.42;
  boat.add(bilge);
  return shadowed(boat);
}

// ---------------------------------------------------------------- children

function sackHead(seed, ears) {
  const head = new THREE.Group();
  const g = new THREE.SphereGeometry(0.17, 40, 30);
  const pos = g.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    v.y *= 1.18;
    if (v.y < -0.08) {
      const k = THREE.MathUtils.smoothstep(-v.y, 0.08, 0.2);
      v.x *= 1 - 0.38 * k;
      v.z *= 1 - 0.38 * k;
    }
    const wr = (fbm2(v.x * 40 + seed, v.y * 40 + v.z * 30, 3) - 0.5) * 0.025;
    v.multiplyScalar(1 + wr / 0.17);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  head.add(new THREE.Mesh(g, M.burlapMaterial()));
  // rope at the neck
  const rope = new THREE.Mesh(new THREE.TorusGeometry(0.11, 0.016, 8, 24), M.burlapMaterial(vec3(0.2, 0.16, 0.1)));
  rope.rotation.x = Math.PI / 2;
  rope.position.y = -0.15;
  head.add(rope);
  // uneven cut eye holes
  const holeMat = new THREE.MeshBasicNodeMaterial({ color: 0x000000 });
  const e1 = new THREE.Mesh(new THREE.CircleGeometry(0.03, 16), holeMat);
  e1.position.set(-0.06, 0.035, -0.172);
  e1.rotation.y = Math.PI + 0.3;
  const e2 = new THREE.Mesh(new THREE.CircleGeometry(0.022, 16), holeMat);
  e2.position.set(0.065, 0.025, -0.17);
  e2.rotation.y = Math.PI - 0.3;
  e2.scale.y = 1.4;
  head.add(e1, e2);
  // crude stitched mouth
  const thread = new THREE.MeshStandardNodeMaterial({ color: 0x0a0604, roughness: 0.9 });
  for (let i = 0; i < 6; i++) {
    const st = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.026, 0.004), thread);
    const x = -0.045 + i * 0.018;
    st.position.set(x, -0.06 - Math.abs(x) * 0.25, -0.168 + Math.abs(x) * 0.15);
    st.rotation.z = (i % 2 ? 0.25 : -0.25);
    head.add(st);
  }
  const seam = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.003, 0.003), thread);
  seam.position.set(0, -0.062, -0.168);
  head.add(seam);
  if (ears) {
    for (const s of [-1, 1]) {
      const ear = new THREE.Mesh(taperedTube(
        [new THREE.Vector3(0, 0, 0), new THREE.Vector3(s * 0.04, 0.12, 0.02), new THREE.Vector3(s * 0.1, 0.22, 0.08), new THREE.Vector3(s * 0.2, 0.25, 0.16)],
        (u) => 0.04 * (1 - u * 0.75), 16, 8), M.burlapMaterial());
      ear.position.set(s * 0.07, 0.15, 0.02);
      head.add(ear);
    }
  }
  return head;
}

function buildChild({ coat, seed, ears, seated }) {
  const kid = new THREE.Group();
  const prof = [[0.0, 0], [0.2, 0], [0.22, 0.08], [0.19, 0.3], [0.15, 0.5], [0.13, 0.62], [0.08, 0.68], [0.0, 0.69]]
    .map(([r, y]) => new THREE.Vector2(r, y));
  const body = new THREE.Mesh(new THREE.LatheGeometry(prof, 28), M.clothMaterial(coat));
  body.scale.z = 0.8;
  kid.add(body);
  const head = sackHead(seed, ears);
  head.position.y = 0.86;
  kid.add(head);
  kid.userData.head = head;
  const armMat = M.clothMaterial(coat);
  const arms = [];
  for (const s of [-1, 1]) {
    const arm = new THREE.Group();
    arm.position.set(s * 0.15, 0.58, 0);
    const a = new THREE.Mesh(taperedTube(
      [new THREE.Vector3(0, 0, 0), new THREE.Vector3(s * 0.05, -0.12, -0.12), new THREE.Vector3(s * 0.02, -0.08, -0.32)],
      (u) => 0.048 - u * 0.012, 12, 8), armMat);
    arm.add(a);
    kid.add(arm);
    arms.push(arm);
  }
  kid.userData.arms = arms;
  if (seated) kid.position.y = -0.2;
  return shadowed(kid);
}

function buildLantern() {
  const lantern = new THREE.Group();
  const iron = M.ironMaterial();
  const uGlow = uniform(1);
  const glass = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.085, 0.2, 12), M.glowMaterial(vec3(1.0, 0.55, 0.2), uGlow));
  glass.position.y = -0.17;
  lantern.add(glass);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.007, 0.24, 4), iron);
    rod.position.set(Math.cos(a) * 0.09, -0.17, Math.sin(a) * 0.09);
    lantern.add(rod);
  }
  const top = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.08, 12), iron);
  top.position.y = -0.04;
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.025, 12), iron);
  base.position.y = -0.29;
  const hook = new THREE.Mesh(new THREE.TorusGeometry(0.03, 0.006, 6, 12), iron);
  lantern.add(top, base, hook);
  const light = new THREE.PointLight(0xff8a3a, 12, 26, 2);
  light.position.y = -0.17;
  lantern.add(light);
  return { lantern, light, uGlow };
}

// ---------------------------------------------------------------- the creature

function buildCreature() {
  const flesh = M.fleshMaterial();
  const bone = M.boneMaterial();
  const horn = M.hornMaterial();
  const root = new THREE.Group();

  // legs sunk into the water
  for (const s of [-1, 1]) {
    root.add(new THREE.Mesh(taperedTube(
      [new THREE.Vector3(s * 1.2, -3, -0.6), new THREE.Vector3(s * 1.15, 1.2, 0.3), new THREE.Vector3(s * 0.95, 3.0, 1.5), new THREE.Vector3(s * 0.6, 4.9, 0.4), new THREE.Vector3(s * 0.35, 6.2, 0)],
      (u) => 0.36 - u * 0.1 + Math.exp(-((u - 0.55) ** 2) / 0.004) * 0.12, 32, 12), flesh)); // bony knee
  }
  const upper = new THREE.Group();
  upper.position.y = 6;
  root.add(upper);

  const prof = [[0.0, -0.6], [0.95, -0.4], [0.75, 0.6], [0.6, 1.5], [1.25, 3.0], [1.35, 3.9], [1.05, 4.7], [0.4, 5.2], [0.3, 5.7], [0.0, 5.8]]
    .map(([r, y]) => new THREE.Vector2(r, y));
  const torsoGeo = new THREE.LatheGeometry(prof, 40);
  displace(torsoGeo, 0.12, 1.4, 21);
  const torso = new THREE.Mesh(torsoGeo, flesh);
  torso.scale.set(0.78, 1, 0.58);
  upper.add(torso);

  // spine knuckles down the back
  for (let i = 0; i < 9; i++) {
    const k = new THREE.Mesh(displace(new THREE.IcosahedronGeometry(0.16 + Math.sin(i) * 0.03, 2), 0.04, 6, i), bone);
    k.position.set(0, 0.6 + i * 0.55, -0.65 - Math.sin((i / 8) * Math.PI) * 0.35);
    upper.add(k);
  }

  // impossibly long arms ending in finger-bundles that trail in the water
  for (const s of [-1, 1]) {
    upper.add(new THREE.Mesh(taperedTube(
      [new THREE.Vector3(s * 0.88, 4.6, 0), new THREE.Vector3(s * 1.8, 2.6, 0.5), new THREE.Vector3(s * 2.3, 0.2, 1.0), new THREE.Vector3(s * 2.0, -3.0, 1.4), new THREE.Vector3(s * 1.85, -5.2, 1.6)],
      (u) => 0.32 - u * 0.2, 40, 10), flesh));
    for (let f = 0; f < 4; f++) {
      const a = (f - 1.5) * 0.12;
      upper.add(new THREE.Mesh(taperedTube(
        [new THREE.Vector3(s * 1.85, -5.2, 1.6), new THREE.Vector3(s * (1.85 + a * 2), -6.0, 1.75 + a), new THREE.Vector3(s * (1.8 + a * 3), -6.9, 1.6 + a * 2)],
        (u) => 0.07 * (1 - u * 0.7), 12, 6), bone));
    }
  }

  // tattered shroud hanging from the shoulders
  const cloakGeo = new THREE.PlaneGeometry(2.7, 7.5, 30, 60);
  const cp = cloakGeo.attributes.position;
  for (let i = 0; i < cp.count; i++) {
    const x = cp.getX(i), y = cp.getY(i);
    const k = 1 - (y + 3.75) / 7.5; // 0 at the shoulders, 1 at the hem
    const z = -0.55 - 0.45 * x * x + Math.sin(y * 1.3 + x) * 0.12 - k * 0.5;
    cp.setXYZ(i, x * (1 + k * 0.25), y, z);
  }
  cloakGeo.computeVertexNormals();
  const cloak = new THREE.Mesh(cloakGeo, M.clothMaterial(vec3(0.03, 0.028, 0.026), { tatter: true }));
  cloak.position.y = 1.4;
  upper.add(cloak);

  // ram skull
  const head = new THREE.Group();
  head.position.set(0, 5.75, 0.55);
  head.rotation.x = 0.55;
  head.scale.setScalar(1.3);
  upper.add(head);
  const skullGeo = new THREE.SphereGeometry(1, 64, 48);
  const sp = skullGeo.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < sp.count; i++) {
    v.fromBufferAttribute(sp, i);
    v.x *= 0.52; v.y *= 0.6; v.z *= 1.05;
    if (v.z > 0) {
      const k = v.z / 1.05;
      v.x *= 1 - 0.5 * k;
      v.y = v.y * (1 - 0.45 * k) - 0.18 * k;
    }
    // brow ridge
    v.y += Math.exp(-((v.z - 0.15) ** 2) / 0.02) * Math.max(0, v.y) * 0.3;
    pos3(sp, i, v);
  }
  displace(skullGeo, 0.03, 5, 31);
  head.add(new THREE.Mesh(skullGeo, bone));
  const jaw = new THREE.Mesh(displace(new THREE.SphereGeometry(1, 32, 16, 0, Math.PI * 2, Math.PI * 0.5, Math.PI * 0.5), 0.02, 6, 40), bone);
  jaw.scale.set(0.3, 0.2, 0.75);
  jaw.position.set(0, -0.32, 0.38);
  jaw.rotation.x = 0.28;
  head.add(jaw);
  const socketMat = new THREE.MeshBasicNodeMaterial({ color: 0x000000 });
  const uEyes = uniform(0);
  for (const s of [-1, 1]) {
    const sock = new THREE.Mesh(new THREE.SphereGeometry(0.15, 16, 12), socketMat);
    sock.position.set(s * 0.3, 0.12, 0.42);
    sock.scale.set(1, 0.8, 0.6);
    head.add(sock);
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.022, 8, 6), M.glowMaterial(vec3(1.0, 0.75, 0.55), uEyes));
    eye.position.set(s * 0.3, 0.12, 0.53);
    head.add(eye);
    // curled horn
    const pts = [];
    for (let i = 0; i <= 24; i++) {
      const a = i / 24;
      const phi = a * Math.PI * 1.55;
      const rr = 0.62 * (1 - 0.4 * a);
      pts.push(new THREE.Vector3(s * (0.4 + 0.55 * a), 0.35 + Math.sin(phi) * rr, -0.25 - (1 - Math.cos(phi)) * rr * 0.9 + a * 0.5));
    }
    head.add(new THREE.Mesh(taperedTube(pts, (u) => 0.24 * (1 - u * 0.85), 64, 12), horn));
  }
  // nasal cavity
  const nose = new THREE.Mesh(new THREE.SphereGeometry(0.08, 12, 8), socketMat);
  nose.position.set(0, -0.06, 0.98);
  nose.scale.set(1, 1.6, 0.5);
  head.add(nose);

  root.scale.setScalar(1.2);
  shadowed(root);
  return { root, upper, head, uEyes };
}

function pos3(attr, i, v) {
  attr.setXYZ(i, v.x, v.y, v.z);
}

// ---------------------------------------------------------------- the man in the white shroud
// Built from the reference: one long sheet of crumpled linen over a tall figure,
// a hood that hangs forward over an empty black face, threads fraying off the
// tear. In the dark of the hood, a grin.

const SHROUD_H = 2.15;
const FACE = { faceY: 1.84, faceH: 0.15, faceW: 0.56 };
const SHROUD_PROFILE = [[0, 0.6], [0.3, 0.53], [0.8, 0.46], [1.2, 0.41], [1.45, 0.36], [1.58, 0.27], [1.68, 0.225], [1.82, 0.215], [1.96, 0.19], [2.06, 0.12], [2.15, 0.0]];

const gauss = (x, c, w) => Math.exp(-((x - c) * (x - c)) / (w * w));

function shroudRadius(y) {
  const P = SHROUD_PROFILE;
  if (y <= P[0][0]) return P[0][1];
  for (let i = 0; i < P.length - 1; i++) {
    const [y0, r0] = P[i], [y1, r1] = P[i + 1];
    if (y <= y1) {
      const k = (y - y0) / (y1 - y0);
      return r0 + (r1 - r0) * k * k * (3 - 2 * k);
    }
  }
  return 0;
}

function shroudPoint(theta, y, target) {
  const c = Math.cos(theta), s = Math.sin(theta);
  let r = shroudRadius(y);
  const body = 1 - THREE.MathUtils.smoothstep(y, 1.45, 1.7);
  // long hanging folds, deeper toward the hem
  r += Math.sin(theta * 11 + (fbm2(y * 1.4 + 3, c * 2 + s, 3) - 0.5) * 5) * (0.024 * (1 - y / 1.7) + 0.005) * body;
  r += (fbm2(c * 3 + y * 0.8, s * 3 + y * 1.6, 4) - 0.5) * 0.06 * body;
  // arm wrapped under the sheet on his left, gathered cloth spilling over it
  const wrap = gauss(theta, 0.55, 0.65) * gauss(y, 1.0, 0.32);
  r += wrap * (0.11 + 0.025 * Math.sin(y * 16 + theta * 7));
  // hood brim hangs forward over the face
  r += gauss(theta, Math.PI / 2, 0.7) * gauss(y, 1.98, 0.09) * 0.06;
  r += gauss(theta, Math.PI / 2, 0.9) * gauss(y, 1.84, 0.2) * 0.035;
  const wx = 1.0 + 0.34 * gauss(y, 1.3, 0.35) + 0.1 * body;
  const wz = y > 1.62 ? 1.0 : 0.82 + 0.18 * THREE.MathUtils.smoothstep(y, 1.45, 1.62);
  // the peak of the hood droops forward a little
  const droop = THREE.MathUtils.smoothstep(y, 1.95, SHROUD_H) * 0.06;
  return target.set(c * r * wx, y - 0.02, s * r * wz + droop);
}

function buildCloakedMan() {
  const root = new THREE.Group();
  const geo = new ParametricGeometry((u, v, target) => shroudPoint(u * Math.PI * 2, v * SHROUD_H, target), 200, 260);
  geo.computeVertexNormals();
  const mat = M.shroudMaterial({ height: SHROUD_H, ...FACE });
  const shroud = new THREE.Mesh(geo, mat);
  root.add(shroud);

  // the empty face
  const voidMat = new THREE.MeshBasicNodeMaterial({ color: 0x000000 });
  voidMat.fog = false;
  const voidHead = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 24), voidMat);
  voidHead.scale.set(0.175, 0.2, 0.165);
  voidHead.position.set(0, 1.84, 0.0);
  root.add(voidHead);

  // frayed threads hanging off the tear and the gathered side
  const r = rng(404);
  const p = new THREE.Vector3();
  const threads = [];
  for (let i = 0; i < 14; i++) {
    const a = r() * Math.PI * 2;
    if (Math.sin(a) < -0.2) continue; // only the upper and side rim
    const th = Math.PI / 2 + Math.cos(a) * FACE.faceW * 0.98;
    const y = FACE.faceY + Math.sin(a) * FACE.faceH * 0.98;
    shroudPoint(th, y, p);
    const len = 0.025 + r() * 0.08;
    const start = p.clone().add(new THREE.Vector3(0, 0, 0.004));
    threads.push(taperedTube(
      [start, start.clone().add(new THREE.Vector3((r() - 0.5) * 0.02, -len * 0.55, 0.012)), start.clone().add(new THREE.Vector3((r() - 0.5) * 0.04, -len, 0.006))],
      (u) => 0.0022 * (1 - u * 0.6), 8, 4));
  }
  for (let i = 0; i < 16; i++) {
    const th = 0.15 + r() * 0.9;
    const y = 0.75 + r() * 0.6;
    shroudPoint(th, y, p);
    const len = 0.06 + r() * 0.22;
    const out = new THREE.Vector3(Math.cos(th), 0, Math.sin(th)).multiplyScalar(0.01);
    threads.push(taperedTube(
      [p.clone().add(out), p.clone().add(out).add(new THREE.Vector3(out.x * 2, -len * 0.5, out.z * 2)), p.clone().add(new THREE.Vector3(out.x * 2.5, -len, out.z * 2.5))],
      (u) => 0.0026 * (1 - u * 0.6), 8, 4));
  }
  const threadMesh = new THREE.Mesh(mergeGeometries(threads), M.clothMaterial(vec3(0.5, 0.49, 0.46)));
  root.add(threadMesh);

  // the grin: two rows of small, too-many teeth on the face of the void
  const uTeeth = uniform(0);
  const toothMat = M.toothMaterial(uTeeth);
  const teeth = [];
  const tr = rng(666);
  for (const row of [1, -1]) {
    for (let i = 0; i < 25; i++) {
      // thin needles, uneven, crowding each other
      const w = 0.0055 + tr() * 0.004;
      const h = 0.019 + tr() * 0.02 * (1 - Math.abs(i / 12 - 1) * 0.5);
      const tooth = new THREE.Mesh(new THREE.ConeGeometry(w, h, 5, 1), toothMat);
      tooth.userData = { row, k: (i / 24) * 2 - 1 + (tr() - 0.5) * 0.03, h, jitter: (tr() - 0.5) * 0.003, lean: (tr() - 0.5) * 0.35 };
      tooth.visible = false;
      root.add(tooth);
      teeth.push(tooth);
    }
  }

  shadowed(root);
  voidHead.castShadow = false;
  return { root, teeth, uTeeth, voidCenter: voidHead.position.clone(), voidScale: voidHead.scale.clone() };
}

// Lay the teeth along a grin carved on the front of the void. smile: 0..1
export function setSmile(man, smile) {
  const { teeth, voidCenter: c, voidScale: v } = man;
  const width = 0.02 + smile * 0.12; // wider than a face should allow
  const curve = 0.012 + smile * 0.05; // corners rise
  const open = 0.002 + smile * 0.007;
  for (const tooth of teeth) {
    const { row, k, h, jitter, lean } = tooth.userData;
    const reveal = Math.abs(k) < smile * 1.15;
    tooth.visible = smile > 0.01 && reveal;
    if (!tooth.visible) continue;
    const x = k * width;
    const y = c.y - 0.055 + curve * k * k + row * (open + h * 0.5) + jitter;
    const nx = Math.min(0.98, Math.abs(x) / v.x);
    const ny = Math.min(0.98, Math.abs(y - c.y) / v.y);
    const z = c.z + v.z * Math.sqrt(Math.max(0.02, 1 - nx * nx - ny * ny)) + 0.002;
    tooth.position.set(x, y, z);
    // upper row points down into the gap, lower row points up; fanned toward the corners
    tooth.rotation.set(0, Math.atan2(x, 0.12), (row > 0 ? Math.PI : 0) + row * k * 0.45 + lean);
  }
  man.uTeeth.value = 0.02 + smile * 0.22;
}

// ---------------------------------------------------------------- assemble

export function buildWorld(scene) {
  const stone = M.stoneMaterial();
  const iron = M.ironMaterial();

  // sky dome follows the camera
  const sky = new THREE.Mesh(new THREE.SphereGeometry(900, 64, 32), M.skyMaterial());
  sky.frustumCulled = false;
  sky.renderOrder = -1;
  scene.add(sky);

  const ocean = new THREE.Mesh(new THREE.PlaneGeometry(700, 700, 600, 600).rotateX(-Math.PI / 2), M.oceanMaterial());
  ocean.position.z = -60;
  ocean.receiveShadow = true;
  ocean.frustumCulled = false;
  ocean.renderOrder = 2; // after the boat's water mask (renderOrder 1), see buildBoat
  scene.add(ocean);

  scene.add(buildTerrain());

  const { gate, left, right } = buildGate(iron, stone);
  gate.position.set(0, terrainHeight(0, -62) - 0.2, -62);
  scene.add(gate);
  left.rotation.y = 0.55; // left leaf hangs open
  right.rotation.y = -0.06;

  const tower = buildTower(stone, iron);
  const tx = 18, tz = -100;
  tower.position.set(tx, terrainHeight(tx, tz) - 1, tz);
  scene.add(tower);

  // trees
  const treeSpots = [[-9, -64, 1.0], [10.5, -66, 1.15], [-17, -72, 1.3], [6, -78, 0.9], [-4, -86, 1.4], [24, -82, 1.2], [-26, -66, 1.1], [30, -95, 1.3]];
  treeSpots.forEach(([x, z, s], i) => {
    const t = buildTree(100 + i, s);
    t.position.set(x, terrainHeight(x, z) - 0.3, z);
    t.rotation.y = i * 1.7;
    scene.add(t);
  });

  // shoreline rocks
  const rockGeo = displace(new THREE.IcosahedronGeometry(1, 4), 0.45, 0.9, 7);
  const rocks = new THREE.InstancedMesh(rockGeo, M.rockMaterial(), 60);
  const r = rng(77);
  const mtx = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), p = new THREE.Vector3();
  for (let i = 0; i < 60; i++) {
    const x = (r() - 0.5) * 90;
    if (Math.abs(x) < 5) { i--; continue; }
    const z = SHORE_Z - 2 - r() * 9;
    const s = 0.5 + r() * 1.8;
    p.set(x, terrainHeight(x, z) - s * 0.35, z);
    q.setFromEuler(new THREE.Euler(r() * 3, r() * 3, r() * 3));
    sc.set(s * (1 + r() * 0.6), s * (0.6 + r() * 0.4), s);
    rocks.setMatrixAt(i, mtx.compose(p, q, sc));
  }
  shadowed(rocks);
  scene.add(rocks);

  // rotten pier posts lining the approach
  const postMat = M.woodMaterial({ paint: false, planks: 1, axis: 'local' });
  const posts = [];
  const pr = rng(9);
  for (let z = 34; z > -52; z -= 5.5) {
    for (const s of [-1, 1]) {
      if (pr() < 0.3) continue;
      const h = 2.2 + pr() * 2.4;
      const geo = displace(new THREE.CylinderGeometry(0.14 + pr() * 0.06, 0.2, h, 10, 8), 0.035, 3, z + s);
      const post = new THREE.Mesh(geo, postMat);
      post.position.set(s * (5.0 + pr() * 1.8), h / 2 - 1.1, z + pr() * 2);
      post.rotation.set((pr() - 0.5) * 0.25, 0, (pr() - 0.5) * 0.3);
      shadowed(post);
      scene.add(post);
      posts.push(post);
    }
  }

  // bell buoy
  const buoy = new THREE.Group();
  const buoyBody = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.55, 0.9, 16), M.woodMaterial({ paint: true, planks: 2, axis: 'local' }));
  const cage = new THREE.Mesh(new THREE.ConeGeometry(0.4, 1.4, 4, 1, true), iron);
  cage.position.y = 1.1;
  const bell = new THREE.Mesh(new THREE.SphereGeometry(0.16, 16, 8, 0, Math.PI * 2, 0, Math.PI * 0.6), iron);
  bell.position.y = 1.2;
  buoy.add(buoyBody, cage, bell);
  shadowed(buoy);
  buoy.position.set(7.5, 0, -14);
  scene.add(buoy);

  // boat + children + lantern
  const boatRig = new THREE.Group();
  const boat = buildBoat(M.woodMaterial({ paint: true, planks: 9 }));
  boatRig.add(boat);
  const bowKid = buildChild({ coat: vec3(0.085, 0.022, 0.016), seed: 3, ears: false, seated: false });
  bowKid.position.set(0.0, -0.3, -0.95);
  boatRig.add(bowKid);
  const rowKid = buildChild({ coat: vec3(0.035, 0.038, 0.035), seed: 8, ears: true, seated: true });
  rowKid.position.set(0, -0.3, 0.25);
  rowKid.rotation.y = Math.PI; // rowers face the stern
  boatRig.add(rowKid);

  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.018, 1.25, 6), postMat);
  pole.position.set(0.24, 0.66, -1.45);
  pole.rotation.z = -0.08;
  pole.rotation.x = -1.0;
  boatRig.add(pole);
  const { lantern, light: lanternLight, uGlow } = buildLantern();
  const lanternPivot = new THREE.Group();
  lanternPivot.position.set(0.29, 0.98, -1.98);
  lanternPivot.add(lantern);
  boatRig.add(lanternPivot);

  const oars = [];
  for (const s of [-1, 1]) {
    const oar = new THREE.Group();
    oar.position.set(s * 0.56, 0.1, 0.25);
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 2.6, 6), postMat);
    shaft.rotation.z = Math.PI / 2;
    shaft.position.x = s * 0.8;
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.02, 0.15), postMat);
    blade.position.x = s * 2.0;
    oar.add(shaft, blade);
    shadowed(oar);
    boatRig.add(oar);
    oars.push(oar);
  }
  scene.add(boatRig);

  const creature = buildCreature();
  scene.add(creature.root);

  const man = buildCloakedMan();
  man.root.position.set(0, terrainHeight(0, -65.6), -65.6);
  man.root.visible = false;
  scene.add(man.root);

  return {
    sky, ocean, gate, gateLeft: left, gateRight: right, tower, buoy,
    boatRig, bowKid, rowKid, lanternPivot, lanternLight, uLanternGlow: uGlow, oars, creature, posts, man,
  };
}
