/**
 * The app side of `mcp-bridge.ts`: a JSON-RPC endpoint on 127.0.0.1 that answers MCP `initialize`, `tools/list` and
 * `tools/call` for one subscription chat. Each chat registers with a random token, so a request names its chat by
 * the token alone and no other local program can call the tools.
 * @module hypersuperfluid/mcp-host
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/** One tool as MCP describes it. */
export interface McpTool {
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
}

/** A tool's result. */
export interface McpToolResult {
  readonly text: string
  readonly isError: boolean
}

/** What one chat offers. */
export interface McpEndpoint {
  tools(): readonly McpTool[]
  call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<McpToolResult>
}

/** One registered chat. */
export interface McpRegistration {
  readonly url: string
  readonly token: string
  dispose(): void
}

const PROTOCOL_VERSION = '2025-06-18'
const MAX_BODY = 8 * 1024 * 1024

interface RpcMessage {
  readonly jsonrpc?: string
  readonly id?: string | number | null
  readonly method?: string
  readonly params?: Record<string, unknown>
}

/** The shared local server. It starts with the first chat and stops with the adapter. */
export class McpHost {
  private server: Server | undefined
  private starting: Promise<string> | undefined
  private readonly endpoints = new Map<string, McpEndpoint>()

  /**
   * Registers a chat.
   * @param endpoint - its tools.
   * @returns the URL and token the bridge needs.
   */
  async register(endpoint: McpEndpoint): Promise<McpRegistration> {
    const url = await this.start()
    const token = randomBytes(24).toString('base64url')
    this.endpoints.set(token, endpoint)
    return { url, token, dispose: () => { this.endpoints.delete(token) } }
  }

  /** Stops the server. */
  close(): Promise<void> {
    this.endpoints.clear()
    const server = this.server
    this.server = undefined
    this.starting = undefined
    if (server === undefined) return Promise.resolve()
    return new Promise((done) => { server.close(() => { done() }); server.closeAllConnections() })
  }

  private start(): Promise<string> {
    this.starting ??= new Promise((done, reject) => {
      const server = createServer((request, response) => { void this.handle(request, response) })
      server.on('error', reject)
      server.listen(0, '127.0.0.1', () => {
        this.server = server
        server.unref()
        done(`http://127.0.0.1:${String((server.address() as AddressInfo).port)}/mcp`)
      })
    })
    return this.starting
  }

  private endpointOf(request: IncomingMessage): McpEndpoint | undefined {
    const header = request.headers.authorization ?? ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : ''
    const wanted = Buffer.from(token)
    for (const [known, endpoint] of this.endpoints) {
      const have = Buffer.from(known)
      if (have.length === wanted.length && timingSafeEqual(have, wanted)) return endpoint
    }
    return undefined
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== 'POST' || request.url !== '/mcp') {
      response.writeHead(request.method === 'POST' ? 404 : 405).end()
      return
    }
    const endpoint = this.endpointOf(request)
    if (endpoint === undefined) {
      response.writeHead(401).end()
      return
    }
    let body = ''
    for await (const chunk of request) {
      body += String(chunk)
      if (body.length > MAX_BODY) {
        response.writeHead(413).end()
        return
      }
    }
    let parsed: RpcMessage | RpcMessage[]
    try {
      parsed = JSON.parse(body) as RpcMessage | RpcMessage[]
    } catch {
      response.writeHead(400, { 'content-type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }))
      return
    }
    const aborted = new AbortController()
    response.on('close', () => { if (!response.writableFinished) aborted.abort() })
    const messages = Array.isArray(parsed) ? parsed : [parsed]
    const answers = (await Promise.all(messages.map(message => this.answer(endpoint, message, aborted.signal))))
      .filter(answer => answer !== undefined)
    if (answers.length === 0) {
      response.writeHead(202).end()
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify(Array.isArray(parsed) ? answers : answers[0]))
  }

  private async answer(endpoint: McpEndpoint, message: RpcMessage, signal: AbortSignal): Promise<unknown> {
    if (message.id === undefined || message.id === null) return undefined
    const reply = (result: unknown): unknown => ({ jsonrpc: '2.0', id: message.id, result })
    const error = (code: number, text: string): unknown => ({ jsonrpc: '2.0', id: message.id, error: { code, message: text } })
    switch (message.method) {
      case 'initialize': {
        const requested = message.params?.protocolVersion
        return reply({
          protocolVersion: typeof requested === 'string' ? requested : PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'hypersuperfluid', version: '1' },
          instructions: 'Hypersuperfluid\'s own tools for this chat. A call can wait for the person\'s approval.',
        })
      }
      case 'ping':
        return reply({})
      case 'tools/list':
        return reply({ tools: endpoint.tools() })
      case 'tools/call': {
        const name = message.params?.name
        const args = message.params?.arguments
        if (typeof name !== 'string') return error(-32602, 'tools/call needs a tool name')
        if (!endpoint.tools().some(tool => tool.name === name)) return error(-32602, `unknown tool: ${name}`)
        try {
          const result = await endpoint.call(name, typeof args === 'object' && args !== null ? args as Record<string, unknown> : {}, signal)
          return reply({ content: [{ type: 'text', text: result.text }], isError: result.isError })
        } catch (cause) {
          return reply({ content: [{ type: 'text', text: cause instanceof Error ? cause.message : String(cause) }], isError: true })
        }
      }
      default:
        return error(-32601, `method not found: ${String(message.method)}`)
    }
  }
}
