# Heaven's Gate: teaser trailer

A 74.5 s horror teaser built entirely in code: Three.js (WebGPU) for the picture,
Web Audio for the sound, Remotion for the timeline and video export.
There are no model, texture or audio files. Every surface, character and sound is generated.

**Story beats:** two masked children row toward an island gate at night. A giant
rabbit-skulled creature rises in the fog, the lantern dies, it is suddenly right behind
them, the gate slams shut, and the guardian who keeps it, all in white, his face pale and blurred, smiles from the dark.
Final card (as set in `NAME_CARD`, `src/shots.js`): **THE DEVIL MAN / IMI / Left Hand of God**.

## Requirements

- Node.js 20.19+ (tested on 24)
- **Google Chrome installed.** Remotion's bundled headless browser cannot create a
  WebGPU device on Windows (`dxcompiler.dll` error), so `remotion.config.ts` points Remotion
  at your installed Chrome automatically.
- A GPU with WebGPU support.

```bash
npm install
```

## Commands

| Command | What it does |
|---|---|
| `npm run studio` | Remotion Studio at **http://localhost:3000/Teaser**: timeline, scrubbing, Render button. Use this one to review and render. |
| `npm run dev` | Standalone viewer at **http://localhost:5173**: plays the teaser live with synthesized sound (click Enter). Only needed for a real-time play-through or to re-export the audio. |
| `npm run render` | Renders `out/teaser.mp4` through Remotion (1920×1080). |
| `npm run typecheck` | Type-checks the Remotion files. |

**You only need one server running at a time.** To watch or scrub, run `npm run studio` only.

### Rendering in 4K

The composition is 1920×1080. A 4K video is made by rendering it at **2× scale** (3840×2160). You don't change the
composition itself; the 3D scene and titles are redrawn at the higher resolution.

**In Remotion Studio** (`npm run studio`, then http://localhost:3000/Teaser in Chrome):

1. Click **Render** at the bottom right of the Studio window.
2. In the panel that opens, make sure **Video** is selected at the top.
3. Open the **Picture** tab on the left and change **Scale** from `1.0x` to **`2`**.
4. Open the **General** tab and check the codec is H.264 (mp4). The output name and folder are shown there too.
5. Click **Render video** (top right). Keep the browser tab open until it finishes.

**Where the video is saved:** in the **`out/`** folder inside the project, named after the output name shown in the
Render panel's General tab (by default `out/Teaser.mp4`). The **Jobs** tab in the Studio sidebar lists renders you have
started, so you can check progress and find the file there. `out/` is git-ignored, so rendered videos are never committed.

**Bitrate / file size:** Scale doesn't set the bitrate directly. The default encoding targets a quality level, so a 4K
render uses a higher bitrate than 1080p automatically (this scene is dark with film grain, which is expensive to compress,
so expect a large file). To change it, use the **Encoding** tab: lower the quality number for a better picture and a bigger
file, or set a fixed **Video bitrate**.

**From the terminal** (same result, no menus):

```bash
npx remotion render src/remotion/index.ts Teaser out/teaser-4k.mp4 --scale=2
```

A section only: add `--frames=1020-1109`. A single frame: `npx remotion still src/remotion/index.ts Teaser out/frame.png --frame=1050`.

### Free camera (explore the world)

Open the standalone viewer (`npm run dev`, then http://localhost:5173), click **Enter**, and press **F**.
The camera starts exactly where the current shot's camera is, and the letterbox, titles and the shot's depth
of field are turned off while you fly around.

| Key / mouse | Action |
|---|---|
| **F** | Turn the free camera on or off |
| **W A S D** | Move forward / left / back / right |
| **Shift** | Move up |
| **Ctrl** | Move down. Careful: **Ctrl+W closes the browser tab**, so let go of W (or Ctrl) before the other |
| **Q / E** | Look left / right (turn the camera) |
| **Hold the mouse button and drag** | Look around |
| **Mouse wheel** | Change fly speed |
| **C** | Copy the camera's position as shot code (`s.camPos = V(…); s.camLook = V(…);`) for `src/shots.js` |
| **Space / ← →** | Pause, play, scrub the timeline while you look around (the world keeps moving) |

Open `?free=1` to start in free-camera mode. The free camera lives only in the standalone viewer
(`src/freecam.js`), not in Remotion, so it can never end up in a render.

### Camera view (see every shot's camera in the world)

In the standalone viewer press **V**. A **Cameras** panel opens on the right and every shot's camera is drawn in the 3D
world, like Blender's camera objects: a frustum showing what the shot sees (with the 2.39:1 frame), a line for its path
(white dot = start, coloured dot = end) and a label. The shot that's playing is highlighted.

- **Checkbox** next to a camera: show or hide that camera in the world. **all** / **none** switch every camera at once.
- **view** button: look through that shot's camera. It jumps to the shot and leaves free-camera mode, like Blender's
  "look through camera".
- While flying (**F**), a white marker shows where the real shot camera currently is.
- **H** hides the whole HUD, including this panel. **?** shows or hides the controls list in the bottom-left corner.

Camera positions come from running the shot code in `src/shots.js`, so after you edit a shot, reload the viewer to see
the updated cameras. Like the free camera, this lives in `src/camerarig.js` and only in the viewer, never in a render.

### The sound (read this before editing `src/audio.js`)

Remotion plays the pre-rendered file **`public/score.wav`**. The score is synthesized in code,
so after you change `src/audio.js` you must re-export the WAV:

1. `npm run dev`
2. Open `http://localhost:5173/?exportAudio=1` in Chrome and wait for "audio saved".
3. The file is written to `public/score.wav`. Stop the dev server.

The standalone viewer can also render a complete 4K MP4 by itself:
`http://localhost:5173/?render=4k` (options: `&fps=30&from=0&to=74.5&name=file.mp4`),
saved into `out/`. Keep the tab open until it says "done".

## Where to edit

Times are in seconds. Line numbers are approximate and will drift as you edit.

| To change | File | Where |
|---|---|---|
| Shot list, timing, camera moves, focus | `src/shots.js` | `SHOTS` (line ~60) |
| Captions, title, name card text | `src/shots.js` | `CAPTIONS` (8), `TITLE` (12), `NAME_CARD` (13) |
| Total length | `src/shots.js` | `DURATION` (6) |
| Boat, oars, oarlocks, lantern | `src/world.js` | `buildBoat`, the oars in `buildWorld`, `buildLantern` |
| Children (coats, sacking masks, arms, mittens) | `src/world.js` | `sackHead`, `buildChild`; their hands are posed each frame by `poseChild` (two-bone reach) from `animateWorld` in `src/engine.js` |
| The rowing stroke | `src/shots.js` | `ROW` and `rowStroke`: one clock for the oars, the rower's body and grip, the ripples, and the oar sounds in `src/audio.js` |
| The giant creature | `src/world.js` | `buildCreature`; its breathing and sway are in `placeCreature`, `src/engine.js` |
| The guardian in white (body, poncho, scarf, sleeves, trousers, shoes) | `src/guardian.js` | body layout at the top (`HEAD_C`, `ARMS`, `LEGS`); `buildPoncho`, `buildScarf`, `buildSleeve`, `buildTrouser`; assembled in `buildGuardian` |
| His wind | `src/guardian.js` | `windAt` (direction, strength, gusts); how each piece of cloth answers is in `buildGuardian` (`windSection`) and the `push` / `lift` / `ripple` numbers on each `build*` |
| His face (pale, blurred, only the mouth) | `src/guardian.js`, `src/materials.js` | shape: `headGeometry`; look and mouth: `faceMaterial`, the softening veil `faceVeilMaterial` |
| His smile, head tilt, jaw | `src/shots.js` | `s.smile`, `s.manTilt`, `s.mouthOpen` in the shots (no shot speaks, so `mouthOpen` stays 0) |
| How worn his white clothes look | `src/materials.js` | `linenMaterial` (`mud`, `fray`); each piece's values are in `buildGuardian` |
| Island, gate, lighthouse, trees, rocks, ground stones and grass | `src/world.js` | `buildTerrain`, `buildTree`, `buildGate`, `buildTower`; everything is placed in `buildWorld` |
| Surface looks (sea, sky, wood, stone, cloth, flesh, bone, linen, skin, leather, glass, grass, ripples) | `src/materials.js` | one `*Material` function each |
| Lights, exposure, colour grade, post-effects | `src/engine.js` | exposure (16), moon light (~51), lighthouse spotlight (~74), guardian key light (~79), post chain below |
| Sound | `src/audio.js` | `scheduleBeds` (~158), `scheduleEvents` (just after) |
| Remotion size and frame rate | `src/remotion/Root.tsx` | the whole file |

### How the pieces fit

```
src/shots.js     pure functions of time: which shot is on, where the camera is
src/world.js     builds every 3D object
src/guardian.js  the guardian at the gate, and his wind-blown cloth (re-shaped every frame, as a function of time)
src/materials.js procedural surfaces (noise-based, no image files)
src/engine.js    creates the world, lights and post-processing; exposes update(t) / render()
src/audio.js     synthesized score and sound effects
src/main.js      standalone viewer (npm run dev): live playback, recorder, offline MP4 render
src/remotion/    Remotion wrapper: draws engine frames into a ThreeWebGPUCanvas
public/score.wav exported score, played by Remotion
out/             rendered videos (git-ignored)
```

Everything is deterministic: the picture at time `t` is the same every time, which is what
lets Remotion render frame by frame. That includes the guardian's cloth (re-shaped from its rest shape from `t`, no
simulation state), the children's grip, the creature's breathing and the oar ripples (each placed where the blade was at
its own catch, recomputed from that moment). Seeking straight to a time, playing up to it, and scrubbing back to it give
identical poses. The guardian's cloth is only updated in the shots where he is visible.

## The vanish glitch (36.9 s)

When the giant creature vanishes in "the keeper" shot, it first stutters in and out, then the screen breaks up like a failing
display (sliding bands, split colours, static and inverted blocks, a scan bar) with a buzzer and static burst.
The picture and the sound both read the same function, `glitchAt()` in `src/shots.js`, so they cut in and out together.
To change when it happens, edit `VANISH_T` there; the effect itself is `glitchPass` in `src/engine.js` and the sound is
`glitchBuzzer` in `src/audio.js`. After changing the sound, re-export `public/score.wav` (see "The sound").

## Known issues and notes

- **Studio live preview: fixed.** It used to show black because Remotion's canvas wrapper never tells
  Three.js the real canvas size in the live preview (renderer stuck at 300×150, camera aspect 0, depth buffer size
  errors). `src/remotion/Teaser.tsx` now sets the renderer size explicitly and `src/engine.js` sets the camera aspect
  and rebuilds WebGPU's cached pass when the size changes. If the preview ever goes black again, hard-refresh
  (Ctrl+Shift+R) and check the browser console (F12). A few one-off godrays errors at startup are harmless.
- **Depth of field is custom.** Three.js's built-in depth-of-field rendered flat grey under Remotion's
  Chrome, so `src/engine.js` uses its own single-pass blur (`depthOfField`). Looks slightly different from the
  first 4K render made before the Remotion move.
- **The scene pass uses `samples: 0`** (no multisampling) because Remotion's canvas enables MSAA, which breaks the
  depth reads that godrays and depth of field depend on.
- Preview in Studio plays slower than real time because every frame runs the full WebGPU scene.
- **The first frame is slow.** Building the world and compiling every shader takes about 30-40 s on the first frame,
  longer than Remotion's default wait, so `remotion.config.ts` raises the delayRender timeout to 180 s.
- Everything is procedural (no model or texture files). The characters are built from shaped procedural meshes,
  not sculpted or scanned assets, so they are stylised rather than film-realistic up close.

## Output

The first 4K render (made with the standalone renderer) is `out/heavens-gate-teaser-4k.mp4`:
3840×2160, 30 fps, 74.5 s, H.264 + AAC.
