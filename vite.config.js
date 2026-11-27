import crypto from 'node:crypto';
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

function walkFiles(dir, baseDir = dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(full, baseDir));
    } else if (entry.isFile()) {
      const rel = '/' + path.relative(baseDir, full).split(path.sep).join('/');
      results.push({ rel, full });
    }
  }
  return results.sort((a, b) => a.rel.localeCompare(b.rel));
}

function serviceWorkerManifestPlugin() {
  const excluded = new Set([
    '/_headers',
    '/robots.txt',
    '/sitemap.xml',
    '/llms.txt',
    '/google617dd05014786b41.html',
    '/sw.js',
  ]);

  return {
    name: 'gravipress-sw-manifest',
    closeBundle() {
      const outDir = path.join(rootDir, 'dist');
      if (!fs.existsSync(outDir)) return;

      const allFiles = walkFiles(outDir).filter((f) => !excluded.has(f.rel));
      const indexHtmlPath = path.join(outDir, 'index.html');
      const indexHtml = fs.existsSync(indexHtmlPath)
        ? fs.readFileSync(indexHtmlPath, 'utf8')
        : '';

      const shellAssets = new Set([
        '/',
        '/index.html',
        '/site.webmanifest',
        '/favicon.svg',
        '/favicon.ico',
        '/apple-touch-icon.png',
        '/icon-192.png',
        '/icon-512.png',
        '/maskable-icon-512.png',
        '/brand/logo-horizontal-light.png',
      ]);

      for (const m of indexHtml.matchAll(
        /(?:src|href)=["'](\/assets\/[^"']+)["']/g
      )) {
        shellAssets.add(m[1]);
      }

      const offlineAllowlist = new Set();
      const hash = crypto.createHash('sha256');
      let totalOfflineBytes = 0;

      const templatePath = path.join(rootDir, 'src', 'sw-template.js');
      const template = fs.readFileSync(templatePath, 'utf8');
      hash.update(template);

      for (const file of allFiles) {
        const content = fs.readFileSync(file.full);
        hash.update(file.rel);
        hash.update(content);
        totalOfflineBytes += content.byteLength;
        if (!shellAssets.has(file.rel)) {
          offlineAllowlist.add(file.rel);
        }
      }

      for (const route of ['/privacy', '/faq', '/terms', '/404']) {
        if (fs.existsSync(path.join(outDir, `${route.slice(1)}.html`))) {
          offlineAllowlist.add(route);
        }
      }

      const buildId = hash.digest('hex').slice(0, 12);
      const swSource = template
        .replace('__BUILD_ID__', JSON.stringify(buildId))
        .replace('__OFFLINE_BYTES__', String(totalOfflineBytes))
        .replace(
          '__SHELL_ASSETS__',
          JSON.stringify([...shellAssets].sort(), null, 2)
        )
        .replace(
          '__OFFLINE_ALLOWLIST__',
          JSON.stringify([...offlineAllowlist].sort(), null, 2)
        );

      fs.writeFileSync(path.join(outDir, 'sw.js'), swSource, 'utf8');
    },
  };
}

export default defineConfig({
  plugins: [pdfjsAssetsPlugin(), serviceWorkerManifestPlugin()],
  build: {
    target: 'esnext',
  },
});
