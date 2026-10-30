import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `npm run dev` here proxies the Worker (`wrangler dev` on :8787). `npm run build` writes ../dist/web, which the Worker serves as static assets.
const worker = 'http://127.0.0.1:8787';
export default defineConfig({
  plugins: [react()],
  build: { outDir: '../dist/web', emptyOutDir: true, chunkSizeWarningLimit: 4000 },
  server: { port: 5173, proxy: Object.fromEntries(['/api', '/mcp', '/mandates', '/checkout', '/mock-paypal'].map((p) => [p, worker])) },
});
