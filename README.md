# Hypersuperfluid

<img src="apps/hypersuperfluid/branding/source.webp" alt="Hypersuperfluid eagle" width="120">

Hypersuperfluid is one agent for most of your work: code, testing, data engineering, DevOps, AIOps and MLOps, embedded systems, ERP consulting, research, office documents and your job search. It learns how you like things done, checks with you before anything that is hard to undo, and runs from a folder on Windows with no installation.

It is built on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH), an open-source agent harness. Hypersuperfluid is an independent project and is not made or endorsed by DeepSeek.

## Run

### Download

Get the latest build from [Releases](https://github.com/plaethos99/hypersuperfluid/releases):

- **Portable zip** (`…-win-x64-portable.zip`): extract it anywhere, even a USB drive, and run `Hypersuperfluid.cmd`. Sessions, settings, memory and skills stay inside the folder.
- **Installer** (`…-win-x64-setup-unsigned.exe`): installs it like any Windows app.

The builds are unsigned, so Windows SmartScreen may warn the first time. Choose **More info**, then **Run anyway**.

### Run from source

Install `Node.js` 24 and `pnpm`, then build and start the Web UI. The Hypersuperfluid bundle is part of the `web` profile, so it loads in new profiles:

```sh
git clone https://github.com/plaethos99/hypersuperfluid.git
cd hypersuperfluid
pnpm install
pnpm run build:artifacts
pnpm --filter @deepseek-ai/dsh-hypersuperfluid run build
pnpm dsh web
```

The Web UI opens at `http://127.0.0.1:3080`. To check changes, run the typecheck and the tests:

```sh
pnpm run typecheck
pnpm exec vitest run apps/hypersuperfluid/tests apps/desktop/tests
```

### Build the Windows app

Builds run in GitHub Actions. The **Portable Windows build** workflow (`.github/workflows/portable-windows.yml`) builds the portable zip and the installer on a Windows runner. Run it from the Actions tab to get the files as run artifacts, or push a version tag to publish them as a release:

```sh
git tag -a v0.2.2-rc.3 -m "Hypersuperfluid 0.2.2-rc.3"
git push origin v0.2.2-rc.3
```

## First start

1. Put your API keys in a file named `keys.env` next to `Hypersuperfluid.cmd`, one per line, such as `DEEPSEEK_API_KEY=...`. At first start the keys are encrypted for your Windows account and the file is overwritten and deleted. They never appear in Settings, and the agent's tools cannot read them. You can also add keys later in **Settings → Models**.
2. Pick a mode in the new-chat picker, or keep **Master operator**.
3. Describe a task, or point the agent at a folder.

To use a subscription instead of an API key, open **Settings → Subscriptions** and sign in to the vendor's own command-line tool there.

## Modes

| Mode | For |
|---|---|
| Master operator | Anything; the default |
| Coding, Software testing, Data engineering | Code, tests and quality, SQL and pipelines |
| DevOps, AIOps, MLOps | Operations, telemetry and incidents, models in production |
| Embedded systems | Firmware and hardware bring-up; flashing waits for your yes |
| ERP: Odoo, SAP, Oracle, Dynamics, ERPNext, NetSuite, Tally | One consultant per ERP; Odoo has a live connection |
| Career and job search | CareerOps plus deep company research; never submits anything for you |
| Research and analysis | Deep, cited research and data analysis |
| Office documents | Word, Excel, PowerPoint, PDF editing, UML and other diagrams |
| Autopilot | Give it a folder and a goal; it works alone and reports back |
| Guide | Plain-language, step-by-step help from screenshots |

## What it does

- **Learns.** It keeps a small memory of facts about you and your setup, writes reusable skills from its own work, and reviews its conversations in the background. Stale skills are archived, never deleted.
- **Refines itself.** `harness_refine` runs a hard task several ways under improved instructions and keeps the best result as a patch for you to apply. It is expensive, so it asks first.
- **Hands off before the context fills.** At 70% of the model's context window it writes a detailed handoff (goal, state, decisions, files, commands, errors, next steps) and continues in a new session in the same folder, mode and model.
- **Shares links.** An *ask link* lets anyone send screenshots and questions and get plain-language guidance. An *agent link* lets someone upload a folder and a task; each task waits for your approval, then runs on its own, and they download the result as a ZIP. Links are published through a free Cloudflare quick tunnel (`winget install --id Cloudflare.cloudflared`).
- **Researches deeply.** The Firecrawl MCP server is built in and works without a key; set `FIRECRAWL_API_KEY` for your own plan.
- **Makes office files.** Word, Excel and PowerPoint; PDF merge, split, watermark, forms, encryption, text and tables; Graphviz and PlantUML diagrams as SVG or PNG.
- **Connects to ERP.** A live Odoo connection, and expert knowledge of SAP, Oracle, Dynamics, ERPNext, NetSuite and Tally.

## Models and subscriptions

**API keys:** DeepSeek (`DEEPSEEK_API_KEY`), OpenRouter (`OPENROUTER_API_KEY`), OpenAI (`OPENAI_API_KEY`), Anthropic (`ANTHROPIC_API_KEY`), Google Gemini (`GEMINI_API_KEY`) and xAI Grok (`XAI_API_KEY`). Any OpenAI-compatible endpoint, including a local server, can be added in **Settings → Models → Custom provider**. DeepSeek's models read screenshots.

**Subscriptions:** use the vendors' own command-line agents on your plans: Grok Build, Google Antigravity, Gemini CLI, OpenCode and Hermes Agent. Install one, restart the app, and sign in from **Settings → Subscriptions**. The login stays inside the vendor's program; Hypersuperfluid never sees it. Then either:

- **Chat with it:** pick **"Grok Build · your plan"** (or another tool's entry) in the chat's model picker. The vendor's agent answers with its own tools in the chat's working folder and on its own rules: it can't use Hypersuperfluid's tools or modes, it receives text only, and Hypersuperfluid's approval gate does not cover what it does there.
- **Hand it a task:** in any mode, ask the agent to use `grok`, `agy`, `gemini_cli`, `opencode` or `hermes`; it waits for your go in Check with me mode.

Google's Gemini CLI terms forbid using its sign-in through other software, and people report suspended accounts. Use a Gemini API key for anything you cannot risk.

## Safety

- In the **Check with me** permission mode, anything hard to undo waits for your go: handing work to another agent, ERP changes, flashing hardware, creating share links and running guest tasks.
- Keys in a distributed build: `assemble.mjs --keys` seals keys into a build you give to someone else, so its zip holds no plain-text key. Anyone who has that build can still use the keys, so give out only keys with spending limits.
- Guest tasks from an agent link always need your approval, because the Windows sandbox limits what a task can write, not what it can read.

Read DSH's [safety notice](SAFETY.md) before running the project.

## Repository layout

| Path | Holds |
|---|---|
| [`apps/hypersuperfluid/`](apps/hypersuperfluid/README.md) | The Hypersuperfluid bundle: modes, skills, learning, self-refinement, handoff, share links, Firecrawl, CareerOps, office and ERP tools, branding, and the portable assembler. Its README is the full reference. |
| `apps/desktop/src/key-vault.ts` | The encrypted key vault for keys dropped beside the portable app |
| `apps/desktop/src/subscriptions.ts` | Settings → Subscriptions: CLI status and sign-in |
| `.github/workflows/portable-windows.yml` | The portable and installer build |
| Everything else | DeepSeek Harness, which the app is built on. See [AGENTS.md](AGENTS.md) and the [development guide](docs/development.md). |

## Credits and license

Hypersuperfluid is released under the [MIT license](LICENSE), like DeepSeek Harness. It builds on ideas and code from [Hermes Agent](https://github.com/NousResearch/hermes-agent), Harness², the DSH superagent prototype, [CareerOps](https://github.com/career-ops-hq/career-ops) and [Firecrawl](https://github.com/firecrawl/firecrawl-mcp-server); see [apps/hypersuperfluid/THIRD_PARTY.md](apps/hypersuperfluid/THIRD_PARTY.md) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
