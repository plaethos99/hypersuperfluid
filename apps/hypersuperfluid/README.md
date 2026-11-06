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

DeepSeek Harness's own workflows stay in `.github/workflows/` but are disabled in this repository's Actions settings, because they need DeepSeek's private runners and secrets. Re-enable one with `gh workflow enable <file>`.

## Branding

The app is named Hypersuperfluid. DeepSeek's brand guidelines reserve "DeepSeek Harness" and its marks; describing the app as "built on DSH" is allowed. Every icon comes from `branding/source.webp` through `branding/render-brand.mjs`, which writes the desktop and Web icons, the welcome wordmark and the browser plugin's images in `src/client/brand-assets.ts`. The plugin itself is `src/client/index.ts`, which the package build bundles into `lib/client.js`. After changing the artwork, run it and the tray renderer:

```bash
node apps/hypersuperfluid/branding/render-brand.mjs
```

```bash
pnpm --dir apps/desktop run render:tray-icon
```

## Models

**API keys.** Put them in the environment or a root `.env`, or in Settings > Models.

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

**Subscriptions.** The agent drives each vendor's own CLI over the Agent Client Protocol. The CLI keeps its own login, and this bundle never reads or copies a token. Sign in once in a terminal:

| Tool | CLI | Sign in |
|---|---|---|
| `grok` | Grok Build | `grok login` |
| `agy` | Google Antigravity | run `agy` once |
| `opencode` | OpenCode | `opencode auth login`; its free models need no login |
| `gemini_cli` | Gemini CLI | run `gemini` once |
| `hermes` | Hermes Agent, with its `acp` extra | `hermes model` |

A tool appears only when its CLI is installed. `workers_status` shows what answers, and spends nothing.

A worker is not a model in the picker: it runs its own agent loop in the working folder and returns one final answer. With `permission: allow` it can change files under its own permissions, outside DSH's sandbox, so its tool waits for a go in Check with me mode.

Google's Gemini CLI terms forbid using its OAuth login through third-party software, and people report suspended accounts. Launching Google's own `agy` or `gemini` program is a different thing, but Google has not said whether scripted use of it is allowed. Use `GEMINI_API_KEY` for anything you cannot risk.

## What it does

**Learns (from Hermes Agent).** `memory` keeps small, scanned stores of facts about the person and the environment, which reach new sessions as an appended, logged message, so the cached prompt prefix stays intact. `skill_manage` writes class-level skills, which must be read before they are changed. Every 10 messages or 15 tool calls, a background fork reviews the conversation and may use only `memory`, `skill_view` and `skill_manage`. A daily curator marks agent-written skills stale after 30 idle days and archives them after 90, after taking a snapshot. It never deletes, and it skips pinned skills and skills a person wrote. `learning_run` does any of this on demand. State lives in `<DSH_HOME>/hsf`, and the activity log is `learning.log`.

**Refines itself (from Harness²).** `harness_refine` runs a task under the current instructions in isolated workspace copies, proposes edits on how the agent works and what a practitioner knows, probes them on the same task, composes a refined harness, and picks the best result blind. The lesson goes into a per-domain library that later refinements read. `k` is the budget: **4k full runs and 3k editor sessions**, so it costs far more than doing the task once. It never changes the workspace: the result is a patch under `.hsf/runs/<id>/` for you to apply.

**Works like an employee (from the Odoo agent and superagent).** The persona takes as little of your attention as it can, reports failures as failures, and stops before anything hard to undo. In the Check with me permission mode, hand-offs and ERP changes wait for a message ending in "go" or a Go answer, and committing ERP calls wait for Submit. Full access and Auto skip both. Task pace lowers reasoning effort for mechanical work and raises it for hard problems, on routes that support effort.

**Knows the domains.** Skills cost one catalog line until read: `software-engineering`, `devops-operations`, `systems-administration`, `embedded-systems`, `odoo-*`, and `erp-*` for Odoo, SAP, Oracle, Dynamics, ERPNext, NetSuite and Tally.

**Connects to ERP.** Copy `erp/config/erp-agent.example.yaml` to `<DSH_HOME>/hsf/erp/erp-agent.yaml`, put keys in `.env` beside it, and restart. The first start builds a Python environment of about 250 MB, which needs `uv` or Python 3.12 or newer. Until then nothing starts. This adds 8 read tools and 19 customization and module tools. **Live connections exist for Odoo only.** For the other ERPs the agent has knowledge skills and whatever browser or database access you give it.

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
