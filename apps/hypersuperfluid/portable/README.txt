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

Then open Settings > Models and enter an API key, or add an OpenAI-compatible endpoint under Custom provider.

Optional
--------
- Subscription workers appear when their command-line tools are installed and signed in on this PC:
  grok (Grok Build), agy (Google Antigravity), opencode (OpenCode), gemini (Gemini CLI).
- ERP tools need uv or Python 3.12 or newer on this PC. Put data\home\hsf\erp\erp-agent.yaml in place to connect an
  ERP; the template is erp\config\erp-agent.example.yaml in the app's resources.

Hypersuperfluid is built on DSH (DeepSeek Harness), which is open source under the MIT license.
