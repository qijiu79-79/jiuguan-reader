import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const fromExtension = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  envDir: false,
  publicDir: false,
  build: {
    outDir: fromExtension('../../dist-extensions/jiuguan-reader'),
    emptyOutDir: true,
    target: 'es2022',
    lib: {
      entry: fromExtension('./src/index.ts'),
      formats: ['es'],
      fileName: () => 'index.js',
      cssFileName: 'style',
    },
    rollupOptions: { output: { assetFileNames: '[name][extname]' } },
  },
  plugins: [{
    name: 'jiuguan-reader-delivery-files',
    generateBundle() {
      for (const [fileName, sourcePath] of [
        ['manifest.json', './manifest.json'],
        ['README.md', './README.md'],
        ['LICENSE', '../../LICENSE'],
        ['THIRD_PARTY_NOTICES.md', '../../THIRD_PARTY_NOTICES.md'],
      ]) {
        this.emitFile({ type: 'asset', fileName, source: readFileSync(fromExtension(sourcePath), 'utf8') });
      }
    },
  }],
});
