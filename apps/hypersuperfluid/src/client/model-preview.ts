/**
 * 3D model previews in the right sidebar, drawn with three.js: glTF and GLB (with their external buffers and
 * textures, and their first animation playing), OBJ, STL, PLY and FBX. Drag to orbit, scroll to zoom, right-drag to
 * pan; the model is centred and framed when it loads. Files stream from the app's authenticated file route.
 * @module hypersuperfluid/client/model-preview
 */

import { createElement as h, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  AnimationMixer, Box3, BufferGeometry, Clock, DirectionalLight, Group, HemisphereLight, LoadingManager, Mesh,
  ACESFilmicToneMapping, MeshStandardMaterial, Object3D, PerspectiveCamera, PMREMGenerator, Scene, SRGBColorSpace, Vector3, WebGLRenderer,
} from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import type { DocumentPreviewDefinition, DocumentPreviewProps } from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import { fileMediaUrl } from '@deepseek-ai/dsh-util-workspace-path'
import { extensionOf } from './media-preview.ts'

/** Renderer identity, shared by the definition and its keyed body. */
export const MODEL_PREVIEW_ID = '@deepseek-ai/dsh-hypersuperfluid/model-preview'

/** Model suffixes the viewer opens. */
export const MODEL_EXTENSIONS = ['glb', 'gltf', 'obj', 'stl', 'ply', 'fbx'] as const

/** The preview definition. glTF and OBJ are text, so a plain-text view stays available for them. */
export const modelPreviewDefinition: DocumentPreviewDefinition = {
  id: MODEL_PREVIEW_ID,
  extensions: MODEL_EXTENSIONS,
  binaryExtensions: ['glb', 'stl', 'ply', 'fbx'],
  priority: 'extension',
  title: () => '3D viewer',
  loading: 'renderer',
  wrap: false,
}

/** Relative resources of a glTF file are requested under this prefix and mapped to files beside it. */
const RELATIVE = 'hsf-model-relative:/'

/**
 * Maps a URL a loader asks for to the file route: the model itself, or a file beside it.
 * @param requested - what the loader asked for.
 * @param modelUrl - the model's own URL.
 * @param directory - the model's folder, ending in a separator.
 * @param base - the document base URI.
 * @returns the URL to fetch.
 */
export function resourceUrl(requested: string, modelUrl: string, directory: string, base: string): string {
  if (requested === modelUrl || requested.startsWith('data:') || requested.startsWith('blob:')) return requested
  if (!requested.startsWith(RELATIVE)) return requested
  const relative = decodeURIComponent(requested.slice(RELATIVE.length)).replace(/^\.\//u, '')
  return fileMediaUrl(base, directory + relative) ?? requested
}

/** Loads one model into an object. */
async function loadModel(url: string, extension: string, manager: LoadingManager): Promise<{ object: Object3D; animations: Object3D['animations'] }> {
  const material = (geometry: BufferGeometry): Mesh => {
    geometry.computeVertexNormals()
    const colored = geometry.hasAttribute('color')
    const surface = new MeshStandardMaterial({
      color: colored ? 0xffffff : 0xb8c4d6, vertexColors: colored, metalness: 0.1, roughness: 0.6,
    })
    return new Mesh(geometry, surface)
  }
  switch (extension) {
    case 'glb':
    case 'gltf': {
      const loader = new GLTFLoader(manager)
      loader.setResourcePath(RELATIVE)
      const gltf = await loader.loadAsync(url)
      return { object: gltf.scene, animations: gltf.animations }
    }
    case 'obj':
      return { object: await new OBJLoader(manager).loadAsync(url), animations: [] }
    case 'stl':
      return { object: material(await new STLLoader(manager).loadAsync(url)), animations: [] }
    case 'ply':
      return { object: material(await new PLYLoader(manager).loadAsync(url)), animations: [] }
    case 'fbx': {
      const object = await new FBXLoader(manager).loadAsync(url)
      return { object, animations: object.animations }
    }
    default:
      throw new Error(`unsupported model type: ${extension}`)
  }
}

const MESSAGE = {
  display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, boxSizing: 'border-box', textAlign: 'center',
  position: 'absolute', inset: 0, color: 'var(--dsw-alias-label-secondary)',
} as const
const HINT = { position: 'absolute', left: 12, bottom: 10, fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', pointerEvents: 'none' } as const

/**
 * The viewer body.
 * @param props - the standard document props.
 * @returns the 3D canvas, or a message.
 */
export function ModelPreviewBody(props: DocumentPreviewProps): ReactNode {
  const { content, resourceAddress, useResource } = props
  const file = useResource<'file'>(resourceAddress).value
  const host = useRef<HTMLDivElement | null>(null)
  const [state, setState] = useState<{ kind: 'loading' } | { kind: 'ready'; triangles: number } | { kind: 'failed'; reason: string }>({ kind: 'loading' })
  const path = file?.absolutePath
  const version = file?.version
  const revision = content.kind === 'renderer' ? content.revision : 0

  useEffect(() => {
    const element = host.current
    if (content.kind !== 'renderer' || element === null || path === undefined || version === undefined) return undefined
    const base = document.baseURI
    const url = fileMediaUrl(base, path)
    if (url === undefined) {
      setState({ kind: 'failed', reason: 'This model can only be opened from the app on the computer that holds it.' })
      content.failed()
      return undefined
    }
    setState({ kind: 'loading' })
    const directory = path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
    let disposed = false
    const renderer = new WebGLRenderer({ antialias: true, alpha: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.outputColorSpace = SRGBColorSpace
    renderer.toneMapping = ACESFilmicToneMapping
    renderer.toneMappingExposure = 0.9
    element.appendChild(renderer.domElement)
    renderer.domElement.style.display = 'block'
    const scene = new Scene()
    const pmrem = new PMREMGenerator(renderer)
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    scene.environmentIntensity = 0.6
    scene.add(new HemisphereLight(0xffffff, 0x445066, 0.35))
    const sun = new DirectionalLight(0xffffff, 0.9)
    sun.position.set(3, 5, 4)
    scene.add(sun)
    const camera = new PerspectiveCamera(45, 1, 0.01, 1000)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    const clock = new Clock()
    let mixer: AnimationMixer | undefined
    const resize = (): void => {
      const width = Math.max(element.clientWidth, 1)
      const height = Math.max(element.clientHeight, 1)
      renderer.setSize(width, height, false)
      renderer.domElement.style.width = '100%'
      renderer.domElement.style.height = '100%'
      camera.aspect = width / height
      camera.updateProjectionMatrix()
    }
    const observer = new ResizeObserver(resize)
    observer.observe(element)
    resize()
    let frame = 0
    const tick = (): void => {
      frame = requestAnimationFrame(tick)
      mixer?.update(clock.getDelta())
      controls.update()
      renderer.render(scene, camera)
    }
    tick()

    const manager = new LoadingManager()
    manager.setURLModifier(requested => resourceUrl(requested, url, directory, base))
    loadModel(url, extensionOf(path), manager).then(({ object, animations }) => {
      if (disposed) return
      const holder = new Group()
      holder.add(object)
      const box = new Box3().setFromObject(holder)
      const size = box.getSize(new Vector3())
      const center = box.getCenter(new Vector3())
      object.position.sub(center)
      scene.add(holder)
      const radius = Math.max(size.length() / 2, 1e-3)
      // Frame by the narrower of the two view angles, with a little room around the model.
      const vertical = (camera.fov * Math.PI) / 360
      const horizontal = Math.atan(Math.tan(vertical) * camera.aspect)
      const distance = (radius / Math.sin(Math.min(vertical, horizontal))) * 1.15
      camera.near = distance / 100
      camera.far = distance * 100
      camera.position.set(distance * 0.6, distance * 0.45, distance * 0.75)
      camera.updateProjectionMatrix()
      controls.target.set(0, 0, 0)
      controls.update()
      const first = animations[0]
      if (first !== undefined) {
        mixer = new AnimationMixer(object)
        mixer.clipAction(first).play()
      }
      let triangles = 0
      holder.traverse((node) => {
        if (node instanceof Mesh) {
          const geometry = node.geometry as BufferGeometry
          triangles += (geometry.index?.count ?? geometry.getAttribute('position')?.count ?? 0) / 3
        }
      })
      setState({ kind: 'ready', triangles: Math.round(triangles) })
      content.loaded(version)
    }, (error: unknown) => {
      if (disposed) return
      setState({ kind: 'failed', reason: `This model couldn't be opened: ${error instanceof Error ? error.message : String(error)}` })
      content.failed()
    })

    return () => {
      disposed = true
      cancelAnimationFrame(frame)
      observer.disconnect()
      controls.dispose()
      scene.traverse((node) => {
        if (node instanceof Mesh) {
          (node.geometry as BufferGeometry).dispose()
          for (const material of Array.isArray(node.material) ? node.material : [node.material]) material.dispose()
        }
      })
      pmrem.dispose()
      renderer.dispose()
      renderer.domElement.remove()
    }
    // `content` changes identity on every render; its revision is what matters.
  }, [path, version, revision])

  if (content.kind !== 'renderer') return null
  return h('div', { style: { position: 'relative', height: '100%', minHeight: 240 } },
    h('div', { ref: host, style: { position: 'absolute', inset: 0 } }),
    state.kind === 'ready' ? h('div', { style: HINT }, `${state.triangles.toLocaleString()} triangles · drag to orbit, scroll to zoom, right-drag to pan`)
      : h('div', { style: MESSAGE }, state.kind === 'loading' ? 'Loading model…' : state.reason))
}
