/**
 * Generates every Hypersuperfluid brand file from `source.webp`: the desktop app icons, the Web favicons and install
 * icons, the welcome wordmark, and the images the browser plugin embeds (`src/client/brand-assets.ts`). Run from the repository root:
 *
 *   node apps/hypersuperfluid/branding/render-brand.mjs [--preview]
 *
 * then `pnpm --dir apps/desktop run render:tray-icon` for the tray icon, which reads `icon-windows.svg`.
 *
 * The artwork is detailed raster art, so it stays a raster: SVG outputs wrap an embedded PNG. Large icons show the
 * whole emblem; icons drawn at 64 pixels or less show a tighter crop of the bird and its wings.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..', '..', '..')
const sharp = createRequire(join(repo, 'apps', 'desktop', 'package.json'))('sharp')
const SOURCE = join(here, 'source.webp')

export const BRAND = 'Hypersuperfluid'
/** The artwork's own backdrop: a navy that darkens toward the edges. */
const BACKDROP_CENTER = '#26324A'
const BACKDROP_EDGE = '#050A16'

/**
 * Source regions, in the 2000x1116 artwork. Every icon shows the wings. The emblem is the whole ring; `wings` is a
 * tighter square around the bird and its wings, for icons drawn at 64 pixels or less, where the ring would only take
 * room from them.
 */
const EMBLEM = { left: 360, top: 0, width: 1280, height: 1116 }
const WINGS = { left: 370, top: 95, width: 1260, height: 905 }

/** A square of the backdrop gradient. */
function backdrop(edge) {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${edge}" height="${edge}"><defs><radialGradient id="b" cx="50%" cy="45%" r="70%"><stop offset="0" stop-color="${BACKDROP_CENTER}"/><stop offset="1" stop-color="${BACKDROP_EDGE}"/></radialGradient></defs><rect width="${edge}" height="${edge}" fill="url(#b)"/></svg>`)
}

/** A rounded-square alpha mask: `inset` is the margin and `radius` the corner, both relative to `edge`. */
function roundedMask(edge, inset, radius) {
  const size = edge - 2 * inset
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${edge}" height="${edge}"><rect x="${inset}" y="${inset}" width="${size}" height="${size}" rx="${radius}" fill="#fff"/></svg>`)
}

/**
 * Renders one square icon.
 * @param {object} options - what to draw.
 * @param {'emblem'|'wings'} options.subject - the region of the artwork.
 * @param {number} options.edge - output edge in pixels.
 * @param {number} [options.inset] - transparent margin as a fraction of the edge.
 * @param {number} [options.radius] - corner radius as a fraction of the edge; 0 keeps a full square.
 * @returns {Promise<Buffer>} the PNG.
 */
async function icon({ subject, edge, inset = 0, radius = 0.22 }) {
  const region = subject === 'emblem' ? EMBLEM : WINGS
  // Both regions are wider than tall, so they are fitted inside the square and the backdrop fills the rest. Small
  // renders are sharpened, so the wing edges survive the downscale.
  let art = sharp(SOURCE).extract(region).resize(edge, edge, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 }, kernel: 'lanczos3' })
  if (edge <= 128) art = art.sharpen({ sigma: 0.6 })
  art = await art.png().toBuffer()
  const square = await sharp(backdrop(edge)).composite([{ input: art }]).png().toBuffer()
  if (inset === 0 && radius === 0) return square
  const margin = Math.round(edge * inset)
  return sharp(square)
    .composite([{ input: roundedMask(edge, margin, Math.round((edge - 2 * margin) * radius)), blend: 'dest-in' }])
    .png().toBuffer()
}

/**
 * An SVG document wrapping the image as a palette PNG, for the places that require SVG. The palette keeps the detailed
 * artwork small enough to load on every page.
 * @param {Buffer} png - the image.
 * @param {number} edge - the document's edge.
 * @param {number} pixels - the embedded image's resolution.
 * @param {boolean} [trayGlyph] - wrap the image in the `tray-glyph` group the desktop tray renderer requires. That
 *   renderer enlarges the group 1.2 times around (552, 544); the inner group undoes it, so the mark keeps its shape.
 * @returns {Promise<string>} the SVG document.
 */
async function svgOf(png, edge, pixels, trayGlyph = false) {
  // PNG, not WebP: the desktop tray renderer rasterizes this SVG with librsvg, which cannot decode embedded WebP.
  const small = await sharp(png).resize(pixels, pixels).png({ compressionLevel: 9, palette: true, quality: 92, effort: 10 }).toBuffer()
  const data = `data:image/png;base64,${small.toString('base64')}`
  const image = `<image width="${edge}" height="${edge}" href="${data}" xlink:href="${data}"/>`
  const body = trayGlyph ? `<g id="tray-glyph"><g transform="translate(552 544) scale(${1 / 1.2}) translate(-552 -544)">${image}</g></g>` : image
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${edge}" height="${edge}" viewBox="0 0 ${edge} ${edge}" role="img" aria-label="${BRAND}">${body}</svg>\n`
}

/** Web PNGs are downloaded by browsers, so they are palette-compressed; desktop icons keep full colour. */
const webPng = buffer => sharp(buffer).png({ compressionLevel: 9, palette: true, quality: 92, effort: 10 }).toBuffer()

/** The welcome-window wordmark: the winged mark beside the name, following the system theme like the original. */
async function wordmark(markPng) {
  const small = await sharp(markPng).resize(96, 96).png({ compressionLevel: 9, palette: true, quality: 92, effort: 10 }).toBuffer()
  const data = `data:image/png;base64,${small.toString('base64')}`
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="472" height="40" viewBox="0 0 472 40" role="img" aria-label="${BRAND}">
  <style>
    .name { fill: #0f1115; font: 600 26px "Segoe UI Variable Display", "Segoe UI", Inter, "Helvetica Neue", Arial, sans-serif; }
    @media (prefers-color-scheme: dark) { .name { fill: #ffffff; } }
  </style>
  <g transform="translate(108 0)">
    <image width="40" height="40" href="${data}" xlink:href="${data}"/>
    <text class="name" x="52" y="29">${BRAND}</text>
  </g>
</svg>
`
}

/**
 * The images the browser plugin (`src/client/index.ts`) embeds, as a TypeScript module the package build bundles.
 * @param {string} smallUrl - the wings crop, for the sidebar mark, the home mark and the tab icon.
 * @param {string} emblemUrl - the whole emblem, for large marks.
 */
function brandAssets(smallUrl, emblemUrl) {
  return `/** Generated by branding/render-brand.mjs from branding/source.webp; edit that script, not this file. */

export const BRAND = ${JSON.stringify(BRAND)}
/** The wings crop, 96 pixels, for the sidebar mark, the home mark and the tab icon. */
export const SMALL_MARK = ${JSON.stringify(smallUrl)}
/** The whole emblem, 256 pixels, for large marks. */
export const EMBLEM = ${JSON.stringify(emblemUrl)}
`
}

function write(path, content) {
  const target = join(repo, path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content)
  console.log(`wrote ${path} (${Math.round(content.length / 1024)} KB)`)
}

if (process.argv.includes('--preview')) {
  // One sheet showing each variant at its real size, to judge legibility before writing anything.
  const sizes = [[await icon({ subject: 'emblem', edge: 256, inset: 0.03 }), 256], [await icon({ subject: 'emblem', edge: 128, inset: 0.03 }), 128],
    [await icon({ subject: 'wings', edge: 64 }), 64], [await icon({ subject: 'wings', edge: 48 }), 48], [await icon({ subject: 'wings', edge: 32 }), 32],
    [await icon({ subject: 'wings', edge: 24 }), 24], [await icon({ subject: 'wings', edge: 16 }), 16]]
  let x = 16
  const layers = sizes.map(([input, edge]) => { const layer = { input, left: x, top: 16 + (256 - edge) }; x += edge + 24; return layer })
  await sharp({ create: { width: x, height: 288, channels: 4, background: '#e8eaee' } }).composite(layers).png().toFile(join(here, 'preview.png'))
  console.log(`wrote ${join(here, 'preview.png')}`)
  process.exit(0)
}

const windows = await icon({ subject: 'emblem', edge: 1024, inset: 0.03, radius: 0.2 })
const mac = await icon({ subject: 'emblem', edge: 1024, inset: 100 / 1024, radius: 0.225 })
const full = await icon({ subject: 'emblem', edge: 1104, inset: 0.03, radius: 0.2 })
// The tray renders icon-windows.svg at 16 to 64 pixels, so that SVG carries the tighter wings crop.
const trayWings = await icon({ subject: 'wings', edge: 1024, radius: 0.2 })
const favicon = await icon({ subject: 'wings', edge: 128, radius: 0.22 })
const wordmarkArt = await icon({ subject: 'wings', edge: 160, radius: 0.22 })

write('apps/desktop/resources/icon.png', full)
write('apps/desktop/resources/icon.svg', await svgOf(full, 1104, 512))
write('apps/desktop/resources/icon-windows.png', windows)
write('apps/desktop/resources/icon-windows.svg', await svgOf(trayWings, 1024, 256, true))
write('apps/desktop/resources/icon-macos.png', mac)
write('apps/desktop/resources/icon-macos.svg', await svgOf(mac, 1024, 512))
write('apps/web/public/favicon.svg', await svgOf(favicon, 128, 96))
write('apps/web/public/favicon-dark.svg', await svgOf(favicon, 128, 96))
write('apps/web/public/apple-touch-icon.png', await webPng(await icon({ subject: 'emblem', edge: 180, radius: 0 })))
write('apps/web/public/icon-192.png', await webPng(await icon({ subject: 'emblem', edge: 192, radius: 0.22 })))
write('apps/web/public/icon-512.png', await webPng(await icon({ subject: 'emblem', edge: 512, radius: 0.22 })))
// A maskable icon must fill its canvas: launchers crop it to their own shape.
write('apps/web/public/icon-maskable-512.png', await webPng(await icon({ subject: 'emblem', edge: 512, radius: 0 })))
write('apps/desktop/renderer/assets/welcome-brand.svg', await wordmark(wordmarkArt))
// The browser plugin embeds two images: the wings crop for the small sidebar mark, home mark and tab icon, the emblem
// for large marks. Browsers decode WebP in an <img>, so these stay small.
const smallWebp = await sharp(favicon).resize(96, 96).webp({ quality: 88, effort: 6 }).toBuffer()
const emblemWebp = await sharp(await icon({ subject: 'emblem', edge: 256, inset: 0.03, radius: 0.2 })).webp({ quality: 86, effort: 6 }).toBuffer()
write('apps/hypersuperfluid/src/client/brand-assets.ts', brandAssets(`data:image/webp;base64,${smallWebp.toString('base64')}`, `data:image/webp;base64,${emblemWebp.toString('base64')}`))
