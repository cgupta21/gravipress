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

function parseCloudflareHeaders(content) {
  const rules = [];
  let current = null;
  for (const rawLine of content.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (!/^\s/.test(rawLine)) {
      current = { path: trimmed, headers: [] };
      rules.push(current);
    } else if (current) {
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx > 0) {
        current.headers.push({
          key: trimmed.slice(0, colonIdx).trim(),
          value: trimmed.slice(colonIdx + 1).trim(),
        });
      }
    }
  }
  return rules;
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
    configurePreviewServer(server) {
      const headersPath = path.join(rootDir, 'public', '_headers');
      if (fs.existsSync(headersPath)) {
        const rules = parseCloudflareHeaders(fs.readFileSync(headersPath, 'utf8'));
        const globalHeaders = rules.find((r) => r.path === '/*')?.headers || [];
        if (globalHeaders.length > 0) {
          server.middlewares.use((_req, res, next) => {
            for (const h of globalHeaders) res.setHeader(h.key, h.value);
            next();
          });
        }
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
