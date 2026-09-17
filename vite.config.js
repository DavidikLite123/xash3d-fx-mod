import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 8080,
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp"
    }
  },
  build: {
    outDir: 'dist',
    assetsInlineLimit: 0
  }
});
