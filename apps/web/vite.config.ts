import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  optimizeDeps: { include: ['@itsm/contracts'] },
  build: {
    // The linked contracts workspace emits CommonJS for the API and worker.
    commonjsOptions: { include: [/node_modules/, /packages[\\/]contracts[\\/]dist[\\/]/] },
  },
});
