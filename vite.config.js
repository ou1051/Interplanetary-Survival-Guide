import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { viteStaticCopy } from 'vite-plugin-static-copy';

// `npm run build`         → dist/ (multi-file, for GitHub Pages or any static host)
// `npm run build:single`  → dist-single/index.html (one self-contained file, 3D rover app only)
const cesium = 'node_modules/cesium/Build/Cesium';

export default defineConfig(({ mode }) => ({
  base: './',
  build: {
    outDir: mode === 'single' ? 'dist-single' : 'dist',
    chunkSizeWarningLimit: 6000,
    rollupOptions:
      mode === 'single'
        ? undefined
        : {
            input: {
              main: resolve(import.meta.dirname, 'index.html'),
              map: resolve(import.meta.dirname, 'map.html'), // mission map + 3D Mars globe (src/map)
            },
          },
  },
  plugins:
    mode === 'single'
      ? [viteSingleFile()]
      : [
          // CesiumJS loads its web workers and assets at runtime from ./cesium/
          viteStaticCopy({
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
