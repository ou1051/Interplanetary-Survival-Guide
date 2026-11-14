import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// `npm run build`         → dist/ (multi-file, for GitHub Pages or any static host)
// `npm run build:single`  → dist-single/index.html (one self-contained file)
export default defineConfig(({ mode }) => ({
  base: './',
  build: {
    outDir: mode === 'single' ? 'dist-single' : 'dist',
    chunkSizeWarningLimit: 1500,
  },
  plugins: mode === 'single' ? [viteSingleFile()] : [],
}));
