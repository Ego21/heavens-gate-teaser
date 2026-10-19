import { existsSync } from 'node:fs';
import { Config } from '@remotion/cli/config';

// Remotion's stripped-down headless shell can't create a WebGPU device on Windows
// (dxcompiler.dll fails to load), so use the installed Chrome instead.
const CHROME_PATHS = [
  'C:\Program Files\Google\Chrome\Application\chrome.exe',
  'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
];
const chrome = CHROME_PATHS.find((p) => existsSync(p));
if (chrome) {
  Config.setChromeMode('chrome-for-testing');
  Config.setBrowserExecutable(chrome);
}

Config.setChromiumOpenGlRenderer('angle');
Config.setVideoImageFormat('png');
Config.setConcurrency(1); // one GPU context; frames are heavy
Config.setCodec('h264');
