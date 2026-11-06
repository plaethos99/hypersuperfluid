/**
 * Share links: let someone else use this agent through a web page, without access to DSH itself.
 *
 * - **Ask links** open a conversation with the `guide` mode, which explains things step by step in plain language. The
 *   guest sends text, pasted screenshots and files; images reach the model directly (DeepSeek Flash reads them), and
 *   text files are inlined. The guide mode has no shell and no file tools, and a tool allowlist blocks everything else,
 *   so a guest cannot reach this machine's files or connected systems through it.
 * - **Agent links** take a task and a folder. Each job waits for the owner's go (`portal_jobs` approve), then runs in
 *   the `autopilot` mode inside its own folder, and the guest downloads the result as a ZIP.
 *
 * The page is served by a small server on 127.0.0.1 (never DSH's own port), published by a tunnel. Every guest action
 * also appears in DSH as an ordinary session, so the owner can watch, steer or stop it.
 * @module hypersuperfluid/portal
 */

import { randomBytes } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { extname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-session-title'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { hsfHome } from '../home.ts'
import { guestPage } from './page.ts'
import { LinkStore, newId, safeJoin, type Job, type Link, type LinkKind } from './store.ts'
import { startTunnel, type Tunnel, type TunnelProvider } from './tunnel.ts'
import { zipFolder } from './zip.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'hsf-portal': { kind: 'hsf-portal'; linkId: string }
  }
}

/** Cordis plugin name. */
export const name = 'hsf-portal'
/** Services this plugin needs. */
export const inject = ['tools', 'sessions', 'attachments']

/** Portal settings. */
export interface Config {
  home?: string
  /** Local port of the guest page server, bound to 127.0.0.1. */
  port?: number
  /** Tunnel that publishes it. */
  tunnel?: TunnelProvider
  /** The tunnel's executable, when it is not on PATH. */
  tunnelCommand?: string
  /** A public address you expose yourself; used instead of a tunnel. */
  publicUrl?: string
  /** Mode for ask links. */
  guidePreset?: string
  /** Mode for agent jobs. */
  agentPreset?: string
  /** Model for guest sessions; it must read images for screenshots. Empty uses the owner's default. */
  provider?: string
  model?: string
  /** Default and longest lifetime of a link, in hours. */
  defaultHours?: number
  maxHours?: number
}

/** Runtime schema for {@link Config}. */
export const Config: z<Config> = z.object({
  home: z.string(),
  port: z.natural().default(3311),
  tunnel: z.union(['cloudflared', 'ngrok', 'none']).default('cloudflared'),
  tunnelCommand: z.string(),
  publicUrl: z.string(),
  guidePreset: z.string().default('guide'),
  agentPreset: z.string().default('autopilot'),
  provider: z.string().default('deepseek-official'),
  model: z.string().default('deepseek-flash'),
  defaultHours: z.number().default(24),
  maxHours: z.number().default(168),
})

const IMAGE_TYPES: Record<string, ImageMediaType> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }
const TEXT_EXTENSIONS = new Set(['.txt', '.log', '.md', '.json', '.csv', '.tsv', '.xml', '.yaml', '.yml', '.ini', '.cfg', '.conf', '.toml', '.env.example', '.py', '.js', '.ts', '.tsx', '.jsx', '.java', '.cs', '.go', '.rs', '.c', '.h', '.cpp', '.hpp', '.php', '.rb', '.sh', '.ps1', '.bat', '.sql', '.html', '.css', '.kt', '.swift'])
const LIMITS = {
  ask: { bodyBytes: 36 * 1024 * 1024, files: 10, textInline: 100_000 },
  agent: { bodyBytes: 280 * 1024 * 1024, files: 5000 },
  messagesPerTenMinutes: 30,
}

/** The guest-visible view of a job. */
function jobView(job: Job): Record<string, unknown> {
  return { id: job.id, task: job.task, status: job.status, download: job.status === 'done' && job.result !== undefined }
}

/** Text blocks of an assistant message, joined. */
function textOfMessage(content: readonly ContentBlock[]): string {
  return content.filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text').map(block => block.text).join('\n').trim()
}

/**
 * @param ctx - the host composition.
 * @param config - the settings.
 */
export function apply(ctx: Context, config: Config): void {
  const store = new LinkStore(join(hsfHome(config.home), 'portal'))
  const port = config.port ?? 3311
  const busy = new Set<string>()
  const lastText = new Map<string, string>()
  const recent = new Map<string, number[]>()
  let server: Server | undefined
  let tunnel: Tunnel | undefined
  let tunnelStarting: Promise<Tunnel> | undefined

  const controller = () => {
    const found = ctx.get('sessionController')
    if (found === undefined) throw new Error('This deployment cannot open sessions, so share links are unavailable.')
    return found
  }

  /** Opens a guest session in a folder with a mode and the configured model. */
  const openSession = async (cwd: string, preset: string, title: string): Promise<Agent> => {
    mkdirSync(cwd, { recursive: true })
    const sessions = controller()
    const created = await sessions.create({ sessionId: SessionId(`portal-${randomBytes(8).toString('hex')}`), cwd, agentPreset: preset })
    const resolved = await sessions.resolveAgent(created.sessionId)
    if ('error' in resolved) throw new Error(resolved.error.message)
    const agent = resolved.agent
    if (config.provider !== undefined && config.provider !== '' && config.model !== undefined && config.model !== '') {
      agent.model.select({ provider: config.provider, model: config.model })
    }
    try {
      ctx.get('sessionTitle')?.rename(agent.session, title)
    } catch (error) {
      ctx.logger.debug('hsf-portal: session not named: %s', String(error))
    }
    return agent
  }

  const agentOf = async (sessionId: string): Promise<Agent> => {
    const resolved = await controller().resolveAgent(SessionId(sessionId))
    if ('error' in resolved) throw new Error(resolved.error.message)
    return resolved.agent
  }

  // ── Replies from guest sessions back to the page. ──────────────────────────────────────────────────────────────
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'assistant/message') return
    const owner = store.bySession(String(session.id))
    if (owner === undefined) return
    const text = textOfMessage(event.data.message.content)
    if (text === '') return
    if (owner.job === undefined) store.say(owner.link, { role: 'agent', text })
    else lastText.set(String(session.id), text)
  })

  ctx.on('agent/status', ({ agent, status }) => {
    const id = String(agent.session.id)
    const owner = store.bySession(id)
    if (owner === undefined) return
    if (status !== 'idle') {
      busy.add(id)
      return
    }
    busy.delete(id)
    const job = owner.job
    if (job === undefined || job.status !== 'running') return
    const work = join(store.dirOf(owner.link), 'jobs', job.id, 'work')
    const zip = join(store.dirOf(owner.link), 'jobs', job.id, 'result.zip')
    try {
      writeFileSync(zip, zipFolder(work))
      job.result = zip
      job.status = 'done'
    } catch (error) {
      job.status = 'failed'
      ctx.logger.warn('hsf-portal: packing the result of job %s failed: %s', job.id, String(error))
    }
    job.updatedAt = new Date().toISOString()
    store.say(owner.link, { role: 'agent', text: lastText.get(id) ?? (job.status === 'done' ? 'The task is finished.' : 'The task could not be finished.') })
    lastText.delete(id)
  })

  // ── Guest messages into sessions. ──────────────────────────────────────────────────────────────────────────────
  const rateLimited = (link: Link): boolean => {
    const now = Date.now()
    const times = (recent.get(link.id) ?? []).filter(time => now - time < 600_000)
    times.push(now)
    recent.set(link.id, times)
    return times.length > LIMITS.messagesPerTenMinutes
  }

  interface Upload { readonly path: string; readonly type?: string; readonly data: string }

  const askMessage = async (link: Link, text: string, uploads: readonly Upload[]): Promise<void> => {
    if (uploads.length > LIMITS.ask.files) throw new Error(`Send at most ${String(LIMITS.ask.files)} files at a time.`)
    const folder = join(store.dirOf(link), 'files')
    mkdirSync(folder, { recursive: true })
    const content: ContentBlock[] = [{ type: 'text', text: `Message from the guest using your ask link "${link.title}":\n\n${text === '' ? '(no text, only attachments)' : text}` }]
    const names: string[] = []
    for (const upload of uploads) {
      const base = upload.path.split(/[\\/]/).pop() ?? 'file'
      const bytes = Buffer.from(upload.data, 'base64')
      const saved = safeJoin(folder, `${Date.now().toString(36)}-${base.replace(/[^\w.\- ]/g, '_')}`)
      writeFileSync(saved, bytes)
      names.push(base)
      const extension = extname(base).toLowerCase()
      const image = IMAGE_TYPES[extension]
      if (image !== undefined) {
        try {
          const ref = await ctx.attachments.saveImage({ data: new Uint8Array(bytes), mediaType: image, name: base })
          content.push({ type: 'image', attachment: ref })
        } catch (error) {
          content.push({ type: 'text', text: `[The image ${base} could not be read: ${error instanceof Error ? error.message : String(error)}]` })
        }
      } else if (TEXT_EXTENSIONS.has(extension) && bytes.length <= LIMITS.ask.textInline) {
        content.push({ type: 'text', text: `File ${base}:\n\`\`\`\n${bytes.toString('utf8')}\n\`\`\`` })
      } else {
        content.push({ type: 'text', text: `[The guest attached ${base} (${String(bytes.length)} bytes). This mode cannot open that kind of file: ask them to paste the relevant part as text or a screenshot.]` })
      }
    }
    store.say(link, { role: 'guest', text: text === '' ? '(attachments)' : text, ...names.length === 0 ? {} : { files: names } })
    try {
      if (link.sessionId === undefined) {
        const agent = await openSession(folder, config.guidePreset ?? 'guide', `Ask link: ${link.title}`)
        link.sessionId = String(agent.session.id)
        store.save()
      }
      const agent = await agentOf(link.sessionId)
      busy.add(link.sessionId)
      agent.followup(createUserMessage({ content, source: { kind: 'hsf-portal', linkId: link.id } }))
      await ctx.sessions.flush(agent.session)
    } catch (error) {
      // The guest gets a plain message; the details go to the owner's log, since they can name local paths and settings.
      ctx.logger.warn('hsf-portal: ask link "%s" could not reach its session: %s', link.title, String(error))
      if (link.sessionId !== undefined) busy.delete(link.sessionId)
      store.say(link, { role: 'notice', text: 'Sorry, the helper could not start just now. The owner has been told. Please try again in a few minutes.' })
      throw new Error('The helper could not start. Please try again in a few minutes.')
    }
  }

  const agentJob = (link: Link, text: string, uploads: readonly Upload[]): void => {
    if (text === '') throw new Error('Describe the task.')
    if (uploads.length > LIMITS.agent.files) throw new Error(`Send at most ${String(LIMITS.agent.files)} files.`)
    const job: Job = { id: newId(), task: text, status: 'waiting', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), files: uploads.length, bytes: 0 }
    const work = join(store.dirOf(link), 'jobs', job.id, 'work')
    mkdirSync(work, { recursive: true })
    let bytes = 0
    for (const upload of uploads) {
      const target = safeJoin(work, upload.path)
      mkdirSync(join(target, '..'), { recursive: true })
      const data = Buffer.from(upload.data, 'base64')
      bytes += data.length
      writeFileSync(target, data)
    }
    link.jobs.push({ ...job, bytes })
    store.say(link, { role: 'guest', text, ...uploads.length === 0 ? {} : { files: [`${String(uploads.length)} file(s)`] } })
    store.say(link, { role: 'notice', text: 'Your task was received. It starts as soon as the owner of this link approves it.' })
    ctx.logger.info('hsf-portal: job %s on link "%s" is waiting for your go: use portal_jobs to approve or reject it', job.id, link.title)
  }

  // ── The server. ────────────────────────────────────────────────────────────────────────────────────────────────
  const send = (
    response: ServerResponse, status: number, body: string | Buffer, type: string, extra: Record<string, string> = {},
  ): void => {
    response.writeHead(status, {
      'content-type': type,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      ...extra,
    })
    response.end(body)
  }
  const json = (response: ServerResponse, status: number, value: unknown): void => { send(response, status, JSON.stringify(value), 'application/json; charset=utf-8') }

  const readBody = (request: IncomingMessage, limit: number): Promise<string> => new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('That upload is too large.'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => { resolve(Buffer.concat(chunks).toString('utf8')) })
    request.on('error', reject)
  })

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? '/', 'http://portal.local')
    const match = /^\/s\/([A-Za-z0-9_-]{20,})(?:\/(state|message|download\/([a-f0-9]+)))?\/?$/.exec(url.pathname)
    if (match === null) {
      send(response, 404, 'Not found', 'text/plain; charset=utf-8')
      return
    }
    const link = store.byToken(match[1] as string)
    if (link === undefined) {
      json(response, 404, { error: 'This link does not exist.' })
      return
    }
    if (!store.active(link)) {
      json(response, 410, { error: 'This link has expired or was stopped.' })
      return
    }
    const action = match[2]
    if (action === undefined && request.method === 'GET') {
      const nonce = randomBytes(16).toString('base64')
      send(response, 200, guestPage(link.kind, link.title, nonce), 'text/html; charset=utf-8', {
        'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src data: blob:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
      })
      return
    }
    if (action === 'state' && request.method === 'GET') {
      const sessions = [link.sessionId, ...link.jobs.map(job => job.sessionId)].filter((id): id is string => id !== undefined)
      json(response, 200, {
        kind: link.kind, title: link.title, active: true, busy: sessions.some(id => busy.has(id)),
        transcript: link.transcript, jobs: link.jobs.map(jobView),
      })
      return
    }
    if (action === 'message' && request.method === 'POST') {
      if (rateLimited(link)) {
        json(response, 429, { error: 'Too many messages. Please wait a few minutes.' })
        return
      }
      try {
        const body = JSON.parse(await readBody(request, LIMITS[link.kind].bodyBytes)) as { text?: unknown; files?: unknown }
        const text = typeof body.text === 'string' ? body.text.slice(0, 20_000).trim() : ''
        const uploads = Array.isArray(body.files)
          ? body.files.filter((file): file is Upload => typeof file === 'object' && file !== null && typeof (file as Upload).path === 'string' && typeof (file as Upload).data === 'string')
          : []
        if (link.kind === 'ask') await askMessage(link, text, uploads)
        else agentJob(link, text, uploads)
        json(response, 200, { ok: true })
      } catch (error) {
        json(response, 400, { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }
    const jobId = match[3]
    if (jobId !== undefined && request.method === 'GET') {
      const job = link.jobs.find(candidate => candidate.id === jobId)
      if (job?.result === undefined || !existsSync(job.result)) {
        json(response, 404, { error: 'No result yet.' })
        return
      }
      response.writeHead(200, {
        'content-type': 'application/zip',
        'content-length': String(statSync(job.result).size),
        'content-disposition': `attachment; filename="result-${job.id}.zip"`,
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
      })
      createReadStream(job.result).pipe(response)
      return
    }
    send(response, 405, 'Method not allowed', 'text/plain; charset=utf-8')
  }

  const ensureServer = (): Promise<void> => {
    if (server !== undefined) return Promise.resolve()
    const created = createServer((request, response) => {
      handle(request, response).catch((error: unknown) => {
        ctx.logger.warn('hsf-portal: request failed: %s', String(error))
        if (!response.headersSent) json(response, 500, { error: 'Something went wrong on the owner\'s side.' })
      })
    })
    server = created
    return new Promise((resolve, reject) => {
      created.once('error', (error) => {
        server = undefined
        reject(new Error(`The share page could not use port ${String(port)}: ${error.message}. Set another port in the portal settings.`))
      })
      created.listen(port, '127.0.0.1', () => { resolve() })
    })
  }

  const publicBase = async (): Promise<{ base: string; note?: string }> => {
    if (config.publicUrl !== undefined && config.publicUrl !== '') return { base: config.publicUrl.replace(/\/+$/, '') }
    const provider = config.tunnel ?? 'cloudflared'
    const local = `http://127.0.0.1:${String(port)}`
    if (provider === 'none') return { base: local, note: 'No tunnel is configured, so this address works only on this computer.' }
    if (tunnel !== undefined) return { base: tunnel.url }
    tunnelStarting ??= startTunnel(provider, port, config.tunnelCommand === '' ? undefined : config.tunnelCommand)
    try {
      tunnel = await tunnelStarting
      return { base: tunnel.url }
    } catch (error) {
      return { base: local, note: `The tunnel did not start, so this address works only on this computer. ${error instanceof Error ? error.message : String(error)}` }
    } finally {
      tunnelStarting = undefined
    }
  }

  const stopTunnelIfIdle = (): void => {
    if (store.all().some(link => store.active(link))) return
    tunnel?.stop()
    tunnel = undefined
  }

  ctx.effect(() => () => {
    tunnel?.stop()
    tunnel = undefined
    server?.close()
    server = undefined
  }, 'hsf-portal: server and tunnel')

  // ── The owner's tools. ─────────────────────────────────────────────────────────────────────────────────────────
  const text = (value: string) => [{ type: 'text' as const, text: value }]
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'portal_share',
    description: 'Create a share link that someone else opens in a browser. kind "ask": they send questions, screenshots and files, and get plain-language step-by-step guidance from the guide mode, which cannot touch this computer\'s files or systems. kind "agent": they send a task and a folder; each task waits for the owner\'s approval through portal_jobs, then runs on its own in that folder and they download the result. Starts the page server and the tunnel when needed. Only create a link when the person asks for one.',
    parameters: {
      kind: { type: 'string', required: true, enum: ['ask', 'agent'] },
      title: { type: 'string', required: true, description: 'What the guest sees as the page title, for example "Help with the Odoo invoice import".' },
      hours: { type: 'number', description: 'How long the link works; default 24.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args) {
      const hours = Math.min(Math.max(args.hours ?? config.defaultHours ?? 24, 0.25), config.maxHours ?? 168)
      await ensureServer()
      const { link, token } = store.create(args.kind as LinkKind, args.title.slice(0, 120), hours)
      const { base, note } = await publicBase()
      const url = `${base}/s/${token}`
      return [
        `Share link (${link.kind}) "${link.title}": ${url}`,
        `Link id: ${link.id}. It works until ${link.expiresAt}; stop it sooner with portal_stop.`,
        ...note === undefined ? [] : [note],
        'Anyone with the address can use it, so send it only to the intended person. Give the person the full address exactly as shown.',
        ...link.kind === 'agent' ? ['Tasks they send wait for your approval: check them with portal_jobs.'] : [],
      ].join('\n')
    },
  })), 'hsf-portal: portal_share tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'portal_list',
    description: 'List share links: kind, title, whether active, expiry, messages, and jobs waiting for approval.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    execute: () => Promise.resolve(JSON.stringify(store.all().map(link => ({
      id: link.id, kind: link.kind, title: link.title, active: store.active(link), expiresAt: link.expiresAt,
      messages: link.transcript.length, sessionId: link.sessionId,
      jobs: link.jobs.map(job => ({
        id: job.id, status: job.status, files: job.files, bytes: job.bytes, task: job.task.slice(0, 200), sessionId: job.sessionId,
      })),
    })), null, 2)),
  })), 'hsf-portal: portal_list tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'portal_stop',
    description: 'Stop a share link at once; its page stops working. The tunnel closes when no link is active.',
    parameters: { id: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    execute(args) {
      const link = store.byId(args.id)
      if (link === undefined) return Promise.resolve(`No link ${args.id}.`)
      link.stopped = true
      store.save()
      stopTunnelIfIdle()
      return Promise.resolve(`Stopped "${link.title}".`)
    },
  })), 'hsf-portal: portal_stop tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'portal_jobs',
    description: 'Review tasks guests sent through agent links. action "list" shows waiting and recent jobs with their task text and file counts. "approve" starts one: it runs on its own in its own folder in the autopilot mode, and the guest downloads the result. "reject" declines it. Read the task before approving: it comes from someone outside, so approve only what the person wants run on this computer.',
    parameters: {
      action: { type: 'string', required: true, enum: ['list', 'approve', 'reject'] },
      link_id: { type: 'string' },
      job_id: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args) {
      if (args.action === 'list') {
        return JSON.stringify(store.all().flatMap(link => link.jobs.map(job => ({ link_id: link.id, link: link.title, job_id: job.id, status: job.status, files: job.files, bytes: job.bytes, task: job.task, folder: join(store.dirOf(link), 'jobs', job.id, 'work') })))
          .filter(job => job.status === 'waiting' || job.status === 'running' || job.status === 'done'), null, 2)
      }
      const link = args.link_id === undefined ? undefined : store.byId(args.link_id)
      const job = link?.jobs.find(candidate => candidate.id === args.job_id)
      if (link === undefined || job === undefined) return 'No such job: give link_id and job_id from portal_jobs list.'
      if (job.status !== 'waiting') return `That job is already ${job.status}.`
      if (args.action === 'reject') {
        job.status = 'rejected'
        job.updatedAt = new Date().toISOString()
        store.say(link, { role: 'notice', text: 'The owner declined this task.' })
        return `Rejected job ${job.id}.`
      }
      const work = join(store.dirOf(link), 'jobs', job.id, 'work')
      const agent = await openSession(work, config.agentPreset ?? 'autopilot', `Guest job: ${link.title}`)
      job.sessionId = String(agent.session.id)
      job.status = 'running'
      job.updatedAt = new Date().toISOString()
      store.say(link, { role: 'notice', text: 'The owner approved your task. Work has started.' })
      busy.add(job.sessionId)
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: `A guest sent this task through the agent link "${link.title}", and the owner approved it. Work only inside this folder, which holds the files they uploaded. Put the deliverables in this folder; everything in it is returned to the guest as a ZIP. Finish with a short report for the guest in plain language.\n\nTask:\n${job.task}` }],
        source: { kind: 'hsf-portal', linkId: link.id },
      }))
      await ctx.sessions.flush(agent.session)
      return `Approved job ${job.id}: it runs in session ${job.sessionId} (folder ${work}). The guest sees progress on their page and gets the result when it finishes.`
    },
  })), 'hsf-portal: portal_jobs tool')

  // Links that survive a restart keep working wherever their address does: on this computer, at a public URL, or a
  // fixed ngrok domain. A quick tunnel gets a new address, so those links need sharing again.
  if (store.all().some(link => store.active(link))) {
    ensureServer().catch((error: unknown) => { ctx.logger.warn('hsf-portal: %s', String(error)) })
  }
}
