import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  build: { outDir: '../sm_manager/web', emptyOutDir: true, manifest: true },
  server: { host: '127.0.0.1', proxy: { '/api': { target: 'http://127.0.0.1:18791', changeOrigin: false }, '/planner': { target: 'http://127.0.0.1:18791', changeOrigin: false } } },
});
