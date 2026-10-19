import * as THREE from 'three/webgpu';
import { createTrailer, BASE_EXPOSURE } from './engine.js';
import { createFreeCam } from './freecam.js';
import { createCameraRig } from './camerarig.js';
import { SHOTS, shotAt, DURATION } from './shots.js';
import { Score } from './audio.js';
import { Output, Mp4OutputFormat, StreamTarget, CanvasSource, AudioBufferSource, getFirstEncodableVideoCodec, canEncodeAudio } from 'mediabunny';

const params = new URLSearchParams(location.search);
const LOW = params.get('q') === 'low';
const START = parseFloat(params.get('t') || '0');
const RENDER = params.get('render'); // e.g. ?render=4k  (optional &fps=30&from=0&to=74.5)

async function main() {
  console.info('[trailer] boot');
  const canvas = document.getElementById('view');
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, LOW ? 0.7 : 1.25));
  renderer.setSize(innerWidth, innerHeight, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = BASE_EXPOSURE;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  await renderer.init();
  const backendName = renderer.backend.isWebGPUBackend ? 'WebGPU' : 'WebGL2 fallback';
  document.getElementById('backend').textContent = backendName;

  // ------------------------------------------------------------ scene + post (shared engine)
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, innerWidth / innerHeight, 0.05, 1500);
  const engine = createTrailer({ renderer, scene, camera, low: LOW });
  const { W, pipeline, moon, hemi, spot, U, view } = engine;
  view.w = innerWidth;
  view.h = innerHeight;

  // ------------------------------------------------------------ overlay (titles drawn into a 2D canvas so they record)
  const overlay = document.getElementById('overlay');
  const octx = overlay.getContext('2d');
  function sizeOverlay() {
    overlay.width = Math.round(innerWidth * devicePixelRatio);
    overlay.height = Math.round(innerHeight * devicePixelRatio);
  }
  sizeOverlay();

  // ------------------------------------------------------------ free camera (press F)
  const free = createFreeCam(camera, canvas);
  const camEl = document.getElementById('cam');

  // controls card: ? toggles it, and the buttons do the same
  const legend = document.getElementById('legend');
  const toggleLegend = () => legend.classList.toggle('collapsed');
  document.getElementById('legend-close').addEventListener('click', toggleLegend);
  document.getElementById('legend-open').addEventListener('click', toggleLegend);
  addEventListener('keydown', (e) => { if (e.key === '?') toggleLegend(); });

  // ------------------------------------------------------------ camera view (press V)
  const rig = createCameraRig({
    scene, camera, engine, SHOTS, shotAt,
    labelsEl: document.getElementById('camlabels'),
    panelEl: document.getElementById('campanel'),
    lookThrough: (shot) => { free.exit(); seek(shot.t0 + Math.min(0.6, (shot.t1 - shot.t0) / 2)); },
  });

  // ------------------------------------------------------------ transport
  let score = null;
  let t = START;
  let playing = false;
  let last = performance.now();
  const clockEl = document.getElementById('clock');
  rig.getTime = () => t;

  function now() {
    // audio clock is the master when it is running
    if (score && playing && score.ctx.state === 'running') return score.time;
    return t;
  }

  async function seek(to) {
    t = Math.max(0, Math.min(DURATION - 0.01, to));
    if (score && playing) await score.start(t);
  }

  function frame() {
    if (!innerWidth || !innerHeight) return; // hidden pane / minimised: nothing to draw into
    const n = performance.now();
    if (playing) {
      if (score && score.ctx.state === 'running') t = score.time;
      else t += Math.min(0.1, (n - last) / 1000);
      if (t >= DURATION) {
        t = DURATION - 0.001;
        playing = false;
        if (recorder) stopRecording();
      }
    }
    const dt = Math.min(0.1, (n - last) / 1000);
    last = n;
    engine.update(t);
    if (free.active) {
      free.apply(dt, innerWidth / innerHeight);
      engine.W.sky.position.copy(camera.position); // sky dome follows the camera
      engine.U.uBokeh.value = 0; // the shot's depth of field makes no sense off-script
    }
    engine.render();
    if (free.active) octx.clearRect(0, 0, overlay.width, overlay.height); // no letterbox or titles while exploring
    else engine.drawOverlay(octx, overlay.width, overlay.height, engine.state, t);
    rig.update(t, document.getElementById('hud').classList.contains('hidden'), free.active);
    camEl.textContent = free.active ? free.info() + (free.copied ? '  ·  copied shot code' : '') : '';
    if (recorder) composite();
    clockEl.textContent = `${t.toFixed(1)}s · ${shotAt(t).name}`;
  }

  // compile everything once before the user hits Enter
  engine.update(t);
  await renderer.compileAsync(scene, camera);
  renderer.setAnimationLoop(frame);

  if (params.get('free')) setTimeout(() => free.enter(), 1500);

  const playBtn = document.getElementById('play');
  playBtn.disabled = false;
  playBtn.textContent = 'Enter';
  playBtn.addEventListener('click', async () => {
    await document.fonts.ready;
    score = new Score();
    playing = true;
    await score.start(t);
    document.getElementById('gate').classList.add('gone');
    document.getElementById('hud').classList.remove('hidden');
  });

  addEventListener('keydown', async (e) => {
    if (!score) return;
    if (e.code === 'Space') {
      e.preventDefault();
      playing = !playing;
      if (playing) await score.start(t);
      else score.stopAll();
    } else if (e.code === 'KeyR') {
      await seek(0);
    } else if (e.code === 'ArrowRight') {
      await seek(now() + 5);
    } else if (e.code === 'ArrowLeft') {
      await seek(now() - 5);
    } else if (e.code === 'KeyH') {
      document.getElementById('hud').classList.toggle('hidden');
    }
  });

  // ------------------------------------------------------------ recording
  let recorder = null, chunks = [], recCanvas = null, recCtx = null;
  const recBtn = document.getElementById('rec');

  function composite() {
    recCtx.drawImage(canvas, 0, 0, recCanvas.width, recCanvas.height);
    recCtx.drawImage(overlay, 0, 0, recCanvas.width, recCanvas.height);
  }

  async function startRecording() {
    recCanvas = document.createElement('canvas');
    recCanvas.width = 1920;
    recCanvas.height = 1080;
    recCtx = recCanvas.getContext('2d');
    const stream = recCanvas.captureStream(60);
    for (const track of score.stream.stream.getAudioTracks()) stream.addTrack(track);
    const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));
    recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 24_000_000 });
    chunks = [];
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: 'video/webm' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'heavens-gate-teaser.webm';
      a.click();
    };
    playing = true;
    await seek(0);
    recorder.start(250);
    recBtn.classList.add('on');
    recBtn.textContent = '■ Stop recording';
  }

  function stopRecording() {
    recorder.stop();
    recorder = null;
    recBtn.classList.remove('on');
    recBtn.textContent = '● Record .webm';
  }

  recBtn.addEventListener('click', () => (recorder ? stopRecording() : startRecording()));

  addEventListener('resize', () => {
    if (rendering) return;
    engine.view.w = innerWidth;
    engine.view.h = innerHeight;
    renderer.setSize(innerWidth, innerHeight, false);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    sizeOverlay();
  });

  // ------------------------------------------------------------ offline render to MP4
  // Every frame is rendered at full resolution with a fixed time step, so the
  // output never drops frames however slow a 4K frame is. Video is encoded with
  // WebCodecs, audio is rendered with an OfflineAudioContext, and the MP4 is
  // streamed to disk through the dev server (trailer-3d/out/).
  let rendering = false;

  async function renderMovie({ width, height, fps, from, to, name }) {
    rendering = true;
    renderer.setAnimationLoop(null);
    const hint = document.querySelector('.gate-inner .hint');
    const btn = document.getElementById('play');
    btn.textContent = 'Rendering';
    btn.disabled = true;
    const say = (msg) => {
      hint.textContent = msg;
      fetch('/__render/log', { method: 'POST', body: msg }).catch(() => {});
    };

    await document.fonts.ready;
    engine.view.w = width;
    engine.view.h = height;
    renderer.setPixelRatio(1);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    overlay.width = width;
    overlay.height = height;
    const comp = document.createElement('canvas');
    comp.width = width;
    comp.height = height;
    const cctx = comp.getContext('2d');

    const bitrate = Math.round(width * height * fps * 0.16); // ~40 Mbps at 4K30
    const codec = await getFirstEncodableVideoCodec(['avc', 'hevc', 'vp9', 'av1'], { width, height, bitrate });
    if (!codec) throw new Error(`This browser cannot encode ${width}x${height} video`);
    const audioCodec = (await canEncodeAudio('aac', { numberOfChannels: 2, sampleRate: 48000, bitrate: 256000 })) ? 'aac' : 'opus';
    say(`codec ${codec} + ${audioCodec}, ${width}x${height} @ ${fps}fps, ${(bitrate / 1e6).toFixed(0)} Mbps`);

    await fetch(`/__render/open?name=${encodeURIComponent(name)}`, { method: 'POST' });
    const writable = new WritableStream({
      async write(chunk) {
        const r = await fetch(`/__render/write?pos=${chunk.position}`, { method: 'POST', body: chunk.data });
        if (!r.ok) throw new Error(await r.text());
      },
    });
    const output = new Output({ format: new Mp4OutputFormat(), target: new StreamTarget(writable, { chunked: true, chunkSize: 8 * 1024 * 1024 }) });
    const video = new CanvasSource(comp, { codec, bitrate, keyFrameInterval: 2 });
    output.addVideoTrack(video, { frameRate: fps });
    const audio = new AudioBufferSource({ codec: audioCodec, bitrate: 256000 });
    output.addAudioTrack(audio);
    await output.start();

    say('rendering audio…');
    const full = await Score.renderOffline(DURATION);
    const a0 = Math.floor(from * full.sampleRate), a1 = Math.min(full.length, Math.ceil(to * full.sampleRate));
    const clip = new AudioBuffer({ length: a1 - a0, numberOfChannels: 2, sampleRate: full.sampleRate });
    for (let c = 0; c < 2; c++) clip.copyToChannel(full.getChannelData(c).subarray(a0, a1), c);
    await audio.add(clip);
    audio.close();

    const frames = Math.round((to - from) * fps);
    const started = performance.now();
    for (let i = 0; i < frames; i++) {
      const tt = from + i / fps;
      engine.update(tt);
      // The render loop normally ticks three's node frame once per rAF; passes like the
      // scene pass skip re-rendering inside the same frame, so advance it by hand here.
      engine.render(true);
      engine.drawOverlay(octx, width, height, engine.state, tt);
      cctx.drawImage(canvas, 0, 0, width, height);
      cctx.drawImage(overlay, 0, 0, width, height);
      await video.add(i / fps, 1 / fps);
      if (i % 15 === 0 || i === frames - 1) {
        const el = (performance.now() - started) / 1000;
        const eta = (el / (i + 1)) * (frames - i - 1);
        say(`frame ${i + 1}/${frames} · ${tt.toFixed(1)}s · ${shotAt(tt).name} · ${(el / (i + 1) * 1000).toFixed(0)} ms/frame · ETA ${Math.ceil(eta)}s`);
      }
    }
    video.close();
    say('finalizing…');
    await output.finalize();
    const { path } = await (await fetch('/__render/close', { method: 'POST' })).json();
    say(`done in ${((performance.now() - started) / 1000).toFixed(0)}s → ${path}`);
    btn.textContent = 'Done';
    window.__renderDone = path;
    rendering = false;
  }

  // Render the synthesized score to public/score.wav so Remotion can play and mix it.
  async function exportAudio() {
    const buf = await Score.renderOffline(DURATION);
    const n = buf.length, ch = 2, bytes = n * ch * 2;
    const wav = new DataView(new ArrayBuffer(44 + bytes));
    const str = (o, t) => [...t].forEach((c, i) => wav.setUint8(o + i, c.charCodeAt(0)));
    str(0, 'RIFF'); wav.setUint32(4, 36 + bytes, true); str(8, 'WAVEfmt ');
    wav.setUint32(16, 16, true); wav.setUint16(20, 1, true); wav.setUint16(22, ch, true);
    wav.setUint32(24, buf.sampleRate, true); wav.setUint32(28, buf.sampleRate * ch * 2, true);
    wav.setUint16(32, ch * 2, true); wav.setUint16(34, 16, true); str(36, 'data'); wav.setUint32(40, bytes, true);
    const L = buf.getChannelData(0), R = buf.getChannelData(1);
    for (let i = 0; i < n; i++) {
      wav.setInt16(44 + i * 4, Math.max(-1, Math.min(1, L[i])) * 32767, true);
      wav.setInt16(46 + i * 4, Math.max(-1, Math.min(1, R[i])) * 32767, true);
    }
    await fetch('/__render/open?dir=public&name=score.wav', { method: 'POST' });
    await fetch('/__render/write?pos=0', { method: 'POST', body: wav.buffer });
    const { path } = await (await fetch('/__render/close', { method: 'POST' })).json();
    window.__audioDone = path;
    document.querySelector('.gate-inner .hint').textContent = 'audio saved → ' + path;
  }
  if (params.get('exportAudio')) exportAudio().catch((e) => { window.__audioError = String(e); });

  if (RENDER) {
    const [width, height] = RENDER === '1080p' ? [1920, 1080] : [3840, 2160];
    const fps = Number(params.get('fps') || 30);
    const from = Number(params.get('from') || 0);
    const to = Math.min(DURATION, Number(params.get('to') || DURATION));
    const name = params.get('name') || `heavens-gate-teaser-${RENDER}.mp4`;
    renderMovie({ width, height, fps, from, to, name }).catch((err) => {
      console.error(err);
      window.__renderError = String(err?.message || err);
      document.querySelector('.gate-inner .hint').textContent = 'Render failed: ' + window.__renderError;
      fetch('/__render/log', { method: 'POST', body: 'FAILED ' + window.__renderError }).catch(() => {});
    });
  }

  // debugging hooks
  window.__trailer = { seek: (x) => { t = x; engine.update(t); }, SHOTS, get t() { return t; }, get score() { return score; }, scene, camera, renderer, pipeline, THREE, W, moon, hemi, spot, U, override: null };
}

main().catch((err) => {
  console.error(err);
  const b = document.getElementById('play');
  b.textContent = 'Failed to start';
  document.querySelector('.gate-inner .hint').textContent = String(err?.message || err);
});
