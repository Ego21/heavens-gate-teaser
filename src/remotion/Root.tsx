import { Composition } from 'remotion';
import { Teaser } from './Teaser';
import { DURATION } from '../shots.js';

export const FPS = 30;

export const RemotionRoot = () => (
  <Composition
    id="Teaser"
    component={Teaser}
    durationInFrames={Math.round(DURATION * FPS)}
    fps={FPS}
    width={1920}
    height={1080}
  />
);
