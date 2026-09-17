import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: '0.0.0.0',
    port: 8080,
    allowedHosts: true,
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp"
    }
  },
  preview: {
    host: '0.0.0.0',
    port: 8080,
    allowedHosts: true,
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
