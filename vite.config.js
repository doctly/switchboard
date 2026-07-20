import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'path';

export default defineConfig({
  plugins: [vue()],
  publicDir: false,
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  build: {
    lib: {
      entry: resolve('src/vue/main.js'),
      name: 'SwitchboardVue',
      fileName: () => 'vue-bundle.js',
      formats: ['iife'],
    },
    outDir: 'public',
    emptyOutDir: false,
    rollupOptions: {
      output: {
        assetFileNames: '[name][extname]',
      },
    },
    target: 'chrome130',
    minify: false,
  },
});
