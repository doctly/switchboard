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
      entry: resolve('src/landing/main.js'),
      name: 'SwitchboardLanding',
      fileName: () => 'landing.js',
      formats: ['iife'],
    },
    outDir: 'docs',
    emptyOutDir: false,
    rollupOptions: {
      output: {
        assetFileNames: 'landing[extname]',
      },
    },
    target: 'es2020',
    minify: true,
  },
});
