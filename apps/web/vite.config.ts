import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API_TARGET = process.env['PLAKAT_API_URL'] ?? 'http://localhost:8787';

const proxy = {
  '/api': { target: API_TARGET, changeOrigin: true },
  '/uploads': { target: API_TARGET, changeOrigin: true },
};

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: false, proxy },
  preview: { port: 4173, proxy },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 1500,
  },
});
