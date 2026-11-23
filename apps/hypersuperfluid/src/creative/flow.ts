/**
 * Google Flow, driven in its own browser window (`browser.ts`). Flow has no public API, so the app injects
 * {@link FLOW_DRIVER} into the Flow project tab. A picture takes three steps:
 *
 *   1. `__hsfFlow.prepare({prompt, aspect})` picks Image, the aspect ratio and one picture, types the prompt and
 *      returns where the generate button is;
 *   2. the app clicks there natively: Flow ignores clicks made by page script on that button;
 *   3. the app reads the new picture's link from Flow's own answer to that request.
 *
 * Changing a picture ("the same people, a moment later") puts it in as an ingredient: `startEdit`, then
 * `findIngredient(name)` for a picture already in the project; if it is not there, `armUpload()` marks the upload
 * input for the app to fill and `findIngredient(name, ms)` waits for it; `useIngredient(name)` adds it to the prompt
 * and `prepareEdit({prompt})` types the prompt and returns where the generate button is.
 *
 * It works the page the way a person would, at a person's pace. If Flow shows a CAPTCHA it stops and says so, for
 * the person to answer in the Flow window; it never tries to get around one.
 *
 * Tied to Flow's page as of 2026: the prompt box is labelled "What do you want to create?", the generate button
 * "Start generation", the settings button "Settings trigger", and mode, aspect and count are radio buttons in its
 * popover. When Flow changes those, this is the one place to update. Ported from BookShorts
 * (`packages/pipeline/src/flowDriver.ts`, `apps/studio/electron/flow.ts`).
 * @module hypersuperfluid/creative/flow
 */

import { createHash } from 'node:crypto'
import { copyFile, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { attach, clickAt, evaluate, serial, uploadFile, type Listen, type Send, type ServiceBrowser, type Tab } from './browser.ts'

/** Flow's home page. */
export const FLOW_URL = 'https://flow.google.com/'

/** The script injected into the Flow project tab. */
export const FLOW_DRIVER = `(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const radios = () => [...document.querySelectorAll('button[role="radio"]')];
  const pick = (label) => radios().find((b) => b.innerText.trim().split('\\n').pop().trim() === label);
  const challenge = () =>
    [...document.querySelectorAll('iframe')].some((f) => /recaptcha/.test(f.src) && /bframe|challenge/.test(f.src + f.title) && f.offsetHeight > 50);
  const imageKey = (src) => (src.split('/image/')[1] || src).split('?')[0];
  const visible = (e) => e.offsetParent !== null;
  // The project's grid, newest first: a generation's tile goes in at the very
  // start, showing its progress, then its picture or an error. Old tiles are
  // redrawn as the page scrolls and fills, so an element being new says nothing;
  // only the start of the grid says what this generation did.
  const toTop = () => {
    const grid = document.querySelector('cdk-virtual-scroll-viewport');
    if (grid && grid.scrollTop) grid.scrollTop = 0;
  };
  const gridTiles = () => [...document.querySelectorAll('flow-grid-tile-container')];
  const isError = (tile) => !!tile.querySelector('flow-error-tile');
  // How many failures the grid starts with: one more than before is this one.
  const leadingErrors = () => {
    let n = 0;
    for (const t of gridTiles()) {
      if (!isError(t)) break;
      n++;
    }
    return n;
  };
  let errorsBefore = 0;
  const markErrors = () => {
    toTop();
    errorsBefore = leadingErrors();
  };
  const refusal = () => {
    toTop();
    if (leadingErrors() <= errorsBefore) return null;
    const text = gridTiles()[0].textContent || '';
    return /polic|violat|safety|guideline/i.test(text) ? 'POLICY: Flow refused it: it might break Google’s policies' : 'Flow failed to make it: ' + text.replace(/\s+/g, ' ').trim().slice(0, 160);
  };

  // Sets the popover's radio options in order (a mode first: later options
  // depend on it), opening the popover if needed and closing it after.
  async function setOptions(labels) {
    // A project just opened is still drawing its page: give it a moment.
    let trigger = null;
    for (let i = 0; i < 40 && !trigger; i++) {
      trigger = document.querySelector('button[aria-label="Settings trigger"]');
      if (!trigger) await new Promise((r) => setTimeout(r, 500));
    }
    if (!trigger) throw new Error('Flow page not ready: no settings button');
    if (!pick(labels[0])) { trigger.click(); await sleep(700); }
    for (const label of labels) {
      const b = pick(label);
      if (!b) throw new Error('Flow has no option ' + label);
      if (b.getAttribute('aria-checked') !== 'true') { b.click(); await sleep(400); }
    }
    if (pick(labels[0])) { trigger.click(); await sleep(400); }
  }

  async function typePrompt(text) {
    const box = document.querySelector('[role="textbox"][contenteditable="true"][aria-label*="create"]');
    if (!box) throw new Error('Flow page not ready: no prompt box');
    box.focus();
    document.execCommand('selectAll');
    document.execCommand('delete');
    document.execCommand('insertText', false, text);
    await sleep(500);
    if (!box.innerText.trim()) throw new Error('Could not type the prompt into Flow');
  }

  // In Agent mode a prompt goes to Flow's chat agent, not straight to the
  // image model, and the aspect and count options are gone. Some accounts
  // start in it.
  async function agentOff() {
    const chip = [...document.querySelectorAll('button')].find(
      (b) => b.innerText.trim() === 'Agent' && b.getAttribute('aria-pressed') === 'true',
    );
    if (!chip) return;
    chip.click();
    await sleep(600);
    if (chip.getAttribute('aria-pressed') === 'true') throw new Error('Turn off "Agent" in the Flow prompt bar');
  }

  // ---- A picture as an ingredient ----------------------------------------------------

  const addButton = () => document.querySelector('button[aria-label="Add ingredients to the prompt box"]');
  const uploadButton = () => [...document.querySelectorAll('button')].filter(visible).find((b) => /Upload media/.test(b.innerText));
  const ingredients = () => [...document.querySelectorAll('button[aria-label="Ingredient"]')].filter(visible);

  async function closePicker() {
    if (!uploadButton()) return;
    addButton()?.click();
    await sleep(500);
  }

  // Whatever the last picture left in the prompt.
  async function clearIngredients() {
    await closePicker();
    for (let i = 0; i < 6 && ingredients().length; i++) {
      ingredients()[0].click();
      await sleep(400);
    }
  }

  async function openPicker() {
    if (uploadButton()) return;
    const add = addButton();
    if (!add) throw new Error('Flow page not ready: no way to add an ingredient');
    add.click();
    for (let i = 0; i < 20 && !uploadButton(); i++) await sleep(300);
    if (!uploadButton()) throw new Error('Flow did not open its picture picker');
  }

  const setSearch = async (text) => {
    const box = document.querySelector('input[placeholder="Search assets"]');
    if (!box) return;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(box, text);
    box.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(900);
  };

  const ingredientOption = (name) => [...document.querySelectorAll('[role="option"]')].filter(visible).find((o) => o.innerText.includes(name));
  const ready = (o) => { const i = o.querySelector('img'); return !!i && i.naturalWidth > 0; };

  async function startEdit({ aspect }) {
    if (challenge()) throw new Error('CAPTCHA: Flow is asking for a check — answer it in the Flow window');
    await clearIngredients();
    await agentOff();
    await setOptions(['Image', aspect, 'x1']);
  }

  // Whether the project has the picture, loaded, waiting up to ms for it.
  async function findIngredient(name, ms = 0) {
    await openPicker();
    await setSearch(name);
    const started = Date.now();
    do {
      const o = ingredientOption(name);
      if (o && ready(o)) return true;
      if (ms) await sleep(1000);
    } while (Date.now() - started < ms);
    return false;
  }

  // The next file input the upload button asks for is kept for the app to
  // fill, instead of opening a file dialog.
  async function armUpload() {
    document.querySelectorAll('[data-bs-upload]').forEach((e) => e.removeAttribute('data-bs-upload'));
    await openPicker();
    const click = HTMLInputElement.prototype.click;
    let armed = false;
    HTMLInputElement.prototype.click = function () {
      if (this.type !== 'file') return click.call(this);
      this.setAttribute('data-bs-upload', '1');
      if (!this.isConnected) {
        this.style.display = 'none';
        document.body.appendChild(this);
      }
      armed = true;
    };
    try {
      uploadButton().click();
      for (let i = 0; i < 20 && !armed; i++) await sleep(200);
    } finally {
      HTMLInputElement.prototype.click = click;
    }
    if (!armed) throw new Error('Flow did not offer a file to upload');
  }

  async function useIngredient(name) {
    const option = ingredientOption(name);
    if (!option) throw new Error('Flow lost the picture to change');
    option.click();
    for (let i = 0; i < 20; i++) {
      await sleep(300);
      const add = [...document.querySelectorAll('button')].filter(visible).find((b) => /add to prompt/i.test(b.innerText));
      if (add) {
        add.click();
        break;
      }
    }
    for (let i = 0; i < 30 && !ingredients().length; i++) await sleep(300);
    if (!ingredients().length) throw new Error('Flow did not take the picture into the prompt');
    await sleep(400);
  }

  async function prepareEdit({ prompt }) {
    await typePrompt(prompt);
    const go = document.querySelector('button[aria-label="Start generation"]');
    if (!go) throw new Error('Flow page not ready: no generate button');
    const r = go.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  }

  async function prepare({ prompt, aspect }) {
    if (challenge()) throw new Error('CAPTCHA: Flow is asking for a check — answer it in the Flow window');
    await clearIngredients();
    await agentOff();
    await setOptions(['Image', aspect, 'x1']);
    await typePrompt(prompt);
    const go = document.querySelector('button[aria-label="Start generation"]');
    if (!go) throw new Error('Flow page not ready: no generate button');
    const r = go.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  }

  // Throws when Flow asks for a check; the app reads the picture itself from
  // Flow's answer to the generation (a tile on the page can't say whose it is).
  async function watchForChallenge(timeoutMs = 600000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      await sleep(2000);
      if (challenge()) throw new Error('CAPTCHA: Flow is asking for a check — answer it in the Flow window');
    }
  }
  window.__hsfFlow = { startEdit, findIngredient, armUpload, useIngredient, prepareEdit, clearIngredients, prepare, watchForChallenge, setOptions };
  return 'ready';
})()`

/** How long one picture may take. */
const GENERATION_TIMEOUT = 180_000

/** Whether a tab is a Flow project (pictures are made inside one). */
export const isFlowProject = (tab: Tab): boolean => tab.type === 'page' && /flow\.google\.com\/project\//u.test(tab.url)

/**
 * The picture in Flow's answer to a generation: its signed link, or why there is none. The answer begins with the new
 * picture's id, and its link is one of those in the answer (an ingredient's can be there too).
 * @param body - the response body.
 * @returns the picture's link.
 */
export function pictureIn(body: string): string {
  const links = [...body.matchAll(/https:\/\/flow-content\.google\/image\/[^"\\]+(?:\\+u00(?:3d|26)[^"\\]*)*/gu)]
    .map(match => match[0].replace(/\\+u003d/gu, '=').replace(/\\+u0026/gu, '&'))
  const first = /\[\[\[\\+"([0-9a-f-]{36})\\+"/u.exec(body)?.[1]
  const link = links.find(item => first !== undefined && item.includes(first)) ?? links[0]
  if (link !== undefined) return link
  const said = body.replace(/\s+/gu, ' ').slice(0, 240)
  throw new Error(/polic|violat|unsafe|prohibit|safety|filter/iu.test(body) ? `POLICY: Flow refused it (${said})` : `Flow failed to make it (${said})`)
}

/**
 * Presses generate and reads the picture from Flow's answer to that very request, told by the prompt it carries.
 * The grid of tiles cannot say whose a picture is, so the answer is the only reliable source.
 */
async function generate(send: Send, listen: Listen, at: { x: number; y: number }, prompt: string): Promise<string> {
  await send('Network.enable', { maxPostDataSize: 1_000_000 })
  const excerpt = prompt.slice(0, 40)
  let stop = (): void => {}
  const answer = new Promise<string>((resolve, reject) => {
    const mine = new Set<string>()
    stop = listen((method, params) => {
      if (method === 'Network.requestWillBeSent') {
        const request = params.request as { url: string; method: string; postData?: string }
        if (request.method !== 'POST' || !/batchexecute/u.test(request.url)) return
        let sent = request.postData ?? ''
        try { sent = decodeURIComponent(sent) } catch { /* left as it came */ }
        if (sent.includes(excerpt)) mine.add(params.requestId as string)
      } else if (method === 'Network.loadingFinished' && mine.has(params.requestId as string)) {
        void send('Network.getResponseBody', { requestId: params.requestId as string })
          .then((result) => {
            const body = String(result.body)
            if (/flow-content\.google\/image|ErrorInfo/u.test(body)) resolve(pictureIn(body))
          })
          .catch(reject)
      }
    })
  })
  const challenge = evaluate<undefined>(send, 'window.__hsfFlow.watchForChallenge()').then(() => new Promise<never>(() => {}))
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { reject(new Error('Flow did not return a picture in time')) }, GENERATION_TIMEOUT) })
  await clickAt(send, at)
  try {
    return await Promise.race([answer, challenge, late])
  } finally {
    stop()
    clearTimeout(timer)
  }
}

/** Downloads a picture from Flow's signed link (it needs no cookies). */
async function download(url: string): Promise<Buffer> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Could not download the picture from Flow (${String(response.status)})`)
  return Buffer.from(await response.arrayBuffer())
}

/** Google Flow, through its browser window. */
export class Flow {
  private readonly exclusive = serial()

  constructor(readonly browser: ServiceBrowser) {}

  /** closed: no window; signin: open but no project open yet; ready: a project is open. */
  async state(): Promise<'closed' | 'signin' | 'ready'> {
    const tabs = await this.browser.tabs()
    if (tabs === undefined) return 'closed'
    return tabs.some(isFlowProject) ? 'ready' : 'signin'
  }

  private async project(): Promise<Tab> {
    const tab = (await this.browser.tabs())?.find(isFlowProject)
    if (tab === undefined) throw new Error('Open Flow, sign in, and open a project (New project) in the Flow window first.')
    return tab
  }

  /**
   * Draws one picture.
   * @param prompt - what it shows.
   * @param aspect - its aspect ratio, as Flow names it.
   * @returns the picture's bytes.
   */
  image(prompt: string, aspect: string): Promise<Buffer> {
    return this.exclusive(async () => {
      const url = await attach(await this.project(), async (send, listen) => {
        // A tab in the background has its timers throttled; Flow needs it awake.
        await send('Page.bringToFront')
        await evaluate(send, FLOW_DRIVER)
        const at = await evaluate<{ x: number; y: number }>(send, `window.__hsfFlow.prepare(${JSON.stringify({ prompt, aspect })})`)
        return generate(send, listen, at, prompt)
      })
      return download(url)
    })
  }

  /**
   * Changes a picture as the prompt says. The picture is uploaded to the project once, under a name made from the
   * file, and found by that name after.
   * @param picture - the picture file.
   * @param prompt - what to change.
   * @param aspect - the result's aspect ratio.
   * @returns the new picture's bytes.
   */
  edit(picture: string, prompt: string, aspect: string): Promise<Buffer> {
    return this.exclusive(async () => {
      const name = `hsf-${createHash('sha1').update(`${picture}|${String((await stat(picture)).mtimeMs)}`).digest('hex').slice(0, 16)}`
      const url = await attach(await this.project(), async (send, listen) => {
        await send('Page.bringToFront')
        await evaluate(send, FLOW_DRIVER)
        await evaluate(send, `window.__hsfFlow.startEdit(${JSON.stringify({ aspect })})`)
        if (!await evaluate<boolean>(send, `window.__hsfFlow.findIngredient(${JSON.stringify(name)})`)) {
          await evaluate(send, 'window.__hsfFlow.armUpload()')
          const folder = await mkdtemp(join(tmpdir(), 'hsf-flow-'))
          try {
            const file = join(folder, `${name}${extname(picture)}`)
            await copyFile(picture, file)
            await uploadFile(send, file, 'Flow')
            if (!await evaluate<boolean>(send, `window.__hsfFlow.findIngredient(${JSON.stringify(name)}, 90000)`)) throw new Error('Flow did not take the picture')
          } finally {
            await rm(folder, { recursive: true, force: true }).catch(() => {})
          }
        }
        await evaluate(send, `window.__hsfFlow.useIngredient(${JSON.stringify(name)})`)
        const at = await evaluate<{ x: number; y: number }>(send, `window.__hsfFlow.prepareEdit(${JSON.stringify({ prompt })})`)
        return generate(send, listen, at, prompt)
      })
      return download(url)
    })
  }
}
