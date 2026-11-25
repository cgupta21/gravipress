import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const pdfjsDistDir = path.join(rootDir, 'node_modules', 'pdfjs-dist');
const ffmpegCoreDistDir = path.join(
  rootDir,
  'node_modules',
  '@ffmpeg',
  'core',
  'dist',
  'esm'
);

function serveStaticDir(
  middlewares,
  mountPath,
  sourceDir,
  defaultMime = 'application/octet-stream'
) {
  middlewares.use(mountPath, (req, res, next) => {
    const cleanUrl = (req.url || '/').split('?')[0];
    const targetPath = path.join(sourceDir, cleanUrl);
    if (!targetPath.startsWith(sourceDir) || !fs.existsSync(targetPath)) {
      next();
      return;
    }
    const stat = fs.statSync(targetPath);
    if (!stat.isFile()) {
      next();
      return;
    }
    let mime = defaultMime;
    if (targetPath.endsWith('.wasm')) {
      mime = 'application/wasm';
    } else if (targetPath.endsWith('.js') || targetPath.endsWith('.mjs')) {
      mime = 'text/javascript';
    }
    res.setHeader('Content-Type', mime);
    fs.createReadStream(targetPath).pipe(res);
  });
}

function pdfjsAssetsPlugin() {
  const assetDirs = ['cmaps', 'standard_fonts'];

  return {
    name: 'pdfjs-local-assets',
    configureServer(server) {
      for (const dir of assetDirs) {
        serveStaticDir(
          server.middlewares,
          `/pdfjs/${dir}`,
          path.join(pdfjsDistDir, dir)
        );
      }
    },
    writeBundle(options) {
      const outDir = options.dir || path.join(rootDir, 'dist');
      for (const dir of assetDirs) {
        const src = path.join(pdfjsDistDir, dir);
        const dest = path.join(outDir, 'pdfjs', dir);
        if (fs.existsSync(src)) {
          fs.cpSync(src, dest, { recursive: true });
        }
      }
    },
  };
}

function ffmpegAssetsPlugin() {
  return {
    name: 'ffmpeg-local-assets',
    configureServer(server) {
      serveStaticDir(server.middlewares, '/ffmpeg/', ffmpegCoreDistDir);
    },
    configurePreviewServer(server) {
      serveStaticDir(server.middlewares, '/ffmpeg/', ffmpegCoreDistDir);
    },
    writeBundle(options) {
      const outDir = options.dir || path.join(rootDir, 'dist');
      const destDir = path.join(outDir, 'ffmpeg');
      if (fs.existsSync(ffmpegCoreDistDir)) {
        fs.mkdirSync(destDir, { recursive: true });
        for (const file of ['ffmpeg-core.js', 'ffmpeg-core.wasm']) {
          const src = path.join(ffmpegCoreDistDir, file);
          const dest = path.join(destDir, file);
          if (fs.existsSync(src)) {
            fs.copyFileSync(src, dest);
          }
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [pdfjsAssetsPlugin(), ffmpegAssetsPlugin()],
  optimizeDeps: {
    exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'],
  },
  build: {
    target: 'esnext',
  },
});
