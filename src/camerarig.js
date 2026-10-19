// Blender-style camera view for the standalone viewer: every shot camera drawn in the
// world as a frustum gizmo with its path, a list panel to switch each one on or off, and a
// "look through" button that cuts to that shot camera. Press V to show or hide the panel.
// Lives only in the viewer (npm run dev), never in Remotion, so nothing here can reach a render.
import * as THREE from 'three/webgpu';

const SKIP = new Set(['cold open', 'name card']); // black screens, no camera worth showing
const SAMPLES = 10;
const GIZMO_DEPTH = 3; // how far the frustum extends, in metres

export function createCameraRig({ scene, camera, engine, SHOTS, shotAt, labelsEl, panelEl, lookThrough }) {
  const root = new THREE.Group();
  root.visible = false;
  scene.add(root);

  const cams = []; // { shot, color, group, labelEl, rowEl, checkbox, samples }
  let built = false;
  let showPanel = false;
  let marker = null;

  const V = (x, y, z) => new THREE.Vector3(x, y, z);

  function frustumLines(pos, look, fovDeg) {
    const fwd = look.clone().sub(pos).normalize();
    const right = new THREE.Vector3().crossVectors(fwd, V(0, 1, 0));
    if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
    right.normalize();
    const up = new THREE.Vector3().crossVectors(right, fwd).normalize();
    // shots are authored for 16:9 and cropped to a 2.39:1 letterbox, which is what you actually see
    const halfH = GIZMO_DEPTH * Math.tan(THREE.MathUtils.degToRad(fovDeg * 0.744) / 2);
    const halfW = halfH * 2.39;
    const c = pos.clone().addScaledVector(fwd, GIZMO_DEPTH);
    const corner = (sx, sy) => c.clone().addScaledVector(right, sx * halfW).addScaledVector(up, sy * halfH);
    const a = corner(-1, 1), b = corner(1, 1), d = corner(1, -1), e = corner(-1, -1);
    // little "up" triangle above the frame, like a Blender camera
    const t0 = c.clone().addScaledVector(up, halfH * 1.05).addScaledVector(right, -halfW * 0.3);
    const t1 = c.clone().addScaledVector(up, halfH * 1.05).addScaledVector(right, halfW * 0.3);
    const t2 = c.clone().addScaledVector(up, halfH * 1.5);
    const seg = [
      pos, a, pos, b, pos, d, pos, e,
      a, b, b, d, d, e, e, a,
      t0, t1, t1, t2, t2, t0,
      pos, c,
    ];
    return new THREE.BufferGeometry().setFromPoints(seg);
  }

  function lineMat(color, opacity = 1) {
    const m = new THREE.LineBasicNodeMaterial({ color, transparent: true, opacity, depthTest: false });
    m.fog = false;
    m.toneMapped = false;
    return m;
  }

  function dotMat(color) {
    const m = new THREE.MeshBasicNodeMaterial({ color, depthTest: false });
    m.fog = false;
    m.toneMapped = false;
    return m;
  }

  // Sampling runs the shot code at several times, which also moves the boat etc.; the
  // scene is put back to the current time at the end.
  function build(currentT) {
    const shots = SHOTS.filter((s) => !SKIP.has(s.name));
    shots.forEach((shot, i) => {
      const color = new THREE.Color().setHSL(i / shots.length, 0.8, 0.5);
      const samples = [];
      for (let k = 0; k <= SAMPLES; k++) {
        const t = shot.t0 + (shot.t1 - shot.t0) * Math.min(k / SAMPLES, 0.999);
        engine.update(t);
        const s = engine.state;
        samples.push({ pos: s.camPos.clone(), look: s.camLook.clone(), fov: s.fov });
      }
      const group = new THREE.Group();
      // gizmo at the START of the shot, path to the end
      const g = new THREE.LineSegments(frustumLines(samples[0].pos, samples[0].look, samples[0].fov), lineMat(color));
      g.renderOrder = 999;
      const path = new THREE.Line(new THREE.BufferGeometry().setFromPoints(samples.map((p) => p.pos)), lineMat(color, 0.8));
      path.renderOrder = 999;
      const end = new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 8), dotMat(color));
      end.position.copy(samples[samples.length - 1].pos);
      end.renderOrder = 999;
      const start = new THREE.Mesh(new THREE.SphereGeometry(0.035, 12, 8), dotMat(0xbbbbbb));
      start.position.copy(samples[0].pos);
      start.renderOrder = 999;
      group.add(g, path, end, start);
      root.add(group);

      const labelEl = document.createElement('div');
      labelEl.className = 'camlabel';
      labelEl.textContent = shot.name;
      labelEl.style.color = '#' + color.getHexString();
      labelsEl.appendChild(labelEl);

      const rowEl = document.createElement('label');
      rowEl.className = 'camrow';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = true;
      checkbox.addEventListener('change', () => { group.visible = checkbox.checked; });
      const dot = document.createElement('span');
      dot.className = 'camdot';
      dot.style.background = '#' + color.getHexString();
      const name = document.createElement('span');
      name.className = 'camname';
      name.textContent = shot.name;
      const time = document.createElement('span');
      time.className = 'camtime';
      time.textContent = `${shot.t0}-${shot.t1}s`;
      const view = document.createElement('button');
      view.textContent = 'view';
      view.title = 'Look through this camera';
      view.addEventListener('click', (e) => { e.preventDefault(); lookThrough(shot); });
      rowEl.append(checkbox, dot, name, time, view);
      panelEl.querySelector('.camlist').appendChild(rowEl);

      cams.push({ shot, color, group, labelEl, rowEl, checkbox, samples });
    });

    // marker for where the active shot camera is right now
    marker = new THREE.Mesh(new THREE.SphereGeometry(0.08, 16, 12), dotMat(0xdddddd));
    marker.renderOrder = 1000;
    root.add(marker);
    built = true;
    engine.update(currentT);
  }

  function setAll(on) {
    cams.forEach((c) => { c.checkbox.checked = on; c.group.visible = on; });
  }

  panelEl.querySelector('.camall').addEventListener('click', () => setAll(true));
  panelEl.querySelector('.camnone').addEventListener('click', () => setAll(false));

  const tmp = new THREE.Vector3();
  const rig = {
    getTime: () => 0, // set by the viewer: returns the current trailer time
    toggle() {
      showPanel = !showPanel;
      if (showPanel && !built) build(rig.getTime());
      root.visible = showPanel;
      panelEl.style.display = showPanel ? 'block' : 'none';
      labelsEl.style.display = showPanel ? 'block' : 'none';
    },
    get visible() { return showPanel; },
    // call every frame, after engine.update(t)
    update(t, hudHidden, flying = false) {
      const on = showPanel && !hudHidden;
      panelEl.style.display = on ? 'block' : 'none';
      labelsEl.style.display = on ? 'block' : 'none';
      if (!on || !built) return;
      const active = shotAt(t);
      marker.visible = flying; // only useful while flying: shows where the shot camera really is
      marker.position.copy(engine.state.camPos); // the real shot camera, even while you fly elsewhere
      for (const c of cams) {
        const isActive = c.shot === active;
        c.rowEl.classList.toggle('active', isActive);
        tmp.copy(c.samples[0].pos).project(camera);
        const visible = c.group.visible && tmp.z < 1 && Math.abs(tmp.x) < 1.2 && Math.abs(tmp.y) < 1.2;
        c.labelEl.style.display = visible ? 'block' : 'none';
        if (visible) c.labelEl.style.transform = `translate(${(tmp.x * 0.5 + 0.5) * innerWidth}px, ${(-tmp.y * 0.5 + 0.5) * innerHeight}px)`;
        c.labelEl.classList.toggle('active', isActive);
      }
    },
  };

  addEventListener('keydown', (e) => {
    const tag = e.target?.tagName;
    if (['TEXTAREA', 'SELECT'].includes(tag) || (tag === 'INPUT' && e.target.type !== 'checkbox')) return;
    if (e.key.toLowerCase() === 'v' && !e.ctrlKey && !e.metaKey && !e.altKey) rig.toggle();
  });

  return rig;
}
