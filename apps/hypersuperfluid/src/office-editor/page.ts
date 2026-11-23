/**
 * The host page around one ONLYOFFICE editor. It is served by `server.ts` on the same origin as the editor, so it can
 * reach the editor's document API directly (as ONLYOFFICE plugins do), and it:
 * - loads the file into the editor (`document:open-buffer` from the embed API),
 * - saves edits back to the file a moment after they stop (`document:save`), with a status line,
 * - takes the agent's scripts (Office JavaScript) from the server, runs them in the open document and reports the
 *   result, then saves,
 * - reloads the file when it changed on disk and there are no unsaved edits.
 * @module hypersuperfluid/office-editor/page
 */

/** What the page needs to know. */
export interface PageOptions {
  readonly id: string
  readonly token: string
  readonly kind: string
  readonly name: string
  readonly theme: 'light' | 'dark'
}

/**
 * The page's HTML.
 * @param options - the document.
 * @returns a complete HTML document.
 */
export function hostPage(options: PageOptions): string {
  const config = JSON.stringify(options).replaceAll('<', '\\u003c')
  const dark = options.theme === 'dark'
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(options.name)}</title>
<style>
html,body{margin:0;height:100%;overflow:hidden;background:${dark ? '#0d121b' : '#fcfcfd'};font:12px system-ui,sans-serif}
#editor{position:absolute;inset:0;width:100%;height:100%;border:0}
#status{position:absolute;right:12px;bottom:30px;padding:4px 10px;border-radius:999px;pointer-events:none;opacity:0;transition:opacity .2s;
background:${dark ? 'rgba(20,27,40,.92)' : 'rgba(255,255,255,.95)'};color:${dark ? '#e9edf4' : '#0f1623'};box-shadow:0 1px 4px rgba(0,0,0,.2)}
#status.show{opacity:1}#status.bad{color:#d14343}
#notice{display:none;position:absolute;left:50%;top:8px;transform:translateX(-50%);padding:6px 12px;border-radius:8px;background:#fbf3df;color:#5a3d06}
#notice button{margin-left:8px;font:inherit;cursor:pointer}
</style></head>
<body><iframe id="editor" src="/office?embed=1&amp;locale=en" allow="clipboard-read; clipboard-write"></iframe>
<div id="status"></div><div id="notice"><span></span><button type="button">Reload</button></div>
<script>
(() => {
  const C = ${config};
  const frame = document.getElementById('editor');
  const status = document.getElementById('status');
  const notice = document.getElementById('notice');
  const q = '?t=' + encodeURIComponent(C.token);
  const base = '/hsf/doc/' + C.id + '/';
  let opened = false, dirty = false, saving = false, saveAgain = false, saveTimer = 0, version = '', statusTimer = 0;

  const show = (text, bad = false, keep = false) => {
    status.textContent = text; status.className = 'show' + (bad ? ' bad' : '');
    clearTimeout(statusTimer);
    if (!keep) statusTimer = setTimeout(() => { status.className = ''; }, 2500);
  };
  const send = (type, payload = {}, transfer) => {
    const id = Math.random().toString(16).slice(2);
    frame.contentWindow.postMessage({ id, type, payload }, location.origin, transfer || []);
    return id;
  };

  async function load() {
    const response = await fetch(base + 'file' + q, { cache: 'no-store' });
    if (!response.ok) { show('This file could not be opened (' + response.status + ').', true, true); return; }
    version = response.headers.get('x-hsf-version') || '';
    const buffer = await response.arrayBuffer();
    send('document:open-buffer', { fileName: C.name, buffer, readonly: false }, [buffer]);
  }

  function scheduleSave(delay = 1500) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, delay);
  }
  function save() {
    if (!opened) return;
    if (saving) { saveAgain = true; return; }
    saving = true; show('Saving…', false, true);
    send('document:save');
  }
  async function upload(file, stillDirty) {
    try {
      const response = await fetch(base + 'save' + q, { method: 'POST', body: await file.arrayBuffer() });
      if (response.status === 409) {
        notice.firstElementChild.textContent = 'This file changed on disk while it was open. Your edits are kept here; reload to see the file\\'s version.';
        notice.style.display = 'block'; show('Not saved: the file changed on disk.', true, true);
      } else if (!response.ok) {
        show('Not saved (' + response.status + ').', true, true);
      } else {
        version = (await response.json()).version || version;
        show('Saved');
      }
    } catch (error) { show('Not saved: ' + error.message, true, true); }
    saving = false;
    if (saveAgain || stillDirty) { saveAgain = false; scheduleSave(500); }
  }

  // The editor announces itself with \`document:ready\` on its window's load event, which can pass before its embed API
  // listens (or before this page sees it). So ask for its state until it answers, and load the file on the first reply.
  let ready = false, handshake = 0;
  const greet = () => {
    if (ready) return;
    try { send('document:get-state'); } catch {}
    handshake = setTimeout(greet, 300);
  };
  const becameReady = () => {
    if (ready) return;
    ready = true; clearTimeout(handshake);
    // The editor follows \`data-ran-theme\` on its root (else the OS setting); match the app's mode.
    try { frame.contentDocument.documentElement.setAttribute('data-ran-theme', C.theme); } catch {}
    load();
  };
  greet();

  window.addEventListener('message', (event) => {
    if (event.source !== frame.contentWindow) return;
    const { type, payload } = event.data || {};
    if (type === 'document:ready' || type === 'document:state') becameReady();
    else if (type === 'document:opened') { opened = true; dirty = false; poll(); }
    else if (type === 'document:dirty-changed') { dirty = !!(payload && payload.dirty); if (dirty) scheduleSave(); }
    else if (type === 'document:saved') upload(payload.file, !!payload.dirty);
    else if (type === 'document:error') { saving = false; show(String((payload && payload.message) || 'The editor reported an error.'), true); }
  });
  notice.querySelector('button').addEventListener('click', () => { notice.style.display = 'none'; opened = false; load(); });

  // The document API of the open editor, as ONLYOFFICE's own plugins reach it.
  function editorApi() {
    const inner = frame.contentDocument && frame.contentDocument.querySelector('iframe[name="frameEditor"]');
    const w = inner && inner.contentWindow;
    return w && (w.editor || (w.Asc && w.Asc.editor)) ? { w, api: w.editor || w.Asc.editor } : undefined;
  }
  async function runScript(script) {
    const found = editorApi();
    if (!found) throw new Error('The editor is not ready yet.');
    const { w, api } = found;
    for (let i = 0; i < 50 && (api.isLongAction && api.isLongAction()); i++) await new Promise(r => setTimeout(r, 100));
    const code = '(function(){try{return (function(){\\n' + script + '\\n})()}catch(e){return {__hsfError:String(e&&e.message||e)}}})()';
    let value;
    await new Promise((done) => {
      api._beforeEvalCommand();
      try { value = w.AscCommon.safePluginEval(code); } catch (error) { value = { __hsfError: String(error && error.message || error) }; }
      api._afterEvalCommand(() => { api.evalCommand = false; api.onEndBuilderScript(() => done()); });
      setTimeout(done, 5000);
    });
    if (value && typeof value === 'object' && '__hsfError' in value) throw new Error(value.__hsfError);
    try { return JSON.parse(JSON.stringify(value === undefined ? null : value)); } catch { return String(value); }
  }

  let polling = false;
  async function poll() {
    // One loop per page: a second one would keep answering the first's long poll.
    if (polling) return;
    polling = true;
    try { await pollLoop(); } finally { polling = false; }
  }
  async function pollLoop() {
    while (opened) {
      let response;
      const started = Date.now();
      try { response = await fetch(base + 'next' + q, { cache: 'no-store' }); } catch { await new Promise(r => setTimeout(r, 2000)); continue; }
      if (response.status === 403) { show('This editor link has expired. Open the file again.', true, true); return; }
      const disk = response.headers.get('x-hsf-version') || '';
      if (response.status === 204) {
        if (disk && version && disk !== version && !dirty && !saving) { opened = false; show('Updated from disk'); load(); return; }
        if (Date.now() - started < 1000) await new Promise(r => setTimeout(r, 1000));
        continue;
      }
      if (!response.ok) { await new Promise(r => setTimeout(r, 2000)); continue; }
      const command = await response.json();
      let result;
      try { result = { id: command.id, ok: true, value: await runScript(command.script) }; show('Edited by the agent'); }
      catch (error) { result = { id: command.id, ok: false, error: String(error && error.message || error) }; }
      await fetch(base + 'result' + q, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(result) }).catch(() => {});
      if (result.ok) scheduleSave(800);
    }
  }
})();
</script></body></html>`
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/gu, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' })[char] as string)
}
