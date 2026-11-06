import { defineConfig } from 'tsdown'

/** The host half: one Node library per subpath export. */
const host = {
  entry: {
    brand: 'src/brand.ts',
    learning: 'src/learning/index.ts',
    skills: 'src/skills.ts',
    recursion: 'src/recursion/index.ts',
    workers: 'src/workers.ts',
    erp: 'src/erp.ts',
    gate: 'src/gate.js',
    pace: 'src/pace.js',
  },
  outDir: 'lib',
  format: 'esm',
  fixedExtension: false,
  platform: 'node',
  target: 'es2024',
  dts: false,
  clean: true,
  deps: { neverBundle: [/^@deepseek-ai\//, 'zod'] },
} as const

/**
 * The browser half, in the factory format the DSH module loader runs (the same wrapper as
 * `packages/client/tsdown.client.ts`): externals resolve through the loader's `require`, so only React stays an
 * import, and the brand images inline from `src/client/brand-assets.ts`.
 */
const client = {
  name: '@deepseek-ai/dsh-hypersuperfluid/client',
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  dts: false,
  // The host build above already cleaned lib/; cleaning here would remove its output.
  clean: false,
  deps: { neverBundle: ['react', 'react/jsx-runtime', 'react-dom', /^@deepseek-ai\//] },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: "@deepseek-ai/dsh-hypersuperfluid", factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
} as const

export default defineConfig([host, client])
