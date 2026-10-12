import { defineConfig } from 'vite';

// Library build: the DOM-free engine plus the <ray-color-view> web component
// entries. The playground (src/main.ts + index.html) is built by plain
// `vite build`.
export default defineConfig({
  // never copy public/ into the package — the SFX in there are commercially
  // licensed and must not ship to npm (see public/sfx/README.md)
  publicDir: false,
  build: {
    lib: {
      entry: {
        'ray-color': 'src/engine.ts',
        'view': 'src/view.ts',
        'view-webgl': 'src/view-webgl.ts',
        'view-software': 'src/view-software.ts',
      },
      name: 'rayColor',
      formats: ['es', 'cjs'],
      fileName: (format, entryName) => `${entryName}.${format === 'es' ? 'js' : 'cjs'}`,
    },
    outDir: 'lib',
    rollupOptions: {
      // shared engine/core code lands in chunks the entries import, so
      // view + view-software never duplicate the engine. Sourcemaps ship for
      // the ESM build only: they were most of the tarball, and CJS consumers
      // are bundlers or Node scripts that rarely step into the engine.
      output: [
        { format: 'es', sourcemap: true, chunkFileNames: 'chunks/[name]-[hash].es.js' },
        { format: 'cjs', sourcemap: false, chunkFileNames: 'chunks/[name]-[hash].cjs.js' },
      ],
    },
  },
});
