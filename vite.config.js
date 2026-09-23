import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// VITE_BASE sets the subpath the SPA is served from. In development it stays
// '/' (npm run dev at the root of localhost:5173); the production build uses
// '/flow-editor/', the subpath published by nginx (see docs/DEPLOY.md).
const base = process.env.VITE_BASE || '/';

export default defineConfig({
  base,
  plugins: [react()],
  server: {
    // The API runs in a container (see docker-compose.yml) published on
    // 127.0.0.1:8010. The proxy avoids CORS in development: the browser only
    // ever talks to the dev server.
    //
    // FLOW_API_TARGET points at another API -- that is how the end-to-end suite
    // runs against a disposable database instead of the production one, which
    // is what 8010 serves. See e2e/README.md.
    proxy: {
      '/api': {
        target: process.env.FLOW_API_TARGET || 'http://127.0.0.1:8010',
        changeOrigin: true
      }
    }
  },
  build: { sourcemap: false },
  // Unit tests (Vitest). Pure modules only -- no DOM environment is needed,
  // because every component reads what src/ops/view.js returns.
  test: { include: ['src/**/*.test.js'], environment: 'node' }
});
