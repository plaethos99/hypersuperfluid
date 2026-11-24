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
    firecrawl: 'src/firecrawl.ts',
    career: 'src/career.ts',
    handoff: 'src/handoff.ts',
    office: 'src/office.ts',
    portal: 'src/portal/index.ts',
    allowlist: 'src/allowlist.ts',
    'acp-chat': 'src/acp-chat.ts',
    'mcp-bridge': 'src/mcp-bridge.ts',
    'office-editor': 'src/office-editor/index.ts',
    'office-editor-tools': 'src/office-editor/tools.ts',
    creative: 'src/creative/index.ts',
    'creative-tools': 'src/creative/tools.ts',
    apps: 'src/apps/index.ts',
    'apps-tools': 'src/apps/tools.ts',
  },
  outDir: 'lib',
  format: 'esm',
  fixedExtension: false,
  platform: 'node',
  target: 'es2024',
  dts: false,
  clean: true,
  // The WebAssembly packages load their .wasm beside their own files, and firecrawl-mcp is started by path.
  deps: { neverBundle: [/^@deepseek-ai\//, 'zod', 'firecrawl-mcp', '@viz-js/viz', '@resvg/resvg-wasm'] },
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
  // three.js makes up most of this file, so it ships minified.
  minify: true,
  dts: false,
  // The host build above already cleaned lib/; cleaning here would remove its output.
  clean: false,
  // Plugins come from the loader; the few libraries DSH's own client builds inline (INLINE_SAFE in
  // packages/client/tsdown.client.ts) are inlined here too, since the loader does not provide them.
  deps: { neverBundle: ['react', 'react/jsx-runtime', 'react-dom', /^@deepseek-ai\/(?!dsh-util-workspace-path(?:\/|$))/] },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: "@deepseek-ai/dsh-hypersuperfluid", factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
} as const

export default defineConfig([host, client])
