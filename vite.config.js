import { defineConfig } from 'vite';
import { open, mkdir } from 'node:fs/promises';
import { resolve, basename } from 'node:path';

// Dev-only endpoint the offline renderer streams the encoded MP4 into.
// The muxer issues positional writes (it patches the header at the end),
// so the file is written at explicit byte offsets rather than appended.
function renderSink() {
  const outDir = resolve(import.meta.dirname, 'out');
  const publicDir = resolve(import.meta.dirname, 'public');
  let file = null;
  let path = null;

  const body = (req) => new Promise((ok, fail) => {
    const parts = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => ok(Buffer.concat(parts)));
    req.on('error', fail);
  });

  return {
    name: 'render-sink',
    configureServer(server) {
      server.middlewares.use('/__render', async (req, res) => {
        try {
          const url = new URL(req.url, 'http://x');
          if (url.pathname === '/open') {
            const dir = url.searchParams.get('dir') === 'public' ? publicDir : outDir;
            await mkdir(dir, { recursive: true });
            path = resolve(dir, basename(url.searchParams.get('name') || 'render.mp4'));
            if (file) await file.close();
            file = await open(path, 'w+');
            res.end(JSON.stringify({ path }));
          } else if (url.pathname === '/write') {
            const data = await body(req);
            await file.write(data, 0, data.length, Number(url.searchParams.get('pos')));
            res.end('ok');
          } else if (url.pathname === '/close') {
            await file?.close();
            file = null;
            res.end(JSON.stringify({ path }));
          } else if (url.pathname === '/log') {
            server.config.logger.info(`[render] ${(await body(req)).toString()}`);
            res.end('ok');
          } else {
            res.statusCode = 404;
            res.end();
          }
        } catch (err) {
          res.statusCode = 500;
          res.end(String(err));
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [renderSink()],
});
