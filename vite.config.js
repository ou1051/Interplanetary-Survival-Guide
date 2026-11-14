import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { viteSingleFile } from 'vite-plugin-singlefile';

// `npm run build`         → dist/ (multi-file, for GitHub Pages or any static host)
// `npm run build:single`  → dist-single/index.html (one self-contained file)
export default defineConfig(({ mode }) => ({
  base: './',
  build: {
    outDir: mode === 'single' ? 'dist-single' : 'dist',
    chunkSizeWarningLimit: 1500,
    rollupOptions:
      mode === 'single'
        ? undefined
        : {
            input: {
              main: resolve(import.meta.dirname, 'index.html'),
              map: resolve(import.meta.dirname, 'map.html'), // mission map dev page (src/map)
            },
          },
  },
  plugins: mode === 'single' ? [viteSingleFile()] : [],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
  },
}));
