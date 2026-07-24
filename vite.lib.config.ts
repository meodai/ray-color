import { defineConfig } from 'vite';

// Library build: only the DOM-free engine ships to npm.
// The playground (src/main.ts + index.html) is built by plain `vite build`.
export default defineConfig({
  // never copy public/ into the package — the SFX in there are commercially
  // licensed and must not ship to npm (see public/sfx/README.md)
  publicDir: false,
  build: {
    lib: {
      entry: 'src/engine.ts',
      name: 'rayColor',
      fileName: 'ray-color',
      formats: ['es', 'cjs'],
    },
    outDir: 'lib',
    sourcemap: true,
  },
});
