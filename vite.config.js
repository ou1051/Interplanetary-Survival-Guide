import { defineConfig } from 'vite';
import { routeApi } from './server/routes.js';
import { viteSingleFile } from 'vite-plugin-singlefile';

// `npm run build`         → dist/ (multi-file, for GitHub Pages or any static host)
// `npm run build:single`  → dist-single/index.html (one self-contained file)
export default defineConfig(({ mode }) => ({
  base: './',
  build: {
    outDir: mode === 'single' ? 'dist-single' : 'dist',
    chunkSizeWarningLimit: 1500,
  },
  plugins: [
    {
      name: 'route-api',
      configureServer(server) { server.middlewares.use(routeApi); },
      configurePreviewServer(server) { server.middlewares.use(routeApi); },
    },
    ...(mode === 'single' ? [viteSingleFile()] : []),
  ],
}));
