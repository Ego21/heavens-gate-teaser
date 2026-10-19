// Free-fly camera for the standalone viewer (npm run dev). Press F to toggle.
// Not used by Remotion, so it can never leak into a render.
import * as THREE from 'three/webgpu';

const TURN_RATE = 1.4; // radians per second for Q / E (about 80 degrees)

export function createFreeCam(camera, element) {
  const pos = new THREE.Vector3();
  const fwd = new THREE.Vector3();
  const right = new THREE.Vector3();
  const euler = new THREE.Euler(0, 0, 0, 'YXZ');
  const keys = new Set();
  const st = { active: false, yaw: 0, pitch: 0, speed: 8, fov: 60, dragging: false };

  const typing = (e) => ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target?.tagName);

  function enter() {
    // start exactly where the current shot's camera is
    pos.copy(camera.position);
    euler.setFromQuaternion(camera.quaternion, 'YXZ');
    st.yaw = euler.y;
    st.pitch = euler.x;
    st.active = true;
  }
  const exit = () => { st.active = false; st.dragging = false; keys.clear(); };
  const toggle = () => (st.active ? exit() : enter());

  function direction() {
    euler.set(st.pitch, st.yaw, 0, 'YXZ');
    return fwd.set(0, 0, -1).applyEuler(euler);
  }

  // Call once per frame, after the engine has positioned the camera for the shot.
  function apply(dt, aspect) {
    if (!st.active) return;
    direction();
    right.crossVectors(fwd, camera.up).normalize();
    const v = st.speed * dt;
    if (keys.has('w')) pos.addScaledVector(fwd, v);
    if (keys.has('s')) pos.addScaledVector(fwd, -v);
    if (keys.has('d')) pos.addScaledVector(right, v);
    if (keys.has('a')) pos.addScaledVector(right, -v);
    if (keys.has('shift')) pos.y += v; // Shift = up
    if (keys.has('control')) pos.y -= v; // Ctrl = down
    if (keys.has('q')) st.yaw += TURN_RATE * dt; // Q = look left
    if (keys.has('e')) st.yaw -= TURN_RATE * dt; // E = look right
    // yaw changed after the direction was computed above, so refresh the camera from it below
    camera.position.copy(pos);
    camera.rotation.set(st.pitch, st.yaw, 0, 'YXZ');
    camera.fov = st.fov;
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
  }

  // Text you can paste into a shot in src/shots.js.
  function snippet() {
    const f = direction();
    const look = pos.clone().addScaledVector(f, 10);
    const n = (x) => +x.toFixed(2);
    return `s.camPos = V(${n(pos.x)}, ${n(pos.y)}, ${n(pos.z)});\ns.camLook = V(${n(look.x)}, ${n(look.y)}, ${n(look.z)});`;
  }

  function info() {
    return `FREE CAM  pos ${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}  ·  yaw ${(THREE.MathUtils.radToDeg(st.yaw)).toFixed(0)}°  pitch ${(THREE.MathUtils.radToDeg(st.pitch)).toFixed(0)}°  ·  speed ${st.speed.toFixed(1)}`;
  }

  addEventListener('keydown', (e) => {
    if (typing(e) || e.altKey || e.metaKey) return;
    const k = e.key.toLowerCase();
    if (k === 'f' && !e.ctrlKey) { toggle(); return; }
    if (!st.active) return;
    if (k === 'c' && !e.ctrlKey) {
      const text = snippet();
      navigator.clipboard?.writeText(text).catch(() => {});
      st.copied = text;
      return;
    }
    keys.add(k);
    if (['w', 'a', 's', 'd', 'q', 'e'].includes(k)) e.preventDefault();
  });
  addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
  addEventListener('blur', () => keys.clear());

  element.addEventListener('pointerdown', (e) => {
    if (!st.active) return;
    st.dragging = true;
    element.setPointerCapture?.(e.pointerId);
  });
  addEventListener('pointerup', () => { st.dragging = false; });
  addEventListener('pointermove', (e) => {
    if (!st.active || !st.dragging) return;
    st.yaw -= e.movementX * 0.0035;
    st.pitch = THREE.MathUtils.clamp(st.pitch - e.movementY * 0.0035, -1.55, 1.55);
  });
  element.addEventListener('wheel', (e) => {
    if (!st.active) return;
    e.preventDefault();
    st.speed = THREE.MathUtils.clamp(st.speed * Math.pow(1.12, -Math.sign(e.deltaY)), 0.3, 200);
  }, { passive: false });

  return { get active() { return st.active; }, get copied() { return st.copied; }, enter, exit, toggle, apply, info, snippet };
}
