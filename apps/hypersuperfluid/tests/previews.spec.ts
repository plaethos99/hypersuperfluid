import { describe, expect, it } from 'vitest'
import { AUDIO_EXTENSIONS, cssOf, extensionOf, isAudio, mediaPreviewDefinition, VIDEO_EXTENSIONS } from '../src/client/media-preview.ts'
import { MODEL_EXTENSIONS, modelPreviewDefinition, resourceUrl } from '../src/client/model-preview.ts'
import { unreadableMessage } from '../src/client/unreadable.ts'

const BASE = 'http://127.0.0.1:7420/'

describe('media preview', () => {
  it('claims video and audio, all as binary', () => {
    expect(mediaPreviewDefinition.extensions).toEqual([...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS])
    expect(mediaPreviewDefinition.binaryExtensions).toEqual(mediaPreviewDefinition.extensions)
    expect(mediaPreviewDefinition.loading).toBe('renderer')
  })

  it('tells audio from video by suffix', () => {
    expect(extensionOf('C:\\clips\\Intro.MP4')).toBe('mp4')
    expect(extensionOf('/tmp/no-suffix')).toBe('')
    expect(isAudio('/music/song.flac')).toBe(true)
    expect(isAudio('/movies/clip.webm')).toBe(false)
  })

  it('reads style strings', () => {
    expect(cssOf('display:flex;justify-content:center; padding: 16px')).toEqual({ display: 'flex', justifyContent: 'center', padding: '16px' })
  })
})

describe('3D preview', () => {
  it('claims the model formats, keeping text views for glTF and OBJ', () => {
    expect(modelPreviewDefinition.extensions).toEqual(MODEL_EXTENSIONS)
    expect(modelPreviewDefinition.binaryExtensions).not.toContain('gltf')
    expect(modelPreviewDefinition.binaryExtensions).not.toContain('obj')
  })

  it('maps a glTF file\'s relative resources to files beside it', () => {
    const model = `${BASE}api/file?path=%2Fmodels%2Fcar.gltf`
    expect(resourceUrl(model, model, '/models/', BASE)).toBe(model)
    expect(resourceUrl('data:application/octet-stream;base64,AA==', model, '/models/', BASE)).toMatch(/^data:/u)
    expect(resourceUrl('hsf-model-relative:/textures%2Fpaint.png', model, '/models/', BASE))
      .toBe(`${BASE}api/file?path=${encodeURIComponent('/models/textures/paint.png')}`)
    expect(resourceUrl('hsf-model-relative:/./car.bin', model, 'C:\\models\\', BASE))
      .toBe(`${BASE}api/file?path=${encodeURIComponent('C:\\models\\car.bin')}`)
  })
})

describe('a file that cannot be read', () => {
  it('says so instead of loading forever', () => {
    expect(unreadableMessage({ status: 'loading', value: undefined })).toBeUndefined()
    expect(unreadableMessage({ status: 'failed', value: { version: '1' }, failure: { message: 'gone' } })).toBeUndefined()
    expect(unreadableMessage({ status: 'failed', value: undefined, failure: { message: 'no entry at "a.docx".' } }))
      .toBe('This file can\'t be opened (no entry at "a.docx"). It may have been moved or deleted.')
    expect(unreadableMessage({ status: 'failed', value: undefined, failure: undefined })).toBe('This file can\'t be opened. It may have been moved or deleted.')
  })
})
