import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The plugin serves dist/ itself from a fixed origin, so asset URLs stay relative and the
// bundle is kept to a few predictable files.
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // WebView2 is always a current Chromium.
    target: 'chrome120',
    chunkSizeWarningLimit: 2048,
  },
});
