// The edit: every shot is a pure function of time, so the trailer is
// deterministic (scrub, restart and record all give identical frames).
import * as THREE from 'three/webgpu';
import { waveHeight } from './materials.js';

export const DURATION = 74.5;

export const CAPTIONS = [
  { t0: 1.0, t1: 3.7, text: 'Mother said the sea would carry us home.' },
  { t0: 27.6, t1: 31.8, text: 'She never told us who keeps the gate.' },
];
export const TITLE = { t0: 48.3, t1: 54.6 };
export const NAME_CARD = { t0: 67.6, t1: 74.5, lines: [
  { t: 68.0, text: 'THE DEVIL MAN', kind: 'small' },
  { t: 69.0, text: 'IMI', kind: 'big' },
  { t: 70.3, text: 'Left Hand of God', kind: 'italic' },
] };

// ---------------------------------------------------------------- utilities
const clamp01 = (x) => Math.min(1, Math.max(0, x));
export const smooth = (x) => { x = clamp01(x); return x * x * x * (x * (x * 6 - 15) + 10); };
const lerp = (a, b, k) => a + (b - a) * k;
const V = (x, y, z) => new THREE.Vector3(x, y, z);
const lerpV = (a, b, k) => a.clone().lerp(b, k);

// layered sines read as handheld camera drift
function handheld(t, amp, seed = 0) {
  const n = (f, p) => Math.sin(t * f + p + seed) * 0.6 + Math.sin(t * f * 2.31 + p * 1.7 + seed) * 0.3 + Math.sin(t * f * 5.13 + p * 0.3) * 0.1;
  return V(n(0.71, 0.3) * amp, n(0.53, 1.9) * amp * 0.7, n(0.37, 4.2) * amp * 0.4);
}

// a stuttering flame, deterministic
export function flicker(t) {
  return 0.86 + Math.sin(t * 13.1) * 0.05 + Math.sin(t * 27.7 + 1.3) * 0.04 + Math.sin(t * 61.3) * 0.03 + Math.sin(t * 3.7) * 0.04;
}

// The rowboat floats like a rigid hull: height, pitch and roll come from the water level under
// five points of the hull, not from the wave at one spot. The hull is 0.55 m deep and floats
// with 0.29 m of it under water, so the rim sits about 0.26 m above the surface.
export const BOAT = { L: 3.3, B: 0.62, D: 0.55, waterlineAboveKeel: 0.29 };
const ORIGIN_ABOVE_WATER = BOAT.D - BOAT.waterlineAboveKeel; // 0.26 m: rim sits well above the water

// The creature vanishes at VANISH_T. Just before it stutters in and out; right after, the picture
// breaks up like a failing display. One function drives both the image and the buzzer sound,
// so they always agree.
export const VANISH_T = 36.9;
const FLICKER_FROM = 36.62;
const flickerSpike = (t) => t > FLICKER_FROM && t < VANISH_T && Math.sin(t * 70) > 0.55;
export function glitchAt(t) {
  if (t < FLICKER_FROM || t > VANISH_T + 0.85) return 0;
  if (t < VANISH_T) return flickerSpike(t) ? 0.4 : 0;
  const k = t - VANISH_T; // 0 .. 0.85 seconds after it is gone
  const decay = 1 - k / 0.85;
  const gate = Math.sin(k * 38 + Math.sin(k * 11) * 2) > -0.35 ? 1 : 0.12; // hard on/off stutter
  const fadeOut = 1 - smooth((k - 0.7) / 0.15);
  return gate * (0.45 + 0.55 * decay) * fadeOut;
}

// The rowing stroke, shared by picture and sound: a stroke every ROW.period seconds from
// ROW.t0 (the rowlock creaks then), the blades enter the water ROW.catchAt seconds later. The
// rower faces the stern: at the catch she reaches toward it with the blades swung toward the
// bow, pulls through the drive with the blades buried, lifts them, and swings back.
// Returns, for that instant: sweep (oar yaw, starboard sign), dip (0 blade out .. 1 buried),
// lean (her body, + reaching toward the stern) and weight (rowing fades out as they arrive).
export const ROW = { t0: 12.3, period: 2.6, catchAt: 0.55, until: 27.4 };
const DRIVE = 0.39; // fraction of the cycle the blades spend in the water
export function rowStroke(t) {
  const w = ((((t - ROW.t0 - ROW.catchAt) / ROW.period) % 1) + 1) % 1; // 0 at the catch
  const drive = w < DRIVE;
  const k = drive ? smooth(w / DRIVE) : smooth((w - DRIVE) / (1 - DRIVE));
  const sweep = drive ? lerp(0.5, -0.45, k) : lerp(-0.45, 0.5, k);
  const dip = w < 0.5 ? 1 - smooth((w - 0.34) / 0.08) : smooth((w - 0.92) / 0.08);
  const lean = drive ? lerp(0.28, -0.22, k) : lerp(-0.22, 0.28, k);
  const weight = 1 - smooth((t - (ROW.until - 0.8)) / 1.2);
  return { sweep: sweep * weight + 0.25 * (1 - weight), dip: dip * weight, lean: lean * weight + 0.05 * (1 - weight), weight, w };
}

export function boatState(t) {
  const x = 0.6 * Math.sin(t * 0.07);
  const z = 6 - 0.5 * t;
  const yaw = Math.sin(t * 0.21) * 0.05;
  const c = Math.cos(yaw), sn = Math.sin(yaw);
  // water height under a point given in the boat's own (x = starboard, z = stern) coordinates
  const at = (lx, lz) => waveHeight(x + lx * c + lz * sn, z - lx * sn + lz * c, t);
  const bow = at(0, -BOAT.L * 0.4), stern = at(0, BOAT.L * 0.4);
  const port = at(-BOAT.B * 0.9, 0), starboard = at(BOAT.B * 0.9, 0), mid = at(0, 0);
  const heave = (bow + stern + port + starboard + 2 * mid) / 6;
  // bow is at -z: it rises when the water is higher there. +roll lifts the +x (starboard) side.
  const pitch = Math.atan2(bow - stern, BOAT.L * 0.8);
  const roll = Math.atan2(starboard - port, BOAT.B * 1.8);
  return { pos: V(x, heave + ORIGIN_ABOVE_WATER, z), pitch, roll, yaw };
}

// ---------------------------------------------------------------- default state per frame
export function baseState() {
  return {
    camPos: V(0, 2, 10), camLook: V(0, 1, 0), fov: 35, roll: 0,
    exposure: 1.0, fog: 0.028, godrays: 0.0, focus: 10, focal: 6, bokeh: 1.5, ca: 0.15, grain: 0.22,
    lantern: 1.0, beamAim: null, beamPower: 1.0,
    creature: { visible: false, pos: V(0, 0, 0), yaw: 0, lean: 0.2, headPitch: 0.5, eyes: 0, follow: null },
    glitch: 0,
    // manTilt tilts his head; mouthOpen (jaw, 0..1) is for speech, and no shot has any yet
    gateOpen: 0.55, ghosts: false, man: false, smile: 0, keyLight: 0, manTilt: 0, mouthOpen: 0,
    black: 0, bars: 1,
  };
}

const CREATURE_POS = V(-14, 0, -34);

// ---------------------------------------------------------------- shots
export const SHOTS = [
  {
    name: 'cold open', t0: 0, t1: 4,
    apply(s) { s.black = 1; },
  },
  {
    name: 'the approach', t0: 4, t1: 12,
    apply(s, lt, t) {
      const k = smooth(lt / 8);
      const b = boatState(t);
      s.camPos = lerpV(V(9.5, 0.45, 38), V(7.2, 0.6, 32.5), k).add(handheld(t, 0.05));
      s.camLook = lerpV(V(0, 2.2, -40), b.pos.clone().add(V(0, 1.0, -8)), 0.55);
      s.fov = 30;
      s.focus = s.camPos.distanceTo(b.pos);
      s.focal = 40;
      s.godrays = 0.7;
      s.black = 1 - smooth(lt / 2.2);
    },
  },
  {
    name: 'two children', t0: 12, t1: 20,
    apply(s, lt, t) {
      const b = boatState(t);
      const k = smooth(lt / 8);
      s.camPos = b.pos.clone().add(lerpV(V(-4.8, 0.95, 2.4), V(-4.2, 0.75, -1.2), k)).add(handheld(t, 0.06, 2));
      s.camPos.y = Math.max(s.camPos.y, waveHeight(s.camPos.x, s.camPos.z, t) + 0.35);
      s.camLook = b.pos.clone().add(V(0, 0.45, -0.2));
      s.fov = 34;
      s.focus = s.camPos.distanceTo(b.pos);
      s.focal = 3.5;
      s.bokeh = 2.2;
      s.godrays = 0.25;
    },
  },
  {
    name: 'the gate', t0: 20, t1: 27.4,
    apply(s, lt, t) {
      const b = boatState(t);
      const k = smooth(lt / 7.4);
      s.camPos = b.pos.clone().add(lerpV(V(0.75, 1.55, 3.3), V(0.5, 1.4, 2.5), k)).add(handheld(t, 0.04, 5));
      s.camLook = lerpV(V(0, -2.4, -62), V(0, -1.5, -62), k);
      s.fov = lerp(42, 36, k);
      s.focus = 55;
      s.focal = 40;
      s.godrays = 1.0;
      s.beamPower = 1.0;
    },
  },
  {
    name: 'she turns', t0: 27.4, t1: 32.6,
    apply(s, lt, t, w) {
      const b = boatState(t);
      const head = w.bowKid.userData.head.getWorldPosition(new THREE.Vector3());
      const k = smooth(lt / 5.2);
      s.camPos = head.clone().add(lerpV(V(-0.62, 0.02, -1.55), V(-0.5, 0.0, -1.25), k)).add(handheld(t, 0.012, 9));
      s.camLook = head.clone().add(V(0.12, -0.08, 0));
      s.fov = 30;
      s.focus = s.camPos.distanceTo(head) - 0.12;
      s.focal = 0.9;
      s.bokeh = 3.0;
      s.godrays = 0.2;
      s.headTurn = smooth((lt - 1.6) / 2.6) * 1.05; // slowly looks toward the dark
      void b;
    },
  },
  {
    name: 'the keeper', t0: 32.6, t1: 40,
    apply(s, lt, t) {
      const k = smooth(lt / 7.4);
      s.camPos = lerpV(V(3.0, 0.55, -4.0), V(2.4, 0.6, -5.6), k).add(handheld(t, 0.03, 13));
      s.camLook = V(-9, 7.0, -36);
      s.fov = 37;
      s.focus = 40;
      s.focal = 40;
      s.godrays = 0.6;
      // the beam sweeps slowly, lingers on it... and on the second pass it's gone
      s.beamAim = { target: CREATURE_POS.clone().add(V(0, 10.5, 0)), offset: 0.3 * Math.sin(((t - 34.8) * Math.PI) / 3.5) };
      s.beamPower = 1.6;
      s.creature.visible = t < VANISH_T && !flickerSpike(t);
      s.glitch = glitchAt(t);
      s.creature.pos = CREATURE_POS.clone().add(V(0, -1.8, 0));
      s.creature.yaw = 0.567;
      s.creature.lean = 0.22;
      s.creature.headPitch = 0.45;
      s.creature.headRoll = 0.12;
      s.ca = 0.3;
      s.fog = 0.024;
    },
  },
  {
    name: 'the light dies', t0: 40, t1: 45.3,
    apply(s, lt, t) {
      const b = boatState(t);
      s.camPos = b.pos.clone().add(V(2.4, 0.8, -1.6)).add(handheld(t, 0.025, 21));
      s.camLook = b.pos.clone().add(V(0, 0.55, -0.6));
      s.fov = 36;
      s.focus = s.camPos.distanceTo(b.pos);
      s.focal = 2.5;
      s.godrays = 0.15;
      // sputter, sputter... out
      const sput = lt < 2.6 ? (Math.sin(lt * 31) > 0.2 - lt * 0.35 ? 1 : 0.15) * flicker(t * 2.5) : 0;
      s.lantern = sput;
      s.exposure = lt > 2.6 ? 0.85 : 1.0;
    },
  },
  {
    name: 'behind you', t0: 45.3, t1: 47.2,
    apply(s, lt, t) {
      const b = boatState(t);
      s.camPos = b.pos.clone().add(V(-1.0, 0.55, -3.3)).add(handheld(t, 0.02 + (lt > 0.75 ? 0.05 : 0), 30));
      s.camLook = b.pos.clone().add(V(-0.1, 1.5, 2.0));
      s.fov = 44;
      s.focus = 3.0;
      s.focal = 3.5;
      s.godrays = 0.1;
      s.lantern = lt < 0.3 ? 0 : (lt < 0.42 ? 2.6 : flicker(t) * 1.25); // relights with a flare
      s.creature.visible = true;
      s.creature.follow = { headAt: b.pos.clone().add(V(0, 2.25 + smooth((lt - 0.5) / 1.4) * -0.35, 2.15)), yaw: Math.PI, lean: 1.12, headPitch: 0.55 };
      s.creature.eyes = lt > 0.75 ? 4 : 0;
      s.creature.headRoll = -0.32;
      s.ca = lt > 0.75 ? 1.2 : 0.3;
    },
  },
  {
    name: 'title', t0: 47.2, t1: 55.0,
    apply(s, lt, t) {
      const k = smooth(lt / 7.8);
      s.camPos = lerpV(V(0, 2.4, -34), V(0, 2.6, -38), k).add(handheld(t, 0.02, 40));
      s.camLook = V(0, 5.0, -62);
      s.fov = 40;
      s.focus = 25;
      s.focal = 30;
      s.godrays = 0.9;
      s.exposure = 0.38;
      s.lantern = 0;
      s.black = lt < 0.9 ? 1 : 1 - smooth((lt - 0.9) / 2.5) * 0.55;
      if (lt > 6.6) s.black = lerp(0.45, 1, smooth((lt - 6.6) / 1.0));
    },
  },
  {
    name: 'sting', t0: 55.0, t1: 61.6,
    apply(s, lt, t) {
      s.camPos = V(1.2, 2.0, -50.5).add(handheld(t, 0.012, 50));
      s.camLook = V(0, 2.4, -62);
      s.fov = 34;
      s.focus = 11.5;
      s.focal = 8;
      s.godrays = 1.0;
      s.lantern = 0;
      s.black = lt < 1.3 ? 1 : 1 - smooth((lt - 1.3) / 1.2);
      if (lt > 6.5) s.black = 1;
      // the gate swings shut; the beam passes; two small figures stand behind it
      s.gateOpen = lerp(0.55, 0.0, Math.pow(clamp01((lt - 1.6) / 3.4), 2.2));
      s.ghosts = true;
      s.man = true; // standing behind the children
      s.keyLight = lt < 4.6 ? 1.2 : 3.5; // the white shroud catches the light once the gate is shut
      s.beamAim = { target: V(0, 1.8, -64), offset: (lt - 5.7) * 0.28 };
      s.beamPower = 2.2;
    },
  },
  {
    name: 'the smile', t0: 61.6, t1: 67.6,
    apply(s, lt, t, w) {
      // through the gap between the children, into the hood
      const face = w.man.root.position.clone().add(V(0, 1.82, 0.1));
      const k = smooth(lt / 6.0);
      s.camPos = face.clone().add(lerpV(V(0.05, -0.1, 2.75), V(0.03, -0.05, 1.95), k)).add(handheld(t, 0.006, 60));
      s.camLook = face.clone().add(V(0, -0.02, 0));
      s.fov = 20;
      s.camLook.y += 0.06;
      s.focus = s.camPos.distanceTo(face) - 0.08;
      s.focal = 0.9;
      s.exposure = 0.85;
      s.bokeh = 2.5;
      s.godrays = 0;
      s.fog = 0.012;
      s.lantern = 0;
      s.gateOpen = 0;
      s.ghosts = true;
      s.man = true;
      s.keyLight = 1;
      s.smile = smooth((lt - 2.2) / 2.6);
      s.manTilt = smooth((lt - 3.6) / 1.8) * 0.06;
      s.black = lt < 0.25 ? 1 - lt / 0.25 : 0;
      if (lt > 5.85) s.black = 1;
      s.ca = 0.2 + s.smile * 0.25;
    },
  },
  {
    name: 'name card', t0: 67.6, t1: 74.5,
    apply(s) { s.black = 1; },
  },
];

export function shotAt(t) {
  for (const sh of SHOTS) if (t >= sh.t0 && t < sh.t1) return sh;
  return SHOTS[SHOTS.length - 1];
}
