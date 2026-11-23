/**
 * Grok Imagine (grok.com/imagine), the second place pictures come from, in its own browser window the same way as
 * Google Flow (`browser.ts`). The person signs in to their Grok account there once.
 *
 *   1. `__hsfGrok.prepare({aspect})` picks Image, Quality and the aspect ratio, empties the prompt box and returns
 *      where it is; the app clicks it and types the prompt through the protocol, which the editor takes as typing.
 *   2. `__hsfGrok.submitAt()` returns where the Submit button is, clicked natively.
 *   3. `__hsfGrok.waitForImage()` waits for the first new finished picture and returns it as base64 JPEG.
 *
 * Changing a picture: `prepareEdit()` marks the picture input; the app uploads the picture, types what to change and
 * submits; the page moves to the new post, where `grabPost()` takes the picture once it stops changing.
 *
 * Everything is found by its label or what it says, not by class names. Ported from BookShorts
 * (`packages/pipeline/src/grokDriver.ts`, `apps/studio/electron/grok.ts`).
 * @module hypersuperfluid/creative/grok
 */

import { attach, clickAt, evaluate, serial, uploadFile, type Send, type ServiceBrowser, type Tab } from './browser.ts'

/** Grok Imagine's page. */
export const GROK_URL = 'https://grok.com/imagine'

/** The script injected into the Grok Imagine tab. */
export const GROK_DRIVER = `(() => {
  // Injected once per page; a page holding an older driver gets this one.
  if (window.__hsfGrok && window.__hsfGrok.v === 5) return;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const visible = (e) => e.offsetParent !== null;
  const button = (label) => [...document.querySelectorAll('button')].filter(visible).find((b) => b.getAttribute('aria-label') === label || b.innerText.trim() === label);
  const options = () => [...document.querySelectorAll('[role=menuitemradio],[role=menuitem],[role=option],[role=radio]')].filter(visible);
  const escape = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  // Our aspect ratios, as Grok names them.
  const ASPECT = { '16:9': '16:9', '9:16': '9:16', '4:3': '3:2', '3:4': '2:3', '1:1': '1:1', '3:2': '3:2', '2:3': '2:3' };
  // When Grok's menu lacks one, the nearest of the same shape (the studio
  // crops pictures to fit anyway).
  const NEAREST = { '2:3': ['9:16'], '3:2': ['16:9'], '9:16': ['2:3'], '16:9': ['3:2'], '1:1': [] };
  // A finished picture: a full-size embedded JPEG. Data URLs share their
  // header, so one is known by its length and its end.
  const finals = () => [...document.querySelectorAll('img')].filter((i) => i.src.startsWith('data:image/jpeg') && i.naturalWidth >= 600);
  const keyOf = (src) => src.length + ':' + src.slice(-80);
  let before = new Set();
  let beforeText = '';

  async function choose(label, match) {
    const b = button(label);
    if (!b) return false;
    b.click();
    await sleep(600);
    const o = options().find((e) => match(e.innerText.trim()));
    if (!o) {
      escape();
      await sleep(300);
      return false;
    }
    o.click();
    await sleep(400);
    return true;
  }

  async function prepare({ aspect }) {
    const box = [...document.querySelectorAll('[contenteditable=true]')].filter(visible).pop();
    if (!box) throw new Error('Grok Imagine page not ready: no prompt box (sign in, and open grok.com/imagine)');
    before = new Set(finals().map((i) => keyOf(i.src)));
    beforeText = document.body.innerText;
    // Pictures, at the better quality, in our aspect.
    button('Image')?.click();
    await sleep(300);
    const quality = [...document.querySelectorAll('button')].filter(visible).find((b) => /^Quality/.test(b.innerText.trim()));
    if (quality && quality.getAttribute('aria-pressed') !== 'true') quality.click();
    await sleep(300);
    const want = ASPECT[aspect] || '16:9';
    let chosen = false;
    for (const a of [want, ...(NEAREST[want] || [])]) if (!chosen) chosen = await choose('Aspect Ratio', (t) => t.startsWith(a));
    if (!chosen) throw new Error('Grok Imagine has no ' + want + ' aspect ratio');
    // Empty the box.
    box.focus();
    document.execCommand('selectAll');
    document.execCommand('delete');
    const r = box.getBoundingClientRect();
    return { x: Math.round(r.left + 40), y: Math.round(r.top + r.height / 2) };
  }

  function submitAt() {
    const go = button('Submit');
    if (!go) throw new Error('Grok Imagine page not ready: no Submit button');
    const r = go.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  }

  async function waitForImage(timeoutMs = 300000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      await sleep(2500);
      const fresh = finals().filter((i) => !before.has(keyOf(i.src)));
      if (fresh.length) {
        await sleep(1500);
        const pic = finals().find((i) => !before.has(keyOf(i.src))) || fresh[0];
        return pic.src.slice(pic.src.indexOf(',') + 1);
      }
      // A refusal: words about moderation that weren't on the page before.
      const text = document.body.innerText;
      if (text.length !== beforeText.length && /moderat|violat|not allowed|can.t generate|unable to generate|content polic/i.test(text.slice(-4000)) && !/moderat|violat|not allowed|content polic/i.test(beforeText.slice(-4000)))
        throw new Error('POLICY: Grok Imagine refused the picture');
    }
    throw new Error('Grok Imagine did not return a picture in time');
  }

  // ---- Videos: a picture uploaded as the first frame, brought to life.
  const videos = () => [...document.querySelectorAll('video')];
  const srcOf = (v) => v.currentSrc || v.src || (v.querySelector('source') || {}).src || '';
  let beforeVideos = new Set();
  let beforeBlobs = 0;
  const blobs = () => [...document.querySelectorAll('img')].filter((i) => i.src.startsWith('blob:') || i.src.startsWith('data:image')).length;
  const boxAt = () => {
    const box = [...document.querySelectorAll('[contenteditable=true]')].filter(visible).pop();
    if (!box) throw new Error('Grok Imagine page not ready: no prompt box (sign in, and open grok.com/imagine)');
    const r = box.getBoundingClientRect();
    return { x: Math.round(r.left + 40), y: Math.round(r.top + r.height / 2) };
  };

  // Video mode at 720p, about the length asked, silent (the narration is the
  // sound), in our aspect; marks the composer's picture input for the studio.
  async function prepareVideo({ aspect, seconds }) {
    boxAt();
    beforeVideos = new Set(videos().map(srcOf));
    beforeText = document.body.innerText;
    beforeBlobs = blobs();
    await videoOptions({ aspect, seconds });
    document.querySelectorAll('[data-bs-upload]').forEach((e) => e.removeAttribute('data-bs-upload'));
    const up = button('Upload');
    const inputs = [...document.querySelectorAll('input[type=file]')];
    const input = inputs.find((i) => up && up.closest('form') && i.closest('form') === up.closest('form')) || inputs.find((i) => !i.multiple) || inputs[0];
    if (!input) throw new Error('Grok Imagine has no picture upload on the page');
    input.setAttribute('data-bs-upload', '1');
    return true;
  }

  async function videoOptions({ aspect, seconds }) {
    button('Video')?.click();
    await sleep(500);
    button('720p')?.click();
    await sleep(200);
    button(seconds > 12 ? '15s' : seconds > 7 ? '10s' : '6s')?.click();
    await sleep(200);
    const audio = button('Video audio');
    if (audio && audio.getAttribute('aria-pressed') === 'true') audio.click();
    await sleep(200);
    const want = ASPECT[aspect] || '16:9';
    await choose('Aspect Ratio', (t) => t.startsWith(want));
    const box = [...document.querySelectorAll('[contenteditable=true]')].filter(visible).pop();
    if (box) {
      box.focus();
      document.execCommand('selectAll');
      document.execCommand('delete');
    }
  }

  // The uploaded picture shows in the composer.
  async function waitForAttachment(timeoutMs = 20000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      await sleep(500);
      if (blobs() > beforeBlobs) {
        await sleep(800);
        return true;
      }
    }
    return false;
  }

  async function waitForVideo(timeoutMs = 900000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      await sleep(3000);
      const fresh = videos().filter((v) => {
        const s = srcOf(v);
        return s && !beforeVideos.has(s) && v.readyState >= 2 && v.duration > 1 && isFinite(v.duration);
      });
      if (fresh.length) {
        // The new video is the post the page moved to (others of the
        // user's may show beside it); a finished file, not a preview stream.
        const post = (location.pathname.match(/post[/]([^/?#]+)/) || [])[1];
        const v = (post && fresh.find((x) => srcOf(x).includes(post))) || fresh.find((x) => srcOf(x).startsWith('http')) || fresh[0];
        // Grok's asset server wants the signed-in cookies.
        const res = await fetch(srcOf(v), { credentials: 'include' });
        if (!res.ok) throw new Error('Grok Imagine made the video but it would not download');
        const bytes = new Uint8Array(await res.arrayBuffer());
        let bin = '';
        for (let i = 0; i < bytes.length; i += 32768) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
        return btoa(bin);
      }
      const text = document.body.innerText;
      if (text.length !== beforeText.length && /moderat|violat|not allowed|can.t generate|unable to generate|content polic/i.test(text.slice(-4000)) && !/moderat|violat|not allowed|content polic/i.test(beforeText.slice(-4000)))
        throw new Error('POLICY: Grok Imagine refused the video');
    }
    throw new Error('Grok Imagine did not return a video in time');
  }

  // ---- Edits: a picture uploaded in Image mode, changed by the prompt. The
  // page then moves to the new post (a fresh page: the studio injects the
  // driver again there and calls grabPost).
  async function prepareEdit() {
    boxAt();
    beforeText = document.body.innerText;
    beforeBlobs = blobs();
    button('Image')?.click();
    await sleep(400);
    document.querySelectorAll('[data-bs-upload]').forEach((e) => e.removeAttribute('data-bs-upload'));
    const up = button('Upload');
    const inputs = [...document.querySelectorAll('input[type=file]')];
    const input = inputs.find((i) => up && up.closest('form') && i.closest('form') === up.closest('form')) || inputs.find((i) => !i.multiple) || inputs[0];
    if (!input) throw new Error('Grok Imagine has no picture upload on the page');
    input.setAttribute('data-bs-upload', '1');
    const box = [...document.querySelectorAll('[contenteditable=true]')].filter(visible).pop();
    box.focus();
    document.execCommand('selectAll');
    document.execCommand('delete');
    return true;
  }

  // The finished picture of the post page that's open, as base64. While
  // Grok works, the post shows noisy previews at the same place: the picture
  // is taken once it has stopped changing.
  async function grabPost(timeoutMs = 300000) {
    const started = Date.now();
    const text0 = document.body.innerText;
    let last = '';
    let seen = 0;
    while (Date.now() - started < timeoutMs) {
      const post = (location.pathname.match(/post[/]([^/?#]+)/) || [])[1];
      const img = post && [...document.querySelectorAll('img')].find((x) => x.src.includes(post) && x.naturalWidth >= 600);
      if (img) {
        const res = await fetch(img.src, { credentials: 'include', cache: 'no-store' });
        if (!res.ok) throw new Error('Grok Imagine made the picture but it would not download');
        const bytes = new Uint8Array(await res.arrayBuffer());
        const sig = img.src + ':' + bytes.length;
        seen = sig === last ? seen + 1 : 0;
        last = sig;
        // The same picture three looks running (about 6 seconds).
        if (seen >= 2) {
          let bin = '';
          for (let i = 0; i < bytes.length; i += 32768) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
          return btoa(bin);
        }
      }
      const text = document.body.innerText;
      if (text !== text0 && /moderat|violat|not allowed|can.t generate|unable to generate|content polic/i.test(text.slice(-4000)))
        throw new Error('POLICY: Grok Imagine refused the picture');
      await sleep(2000);
    }
    throw new Error('Grok Imagine did not return a picture in time');
  }

  window.__hsfGrok = { v: 5, prepare, submitAt, waitForImage, prepareVideo, videoOptions, waitForAttachment, waitForVideo, boxAt, prepareEdit, grabPost };
})();`

/** Whether a tab is Grok Imagine. */
export const isImagine = (tab: Tab): boolean => tab.type === 'page' && /^https:\/\/grok\.com\/imagine/u.test(tab.url)

// Signed in when the page has no "Sign in" button and either the prompt box or a picture's own page.
const SIGNED_IN = `(() => {
  const signIn = [...document.querySelectorAll('a,button')].some((b) => /^\\s*sign (in|up)\\s*$/i.test(b.textContent || ''));
  const box = document.querySelector('textarea, [contenteditable="true"]');
  return (!!box || /\\/imagine\\/post\\//.test(location.pathname)) && !signIn;
})()`

const COMPOSER = '!!document.querySelector(\'textarea, [contenteditable="true"]\')'

const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** A fresh composer: the tab may be left on a single picture's page or holding a picture attached from before. */
async function freshPage(send: Send): Promise<void> {
  await send('Page.navigate', { url: GROK_URL })
  for (let i = 0; i < 40; i++) {
    await pause(500)
    if (await evaluate<boolean>(send, COMPOSER).catch(() => false)) break
  }
  await pause(1000)
}

/** Types into the composer and submits. */
async function typeAndSubmit(send: Send, prompt: string): Promise<void> {
  await clickAt(send, await evaluate<{ x: number; y: number }>(send, 'window.__hsfGrok.boxAt()'))
  await send('Input.insertText', { text: prompt })
  await pause(500)
  await clickAt(send, await evaluate<{ x: number; y: number }>(send, 'window.__hsfGrok.submitAt()'))
}

/** Grok Imagine, through its browser window. */
export class Grok {
  private readonly exclusive = serial()

  constructor(readonly browser: ServiceBrowser) {}

  /** closed: no window; signin: open but not signed in on Imagine; ready. */
  async state(): Promise<'closed' | 'signin' | 'ready'> {
    const tabs = await this.browser.tabs()
    if (tabs === undefined) return 'closed'
    const tab = tabs.find(isImagine)
    if (tab === undefined) return 'signin'
    try {
      return await attach(tab, send => evaluate<boolean>(send, SIGNED_IN)) ? 'ready' : 'signin'
    } catch {
      return 'signin'
    }
  }

  private async tab(): Promise<Tab> {
    const tab = (await this.browser.tabs())?.find(isImagine)
    if (tab === undefined) throw new Error('Open Grok Imagine and sign in first.')
    return tab
  }

  /**
   * Draws one picture.
   * @param prompt - what it shows.
   * @param aspect - its aspect ratio.
   * @returns the picture's bytes (JPEG).
   */
  image(prompt: string, aspect: string): Promise<Buffer> {
    return this.exclusive(async () => attach(await this.tab(), async (send) => {
      await send('Page.bringToFront')
      await freshPage(send)
      await evaluate(send, GROK_DRIVER)
      await evaluate(send, `window.__hsfGrok.prepare(${JSON.stringify({ aspect })})`)
      await typeAndSubmit(send, prompt)
      return Buffer.from(await evaluate<string>(send, 'window.__hsfGrok.waitForImage()'), 'base64')
    }))
  }

  /**
   * Changes a picture as the prompt says.
   * @param picture - the picture file.
   * @param prompt - what to change.
   * @returns the new picture's bytes (JPEG).
   */
  edit(picture: string, prompt: string): Promise<Buffer> {
    return this.exclusive(async () => attach(await this.tab(), async (send) => {
      await send('Page.bringToFront')
      await freshPage(send)
      await evaluate(send, GROK_DRIVER)
      await evaluate(send, 'window.__hsfGrok.prepareEdit()')
      await uploadFile(send, picture, 'Grok Imagine')
      if (!await evaluate<boolean>(send, 'window.__hsfGrok.waitForAttachment()')) throw new Error('Grok Imagine did not take the picture')
      await typeAndSubmit(send, prompt)
      // Submitting moves the page to the new post: wait for it, then take the picture from there.
      for (let i = 0; ; i++) {
        await pause(1000)
        if (/\/imagine\/post\//u.test(await evaluate<string>(send, 'location.href').catch(() => ''))) break
        if (i === 59) throw new Error('Grok Imagine did not start the picture')
      }
      await pause(1500)
      await evaluate(send, GROK_DRIVER)
      return Buffer.from(await evaluate<string>(send, 'window.__hsfGrok.grabPost()'), 'base64')
    }))
  }
}
