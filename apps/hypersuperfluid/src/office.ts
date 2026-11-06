/**
 * Office tools beyond DSH's Word, Excel and PowerPoint skills: PDF editing and diagram rendering.
 *
 * `office_tools` with `action: setup` builds a small Python environment once under `<HSF_HOME>/office/python` (pypdf,
 * pdfplumber, reportlab, matplotlib; about 100 MB) with `uv` or a Python 3.10+ already on the machine, and
 * returns the interpreter and the bundled `pdf_tool.py`. `action: render` turns a diagram into SVG or PNG inside the
 * host: Graphviz DOT through the bundled WebAssembly build, which needs nothing installed, and PlantUML through Java
 * when Java and a PlantUML jar are present (`PLANTUML_JAR`, or `plantuml.jar` in the office folder). PNG comes from
 * resvg's WebAssembly build with the system's own fonts, so it needs nothing compiled either.
 * @module hypersuperfluid/office
 */

import { execFile, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-working-directory'
import { hsfHome } from './home.ts'

const run = promisify(execFile)

/** Cordis plugin name. */
export const name = 'hsf-office'
/** Services this plugin needs. */
export const inject = ['tools']

/** Office settings. */
export interface Config {
  /** State directory; defaults to `HSF_HOME`, then `<DSH_HOME>/hsf`. */
  home?: string
}

/** Runtime schema for {@link Config}. */
export const Config: z<Config> = z.object({ home: z.string() })

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PYTHON_DEPENDENCIES = ['pypdf>=5.1,<7', 'pdfplumber>=0.11,<0.12', 'reportlab>=4.2,<5', 'matplotlib>=3.9,<4', 'Pillow>=10.4']

/** Where the office environment lives. */
export interface OfficePaths {
  readonly root: string
  readonly venv: string
  readonly python: string
  readonly ready: string
  readonly pdfTool: string
}

/**
 * @param home - the state directory.
 * @returns the office environment's paths.
 */
export function officePaths(home: string): OfficePaths {
  const root = join(home, 'office')
  const venv = join(root, 'python')
  return {
    root,
    venv,
    python: process.platform === 'win32' ? join(venv, 'Scripts', 'python.exe') : join(venv, 'bin', 'python'),
    ready: join(venv, '.ready'),
    pdfTool: join(packageRoot, 'office', 'pdf_tool.py'),
  }
}

/**
 * Finds a way to build the environment: `uv`, then a Python 3.10 or newer.
 * @returns the command and its leading arguments, or undefined.
 */
export function findBuilder(): { readonly kind: 'uv' | 'python'; readonly command: string; readonly args: string[] } | undefined {
  const probe = (command: string, args: string[]): string | undefined => {
    try {
      return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000, windowsHide: true }).trim()
    } catch {
      return undefined
    }
  }
  if (probe('uv', ['--version']) !== undefined) return { kind: 'uv', command: 'uv', args: [] }
  const candidates: Array<[string, string[]]> = process.platform === 'win32' ? [['py', ['-3']], ['python', []], ['python3', []]] : [['python3', []], ['python', []]]
  for (const [command, args] of candidates) {
    const version = probe(command, [...args, '-c', 'import sys; print("%d.%d" % sys.version_info[:2])'])
    if (version === undefined) continue
    const [major, minor] = version.split('.').map(Number)
    if (major === 3 && (minor ?? 0) >= 10) return { kind: 'python', command, args }
  }
  return undefined
}

/**
 * Builds the environment once. A failed build leaves no `.ready`, so the next call tries again.
 * @param paths - the environment's paths.
 * @returns a description of what happened.
 */
export async function ensureOfficeEnv(paths: OfficePaths): Promise<string> {
  if (existsSync(paths.ready) && existsSync(paths.python)) return 'ready'
  const builder = findBuilder()
  if (builder === undefined) {
    throw new Error('No Python 3.10 or newer and no uv on this machine. Ask the person to install one (for example `winget install Python.Python.3.12` or `winget install astral-sh.uv`), then call setup again.')
  }
  rmSync(paths.venv, { recursive: true, force: true })
  mkdirSync(paths.root, { recursive: true })
  const options = { timeout: 900_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }
  if (builder.kind === 'uv') {
    await run('uv', ['venv', paths.venv, '--python', '>=3.10'], options)
    await run('uv', ['pip', 'install', '--python', paths.python, ...PYTHON_DEPENDENCIES], options)
  } else {
    await run(builder.command, [...builder.args, '-m', 'venv', paths.venv], options)
    await run(paths.python, ['-m', 'pip', 'install', '--disable-pip-version-check', '--quiet', ...PYTHON_DEPENDENCIES], options)
  }
  writeFileSync(paths.ready, new Date().toISOString())
  return `built with ${builder.kind}`
}

/**
 * A PlantUML jar and Java, when both are present.
 * @param paths - the environment's paths.
 * @param env - the environment.
 * @returns the jar path, or undefined.
 */
export function plantumlJar(paths: OfficePaths, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const jar = env.PLANTUML_JAR !== undefined && env.PLANTUML_JAR !== '' ? env.PLANTUML_JAR : join(paths.root, 'plantuml.jar')
  if (!existsSync(jar)) return undefined
  try {
    execFileSync('java', ['-version'], { stdio: 'ignore', timeout: 15_000, windowsHide: true })
    return jar
  } catch {
    return undefined
  }
}

/**
 * Renders Graphviz DOT to SVG with the bundled WebAssembly Graphviz.
 * @param source - the DOT text.
 * @returns the SVG document.
 */
export async function renderDot(source: string): Promise<string> {
  const { instance } = await import('@viz-js/viz')
  const viz = await instance()
  return viz.renderString(source, { format: 'svg', engine: 'dot' })
}

/** System fonts resvg can embed, most common first. WebAssembly cannot read the system font list on its own. */
const FONT_CANDIDATES: ReadonlyArray<readonly [string, string]> = [
  ['C:/Windows/Fonts/arial.ttf', 'Arial'],
  ['C:/Windows/Fonts/segoeui.ttf', 'Segoe UI'],
  ['/System/Library/Fonts/Supplemental/Arial.ttf', 'Arial'],
  ['/System/Library/Fonts/Helvetica.ttc', 'Helvetica'],
  ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 'DejaVu Sans'],
  ['/usr/share/fonts/dejavu/DejaVuSans.ttf', 'DejaVu Sans'],
  ['/usr/share/fonts/TTF/DejaVuSans.ttf', 'DejaVu Sans'],
]

let resvgReady: Promise<typeof import('@resvg/resvg-wasm')> | undefined

/**
 * Rasterizes an SVG to PNG on a white background.
 * @param svg - the SVG document.
 * @param scale - the zoom; 2 suits documents and slides.
 * @returns the PNG bytes.
 */
export async function svgToPng(svg: string, scale = 2): Promise<Uint8Array> {
  resvgReady ??= (async () => {
    const resvg = await import('@resvg/resvg-wasm')
    const require = createRequire(import.meta.url)
    await resvg.initWasm(readFileSync(require.resolve('@resvg/resvg-wasm/index_bg.wasm')))
    return resvg
  })()
  const { Resvg } = await resvgReady
  const fonts = FONT_CANDIDATES.filter(([path]) => existsSync(path))
  const image = new Resvg(svg, {
    fitTo: { mode: 'zoom', value: scale },
    background: 'white',
    font: {
      loadSystemFonts: false,
      fontBuffers: fonts.map(([path]) => readFileSync(path)),
      ...fonts[0] === undefined ? {} : { defaultFontFamily: fonts[0][1], sansSerifFamily: fonts[0][1], serifFamily: fonts[0][1] },
    },
  })
  return image.render().asPng()
}

/**
 * @param ctx - a preset scope.
 * @param config - the settings.
 */
export function apply(ctx: Context, config: Config): void {
  const paths = officePaths(hsfHome(config.home))
  const absolute = (path: string, cwd: string): string => (isAbsolute(path) ? path : resolve(cwd, path))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'office_tools',
    description: 'PDF editing and diagram rendering. action "setup" prepares the office Python environment once (it can take a few minutes the first time) and returns the interpreter and pdf_tool.py, whose commands merge, split, extract pages, rotate, delete pages, watermark, encrypt, decrypt, fill forms, extract text and tables, combine images into a PDF, and compress. action "render" turns a diagram file into SVG or PNG: .dot/.gv (Graphviz, always available) or .puml (PlantUML, when Java and a PlantUML jar are present; "setup" says whether they are).',
    parameters: {
      action: { type: 'string', required: true, enum: ['setup', 'render'] },
      input: { type: 'string', description: 'For render: the .dot, .gv or .puml file.' },
      output: { type: 'string', description: 'For render: the .svg or .png to write.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      const cwd = (exec.agent === undefined ? undefined : ctx.get('workingDirectory')?.get(exec.agent.session)) ?? process.cwd()
      if (args.action === 'setup') {
        const built = await ensureOfficeEnv(paths)
        const jar = plantumlJar(paths)
        return JSON.stringify({
          environment: built,
          python: paths.python,
          pdf_tool: paths.pdfTool,
          usage: `"${paths.python}" "${paths.pdfTool}" --help`,
          plantuml: jar === undefined ? `not available: install Java and put a PlantUML jar at ${join(paths.root, 'plantuml.jar')} or in PLANTUML_JAR, with the person's OK; DOT works without it` : jar,
        }, null, 2)
      }
      if (args.input === undefined || args.output === undefined) throw new Error('render needs input and output.')
      const input = absolute(args.input, cwd)
      const output = absolute(args.output, cwd)
      const kind = extname(input).toLowerCase()
      const wantPng = extname(output).toLowerCase() === '.png'
      const svgPath = wantPng ? `${output.slice(0, -4)}.svg` : output
      mkdirSync(dirname(output), { recursive: true })
      if (kind === '.dot' || kind === '.gv') {
        writeFileSync(svgPath, await renderDot(readFileSync(input, 'utf8')), 'utf8')
      } else if (kind === '.puml' || kind === '.plantuml') {
        const jar = plantumlJar(paths)
        if (jar === undefined) throw new Error('PlantUML needs Java and a PlantUML jar; write the diagram as Graphviz DOT instead, or ask the person to install them.')
        await run('java', ['-jar', jar, '-tsvg', '-o', dirname(svgPath), input], { timeout: 120_000, windowsHide: true })
        const produced = join(dirname(svgPath), `${input.slice(dirname(input).length + 1, -kind.length)}.svg`)
        if (produced !== svgPath && existsSync(produced)) writeFileSync(svgPath, readFileSync(produced))
      } else {
        throw new Error(`render reads .dot, .gv or .puml, not ${kind || 'a file without an extension'}.`)
      }
      if (!wantPng) return `Wrote ${svgPath}.`
      writeFileSync(output, await svgToPng(readFileSync(svgPath, 'utf8')))
      return `Wrote ${output} (and its source ${svgPath}).`
    },
  })), 'hsf-office: office_tools tool')
}
