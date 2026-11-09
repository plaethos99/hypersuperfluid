/**
 * The MCP server a subscription CLI starts to reach Hypersuperfluid's tools. It is a pipe: each JSON-RPC line on stdin
 * goes to the chat's local endpoint (`HSF_MCP_URL`, authorised by `HSF_MCP_TOKEN`), and each answer comes back on
 * stdout. The endpoint, in `mcp-host.ts`, runs inside the app; a call waits there until DSH has run the tool, which
 * can include waiting for the person's approval, so requests have no timeout.
 *
 * It imports only Node built-ins and runs as a plain script: `node mcp-bridge.js`, or Electron with
 * `ELECTRON_RUN_AS_NODE=1`.
 * @module hypersuperfluid/mcp-bridge
 */

import { request } from 'node:http'
import { createInterface } from 'node:readline'

const url = process.env.HSF_MCP_URL
const token = process.env.HSF_MCP_TOKEN
if (url === undefined || url === '' || token === undefined || token === '') {
  process.stderr.write('hypersuperfluid mcp-bridge: HSF_MCP_URL and HSF_MCP_TOKEN must be set\n')
  process.exit(2)
}
const target = new URL(url)

function write(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function fail(id: unknown, message: string): void {
  if (id === undefined || id === null) return
  write({ jsonrpc: '2.0', id, error: { code: -32603, message } })
}

function forward(line: string): void {
  let id: unknown
  try {
    const parsed = JSON.parse(line) as { id?: unknown }
    id = parsed.id
  } catch {
    return
  }
  const body = Buffer.from(line, 'utf8')
  const call = request({
    hostname: target.hostname, port: target.port, path: target.pathname, method: 'POST',
    headers: {
      'content-type': 'application/json', 'accept': 'application/json, text/event-stream',
      'content-length': String(body.length), 'authorization': `Bearer ${token ?? ''}`,
    },
  }, (response) => {
    const chunks: Buffer[] = []
    response.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    response.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text !== '') process.stdout.write(`${text}\n`)
      else if ((response.statusCode ?? 500) >= 400) fail(id, `Hypersuperfluid answered HTTP ${String(response.statusCode)}`)
    })
  })
  call.on('error', (error) => { fail(id, `Hypersuperfluid is not reachable: ${error.message}`) })
  call.end(body)
}

const lines = createInterface({ input: process.stdin })
lines.on('line', (line) => { if (line.trim() !== '') forward(line) })
lines.on('close', () => { process.exit(0) })
