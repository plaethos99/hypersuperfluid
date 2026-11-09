# hypersuperfluid

A general-purpose agent built as one bundle on DeepSeek Harness (DSH): coding, DevOps, ERP, embedded systems and systems work in one agent that learns from what it does. It uses DSH's Web and desktop apps, sandbox, sessions and tools, and adds about 120 KB of its own runtime code. Nothing heavy runs until it is used.

## Run it

```bash
pnpm install
```

```bash
pnpm run build:artifacts
```

```bash
pnpm dsh web
```

The bundle is part of the `web` profile template, so new profiles get it, and **Master operator** opens each new chat. A profile created before this change needs `@deepseek-ai/dsh-hypersuperfluid` added to `dsh.profile.bundles` in its `package.json`.

For the desktop app: `pnpm run dev:desktop` to develop, and `pnpm run package:desktop:win:x64:unsigned` for a Windows test installer. Each platform's installer is built on that platform.

## Portable Windows build

The **Portable Windows build** workflow (`.github/workflows/portable-windows.yml`) builds an unsigned portable zip and an installer on a GitHub Windows runner. Run it from the Actions tab; pushing a tag such as `v0.2.2` also attaches both to a release. To build the portable folder locally after packaging:

```bash
node apps/hypersuperfluid/portable/assemble.mjs
```

The folder lands in `dist-portable/`. Start it with `Hypersuperfluid.cmd`, which keeps sessions, settings, memory, skills and browser data under the folder's `data\`.

DeepSeek Harness's own workflows stay in `.github/workflows/`. Most run only on `master`, on pull requests or by hand, and they need DeepSeek's runners and secrets. `e2e.yml` also runs on pushes to `main` and nightly, and fails here without its DeepSeek secret. To turn it off, disable it in the Actions tab, or:

```bash
gh workflow disable e2e.yml
```

## Branding

The app is named Hypersuperfluid. DeepSeek's brand guidelines reserve "DeepSeek Harness" and its marks; describing the app as "built on DSH" is allowed. Every icon comes from `branding/source.webp` through `branding/render-brand.mjs`, which writes the desktop and Web icons, the welcome wordmark and the browser plugin's images in `src/client/brand-assets.ts`. The plugin itself is `src/client/index.ts`, which the package build bundles into `lib/client.js`. After changing the artwork, run it and the tray renderer:

```bash
node apps/hypersuperfluid/branding/render-brand.mjs
```

```bash
pnpm --dir apps/desktop run render:tray-icon
```

## Models

**API keys.** Put them in the environment or a root `.env`, or in Settings > Models. In the portable app, drop them in a `keys.env` beside `Hypersuperfluid.cmd` instead: at first start they are encrypted for the Windows account (DPAPI through Electron `safeStorage`) into `data\home\hsf\keys.vault`, the file is overwritten and deleted, and the keys reach only the host process, in memory. `assemble.mjs --keys <file>` seals a keys file into a build you hand out, so its zip holds no plain-text key; the seal is built into the app, so treat such keys as recoverable by anyone who has the build, and give them spending limits.

| Provider | Variable |
|---|---|
| DeepSeek | `DEEPSEEK_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| Anthropic | `ANTHROPIC_API_KEY` |
| Google Gemini | `GEMINI_API_KEY` |
| xAI Grok | `XAI_API_KEY` |

**Any OpenAI-compatible endpoint.** Use Settings > Models > Custom provider: enter the base URL, the key and the models. To set one in configuration instead, add this to a patch or the profile's `cordis.patch.yml`. A patch replaces the row's whole `config`, so restate the routes you keep.

```yaml
- id: llm-pi-ai
  config:
    providers:
      my-gateway:
        displayName: My gateway
        apiKeyEnv: MY_GATEWAY_KEY
        api: openai-completions
        baseURL: https://gateway.example.com/v1
        models:
          - { id: my-model, name: My model, contextWindow: 200000 }
```

A local server with no authentication still needs a placeholder key.

**Subscriptions.** The agent drives each vendor's own CLI over the Agent Client Protocol. The CLI keeps its own login, and this bundle never reads or copies a token. In the desktop app, **Settings → Subscriptions** shows whether each CLI is installed and signed in; **Sign in** opens the vendor's own login in a terminal window, and **Check** opens a session without sending a prompt, so it spends nothing. You can also sign in yourself in a terminal:

| Tool | CLI | Sign in |
|---|---|---|
| `grok` | Grok Build | `grok login` |
| `agy` | Google Antigravity | run `agy` once |
| `opencode` | OpenCode | `opencode auth login`; its free models need no login |
| `gemini_cli` | Gemini CLI | run `gemini` once |
| `hermes` | Hermes Agent, with its `acp` extra | `hermes model` |

A tool appears only when its CLI is installed, and the agent picks up a newly installed CLI after a restart. `workers_status` shows what answers, and spends nothing.

**Chatting with a subscription.** `src/acp-chat.ts` also offers each installed CLI as a chat model, "<tool> · your plan", under the provider "<tool> (subscription)". Picking it makes that vendor's agent the chat's model: each Hypersuperfluid session keeps one CLI session while the app runs and sends it only the new message; a fresh CLI session (first turn, after a restart or a retry) gets the conversation so far as text. Its thinking and its own tool calls show as reasoning. It works with its own tools in the chat's working folder and also gets the chat's DSH tools through an MCP server named `hypersuperfluid` (`src/mcp-host.ts` on 127.0.0.1 behind a per-chat token, reached through the stdio pipe `src/mcp-bridge.ts`). A call to one of those ends the model step with a DSH tool call, so DSH runs it with its approvals, sandbox, display and log, and the next step returns the result to the waiting vendor; set `shareTools: false` to turn this off. It receives text only, and answers its permission requests by the row's `permission` (`allow` by default, `reject` to keep it to chat). Titles and summaries never run on it, so they spend nothing from the plan; its idle CLI stops after `idleMinutes` (30).

As a tool, a worker runs its own agent loop in the working folder and returns one final answer. With `permission: allow` it can change files under its own permissions, outside DSH's sandbox, so its tool waits for a go in Check with me mode.

Google's Gemini CLI terms forbid using its OAuth login through third-party software, and people report suspended accounts. Launching Google's own `agy` or `gemini` program is a different thing, but Google has not said whether scripted use of it is allowed. Use `GEMINI_API_KEY` for anything you cannot risk.

## Modes

Pick a mode in the new-chat picker. Each has its own persona and points at its skills; all share the working principles, the tools, the approval gate and the early handoff (one YAML anchor in `cordis.patch.yml`).

| Mode | For |
|---|---|
| Master operator | Anything; the default |
| Coding, Software testing, Data engineering | Code, tests and quality, SQL and pipelines |
| DevOps, AIOps, MLOps | Operations, telemetry and incidents, models in production |
| Embedded systems | Firmware and hardware bring-up; flashing waits for a yes |
| ERP: Odoo, SAP, Oracle, Dynamics, ERPNext, NetSuite, Tally | One consultant per ERP; Odoo has the live connection |
| Career and job search | CareerOps plus Firecrawl research; never submits anything |
| Research and analysis | Deep, cited research with Firecrawl and data analysis |
| Office documents | Word, Excel, PowerPoint, PDF, UML and other diagrams |
| Autopilot | Give it a folder and a goal; it works alone and reports |
| Guide (plain language) | Step-by-step help from screenshots; serves ask links |

## Share links: ask and agent workflows

Ask the agent to create a link (`portal_share`, which waits for a go). The guest opens it in any browser; nothing of DSH is exposed.

- **Ask link:** the guest types, pastes screenshots and attaches files, and gets step-by-step guidance in plain language from the Guide mode, on `deepseek-flash`, which reads images. The Guide mode has no shell, no file tools and no memory, and its allowlist refuses every other tool, including the ERP and Firecrawl tools.
- **Agent link:** the guest sends a task and a folder. Each task waits for your approval (`portal_jobs`, also gated), then runs in the Autopilot mode inside its own folder under `<DSH_HOME>/hsf/portal`, and the guest downloads the folder as a ZIP. DSH's Windows sandbox confines writes, not reads, which is why a person approves every task.

Each guest conversation and job is also an ordinary session in DSH, so you can watch, steer or stop it. The page server listens on 127.0.0.1:3311; a [Cloudflare quick tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/) publishes it (`winget install --id Cloudflare.cloudflared`, no account). Set `tunnel: ngrok` for ngrok, or `publicUrl` for an address you expose yourself, in the `hsf-portal` row. Without a tunnel a link works only on this computer. A quick tunnel gets a new address when the app restarts, so share those links again; links behind a fixed address keep working. Tokens are stored only as hashes, links expire (24 hours by default, 7 days at most), and `portal_stop` ends one at once.

## Handoff before the context fills

When a request uses 70% of the model's context window, below compaction's 80%, the agent is told once to call `handoff`. That writes a detailed handoff to `<working folder>/.hsf/handoffs/` (the goal in the person's words, state, decisions and reasons, files, commands, errors, next steps, open questions, plus the repository state and the model and mode) and opens a new session in the same folder, mode and model that starts from it. The old session ends with a line naming the new one. A session that began from a handoff must grow by another 25% of the window before it hands off again, so handoffs cannot chain. Compaction checkpoints are saved in the same folder as a safety net. Set `HSF_HANDOFF_THRESHOLD` (for example `0.6`) to change the share; `0` turns the notice off. The person can also ask for a handoff at any time.

## What it does

**Learns (from Hermes Agent).** `memory` keeps small, scanned stores of facts about the person and the environment, which reach new sessions as an appended, logged message, so the cached prompt prefix stays intact. `skill_manage` writes class-level skills, which must be read before they are changed. Every 10 messages or 15 tool calls, a background fork reviews the conversation and may use only `memory`, `skill_view` and `skill_manage`. A daily curator marks agent-written skills stale after 30 idle days and archives them after 90, after taking a snapshot. It never deletes, and it skips pinned skills and skills a person wrote. `learning_run` does any of this on demand. State lives in `<DSH_HOME>/hsf`, and the activity log is `learning.log`.

**Refines itself (from Harness²).** `harness_refine` runs a task under the current instructions in isolated workspace copies, proposes edits on how the agent works and what a practitioner knows, probes them on the same task, composes a refined harness, and picks the best result blind. The lesson goes into a per-domain library that later refinements read. `k` is the budget: **4k full runs and 3k editor sessions**, so it costs far more than doing the task once. It never changes the workspace: the result is a patch under `.hsf/runs/<id>/` for you to apply.

**Works like an employee (from the Odoo agent and superagent).** The persona takes as little of your attention as it can, reports failures as failures, and stops before anything hard to undo. In the Check with me permission mode, hand-offs and ERP changes wait for a message ending in "go" or a Go answer, and committing ERP calls wait for Submit. Full access and Auto skip both. Task pace lowers reasoning effort for mechanical work and raises it for hard problems, on routes that support effort.

**Knows the domains.** Skills cost one catalog line until read: `software-engineering`, `software-testing`, `data-engineering`, `devops-operations`, `aiops`, `mlops`, `systems-administration`, `embedded-systems`, `research-analysis`, `office-documents`, `job-search`, `autonomous-work`, `plain-language-guide`, `odoo-*`, and `erp-*` for Odoo, SAP, Oracle, Dynamics, ERPNext, NetSuite and Tally.

**Connects to ERP.** Copy `erp/config/erp-agent.example.yaml` to `<DSH_HOME>/hsf/erp/erp-agent.yaml`, put keys in `.env` beside it, and restart. The first start builds a Python environment of about 250 MB, which needs `uv` or Python 3.12 or newer. Until then nothing starts. This adds 8 read tools and 19 customization and module tools. **Live connections exist for Odoo only.** For the other ERPs the agent has knowledge skills and whatever browser or database access you give it.

**Researches deeply.** The Firecrawl MCP server is bundled (`firecrawl-mcp` 3.33.4) and runs with the app's own Node. Its tools search, scrape, map, crawl and extract whole sites as Markdown, and read papers and GitHub. Set `FIRECRAWL_API_KEY` for your Firecrawl plan, or `FIRECRAWL_API_URL` for a self-hosted Firecrawl; without either it uses Firecrawl's keyless tier. The key is passed as a credential reference and redacted from diagnostics. Its acting tools (`firecrawl_interact` and the monitor tools) wait for a go.

**Runs your job search.** The career mode uses [CareerOps](https://github.com/career-ops-hq/career-ops) (MIT), found as `career-ops` beside the portable app, under `<DSH_HOME>/hsf`, in a parent folder of the working folder, or at `CAREER_OPS_INSTALL`. `career_ops_status` reports what its first run needs (`npm install`, then building your CV and profile by chatting). CareerOps' own files are the only source of facts about you, and nothing is ever submitted for you.

**Makes office files.** The office mode uses DSH's Word, Excel and PowerPoint skills (bundled in the desktop app) and `office_tools`: `setup` builds a small Python environment once (pypdf, pdfplumber, reportlab, matplotlib; needs `uv` or Python 3.10+) with `pdf_tool.py` for merging, splitting, rotating, watermarking, encrypting, filling forms and extracting text and tables; `render` turns Graphviz DOT into SVG or PNG with bundled WebAssembly builds of Graphviz and resvg, and PlantUML into SVG when Java and a PlantUML jar are present.

**Optional.**
- **Browser:** off by default because it opens a connection per session. `HSF_BROWSER_PATH` selects a specific Chromium.

  ```bash
  dsh plugin --profile web add @deepseek-ai/dsh-browser-use @deepseek-ai/dsh-experimental-browser-use-playwright-mcp
  ```

  Then start with `dsh web --patch apps/hypersuperfluid/optional/browser.patch.yml`.
- **Desktop control:** off by default because it sees and clicks your screen.

  ```bash
  dsh plugin --profile web add @deepseek-ai/dsh-computer-use @deepseek-ai/dsh-experimental-computer-use-cua-driver-native
  ```

  Then start with `dsh web --patch apps/hypersuperfluid/optional/computer-use.patch.yml`.
- **Proactive GitHub and Feishu work:** `dsh-superagent-prototype`, set up by its own `SETUP.md`. It needs Linux or macOS: it rejects Windows state paths and uses `sh` and `tmux`. On this DSH version, first apply `optional/superagent-dsh-0.2.2.patch` from that folder with `git apply`, because DSH removed two interfaces it used.

In the desktop app, use `--profile desktop` with the app quit, and paste an overlay's rows into the profile's `cordis.patch.yml`. These packages install from npm at this DSH version, so a private fork's unpublished version needs them from your own registry.

## Layout

| Path | Holds |
|---|---|
| `cordis.patch.yml` | The composition: routes, workers, the `master` preset |
| `src/learning/` | Memory, skills, reviews, curator |
| `src/recursion/` | `engine.ts` (pure schedule), `executor.ts` (workspaces and children), `library.ts`, `tree.ts`, `prompts.ts` |
| `src/workers.ts` | Finds CLIs and mounts ACP providers |
| `src/erp.ts`, `erp/` | ERP launcher and Python server |
| `src/gate.js`, `src/pace.js` | Approval gate and task pace |
| `src/handoff.ts` | Early handoff and checkpoint saving |
| `src/portal/`, `src/allowlist.ts` | Share links: page server, tunnel, store, ZIP results; the Guide mode's tool allowlist |
| `src/firecrawl.ts`, `src/career.ts`, `src/office.ts`, `office/` | Firecrawl server, CareerOps, office tools |
| `src/client/`, `branding/` | Browser brand plugin and the icon generator |
| `portable/` | Portable Windows folder launcher and assembler |
| `skills/` | Expert skills |

## Development

```bash
pnpm --filter @deepseek-ai/dsh-hypersuperfluid exec tsdown
```

```bash
pnpm --filter @deepseek-ai/dsh-hypersuperfluid exec vitest run
```

```bash
pnpm --filter @deepseek-ai/dsh-hypersuperfluid exec tsc --noEmit
```

See [THIRD_PARTY.md](THIRD_PARTY.md) for what was adapted from where.
