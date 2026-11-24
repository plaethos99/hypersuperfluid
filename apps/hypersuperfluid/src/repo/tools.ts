/**
 * Repo builder tools: `repo_find` lists the codebases the person downloaded recently, `repo_fetch` brings one into
 * the working folder (clone, unpack or copy) and makes it the chat's working folder, and `repo_survey` reads how a
 * codebase is set up, run and tested.
 *
 * The working folder only moves into a folder inside the current one, which is where a fetch puts the codebase, so a
 * tool call never widens where the agent may write.
 * @module hypersuperfluid/repo/tools
 */

import { cp, stat } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-working-directory'
import { downloadsFolder, fetchRepo, freeFolder, recentDownloads } from './fetch.ts'
import { formatSurvey, surveyRepo } from './survey.ts'

/** Cordis plugin name. */
export const name = 'hsf-repo-tools'
/** Services this plugin needs. */
export const inject = ['tools']

/** Folders left out when a downloaded codebase is copied in: installs and build output are made again. */
const NOT_COPIED = new Set(['node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', 'target', '.next', '.turbo'])

/** True when `child` is `parent` or inside it. */
export function isInside(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child))
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

/**
 * Copies a codebase folder into `parent`, without installs and build output.
 * @param source - the folder.
 * @param parent - where the copy goes.
 * @returns the copy.
 */
export async function copyCodebase(source: string, parent: string): Promise<string> {
  const target = freeFolder(parent, basename(source))
  await cp(source, target, {
    recursive: true,
    filter: (path) => {
      const part = path.slice(source.length).split(/[\\/]/u)
      return !part.some(segment => NOT_COPIED.has(segment))
    },
  })
  return target
}

type AgentLike = { session: never }

/**
 * @param ctx - the agent's composition.
 */
export function apply(ctx: Context): void {
  const cwdOf = (agent: AgentLike | undefined): string =>
    (agent === undefined ? undefined : ctx.get('workingDirectory')?.get(agent.session)) ?? process.cwd()

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'repo_find',
    description: 'List the codebases the person downloaded recently (zip and tar archives, and unpacked project folders in Downloads), newest first. Use it when they say "the repo I downloaded" without a path.',
    parameters: {
      folder: { type: 'string', description: 'Where to look; defaults to the Downloads folder.' },
      days: { type: 'number', description: 'How many days back; defaults to 30.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: (args) => {
      const folder = args.folder ?? downloadsFolder()
      const found = recentDownloads(folder, args.days ?? 30)
      if (found.length === 0) return Promise.resolve(`No codebase or archive changed in ${folder} in that time. Ask for a GitHub link or a path.`)
      return Promise.resolve(found.map(item => `${item.kind}: ${item.path} (${new Date(item.modified).toISOString().slice(0, 16).replace('T', ' ')})`).join('\n'))
    },
  })), 'hsf-repo: repo_find tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'repo_fetch',
    description: [
      'Bring a codebase into the working folder and make it this chat\'s working folder: a git URL (GitHub, GitLab, Bitbucket) is cloned,',
      'an archive (.zip, .tar.gz) is unpacked, a folder elsewhere is copied in (without node_modules, virtual envs and build output),',
      'and a folder already inside the working folder is used as it is. Returns where it is and a survey of how it is set up, run and tested.',
    ].join(' '),
    parameters: {
      source: { type: 'string', required: true, description: 'A git URL, or the path of an archive or folder.' },
      inPlace: { type: 'boolean', description: 'For a folder outside the working folder: survey it where it is instead of copying it in. The working folder does not move then.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      const agent = exec.agent as AgentLike | undefined
      const cwd = cwdOf(agent)
      const source = isAbsolute(args.source) || /^[a-z]+:\/\/|^git@/iu.test(args.source) ? args.source : resolve(cwd, args.source)
      let fetched = await fetchRepo(source, cwd, exec.signal)
      let note = fetched.note
      if (fetched.kind === 'folder' && !isInside(cwd, fetched.root)) {
        if (args.inPlace === true) {
          return `${formatSurvey(surveyRepo(fetched.root))}\n\nThis folder is outside the working folder, so the working folder did not move and files there cannot be changed. Ask the person to open it as the project folder, or fetch it again without inPlace to work on a copy.`
        }
        const copy = await copyCodebase(fetched.root, cwd)
        fetched = { ...fetched, root: copy }
        note = `Copied in from ${source}; the original is untouched.`
      }
      let moved = ''
      const service = ctx.get('workingDirectory')
      if (agent !== undefined && service !== undefined && isInside(cwd, fetched.root) && resolve(fetched.root) !== resolve(cwd)) {
        try {
          await service.set(agent as never, fetched.root, exec.signal)
          moved = ' It is now the working folder.'
        } catch (error) {
          moved = ` The working folder did not move (${error instanceof Error ? error.message : String(error)}); use absolute paths.`
        }
      }
      return `${note}${moved}\n\n${formatSurvey(surveyRepo(fetched.root))}`
    },
  })), 'hsf-repo: repo_fetch tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'repo_survey',
    description: 'Read what a codebase is and how it is installed, built, tested and run: its languages and frameworks, commands from its manifests, the settings its .env example names (never values), Docker, subprojects and the README\'s setup section.',
    parameters: {
      path: { type: 'string', description: 'The codebase folder; defaults to the working folder.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      const cwd = cwdOf(exec.agent as AgentLike | undefined)
      const path = args.path === undefined ? cwd : resolve(cwd, args.path)
      const info = await stat(path).catch(() => undefined)
      if (info?.isDirectory() !== true) throw new Error(`${path} is not a folder.`)
      return formatSurvey(surveyRepo(path.endsWith(sep) ? path.slice(0, -1) : path))
    },
  })), 'hsf-repo: repo_survey tool')
}
