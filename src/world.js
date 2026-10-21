// Scene construction: sea, island, gate, lighthouse, boat, children, creature.
// The guardian at the gate lives in guardian.js.
import * as THREE from 'three/webgpu';
import { uniform, vec3 } from 'three/tsl';
import { ParametricGeometry } from 'three/addons/geometries/ParametricGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import * as M from './materials.js';
import { BOAT } from './shots.js';
import { buildGuardian } from './guardian.js';

const lerp = THREE.MathUtils.lerp;

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
  const capGeo = displace(new THREE.BoxGeometry(2.3, 0.7, 2.3, 6, 3, 6), 0.08, 2.0, 5);
  const orbGeo = displace(new THREE.IcosahedronGeometry(0.75, 4), 0.12, 2.5, 9);
  const W = 3.4; // half the opening width
  const br = rng(41);
  for (const s of [-1, 1]) {
    // each pillar is coursed stone: a wide plinth, then blocks laid one on another, each a little
    // off true, with the joints between them showing
    const pillar = new THREE.Group();
    const blocks = [displace(new THREE.BoxGeometry(2.15, 1.1, 2.15, 6, 3, 6), 0.07, 1.6, 30 + s).translate(0, 0.35, 0)];
    let y = 0.9;
    for (let i = 0; i < 8; i++) {
      const h = 1.05 + br() * 0.25;
      const blk = displace(new THREE.BoxGeometry(1.7 - br() * 0.06, h - 0.035, 1.7 - br() * 0.06, 5, 4, 5), 0.07, 1.8, i * 3 + s);
      blk.rotateY((br() - 0.5) * 0.05).translate((br() - 0.5) * 0.04, y + h / 2, (br() - 0.5) * 0.04);
      blocks.push(blk);
      y += h;
    }
    pillar.add(new THREE.Mesh(mergeGeometries(blocks), stoneMat));
    pillar.position.set(s * (W + 0.85), -0.4, 0);
    pillar.rotation.z = s * 0.012;
    pillar.scale.y = 10.35 / y; // top course meets the cap
    const cap = new THREE.Mesh(capGeo, stoneMat);
    cap.position.set(s * (W + 0.85), 10.3, 0);
    const orb = new THREE.Mesh(orbGeo, stoneMat);
    orb.position.set(s * (W + 0.85), 11.3, 0);
    gate.add(pillar, cap, orb);
    // the iron pins the leaf hangs on, leaded into the stone
    for (const hy of [0.7, 3.1, 5.7]) {
      const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.28, 10), ironMat);
      pin.position.set(s * W, hy, 0);
      const bracket = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.09, 0.12), ironMat);
      bracket.position.set(s * (W + 0.12), hy - 0.12, 0);
      gate.add(pin, bracket);
    }
    // fallen stone and rubble where the pillar meets the ground
    for (let i = 0; i < 6; i++) {
      const rb = new THREE.Mesh(displace(new THREE.IcosahedronGeometry(0.18 + br() * 0.22, 2), 0.06, 4, i + s * 9), stoneMat);
      rb.position.set(s * (W + 0.85) + (br() - 0.5) * 2.6, 0.02 + br() * 0.05, (br() - 0.5) * 2.4);
      rb.scale.y = 0.6;
      rb.rotation.set(br() * 3, br() * 3, br() * 3);
      gate.add(rb);
    }
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
  // a heavy hinge stile on the pillar side, a latch stile at the meeting edge, and hinge straps
  // riveted across the rails where the leaf hangs on its pins
  leafGeos.push(new THREE.CylinderGeometry(0.075, 0.075, 6.9, 10).translate(0, 3.45, 0));
  leafGeos.push(new THREE.BoxGeometry(0.09, 7.9, 0.09).translate(leafW, 3.95, 0));
  for (const hy of [0.7, 3.1, 5.7]) {
    leafGeos.push(new THREE.BoxGeometry(1.1, 0.13, 0.05).translate(0.5, hy, 0.05));
    leafGeos.push(new THREE.CylinderGeometry(0.085, 0.085, 0.22, 10).translate(0, hy, 0));
    for (let k = 1; k < 4; k++) leafGeos.push(new THREE.SphereGeometry(0.025, 6, 4).translate(k * 0.3, hy, 0.08));
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
  // the lamp room's glazing between iron mullions, lit from the lamp inside
  const glaze = new THREE.Mesh(new THREE.CylinderGeometry(1.33, 1.33, 2.0, 16, 1, true), M.glowMaterial(vec3(0.5, 0.55, 0.6), M.uGlow.mul(0.35)));
  glaze.position.y = 23.5;
  tower.add(glaze);
  // gallery railing: posts and a top rail round the lamp room
  const rail = [new THREE.TorusGeometry(2.55, 0.035, 6, 48).rotateX(Math.PI / 2).translate(0, 23.25, 0)];
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    rail.push(new THREE.CylinderGeometry(0.025, 0.025, 0.95, 5).translate(Math.cos(a) * 2.55, 22.8, Math.sin(a) * 2.55));
  }
  tower.add(new THREE.Mesh(mergeGeometries(rail), ironMat));
  // small deep-set windows climbing the tower, and the door at its foot
  const dark = new THREE.MeshStandardNodeMaterial({ color: 0x030303, roughness: 0.4 });
  for (let i = 0; i < 4; i++) {
    const y = 5 + i * 4.3, r = 2.9 - (y / 22) * 1.2;
    const win = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.8, 0.4), dark);
    const a = 0.6 + i * 1.9;
    win.position.set(Math.cos(a) * (r - 0.12), y, Math.sin(a) * (r - 0.12));
    win.rotation.y = -a;
    tower.add(win);
  }
  const door = new THREE.Mesh(new THREE.BoxGeometry(1.0, 2.0, 0.4), M.woodMaterial({ paint: false, planks: 4, axis: 'local' }));
  door.position.set(0, 1.0, 2.75);
  door.rotation.x = -0.05;
  tower.add(door);
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
    // inner rail: the gunwale has thickness, a capping strip on the inside of the planking
    const inner = rimPts.map((p) => new THREE.Vector3(p.x * side * 0.93, p.y - 0.028, p.z * 0.985));
    boat.add(new THREE.Mesh(taperedTube(inner, () => 0.022, 60, 6), plankMat));
  }
  // a point on the inside of the hull: s -1 stern .. +1 bow, th 0 (one rim) .. PI (other rim)
  const hullAt = (s, th, inset = 0.985) => {
    const w = s < 0 ? B * (1 - 0.45 * s * s) : B * (1 - Math.pow(s, 1.7));
    const d = s < 0 ? D * (1 - 0.25 * s * s) : D * (1 - 0.55 * Math.pow(s, 2));
    return new THREE.Vector3(Math.cos(th) * w * inset, -Math.sin(th) * d * inset + 0.12 * Math.pow(Math.abs(s), 2.2), -s * L * 0.5);
  };
  // steamed ribs inside the hull, a keel strip along the bottom, the stem post at the bow
  const ribs = [];
  for (const s of [-0.75, -0.5, -0.25, 0.0, 0.25, 0.5, 0.72]) {
    const pts = [];
    for (let k = 0; k <= 16; k++) pts.push(hullAt(s, 0.04 + (k / 16) * (Math.PI - 0.08), 0.965));
    ribs.push(taperedTube(pts, () => 0.016, 32, 5));
  }
  const keel = [];
  for (let k = 0; k <= 20; k++) keel.push(hullAt(-0.98 + (k / 20) * 1.94, Math.PI / 2, 0.96));
  ribs.push(taperedTube(keel, () => 0.022, 40, 5));
  const stem = [];
  for (let k = 0; k <= 8; k++) {
    const p = hullAt(0.985, Math.PI / 2, 1.0);
    stem.push(new THREE.Vector3(0, lerp(p.y, 0.16, k / 8), p.z - 0.02 - 0.03 * Math.sin((k / 8) * Math.PI)));
  }
  ribs.push(taperedTube(stem, (u) => 0.03 - u * 0.008, 16, 6));
  boat.add(new THREE.Mesh(mergeGeometries(ribs), plankMat));
  // oarlocks: a raised wooden pad on the rail, an iron pin and fork the oar turns in
  const iron = M.ironMaterial();
  const lockParts = [];
  for (const s of [-1, 1]) {
    const x = s * (B * 0.985), z = 0.25;
    lockParts.push(new THREE.BoxGeometry(0.07, 0.05, 0.22).translate(x, 0.03, z));
    lockParts.push(new THREE.CylinderGeometry(0.009, 0.009, 0.12, 8).translate(s * 0.56, 0.06, z));
    const fork = new THREE.TorusGeometry(0.032, 0.007, 6, 14, Math.PI);
    fork.rotateY(Math.PI / 2).translate(s * 0.56, 0.1, z);
    lockParts.push(fork);
  }
  const pads = new THREE.Mesh(mergeGeometries([lockParts[0], lockParts[3]]), plankMat);
  const metal = new THREE.Mesh(mergeGeometries([lockParts[1], lockParts[2], lockParts[4], lockParts[5]].map((g) => g.toNonIndexed())), iron);
  boat.add(pads, metal);
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
// Each child: a heavy wool coat, arms that reach for what they hold (posed every frame by
// poseChild), knitted mittens, and a burlap sack for a mask: tied off at the neck with a
// twisted rope, ragged eye holes cut through it, the mouth and a seam stitched with thread.
// The child faces -z in its own space.

const Y_AXIS = new THREE.Vector3(0, 1, 0);

// a unit-length segment mesh (base at the origin, running up +y) stretched between two points
function orient(mesh, a, b) {
  const d = mesh.userData.d || (mesh.userData.d = new THREE.Vector3());
  d.subVectors(b, a);
  const len = d.length();
  mesh.position.copy(a);
  mesh.scale.y = len;
  mesh.quaternion.setFromUnitVectors(Y_AXIS, d.divideScalar(len || 1));
}

// ragged closed loop around a centre on the head, for the cut edge of an eye hole
function raggedLoop(rx, ry, seed, n = 28) {
  const r = rng(seed);
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const k = 1 + (r() - 0.5) * 0.28;
    pts.push(new THREE.Vector2(Math.cos(a) * rx * k, Math.sin(a) * ry * k));
  }
  return pts;
}

function sackHead(seed, ears) {
  const head = new THREE.Group();
  const burlap = M.burlapMaterial();
  const R = 0.17;
  const g = new THREE.SphereGeometry(R, 64, 48);
  const pos = g.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    v.y *= 1.18;
    // the sack narrows into the rope at the neck and gathers there in folds
    if (v.y < -0.08) {
      const k = THREE.MathUtils.smoothstep(-v.y, 0.08, 0.2);
      const gather = 1 - 0.38 * k + 0.05 * k * Math.sin(Math.atan2(v.z, v.x) * 11 + seed);
      v.x *= gather;
      v.z *= gather;
    }
    // loose coarse creases where the cloth sags over the child's head; drawn tight (smooth) over
    // the face, where the eye holes are cut and the mouth is sewn
    const face = THREE.MathUtils.smoothstep(-v.z, 0.09, 0.15) * (1 - THREE.MathUtils.smoothstep(Math.abs(v.y), 0.07, 0.12));
    const crease = (fbm2(v.x * 9 + seed, v.y * 7 + v.z * 9, 4) - 0.5) * 0.03 * (1 - 0.85 * face);
    const wr = (fbm2(v.x * 40 + seed, v.y * 40 + v.z * 30, 3) - 0.5) * 0.012 * (1 - 0.6 * face);
    // the crown is tied off on one child, so it bunches into a little knot
    const knot = ears ? 0 : 0.035 * Math.exp(-((v.x * v.x + v.z * v.z) / 0.002)) * Math.max(0, v.y / (R * 1.18));
    v.multiplyScalar(1 + (crease + wr) / R);
    v.y += knot;
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  const sack = new THREE.Mesh(g, burlap);
  head.add(sack);

  // a skirt of sacking below the rope, over the collar
  const skirt = new THREE.Mesh(displace(new THREE.CylinderGeometry(0.11, 0.17, 0.08, 40, 3, true), 0.012, 14, seed), burlap);
  skirt.position.y = -0.2;
  head.add(skirt);

  // twisted rope: two strands wound round each other
  const thread = M.burlapMaterial(vec3(0.16, 0.12, 0.075));
  for (const ph of [0, Math.PI]) {
    const pts = [];
    for (let i = 0; i <= 96; i++) {
      const a = (i / 96) * Math.PI * 2;
      const tw = a * 9 + ph;
      pts.push(new THREE.Vector3(Math.cos(a) * (0.113 + Math.cos(tw) * 0.006), -0.152 + Math.sin(tw) * 0.006, Math.sin(a) * (0.113 + Math.cos(tw) * 0.006)));
    }
    head.add(new THREE.Mesh(taperedTube(pts, () => 0.0075, 192, 6), thread));
  }
  // the knotted ends hanging at the back
  for (const s of [-1, 1]) {
    head.add(new THREE.Mesh(taperedTube(
      [new THREE.Vector3(0.0, -0.152, 0.115), new THREE.Vector3(s * 0.02, -0.2, 0.13), new THREE.Vector3(s * 0.035, -0.27, 0.125)],
      (u) => 0.008 * (1 - u * 0.3), 12, 6), thread));
  }

  // eye holes cut through the cloth: a ragged rim of frayed sacking, darkness behind it
  const dark = new THREE.MeshBasicNodeMaterial({ color: 0x010101 });
  [[-0.06, 0.035, 0.032, 0.03, 0.3, 11], [0.066, 0.022, 0.024, 0.033, -0.3, 17]].forEach(([x, y, rx, ry, yaw, s2]) => {
    const eye = new THREE.Group();
    const loop = raggedLoop(rx, ry, seed * 31 + s2);
    const shape = new THREE.Shape(loop);
    const hole = new THREE.Mesh(new THREE.ShapeGeometry(shape), dark);
    hole.position.z = 0.0015; // the darkness behind the hole, inside its frayed rim
    const rimPts = loop.map((p) => new THREE.Vector3(p.x, p.y, 0));
    const rim = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(rimPts, true), 64, 0.0045, 5, true), burlap);
    eye.add(hole, rim);
    // frayed threads poking into the hole
    const r = rng(seed * 7 + s2);
    for (let k = 0; k < 7; k++) {
      const a = r() * Math.PI * 2;
      const p0 = new THREE.Vector3(Math.cos(a) * rx, Math.sin(a) * ry, 0);
      const p1 = p0.clone().multiplyScalar(0.62 + r() * 0.2).setZ(-0.002);
      eye.add(new THREE.Mesh(taperedTube([p0, p0.clone().lerp(p1, 0.5), p1], (u) => 0.0012 * (1 - u * 0.6), 4, 3), thread));
    }
    eye.position.set(x, y, -Math.sqrt(R * R - x * x - (y / 1.18) ** 2) - 0.002);
    eye.rotation.set(0, Math.PI + yaw, 0);
    head.add(eye);
  });

  // the mouth sewn shut with cross-stitches, and a seam running up over the head
  const threadDark = new THREE.MeshStandardNodeMaterial({ color: 0x0a0604, roughness: 0.9 });
  const stitch = (a, b) => head.add(new THREE.Mesh(taperedTube([a, a.clone().lerp(b, 0.5).multiplyScalar(1.02), b], () => 0.0016, 4, 4), threadDark));
  const onSack = (x, y) => {
    // a point just above the sack's front surface
    const zz = Math.sqrt(Math.max(0.0005, R * R - x * x - (y / 1.18) ** 2));
    return new THREE.Vector3(x, y, -zz - 0.003);
  };
  for (let i = 0; i < 6; i++) {
    const x = -0.045 + i * 0.018;
    const y = -0.062 - Math.abs(x) * 0.22;
    stitch(onSack(x - 0.006, y + 0.012), onSack(x + 0.006, y - 0.012));
    stitch(onSack(x + 0.006, y + 0.012), onSack(x - 0.006, y - 0.012));
  }
  const seamPts = [];
  for (let i = 0; i <= 20; i++) {
    const a = -0.5 + (i / 20) * 2.6; // up the side, over the crown, down the back
    seamPts.push(new THREE.Vector3(Math.cos(a) * R * 1.02 * 0.96, Math.sin(a) * R * 1.18 * 1.02, 0.01));
  }
  head.add(new THREE.Mesh(taperedTube(seamPts, () => 0.0022, 60, 4), thread));
  for (let i = 1; i < 20; i += 1) {
    const p = seamPts[i], n = p.clone().normalize();
    const side = new THREE.Vector3(0, 0, 1);
    stitch(p.clone().addScaledVector(side, -0.008).addScaledVector(n, 0.002), p.clone().addScaledVector(side, 0.008).addScaledVector(n, 0.002));
  }

  if (ears) {
    for (const s of [-1, 1]) {
      const ear = new THREE.Mesh(taperedTube(
        [new THREE.Vector3(0, 0, 0), new THREE.Vector3(s * 0.04, 0.12, 0.02), new THREE.Vector3(s * 0.1, 0.22, 0.08), new THREE.Vector3(s * 0.2, 0.25, 0.16)],
        (u) => 0.04 * (1 - u * 0.75) * (1 + 0.25 * Math.sin(u * Math.PI)), 24, 10), burlap);
      ear.scale.z = 0.55; // flattened, like stuffed sacking
      ear.position.set(s * 0.07, 0.15, 0.02);
      head.add(ear);
      // stitched where it is sewn on
      for (let k = 0; k < 5; k++) {
        const a = (k / 5) * Math.PI * 2;
        const c = new THREE.Vector3(s * 0.07 + Math.cos(a) * 0.04, 0.16, 0.02 + Math.sin(a) * 0.022);
        stitch(c.clone().add(new THREE.Vector3(0, 0.012, 0)), c.clone().add(new THREE.Vector3(0, -0.012, 0)));
      }
    }
  }
  return head;
}

function buildChild({ coat, seed, ears }) {
  const kid = new THREE.Group();
  const coatMat = M.clothMaterial(coat);
  // heavy coat: narrow shoulders, a little flare at the hem, folds hanging from the yoke
  const prof = [[0.0, 0.01], [0.21, 0.01], [0.222, 0.05], [0.2, 0.22], [0.172, 0.4], [0.16, 0.52], [0.155, 0.58], [0.12, 0.645], [0.07, 0.675], [0.0, 0.68]]
    .map(([r, y]) => new THREE.Vector2(r, y));
  const body = new THREE.LatheGeometry(prof, 48, 0, Math.PI * 2);
  const bp = body.attributes.position;
  for (let i = 0; i < bp.count; i++) {
    const x = bp.getX(i), y = bp.getY(i), z = bp.getZ(i);
    const a = Math.atan2(z, x), low = 1 - THREE.MathUtils.smoothstep(y, 0.0, 0.55);
    const fold = 1 + low * (0.05 * Math.sin(a * 7 + seed) + 0.03 * Math.sin(a * 13 + seed * 2));
    bp.setXYZ(i, x * fold * (1 + 0.12 * THREE.MathUtils.smoothstep(y, 0.45, 0.6)), y, z * fold * 0.78);
  }
  body.computeVertexNormals();
  kid.add(new THREE.Mesh(body, coatMat));
  // collar turned up round the sack
  const collar = new THREE.Mesh(displace(new THREE.CylinderGeometry(0.1, 0.13, 0.07, 32, 2, true), 0.006, 20, seed), coatMat);
  collar.position.y = 0.67;
  collar.scale.z = 0.85;
  kid.add(collar);
  // a row of wooden toggles down the front
  const toggleMat = M.woodMaterial({ paint: false, planks: 1, axis: 'local' });
  [[0.52, -0.138], [0.39, -0.142], [0.26, -0.158]].forEach(([y, z]) => {
    const tg = new THREE.Mesh(new THREE.CapsuleGeometry(0.008, 0.03, 3, 8), toggleMat);
    tg.rotation.z = Math.PI / 2;
    tg.position.set(0, y, z);
    kid.add(tg);
  });

  const head = sackHead(seed, ears);
  head.position.y = 0.86;
  kid.add(head);
  kid.userData.head = head;

  // arms: shoulder -> elbow -> wrist, sleeve cuffs, mittens
  const mitten = M.clothMaterial(vec3(0.05, 0.045, 0.04));
  const segGeo = (r0, r1) => new THREE.CylinderGeometry(r1, r0, 1, 12, 1, true).translate(0, 0.5, 0);
  const arms = [-1, 1].map((s) => {
    const upper = new THREE.Mesh(segGeo(0.05, 0.044), coatMat);
    const fore = new THREE.Mesh(segGeo(0.044, 0.046), coatMat);
    const shoulder = new THREE.Mesh(new THREE.SphereGeometry(0.052, 14, 10), coatMat);
    const elbow = new THREE.Mesh(new THREE.SphereGeometry(0.045, 12, 8), coatMat);
    const cuff = new THREE.Mesh(new THREE.TorusGeometry(0.044, 0.01, 8, 18).rotateX(Math.PI / 2), coatMat);
    // a mitten: palm and fingers in one, a separate thumb, its axis along +y
    const mg = new THREE.SphereGeometry(1, 16, 12).scale(0.032, 0.048, 0.024).translate(0, 0.04, 0);
    const hand = new THREE.Group();
    hand.add(new THREE.Mesh(mg, mitten));
    const thumb = new THREE.Mesh(new THREE.CapsuleGeometry(0.011, 0.02, 3, 8), mitten);
    thumb.position.set(s * 0.026, 0.03, -0.01);
    thumb.rotation.z = -s * 0.6;
    hand.add(thumb);
    for (const m of [upper, fore, shoulder, elbow, cuff, hand]) kid.add(m);
    const S = new THREE.Vector3(s * 0.15, 0.6, 0);
    shoulder.position.copy(S);
    return { s, upper, fore, shoulder, elbow, cuff, hand, S };
  });
  // the rig lives outside userData so clones (the two figures behind the gate) don't share it
  kid.rig = { arms };
  poseChild(kid, null); // arms hanging, until something gives them a grip
  return shadowed(kid);
}

// Two-bone reach: elbow placed so upper arm and forearm keep their lengths, bending toward `pole`.
const UPPER = 0.2, FORE = 0.19;
const _d = new THREE.Vector3(), _p = new THREE.Vector3(), _e = new THREE.Vector3(), _w = new THREE.Vector3(), _q = new THREE.Vector3();
function reach(S, target, pole, outE, outW) {
  _d.subVectors(target, S);
  const L = THREE.MathUtils.clamp(_d.length(), Math.abs(UPPER - FORE) + 0.01, UPPER + FORE - 0.002);
  _d.normalize();
  const a = (UPPER * UPPER - FORE * FORE + L * L) / (2 * L);
  const h = Math.sqrt(Math.max(0, UPPER * UPPER - a * a));
  _p.copy(pole).addScaledVector(_d, -pole.dot(_d)).normalize();
  outE.copy(S).addScaledVector(_d, a).addScaledVector(_p, h);
  outW.copy(S).addScaledVector(_d, L);
}

// targets: { left, right } in the child's own space (hands go there), or null to let them hang
export function poseChild(kid, targets) {
  if (!kid.rig) return;
  for (const arm of kid.rig.arms) {
    const target = targets ? (arm.s > 0 ? targets.right : targets.left) : null;
    const tgt = target || _q.set(arm.S.x * 1.25, 0.22, -0.06);
    reach(arm.S, tgt, _p.set(arm.s * 0.6, -0.5, 0.5), _e, _w);
    orient(arm.upper, arm.S, _e);
    orient(arm.fore, _e, _w);
    arm.elbow.position.copy(_e);
    arm.cuff.position.copy(_e).lerp(_w, 0.96);
    arm.cuff.quaternion.copy(arm.fore.quaternion);
    arm.hand.position.copy(_w);
    arm.hand.quaternion.copy(arm.fore.quaternion);
  }
}

function buildLantern() {
  const lantern = new THREE.Group();
  const iron = M.ironMaterial();
  const uGlow = uniform(1);
  // sooty glass lit from inside, and the small flame itself
  const glass = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.085, 0.2, 16, 1, true), M.lanternGlassMaterial(uGlow));
  glass.position.y = -0.17;
  const flame = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12).scale(0.014, 0.034, 0.014), M.glowMaterial(vec3(1.0, 0.62, 0.28).mul(2.2), uGlow));
  flame.position.y = -0.19;
  const wick = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.026, 0.03, 10), iron);
  wick.position.y = -0.255;
  lantern.add(glass, flame, wick);
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

  // legs sunk into the water: wasted calves, a bony knee jutting forward, the thigh thickening
  // into the hip
  const g = (u, c, w) => Math.exp(-((u - c) ** 2) / (w * w));
  for (const s of [-1, 1]) {
    const leg = taperedTube(
      [new THREE.Vector3(s * 1.2, -3, -0.6), new THREE.Vector3(s * 1.15, 1.2, 0.3), new THREE.Vector3(s * 0.95, 3.0, 1.5), new THREE.Vector3(s * 0.6, 4.9, 0.4), new THREE.Vector3(s * 0.35, 6.2, 0)],
      (u) => 0.27 + 0.07 * g(u, 0.33, 0.12) + 0.13 * g(u, 0.55, 0.05) + 0.17 * THREE.MathUtils.smoothstep(u, 0.62, 0.95), 64, 14);
    root.add(new THREE.Mesh(displace(leg, 0.04, 2.2, 50 + s), flesh));
    // kneecap
    const knee = new THREE.Mesh(displace(new THREE.IcosahedronGeometry(0.3, 3), 0.05, 4, 60 + s), bone);
    knee.position.set(s * 0.97, 3.0, 1.68);
    knee.scale.set(0.9, 1.15, 0.7);
    root.add(knee);
  }
  // the pelvis joining the legs to the body
  const pelvis = new THREE.Mesh(displace(new THREE.SphereGeometry(1, 32, 20), 0.08, 1.6, 70), flesh);
  pelvis.position.set(0, 6.05, 0.05);
  pelvis.scale.set(0.95, 0.55, 0.7);
  root.add(pelvis);
  const upper = new THREE.Group();
  upper.position.y = 6;
  root.add(upper);

  // hunched, starved body: a pinched waist, the ribcage swelling up into broad bony shoulders
  const prof = [[0.0, -0.6], [0.92, -0.4], [0.66, 0.5], [0.5, 1.4], [0.8, 2.2], [1.22, 3.0], [1.48, 3.85], [1.32, 4.45], [0.82, 4.95], [0.38, 5.25], [0.28, 5.7], [0.0, 5.8]]
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

  // ribs pressing through the skin of the chest
  const ribGeos = [];
  const profR = (y) => {
    for (let i = 0; i < prof.length - 1; i++) if (y <= prof[i + 1].y) return lerp(prof[i].x, prof[i + 1].x, (y - prof[i].y) / (prof[i + 1].y - prof[i].y));
    return 0;
  };
  for (let i = 0; i < 6; i++) {
    const y = 2.55 + i * 0.36, rx = profR(y) * 0.78 * 1.03, rz = profR(y) * 0.58 * 1.07;
    const pts = [];
    for (let k = 0; k <= 16; k++) {
      const a = Math.PI * (0.12 + (k / 16) * 0.76);
      pts.push(new THREE.Vector3(Math.cos(a) * rx, y - Math.sin(a) * 0.12, Math.sin(a) * rz));
    }
    ribGeos.push(taperedTube(pts, (u) => 0.05 * (0.6 + 0.4 * Math.sin(u * Math.PI)), 32, 6));
  }
  upper.add(new THREE.Mesh(mergeGeometries(ribGeos), flesh));

  // impossibly long arms: a knotted shoulder, a bony elbow, forearms down into the water and
  // long-fingered hands trailing there. Each arm hangs from its own shoulder pivot so it can sway.
  const arms = [];
  for (const s of [-1, 1]) {
    const arm = new THREE.Group();
    const S = new THREE.Vector3(s * 0.88, 4.6, 0);
    arm.position.copy(S);
    const rel = (x, y, z) => new THREE.Vector3(s * x, y, z).sub(new THREE.Vector3(s * 0.88, 4.6, 0));
    const elbowAt = rel(2.25, 0.4, 0.95);
    const limb = taperedTube(
      [rel(0.88, 4.6, 0), rel(1.8, 2.6, 0.5), elbowAt, rel(2.05, -2.8, 1.35), rel(1.85, -5.2, 1.6)],
      (u) => 0.3 - u * 0.16 + 0.09 * g(u, 0.48, 0.05), 64, 12);
    arm.add(new THREE.Mesh(displace(limb, 0.03, 2.5, 80 + s), flesh));
    const shoulder = new THREE.Mesh(displace(new THREE.IcosahedronGeometry(0.42, 3), 0.06, 3, 90 + s), flesh);
    shoulder.position.copy(rel(0.95, 4.55, 0));
    const elbow = new THREE.Mesh(displace(new THREE.IcosahedronGeometry(0.22, 3), 0.04, 5, 95 + s), bone);
    elbow.position.copy(elbowAt).add(new THREE.Vector3(s * 0.08, 0, -0.12));
    arm.add(shoulder, elbow);
    // the hand: a narrow palm and five long jointed fingers
    const palm = new THREE.Mesh(displace(new THREE.SphereGeometry(1, 16, 12), 0.03, 6, 99 + s), flesh);
    palm.position.copy(rel(1.85, -5.35, 1.62));
    palm.scale.set(0.2, 0.32, 0.1);
    arm.add(palm);
    for (let f = 0; f < 5; f++) {
      const a = (f - 2) * 0.1;
      const base = rel(1.85 + a * 1.4, -5.6, 1.62 + a * 0.6);
      arm.add(new THREE.Mesh(taperedTube(
        [base, base.clone().add(new THREE.Vector3(s * a * 1.2, -0.6, 0.12)), base.clone().add(new THREE.Vector3(s * a * 2.2, -1.25, 0.05 + a)), base.clone().add(new THREE.Vector3(s * a * 2.8, -1.7, -0.08 + a * 1.5))],
        (u) => (f === 0 ? 0.05 : 0.065) * (1 - u * 0.65) * (1 + 0.25 * g(u, 0.35, 0.06) + 0.2 * g(u, 0.68, 0.05)), 24, 6), bone));
    }
    upper.add(arm);
    arms.push(arm);
  }

  // tattered shroud hanging from the shoulders
  const cloakGeo = new THREE.PlaneGeometry(2.7, 7.5, 30, 60);
  const cp = cloakGeo.attributes.position;
  for (let i = 0; i < cp.count; i++) {
    const x = cp.getX(i), y = cp.getY(i);
    const k = 1 - (y + 3.75) / 7.5; // 0 at the shoulders, 1 at the hem
    const z = -0.55 - 0.45 * x * x + Math.sin(y * 1.3 + x) * 0.12 - k * 0.5;
    // narrow across the shoulders and following their slope, flaring toward the ragged hem
    cp.setXYZ(i, x * (0.72 + k * 0.55), y - 0.5 * x * x * (1 - k) ** 2, z);
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
  return { root, upper, head, arms, uEyes };
}

function pos3(attr, i, v) {
  attr.setXYZ(i, v.x, v.y, v.z);
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

  // the ground before and behind the gate: half-buried stones and clumps of dead grass, so the
  // lit ground in the sting reads as a real place rather than a smooth slope
  const stoneGeo = displace(new THREE.IcosahedronGeometry(1, 2), 0.3, 1.4, 13);
  const stones = new THREE.InstancedMesh(stoneGeo, M.stoneMaterial(), 140);
  const grassBlades = [];
  const gr = rng(203);
  for (let k = 0; k < 14; k++) {
    const a = gr() * Math.PI * 2, lean = 0.15 + gr() * 0.55, h = 0.12 + gr() * 0.2;
    const blade = new THREE.ConeGeometry(0.005, h, 3, 1);
    blade.translate((gr() - 0.5) * 0.04, h / 2, (gr() - 0.5) * 0.04).rotateZ(lean * Math.cos(a)).rotateX(lean * Math.sin(a));
    grassBlades.push(blade);
  }
  const tuftGeo = mergeGeometries(grassBlades);
  const TUFTS = 2600;
  const tufts = new THREE.InstancedMesh(tuftGeo, M.grassMaterial(), TUFTS);
  const sr = rng(311);
  let si = 0, ti = 0;
  while (si < 140 || ti < TUFTS) {
    const x = (sr() - 0.5) * 34, z = -50 - sr() * 30;
    if (Math.abs(x) < 4.3 && Math.abs(z + 62) < 1.4) continue; // keep the gateway clear
    if (Math.hypot(x, z + 64.9) < 1.7) continue; // and the ground the guardian and the children stand on
    const y = terrainHeight(x, z);
    if (si < 140 && sr() < 0.16) {
      const s = 0.05 + sr() ** 2 * 0.4;
      p.set(x, y - s * 0.4, z);
      q.setFromEuler(new THREE.Euler(sr() * 3, sr() * 3, sr() * 3));
      stones.setMatrixAt(si++, mtx.compose(p, q, sc.set(s * (1 + sr() * 0.5), s * 0.6, s)));
    } else if (ti < TUFTS) {
      p.set(x, y - 0.02, z);
      q.setFromEuler(new THREE.Euler(0, sr() * 6.3, 0));
      const s = 0.6 + sr() * 0.8;
      tufts.setMatrixAt(ti++, mtx.compose(p, q, sc.set(s, s * (0.7 + sr() * 0.6), s)));
    }
  }
  shadowed(stones);
  tufts.receiveShadow = true;
  scene.add(stones, tufts);

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

  // the lantern pole, held at the girl's waist and leaning out over the bow
  const poleLow = new THREE.Vector3(0.1, 0.06, -1.13), poleHigh = new THREE.Vector3(0.29, 1.0, -1.98);
  const poleLen = poleLow.distanceTo(poleHigh);
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.018, poleLen, 8), postMat);
  pole.position.copy(poleLow).lerp(poleHigh, 0.5);
  pole.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), poleHigh.clone().sub(poleLow).normalize());
  pole.userData.len = poleLen;
  boatRig.add(pole);
  const { lantern, light: lanternLight, uGlow } = buildLantern();
  const lanternPivot = new THREE.Group();
  lanternPivot.position.set(0.29, 0.98, -1.98);
  lanternPivot.add(lantern);
  boatRig.add(lanternPivot);

  // oars: a turned handle, a thick loom, a leather sleeve where it sits in the oarlock, a shaft
  // that thins toward a flat blade. Built along +x (outboard), mirrored for the port side.
  const oarGeo = (() => {
    const r = (x) => (x < -0.36 ? 0.017 : x < 0.25 ? 0.026 : lerp(0.024, 0.017, THREE.MathUtils.smoothstep(x, 0.25, 1.6)));
    const shaft = taperedTube([-0.5, -0.1, 0.4, 1.0, 1.62].map((x) => new THREE.Vector3(x, 0, 0)), (u) => r(-0.5 + u * 2.12), 40, 8);
    const blade = new THREE.BoxGeometry(0.66, 0.014, 0.15, 12, 1, 2);
    const bp = blade.attributes.position;
    for (let i = 0; i < bp.count; i++) {
      const x = bp.getX(i), k = THREE.MathUtils.smoothstep(x, -0.33, -0.05); // narrows into the neck
      bp.setZ(i, bp.getZ(i) * (0.25 + 0.75 * k) * (1 - 0.15 * THREE.MathUtils.smoothstep(x, 0.2, 0.33)));
      bp.setY(i, bp.getY(i) * (1.6 - 0.8 * k));
    }
    blade.translate(1.92, 0, 0);
    blade.computeVertexNormals();
    return { wood: mergeGeometries([shaft, blade.toNonIndexed()].map((g) => (g.index ? g.toNonIndexed() : g))), sleeve: new THREE.CylinderGeometry(0.029, 0.029, 0.13, 10).rotateZ(Math.PI / 2) };
  })();
  const leather = M.leatherMaterial();
  const oars = [];
  for (const s of [-1, 1]) {
    const oar = new THREE.Group();
    oar.position.set(s * 0.56, 0.1, 0.25);
    const wood = new THREE.Mesh(oarGeo.wood, postMat);
    const sleeve = new THREE.Mesh(oarGeo.sleeve, leather);
    if (s < 0) { wood.scale.x = -1; sleeve.scale.x = -1; }
    oar.add(wood, sleeve);
    oar.userData = { s, handle: new THREE.Vector3(-s * 0.43, 0, 0), blade: new THREE.Vector3(s * 2.0, 0, 0) };
    shadowed(oar);
    boatRig.add(oar);
    oars.push(oar);
  }
  scene.add(boatRig);

  const creature = buildCreature();
  scene.add(creature.root);

  const MAN_X = 0, MAN_Z = -65.6;
  const manY = terrainHeight(MAN_X, MAN_Z);
  const man = buildGuardian({ groundAt: (x, z) => terrainHeight(MAN_X + x, MAN_Z + z) - manY });
  man.root.position.set(MAN_X, manY, MAN_Z);
  man.root.visible = false;
  scene.add(man.root);

  return {
    sky, ocean, gate, gateLeft: left, gateRight: right, tower, buoy,
    boatRig, bowKid, rowKid, pole, lanternPivot, lanternLight, uLanternGlow: uGlow, oars, creature, posts, man,
  };
}
