import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const pdfjsDistDir = path.join(rootDir, 'node_modules', 'pdfjs-dist');

function serveStaticDir(middlewares, mountPath, sourceDir) {
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
    res.setHeader('Content-Type', 'application/octet-stream');
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

export default defineConfig({
  plugins: [pdfjsAssetsPlugin()],
  build: {
    target: 'esnext',
  },
});
