import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  build: { outDir: '../../../dist/observability/web-dist', emptyOutDir: true, assetsInlineLimit: 100000000 },
});
