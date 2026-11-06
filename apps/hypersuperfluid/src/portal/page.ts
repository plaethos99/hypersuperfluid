/**
 * The page a guest opens from a share link: one self-contained HTML document with an inline script and style under a
 * per-response nonce, so the Content-Security-Policy can forbid everything else. Ask links show a conversation that
 * takes text, pasted screenshots and files; agent links take a task and a folder, and show each job's status and its
 * result to download.
 * @module hypersuperfluid/portal/page
 */

import type { LinkKind } from './store.ts'

const escape = (text: string): string => text.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' })[ch] as string)

/**
 * Renders the guest page.
 * @param kind - the link's kind.
 * @param title - the link's title, set by the owner.
 * @param nonce - the response's script and style nonce.
 * @returns the HTML document.
 */
export function guestPage(kind: LinkKind, title: string, nonce: string): string {
  const intro = kind === 'ask'
    ? 'Describe what you are trying to do and what went wrong. Paste or attach screenshots, error messages and files. You will get clear, step-by-step help in plain language. If a step does not work, send what you see and we will fix it together.'
    : 'Describe the task, choose the folder to work on, and send it. The owner of this link checks each task before it starts. When it is finished you can download the result here.'
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escape(title)}</title>
<style nonce="${nonce}">
:root { --bg:#f6f7f9; --card:#fff; --text:#16181d; --muted:#5b6170; --line:#dfe2e8; --accent:#2f5bea; --guest:#e8eefc; --notice:#fff6e0; }
@media (prefers-color-scheme: dark) { :root { --bg:#0f1115; --card:#181b22; --text:#eef0f4; --muted:#a0a6b4; --line:#2a2f3a; --accent:#7d9bff; --guest:#1f2a44; --notice:#3a3020; } }
* { box-sizing: border-box; }
body { margin:0; font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; background:var(--bg); color:var(--text); }
main { max-width: 760px; margin: 0 auto; padding: 16px; display:flex; flex-direction:column; min-height:100vh; }
h1 { font-size: 1.3rem; margin: 8px 0 4px; }
.intro { color: var(--muted); margin: 0 0 12px; }
#log { flex:1; display:flex; flex-direction:column; gap:10px; margin-bottom: 12px; }
.msg { padding: 10px 12px; border-radius: 12px; background: var(--card); border:1px solid var(--line); white-space: pre-wrap; overflow-wrap:anywhere; }
.msg.guest { background: var(--guest); align-self: flex-end; max-width: 90%; }
.msg.notice { background: var(--notice); font-size: .92rem; }
.msg pre { background: var(--bg); border:1px solid var(--line); border-radius: 8px; padding: 8px; overflow-x:auto; white-space: pre; user-select: all; }
.msg code { background: var(--bg); border-radius: 4px; padding: 0 4px; }
.msg .files { color: var(--muted); font-size: .85rem; margin-top: 4px; }
.status { color: var(--muted); font-size: .9rem; min-height: 1.4em; }
form { background: var(--card); border:1px solid var(--line); border-radius: 12px; padding: 10px; display:flex; flex-direction:column; gap:8px; position: sticky; bottom: 8px; }
textarea { width:100%; min-height: 84px; resize: vertical; font: inherit; color: inherit; background: transparent; border: 0; outline: none; }
.row { display:flex; gap:8px; flex-wrap: wrap; align-items:center; }
button, label.button { font: inherit; border-radius: 8px; padding: 8px 14px; border:1px solid var(--line); background: var(--bg); color: var(--text); cursor:pointer; }
button.primary { background: var(--accent); color:#fff; border-color: var(--accent); margin-left:auto; }
button:disabled { opacity: .6; cursor: default; }
input[type=file] { display:none; }
.chips { color: var(--muted); font-size: .88rem; }
.job { display:flex; justify-content: space-between; gap: 8px; align-items:center; }
.job a { color: var(--accent); }
</style>
</head>
<body>
<main>
  <h1>${escape(title)}</h1>
  <p class="intro">${escape(intro)}</p>
  <div id="log" aria-live="polite"></div>
  <div class="status" id="status"></div>
  <form id="form">
    <textarea id="text" placeholder="${kind === 'ask' ? 'What do you need help with? You can paste a screenshot here.' : 'What should be done with the folder?'}"></textarea>
    <div class="chips" id="chips"></div>
    <div class="row">
      ${kind === 'agent' ? '<label class="button">Choose a folder<input id="folder" type="file" webkitdirectory multiple></label>' : ''}
      <label class="button">${kind === 'ask' ? 'Add screenshots or files' : 'Add files'}<input id="files" type="file" multiple></label>
      <button class="primary" id="send" type="submit">Send</button>
    </div>
  </form>
</main>
<script nonce="${nonce}">
(() => {
  const base = location.pathname.replace(/\\/$/, '');
  const kind = ${JSON.stringify(kind)};
  const log = document.getElementById('log');
  const status = document.getElementById('status');
  const chips = document.getElementById('chips');
  const text = document.getElementById('text');
  const send = document.getElementById('send');
  let picked = [];
  let shown = '';
  const LIMIT = kind === 'ask' ? 25 * 1024 * 1024 : 200 * 1024 * 1024;

  // A deliberately small Markdown subset. Everything is escaped first, so only these three tags can ever appear.
  const html = text => text.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  // \\x60 is a backtick, written that way because this script lives inside a template literal.
  const markdown = text => {
    const parts = html(text).split(/\\x60\\x60\\x60[a-zA-Z0-9]*\\n?/);
    return parts.map((part, i) => i % 2 === 1
      ? '<pre>' + part.replace(/\\n$/, '') + '</pre>'
      : part.replace(/\\x60([^\\x60\\n]+)\\x60/g, '<code>$1</code>').replace(/\\*\\*([^*\\n]+)\\*\\*/g, '<strong>$1</strong>')).join('');
  };

  const describe = () => {
    const total = picked.reduce((sum, item) => sum + item.file.size, 0);
    chips.textContent = picked.length === 0 ? '' : picked.length + ' file(s), ' + (total / 1048576).toFixed(1) + ' MB: ' + picked.slice(0, 6).map(item => item.path).join(', ') + (picked.length > 6 ? ', ...' : '');
  };
  const add = (files, keepPaths) => {
    for (const file of files) picked.push({ file, path: keepPaths && file.webkitRelativePath ? file.webkitRelativePath : (file.name || 'pasted-image.png') });
    describe();
  };
  document.getElementById('files').addEventListener('change', event => add(event.target.files, false));
  const folder = document.getElementById('folder');
  if (folder) folder.addEventListener('change', event => add(event.target.files, true));
  text.addEventListener('paste', event => {
    const images = [...(event.clipboardData?.files || [])].filter(file => file.type.startsWith('image/'));
    if (images.length > 0) { event.preventDefault(); add(images.map((file, i) => new File([file], 'screenshot-' + Date.now() + '-' + i + '.png', { type: file.type })), false); }
  });

  const readBase64 = file => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

  document.getElementById('form').addEventListener('submit', async event => {
    event.preventDefault();
    const message = text.value.trim();
    if (message === '' && picked.length === 0) return;
    const total = picked.reduce((sum, item) => sum + item.file.size, 0);
    if (total > LIMIT) { status.textContent = 'That is too much to send at once (limit ' + (LIMIT / 1048576) + ' MB). Please send fewer or smaller files.'; return; }
    send.disabled = true;
    status.textContent = 'Sending...';
    try {
      const files = [];
      for (const item of picked) files.push({ path: item.path, type: item.file.type, data: await readBase64(item.file) });
      const response = await fetch(base + '/message', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: message, files }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || ('The server answered ' + response.status));
      text.value = ''; picked = []; describe();
      status.textContent = '';
      await refresh();
    } catch (error) {
      status.textContent = 'Not sent: ' + error.message;
    } finally {
      send.disabled = false;
    }
  });

  const render = state => {
    const key = state.transcript.length + '|' + (state.jobs || []).map(job => job.id + job.status + (job.download ? 1 : 0)).join(',');
    if (key !== shown) {
      log.textContent = '';
      for (const entry of state.transcript) {
        const box = document.createElement('div');
        box.className = 'msg ' + entry.role;
        if (entry.role === 'agent') box.innerHTML = markdown(entry.text); else box.textContent = entry.text;
        if (entry.files && entry.files.length) {
          const files = document.createElement('div');
          files.className = 'files';
          files.textContent = 'Attached: ' + entry.files.join(', ');
          box.appendChild(files);
        }
        log.appendChild(box);
      }
      for (const job of state.jobs || []) {
        const box = document.createElement('div');
        box.className = 'msg job';
        const label = { waiting: 'Waiting for the owner to start it', running: 'Working on it', done: 'Finished', failed: 'Could not finish', rejected: 'Declined by the owner' }[job.status] || job.status;
        box.textContent = 'Task: ' + job.task.slice(0, 120) + ' - ' + label;
        if (job.download) { const link = document.createElement('a'); link.href = base + '/download/' + job.id; link.textContent = 'Download result'; box.appendChild(link); }
        log.appendChild(box);
      }
      shown = key;
      window.scrollTo(0, document.body.scrollHeight);
    }
    if (!state.active) { status.textContent = 'This link has expired or was stopped.'; send.disabled = true; }
    else if (state.busy) status.textContent = kind === 'ask' ? 'Looking at it and writing an answer...' : 'Working...';
    else if (status.textContent.startsWith('Looking') || status.textContent === 'Working...') status.textContent = '';
  };
  const refresh = async () => {
    try {
      const response = await fetch(base + '/state', { cache: 'no-store' });
      if (response.ok) render(await response.json());
      else if (response.status === 410 || response.status === 404) { status.textContent = 'This link has expired or was stopped.'; send.disabled = true; }
    } catch { /* offline for a moment; the next poll retries */ }
  };
  refresh();
  setInterval(refresh, 2500);
})();
</script>
</body>
</html>`
}
