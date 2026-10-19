import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { AbsoluteFill, Audio, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { ThreeWebGPUCanvas } from '@remotion/three/webgpu';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three/webgpu';
import { loadFont as loadCinzel } from '@remotion/google-fonts/Cinzel';
import { loadFont as loadCormorant } from '@remotion/google-fonts/CormorantGaramond';
import { createTrailer } from '../engine.js';

loadCinzel('normal', { weights: ['400'], subsets: ['latin'] });
loadCormorant('italic', { weights: ['300'], subsets: ['latin'] });
loadCormorant('normal', { weights: ['300'], subsets: ['latin'] });

type OverlayRef = React.RefObject<HTMLCanvasElement | null>;

// Lives inside the canvas: builds the shared engine once, then on every Remotion
// frame sets the time, renders the post-processed image and paints the titles.
const Scene = ({ overlay }: { overlay: OverlayRef }) => {
  const { gl, scene, camera } = useThree();
  const { width, height, fps } = useVideoConfig();
  const frame = useCurrentFrame();
  const t = frame / fps;
  const timeRef = useRef(t);
  timeRef.current = t;

  const engine = useMemo(() => {
    gl.toneMapping = THREE.ACESFilmicToneMapping;
    gl.shadowMap.enabled = true;
    gl.shadowMap.type = THREE.PCFShadowMap;
    const e = createTrailer({ renderer: gl as unknown as THREE.WebGPURenderer, scene, camera: camera as THREE.PerspectiveCamera });
    return e;
  }, [gl, scene, camera]);

  engine.view.w = width;
  engine.view.h = height;

  // Remotion's canvas wrapper stubs out R3F's setSize, so in the live preview the renderer
  // keeps its initial 300x150 while the canvas element is 1920x1080 (depth-buffer size errors,
  // black picture). Tell the renderer the real size and pixel ratio.
  const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
  useLayoutEffect(() => {
    gl.setPixelRatio(dpr);
    gl.setSize(width, height, false);
  }, [gl, width, height, dpr]);

  // Priority > 0 turns off R3F's own render, so the post-processing pipeline is the only output.
  useFrame(() => {
    const time = timeRef.current;
    engine.update(time);
    engine.render(true);
    const cvs = overlay.current;
    const ctx = cvs?.getContext('2d');
    if (cvs && ctx) engine.drawOverlay(ctx, cvs.width, cvs.height, engine.state, time);
  }, 1);

  return null;
};

export const Teaser = () => {
  const { width, height } = useVideoConfig();
  const overlay = useRef<HTMLCanvasElement | null>(null);
  const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;

  useEffect(() => {
    if (overlay.current) {
      overlay.current.width = Math.round(width * dpr);
      overlay.current.height = Math.round(height * dpr);
    }
  }, [width, height, dpr]);

  return (
    <AbsoluteFill style={{ background: '#000' }}>
      <Audio src={staticFile('score.wav')} />
      <ThreeWebGPUCanvas width={width} height={height} dpr={dpr}>
        <Scene overlay={overlay} />
      </ThreeWebGPUCanvas>
      <canvas
        ref={overlay}
        width={Math.round(width * dpr)}
        height={Math.round(height * dpr)}
        style={{ position: 'absolute', inset: 0, width, height, pointerEvents: 'none' }}
      />
    </AbsoluteFill>
  );
};
