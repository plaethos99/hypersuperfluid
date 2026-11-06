Hypersuperfluid, portable for Windows x64
=========================================

Start it with Hypersuperfluid.cmd, not with the .exe inside app\.

The launcher keeps everything in this folder, under data\: sessions, settings, keys you enter in Settings, memory,
learned skills, the ERP environment and browser data. Copy the folder to move all of it to another PC; delete the
folder to remove it. Nothing is installed and no registry entry is written.

First start
-----------
This build is not code-signed, so Windows SmartScreen may say "Windows protected your PC".
Choose More info, then Run anyway. Before extracting a downloaded zip, you can instead right-click it,
choose Properties, tick Unblock, and press OK.

API keys
--------
Put your keys in a file named keys.env (or .env) in this folder, one per line:

  DEEPSEEK_API_KEY=...
  OPENROUTER_API_KEY=...
  FIRECRAWL_API_KEY=...

then start Hypersuperfluid.cmd. On that first start the keys are encrypted for your Windows account and the file is
overwritten and deleted, so no readable copy stays on disk. The keys never show in Settings, and the agent cannot read
them. To change a key, drop a new keys.env with just that line; to remove one, write NAME= with nothing after it.

The encrypted keys work only for this Windows account on this PC. After copying the folder to another PC, drop the
keys file in again. If this folder came with keys.sealed, the person who built it sealed keys into it; they are moved
into the encrypted store the same way.

You can also enter keys in Settings > Models, or add any OpenAI-compatible endpoint under Custom provider; keys entered
there are kept in data\home\.env, which is not encrypted.

Modes
-----
Pick a mode when you start a chat: Master operator, Coding, Software testing, Data engineering, DevOps, AIOps, MLOps,
Embedded systems, one per ERP (Odoo, SAP, Oracle, Dynamics, ERPNext, NetSuite, Tally), Career and job search,
Research and analysis, Office documents, Autopilot, and Guide (plain language).

Career and job search uses CareerOps from the career-ops folder here. Its scripts need Node.js 22 or newer installed
on this PC (https://nodejs.org); the agent tells you what is missing on first use.

Share links
-----------
Ask the agent to "create an ask link" or "create an agent link". Ask links let someone send screenshots and questions
and get step-by-step help. Agent links take a task and a folder; each task waits for your approval. To reach people
outside this PC, install cloudflared once (winget install --id Cloudflare.cloudflared); without it a link works only
on this computer.

Optional
--------
- Subscription workers appear when their command-line tools are installed and signed in on this PC:
  grok (Grok Build), agy (Google Antigravity), opencode (OpenCode), gemini (Gemini CLI), hermes (Hermes Agent).
  Settings > Subscriptions shows each one's status; Sign in opens the vendor's own login in a terminal window.
  Restart the app after installing one.
- ERP tools need uv or Python 3.12 or newer on this PC. Put data\home\hsf\erp\erp-agent.yaml in place to connect an
  ERP; the template is erp\config\erp-agent.example.yaml in the app's resources.

Hypersuperfluid is built on DSH (DeepSeek Harness), which is open source under the MIT license.
