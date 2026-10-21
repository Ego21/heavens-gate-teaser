// The trailer engine: builds the world, lights and post-processing chain and
// exposes update(t) / render(). It owns nothing about the page it runs in, so the
// standalone viewer and the Remotion composition both drive it the same way.
import * as THREE from 'three/webgpu';
import { pass, uniform, vec2, vec3, vec4, float, Fn, Loop, mix, smoothstep, length, dot, screenUV, pow, saturate, max, abs, sqrt, sin, cos, floor, fract, viewportSize, convertToTexture, perspectiveDepthToViewZ } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { film } from 'three/addons/tsl/display/FilmNode.js';
import { chromaticAberration } from 'three/addons/tsl/display/ChromaticAberrationNode.js';
import { godrays } from 'three/addons/tsl/display/GodraysNode.js';
import { bilateralBlur } from 'three/addons/tsl/display/BilateralBlurNode.js';

import { uTime, uFogDensity, MOON_DIR, setupFog, beamMaterial, glowMaterial, rippleMaterial, waveHeight, waveSlope } from './materials.js';
import { buildWorld, terrainHeight, poseChild } from './world.js';
import { updateGuardian } from './guardian.js';
import { shotAt, baseState, boatState, rowStroke, ROW, flicker, smooth, CAPTIONS, TITLE, NAME_CARD } from './shots.js';

export const BASE_EXPOSURE = 0.8;

const rand = Fn(([p]) => fract(sin(dot(p, vec2(12.9898, 78.233))).mul(43758.5453)));

// Broken-screen glitch: horizontal slices slip sideways, the picture jumps vertically, colour
// channels split, blocks turn into static or invert, a bright scan bar sweeps and noise
// crawls over everything. `amount` 0 leaves the picture untouched.
function glitchPass(colorNode, amount, seed) {
  const tex = convertToTexture(colorNode);
  return Fn(() => {
    const uv0 = screenUV;
    const slice = floor(uv0.y.mul(34));
    const r1 = rand(vec2(slice, seed));
    const r2 = rand(vec2(slice.add(7), seed.add(3)));
    const slip = r1.greaterThan(0.72).select(r2.sub(0.5).mul(0.22).mul(amount), float(0));
    const hop = rand(vec2(seed, 1)).greaterThan(0.85).select(rand(vec2(seed, 2)).sub(0.5).mul(0.2).mul(amount), float(0));
    const uvg = vec2(fract(uv0.x.add(slip)), fract(uv0.y.add(hop)));
    const split = amount.mul(0.014).mul(r2.add(0.5));
    const col = vec3(
      tex.sample(uvg.add(vec2(split, 0))).r,
      tex.sample(uvg).g,
      tex.sample(uvg.sub(vec2(split, 0))).b,
    ).toVar();

    // corrupted blocks: some turn into static, some invert
    const cell = floor(uv0.mul(vec2(14, 8)));
    const rc = rand(cell.add(vec2(seed.mul(1.7), seed)));
    const hit = rc.greaterThan(float(1).sub(amount.mul(0.07)));
    const noiseBlock = vec3(rand(uv0.mul(viewportSize).add(seed))).mul(0.8);
    const blockCol = fract(rc.mul(37)).greaterThan(0.5).select(noiseBlock, vec3(1).sub(col));
    col.assign(hit.select(blockCol, col));

    // crawling static, a bright scan bar, faint scanlines and an occasional white flash
    col.addAssign(rand(uv0.mul(viewportSize).add(seed.mul(3))).sub(0.5).mul(0.14).mul(amount));
    const barY = fract(seed.mul(0.137));
    col.addAssign(vec3(0.9).mul(smoothstep(0.02, 0.0, abs(uv0.y.sub(barY)))).mul(amount));
    col.mulAssign(float(1).sub(amount.mul(0.25).mul(sin(uv0.y.mul(viewportSize.y).mul(1.5)).mul(0.5).add(0.5))));
    col.assign(mix(col, vec3(1), rand(vec2(seed, 9)).greaterThan(0.9).select(amount.mul(0.25), float(0))));
    return vec4(col, 1);
  })();
}

// Single-pass gather depth of field: blur radius follows the circle of confusion at each
// pixel, taps on a golden-angle spiral. (Three's own DOF uses a multi-target pipeline that
// misrenders in some Chrome builds, so this keeps every host producing the same image.)
function depthOfField(colorNode, viewZNode, focus, focal, bokeh) {
  const tex = convertToTexture(colorNode);
  const TAPS = 40;
  return Fn(() => {
    const coc = smoothstep(0, focal, viewZNode.negate().sub(focus).abs());
    const texel = vec2(1).div(viewportSize);
    const radius = coc.mul(bokeh).mul(viewportSize.y.mul(4.0 / 1080)); // ~4 px at 1080p per unit of bokeh, scales with resolution
    const acc = vec3(0).toVar();
    const wsum = float(0).toVar();
    Loop(TAPS, ({ i }) => {
      const k = float(i).add(0.5);
      const a = k.mul(2.39996323);
      const r = sqrt(k.div(TAPS));
      const off = vec2(cos(a), sin(a)).mul(r).mul(radius).mul(texel);
      const tap = tex.sample(screenUV.add(off)).rgb;
      // brighter taps contribute more, which gives highlights their bokeh bloom
      const w = float(1).add(max(dot(tap, vec3(0.3333)).sub(1.0), 0).mul(2));
      acc.addAssign(tap.mul(w));
      wsum.addAssign(w);
    });
    return vec4(acc.div(wsum), 1);
  })();
}

export function createTrailer({ renderer, scene, camera, low = false, skip = [] }) {
  const view = { w: 1920, h: 1080 }; // size the camera frames for; set by the caller
  setupFog(scene);
  const W = buildWorld(scene);

  const hemi = new THREE.HemisphereLight(0x5a6e80, 0x060606, 0.14);
  const moon = new THREE.DirectionalLight(0xa9bfd6, 0.85);
  moon.target.position.set(0, 0, -45);
  moon.position.copy(moon.target.position).addScaledVector(MOON_DIR, 220);
  moon.castShadow = true;
  moon.shadow.mapSize.set;
  Object.assign(moon.shadow.camera, { left: -85, right: 85, top: 85, bottom: -85, near: 20, far: 480 });
  moon.shadow.bias = -0.0004;
  moon.shadow.normalBias = 0.04;
  scene.add(hemi, moon, moon.target);

  // lighthouse lamp, beam and spotlight
  W.tower.updateMatrixWorld(true);
  const lamp = W.tower.localToWorld(new THREE.Vector3(0, 23.5, 0));
  const uBeam = uniform(1);
  const beamLen = 170;
  const beamGeo = new THREE.CylinderGeometry(0.45, 11, beamLen, 48, 1, true);
  beamGeo.translate(0, -beamLen / 2, 0);
  beamGeo.rotateX(-Math.PI / 2);
  const beam = new THREE.Mesh(beamGeo, beamMaterial(uBeam));
  beam.position.copy(lamp);
  beam.frustumCulled = false;
  const lampGlow = new THREE.Mesh(new THREE.SphereGeometry(0.7, 16, 12), glowMaterial(vec3(0.9, 0.95, 1.0), uBeam.mul(6)));
  lampGlow.position.copy(lamp);
  const spot = new THREE.SpotLight(0xdfe8f0, 150, 260, 0.075, 0.55, 1);
  spot.position.copy(lamp);
  scene.add(beam, lampGlow, spot, spot.target);

  // a cold, soft light from high in front of the guardian: brightest on his face and scarf,
  // falling off down the poncho so the folds still read, his legs left to the dark; and a faint
  // rim from behind that lifts his silhouette off the fog
  const key = new THREE.SpotLight(0xdde5ee, 0, 10, 0.46, 0.85, 2);
  key.position.copy(W.man.root.position).add(new THREE.Vector3(-0.6, 3.2, 2.1));
  key.target.position.copy(W.man.root.position).add(new THREE.Vector3(0, 1.45, 0.05));
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.01;
  key.shadow.radius = 3;
  const rim = new THREE.SpotLight(0xb8c6d6, 0, 9, 0.5, 0.9, 2);
  rim.position.copy(W.man.root.position).add(new THREE.Vector3(1.4, 2.8, -2.4));
  rim.target.position.copy(W.man.root.position).add(new THREE.Vector3(0, 1.3, 0));
  scene.add(key, key.target, rim, rim.target);

  // two small figures that end up behind the gate
  const ghosts = new THREE.Group();
  const gA = W.bowKid.clone();
  const gB = W.rowKid.clone();
  gA.position.set(-0.75, terrainHeight(-0.75, -64) + 0.02, -64);
  gB.position.set(0.6, terrainHeight(0.6, -64.4) + 0.2, -64.4);
  gA.rotation.set(0, Math.PI, 0);
  gB.rotation.set(0, Math.PI + 0.15, 0);
  gA.scale.setScalar(1.05);
  ghosts.add(gA, gB);
  ghosts.visible = false;
  scene.add(ghosts);

  // ------------------------------------------------------------ post
  const uGod = uniform(new THREE.Color(0, 0, 0));
  const uFocus = uniform(10), uFocal = uniform(6), uBokeh = uniform(1.5);
  const uCA = uniform(0.15), uGrain = uniform(0.22);
  const uGlitch = uniform(0), uSeed = uniform(0);

  const pipeline = new THREE.RenderPipeline(renderer);
  // samples: 0 keeps the depth buffer single-sampled; DOF and godrays read it as a plain texture,
  // which breaks if the host renderer was created with MSAA (as Remotion's canvas does).
  const scenePass = pass(scene, camera, { samples: 0 });
  const sceneColor = scenePass.getTextureNode('output');
  const sceneDepth = scenePass.getTextureNode('depth');
  let img = sceneColor;

  if (!low && !skip.includes('godrays')) {
    const rays = godrays(sceneDepth, camera, moon);
    rays.density.value = 0.55;
    rays.maxDensity.value = 0.65;
    rays.distanceAttenuation.value = 1.6;
    const raysBlur = bilateralBlur(rays.getTextureNode());
    img = img.add(vec4(uGod.mul(raysBlur.r), 0));
  }
  if (!low && !skip.includes('dof')) img = depthOfField(img, scenePass.getViewZNode(), uFocus, uFocal, uBokeh);
  if (!skip.includes('bloom')) {
    const glow = bloom(img.min(vec4(4)), 0.32, 0.5, 0.85); // clamp so specular glints can't flood the frame
    img = img.add(glow);
  }

  // grade: crush blacks to teal, warm the highlights, desaturate mids, vignette
  const grade = Fn(([c]) => {
    const lum = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
    const desat = mix(vec3(lum), c.rgb, 0.72);
    const shadowTint = vec3(0.86, 1.0, 1.06);
    const highTint = vec3(1.08, 0.98, 0.88);
    const graded = mix(desat.mul(shadowTint), desat.mul(highTint), smoothstep(0.05, 0.6, lum));
    const d = length(screenUV.sub(0.5).mul(vec2(1.25, 1.0)));
    const vig = pow(saturate(float(1).sub(d.mul(d).mul(1.25))), 1.4);
    return vec4(max(graded.mul(vig), vec3(0.0005)), 1);
  });
  img = grade(img);
  if (!skip.includes('ca')) img = chromaticAberration(img, uCA, vec2(0.5, 0.5), 1.08);
  img = glitchPass(img, uGlitch, uSeed);
  if (!skip.includes('film')) img = film(img, uGrain);
  pipeline.outputNode = img;

  function drawOverlay(ctx, w, h, s, t) {
    ctx.clearRect(0, 0, w, h);
    // 2.39:1 letterbox
    const contentH = Math.min(h, w / 2.39);
    const bar = Math.ceil((h - contentH) / 2);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, bar);
    ctx.fillRect(0, h - bar, w, bar);
    if (s.black > 0) {
      ctx.globalAlpha = Math.min(1, s.black);
      ctx.fillRect(0, bar - 1, w, contentH + 2); // overlap the bars so no sliver leaks
      ctx.globalAlpha = 1;
    }
    const fade = (t0, t1, inT = 0.8, outT = 0.8) => Math.min(smooth((t - t0) / inT), 1 - smooth((t - (t1 - outT)) / outT));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const c of CAPTIONS) {
      if (t < c.t0 || t > c.t1) continue;
      ctx.globalAlpha = fade(c.t0, c.t1);
      ctx.fillStyle = '#e8e2d6';
      ctx.font = `italic 300 ${Math.round(contentH * 0.046)}px "Cormorant Garamond", serif`;
      ctx.shadowColor = 'rgba(0,0,0,0.9)';
      ctx.shadowBlur = 18;
      const text = c.text;
      ctx.fillText(text, w / 2, h - bar - contentH * 0.13);
      ctx.shadowBlur = 0;
    }
    if (t > TITLE.t0 && t < TITLE.t1) {
      const a = fade(TITLE.t0, TITLE.t1, 2.2, 1.2);
      const size = Math.round(contentH * 0.13);
      ctx.globalAlpha = a;
      ctx.fillStyle = '#e8e2d6';
      ctx.font = `400 ${size}px "Cinzel", serif`;
      if ('letterSpacing' in ctx) ctx.letterSpacing = `${Math.round(size * 0.3)}px`;
      ctx.fillText("HEAVEN'S GATE", w / 2 + size * 0.15, h / 2 - size * 0.15);
      ctx.globalAlpha = a * fade(TITLE.t0 + 1.4, TITLE.t1, 1.5, 1.2) * 0.6;
      const sub = Math.round(contentH * 0.032);
      ctx.font = `italic 300 ${sub}px "Cormorant Garamond", serif`;
      if ('letterSpacing' in ctx) ctx.letterSpacing = `${Math.round(sub * 0.3)}px`;
      ctx.fillText('some doors only open one way', w / 2, h / 2 + size * 0.75);
      if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
    }
    if (t > NAME_CARD.t0) {
      const out = 1 - smooth((t - (NAME_CARD.t1 - 1.0)) / 0.9);
      const layout = { small: [-0.17, 0.034, 400, 'Cinzel', 0.6, 0.7], big: [0.0, 0.13, 400, 'Cinzel', 0.32, 1], italic: [0.16, 0.042, 300, 'Cormorant Garamond', 0.15, 0.8] };
      for (const line of NAME_CARD.lines) {
        if (t < line.t) continue;
        const [dy, sz, weight, family, spacing, alpha] = layout[line.kind];
        const size = Math.round(contentH * sz);
        ctx.globalAlpha = smooth((t - line.t) / (line.kind === 'big' ? 1.6 : 1.1)) * out * alpha;
        ctx.fillStyle = line.kind === 'big' ? '#efe9dd' : '#cfc8bb';
        ctx.font = `${line.kind === 'italic' ? 'italic ' : ''}${weight} ${size}px "${family}", serif`;
        if ('letterSpacing' in ctx) ctx.letterSpacing = `${Math.round(size * spacing)}px`;
        ctx.fillText(line.text, w / 2 + size * spacing * 0.5, h / 2 + contentH * dy);
      }
      if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
    }
    ctx.globalAlpha = 1;
  }

  // ------------------------------------------------------------ per-frame animation
  const tmp = new THREE.Vector3();
  const headWorld = new THREE.Vector3();

  function setOar(oar, st) {
    const s = oar.userData.s;
    oar.rotation.set(0, s * st.sweep, s * -(0.1 + 0.15 * st.dip), 'YXZ');
  }

  // Rings on the water where each blade went in, spreading and fading. Each is placed where the
  // blade was at its catch, recomputed from that moment's boat and stroke, so seeking anywhere
  // shows the same rings.
  const ripples = [];
  for (let i = 0; i < 4; i++) {
    const uA = uniform(0);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), rippleMaterial(uA, i));
    m.renderOrder = 4;
    m.frustumCulled = false;
    scene.add(m);
    ripples.push({ m, uA });
  }
  const ghostBoat = new THREE.Object3D(), ghostOar = new THREE.Object3D();
  ghostBoat.rotation.order = 'YXZ';
  ghostBoat.add(ghostOar);
  function placeRipples(t) {
    const first = ROW.t0 + ROW.catchAt;
    const k = Math.floor((t - first) / ROW.period);
    ripples.forEach((rp, i) => {
      const oar = W.oars[i % 2];
      const tc = first + (k - Math.floor(i / 2)) * ROW.period;
      const age = t - tc;
      if (age < 0 || age > 2.6 || rowStroke(tc).weight < 0.5) { rp.m.visible = false; return; }
      const b = boatState(tc);
      ghostBoat.position.copy(b.pos);
      ghostBoat.rotation.set(b.pitch, b.yaw, b.roll);
      ghostOar.position.copy(oar.position);
      ghostOar.userData.s = oar.userData.s;
      setOar(ghostOar, rowStroke(tc));
      ghostBoat.updateMatrixWorld(true);
      ghostOar.localToWorld(tmp.copy(oar.userData.blade));
      rp.m.visible = true;
      rp.m.position.set(tmp.x, waveHeight(tmp.x, tmp.z, t) + 0.012, tmp.z);
      rp.m.scale.setScalar(0.25 + age * 0.55);
      rp.uA.value = (1 - age / 2.6) ** 1.5;
    });
  }

  function animateWorld(t) {
    uTime.value = t;
    const b = boatState(t);
    W.boatRig.position.copy(b.pos);
    W.boatRig.rotation.set(b.pitch, b.yaw, b.roll, 'YXZ');

    // rowing: the oars, her body and her grip all follow one stroke (rowStroke, shared with the
    // oar sounds); the blades bury in the drive and lift clear on the recovery
    const st = rowStroke(t);
    W.oars.forEach((oar) => setOar(oar, st));
    W.rowKid.rotation.x = -st.lean * 0.55;
    W.bowKid.userData.head.rotation.set(Math.sin(t * 0.4) * 0.04, Math.sin(t * 0.23) * 0.08, 0);
    W.rowKid.userData.head.rotation.set(0.1 - st.lean * 0.15, Math.sin(t * 0.31) * 0.1, Math.sin(t * 0.17) * 0.05);

    W.lanternPivot.rotation.set(-b.pitch + Math.sin(t * 1.3) * 0.09, 0, -b.roll + Math.sin(t * 0.9) * 0.07);
    W.boatRig.updateMatrixWorld(true);
    // hands: the rower's on the oar handles (each hand the oar on its side), the girl's on the pole
    const grip = {};
    for (const oar of W.oars) {
      const p = W.rowKid.worldToLocal(oar.localToWorld(tmp.copy(oar.userData.handle)));
      grip[p.x > 0 ? 'right' : 'left'] = p.clone();
    }
    poseChild(W.rowKid, grip);
    const half = W.pole.userData.len / 2;
    poseChild(W.bowKid, {
      right: W.bowKid.worldToLocal(W.pole.localToWorld(tmp.set(0, -half + 0.1, 0))).clone(),
      left: W.bowKid.worldToLocal(W.pole.localToWorld(tmp.set(0, -half + 0.28, 0))).clone(),
    });
    placeRipples(t);

    const bx = W.buoy.position.x, bz = W.buoy.position.z;
    const [sx, sz] = waveSlope(bx, bz, t);
    W.buoy.position.y = waveHeight(bx, bz, t) - 0.25;
    W.buoy.rotation.set(-sz * 1.5 + Math.sin(t * 0.8) * 0.06, 0, sx * 1.5);
    W.boatRig.updateMatrixWorld(true);
  }

  function placeCreature(c, t) {
    const C = W.creature;
    // slow, heavy life: the chest rises and falls, the skull drifts, the arms sway a little. Set
    // first, every frame, so the pose (and the follow placement below) depends only on t.
    C.upper.scale.set(1 + 0.012 * Math.sin(t * 0.8), 1 + 0.006 * Math.sin(t * 0.8 + 0.4), 1 + 0.016 * Math.sin(t * 0.8));
    C.arms.forEach((arm, i) => {
      arm.rotation.x = 0.035 * Math.sin(t * 0.45 + i * 1.7);
      arm.rotation.z = (i ? 1 : -1) * 0.02 * Math.sin(t * 0.31 + i);
    });
    const driftX = 0.025 * Math.sin(t * 0.37 + 1.1), driftZ = 0.03 * Math.sin(t * 0.23);
    C.root.visible = c.visible; // posed even while hidden, so no frame inherits another's pose
    if (c.follow) {
      C.root.rotation.set(0, c.follow.yaw, 0);
      C.upper.rotation.x = c.follow.lean;
      C.head.rotation.x = c.follow.headPitch - c.follow.lean + driftX;
      C.head.rotation.z = (c.headRoll || 0) + driftZ;
      C.root.position.set(0, 0, 0);
      C.root.updateMatrixWorld(true);
      C.head.getWorldPosition(headWorld);
      C.root.position.copy(c.follow.headAt).sub(headWorld);
    } else {
      C.root.position.copy(c.pos);
      C.root.rotation.set(0, c.yaw, 0);
      C.upper.rotation.x = c.lean;
      C.head.rotation.x = c.headPitch - c.lean + driftX;
      C.head.rotation.z = (c.headRoll || 0) + driftZ;
    }
    C.uEyes.value = c.eyes;
  }

  function aimBeam(s, t) {
    let yaw, pitch;
    if (s.beamAim) {
      tmp.copy(s.beamAim.target).sub(lamp);
      yaw = Math.atan2(tmp.x, tmp.z) + s.beamAim.offset;
      pitch = Math.atan2(-tmp.y, Math.hypot(tmp.x, tmp.z));
    } else {
      yaw = t * 0.45 + 1.2;
      pitch = 0.17;
    }
    const d = tmp.set(Math.sin(yaw) * Math.cos(pitch), -Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
    const aimAt = lamp.clone().add(d);
    beam.lookAt(aimAt);
    spot.target.position.copy(lamp).addScaledVector(d, 120);
    spot.target.updateMatrixWorld();
    uBeam.value = s.beamPower;
    spot.intensity = 150 * s.beamPower;
  }

  let state = baseState();
  function update(t) {
    animateWorld(t);
    const shot = shotAt(t);
    const s = baseState();
    shot.apply(s, t - shot.t0, t, W);
    if (window.__trailer?.override) Object.assign(s, window.__trailer.override);
    if (s.headTurn) W.bowKid.userData.head.rotation.y += s.headTurn;

    camera.position.copy(s.camPos);
    camera.lookAt(s.camLook);
    if (s.roll) camera.rotateZ(s.roll);
    // s.fov is authored for a 16:9 screen; widen/narrow so the 2.39:1 letterbox
    // window shows the same framing on any aspect ratio.
    const contentFrac = Math.min(1, view.w / 2.39 / view.h);
    const visible = THREE.MathUtils.degToRad(s.fov * 0.744);
    camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(visible / 2) / contentFrac));
    camera.aspect = view.w / view.h; // hosts that never report a canvas size leave this at 0 (black picture)
    camera.updateProjectionMatrix();
    W.sky.position.copy(camera.position);

    uFogDensity.value = s.fog;
    renderer.toneMappingExposure = BASE_EXPOSURE * s.exposure;
    uGod.value.setRGB(0.55, 0.62, 0.7).multiplyScalar(s.godrays * 0.22);
    uFocus.value = s.focus;
    uFocal.value = s.focal;
    uBokeh.value = s.bokeh;
    uCA.value = s.ca;
    uGrain.value = s.grain;
    uGlitch.value = s.glitch;
    uSeed.value = Math.floor(t * 30) % 997; // new random pattern every 1/30 s, so it is the same on every render

    const fl = s.lantern > 0 ? flicker(t) : 0;
    W.lanternLight.intensity = 11 * s.lantern * fl;
    W.uLanternGlow.value = 1.3 * s.lantern * fl;

    aimBeam(s, t);
    placeCreature(s.creature, t);
    W.gateLeft.rotation.y = s.gateOpen;
    ghosts.visible = s.ghosts;
    W.man.root.visible = s.man;
    if (s.man) updateGuardian(W.man, t, { smile: s.smile, tilt: s.manTilt, open: s.mouthOpen });
    key.visible = s.keyLight > 0;
    key.intensity = 7.5 * s.keyLight;
    rim.visible = key.visible;
    rim.intensity = 2.2 * s.keyLight;
    state = s;
  }

  const drawSize = new THREE.Vector2();
  let lastDrawW = -1, lastDrawH = -1;

  return {
    W, scene, camera, renderer, pipeline, moon, hemi, spot, view, drawOverlay, update,
    get state() { return state; },
    U: { uGod, uFocus, uFocal, uBokeh, uCA, uGrain, uBeam },
    // `manualTick`: when frames are rendered outside an animation loop (offline / Remotion)
    // three's node frame has to be advanced by hand or passes skip re-rendering.
    render(manualTick = false) {
      // WebGPU caches the default pass (including its depth buffer) at whatever size the canvas
      // had when it was first used. If the host resizes the canvas afterwards (Remotion Studio
      // starts at 300x150, then sets 1920x1080) the cache can go stale and every draw is rejected
      // with "depth stencil attachment size does not match". Rebuild it when the size changes.
      renderer.getDrawingBufferSize(drawSize);
      if (drawSize.x !== lastDrawW || drawSize.y !== lastDrawH) {
        lastDrawW = drawSize.x;
        lastDrawH = drawSize.y;
        renderer.backend?.updateSize?.();
      }
      if (manualTick) {
        const nf = renderer._nodes.nodeFrame;
        nf.update();
        renderer.info.frame = nf.frameId;
      }
      pipeline.render();
    },
  };
}
