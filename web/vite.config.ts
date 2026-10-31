/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // The API runs on :3001 in dev. Same-origin from the browser's point of view, no CORS.
    proxy: { '/api': 'http://localhost:3001' },
  },
  test: { environment: 'jsdom', setupFiles: ['./test/setup.ts'], css: false },
});
