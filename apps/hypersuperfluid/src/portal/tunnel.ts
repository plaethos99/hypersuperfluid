/**
 * The public address of the portal. A Cloudflare quick tunnel by default (`cloudflared`, free, no account; the address
 * changes each time it starts), ngrok when chosen (its own login and auth token), or an address the person exposes
 * themselves (`publicUrl`). The tunnel forwards only to the portal's own port, never to DSH's interface.
 * @module hypersuperfluid/portal/tunnel
 */

import { spawn, type ChildProcess } from 'node:child_process'

/** Which tunnel to use. */
export type TunnelProvider = 'cloudflared' | 'ngrok' | 'none'

/** A running tunnel. */
export interface Tunnel {
  readonly url: string
  stop(): void
}

/**
 * Finds the first public address a tunnel prints.
 * @param provider - the tunnel.
 * @param text - its output so far.
 * @returns the address, or undefined.
 */
export function tunnelUrlIn(provider: TunnelProvider, text: string): string | undefined {
  if (provider === 'cloudflared') return /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(text)?.[0]
  if (provider === 'ngrok') return /"url":"(https:\/\/[^"]+)"/.exec(text)?.[1] ?? /url=(https:\/\/\S+)/.exec(text)?.[1]
  return undefined
}

/** How to install each tunnel, for the error a person reads. */
export const INSTALL_HINT: Record<Exclude<TunnelProvider, 'none'>, string> = {
  cloudflared: 'Install cloudflared: on Windows `winget install --id Cloudflare.cloudflared`, on macOS `brew install cloudflared`, on Linux the package from https://pkg.cloudflare.com. No account is needed.',
  ngrok: 'Install ngrok from https://ngrok.com/download and run `ngrok config add-authtoken <token>` once with the token from your ngrok account.',
}

/**
 * Starts a tunnel to a local port and waits for its public address.
 * @param provider - the tunnel.
 * @param port - the local port.
 * @param command - the executable, when not on PATH.
 * @param timeoutMs - how long to wait for the address.
 * @returns the running tunnel.
 */
export function startTunnel(provider: Exclude<TunnelProvider, 'none'>, port: number, command?: string, timeoutMs = 45_000): Promise<Tunnel> {
  const local = `http://127.0.0.1:${String(port)}`
  const args = provider === 'cloudflared'
    ? ['tunnel', '--no-autoupdate', '--url', local]
    : ['http', local, '--log', 'stdout', '--log-format', 'json']
  return new Promise((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawn(command ?? provider, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) {
      reject(new Error(`${provider} could not start: ${String(error)}. ${INSTALL_HINT[provider]}`))
      return
    }
    let output = ''
    let settled = false
    const finish = (error?: Error, url?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error !== undefined) {
        child.kill()
        reject(error)
      } else if (url !== undefined) {
        resolve({ url, stop: () => { child.kill() } })
      }
    }
    const timer = setTimeout(() => { finish(new Error(`${provider} gave no public address within ${String(timeoutMs / 1000)} s. Its last output: ${output.slice(-400)}`)) }, timeoutMs)
    const read = (chunk: Buffer): void => {
      output = (output + chunk.toString('utf8')).slice(-20_000)
      const url = tunnelUrlIn(provider, output)
      if (url !== undefined) finish(undefined, url)
    }
    child.stdout?.on('data', read)
    child.stderr?.on('data', read)
    child.on('error', (error: NodeJS.ErrnoException) => {
      finish(new Error(error.code === 'ENOENT' ? `${provider} is not installed. ${INSTALL_HINT[provider]}` : `${provider} failed: ${error.message}`))
    })
    child.on('exit', (code) => { finish(new Error(`${provider} exited (code ${String(code)}) before giving an address. Its output: ${output.slice(-400)}`)) })
  })
}
