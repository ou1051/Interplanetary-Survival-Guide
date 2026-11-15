import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { routeApi } from './server/routes.js';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import { readFileSync, readdirSync } from 'node:fs';

// `npm run build`         → dist/ (multi-file, for GitHub Pages or any static host)
// `npm run build:single`  → dist-single/index.html (one self-contained file, 3D rover app only)
const cesium = 'node_modules/cesium/Build/Cesium';

// `virtual:site-assets` (see src/ui/siteAssets.js): the Site Topology files carried inside the page for
// the one-file build, which has nothing beside it to load them from. Empty for every other build.
function siteAssets(single) {
  const id = 'virtual:site-assets';
  const mime = { png: 'image/png', jpg: 'image/jpeg' };
  return {
    name: 'site-assets',
    resolveId: (source) => (source === id ? `\0${id}` : null),
    load(source) {
      if (source !== `\0${id}`) return null;
      if (!single) return 'export default {};';
      const urls = {};
      for (const dir of ['jezero', 'mars']) {
        for (const file of readdirSync(resolve(import.meta.dirname, 'public', dir))) {
          const type = mime[file.split('.').pop()];
          if (!type) continue;
          const data = readFileSync(resolve(import.meta.dirname, 'public', dir, file)).toString('base64');
          urls[`./${dir}/${file}`] = `data:${type};base64,${data}`;
        }
      }
      const grid = readFileSync(resolve(import.meta.dirname, 'public/jezero/topography_grid.json'), 'utf8');
      return `export default { urls: ${JSON.stringify(urls)}, grid: ${grid} };`;
    },
  };
}

export default defineConfig(({ mode }) => ({
  base: './',
  appType: 'mpa',
  build: {
    outDir: mode === 'single' ? 'dist-single' : 'dist',
    copyPublicDir: mode !== 'single', // the one-file build carries what it needs inline
    chunkSizeWarningLimit: 6000,
  },
  plugins: [
    siteAssets(mode === 'single'),
    {
      name: 'route-api',
      configureServer(server) { server.middlewares.use(routeApi); },
      configurePreviewServer(server) { server.middlewares.use(routeApi); },
    },
    mode === 'single'
      ? viteSingleFile()
      : viteStaticCopy({
          // CesiumJS loads its web workers and assets at runtime from ./cesium/
          targets: ['Workers', 'ThirdParty', 'Assets', 'Widgets'].map((d) => ({
            src: `${cesium}/${d}`,
            dest: 'cesium',
            rename: { stripBase: 4 },
          })),
        }),
  ],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
  },
}));
