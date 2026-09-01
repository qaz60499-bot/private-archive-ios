import { describe, expect, it } from 'vitest'
import { summarizeImportErrors } from '../../src/web/lib/import-error-summary'

describe('summarizeImportErrors', () => {
  it('returns no message when there are no errors', () => {
    expect(summarizeImportErrors([])).toBeNull()
  })

  it('keeps a single error intact', () => {
    expect(summarizeImportErrors(['IMG_0001.jpeg：上传失败'])).toBe('IMG_0001.jpeg：上传失败')
  })

  it('summarizes repeated per-file failures without listing every filename', () => {
    const result = summarizeImportErrors([
      'IMG_0001.jpeg：NativeBackgroundUpload plugin is not implemented on ios',
      'IMG_0002.jpeg：NativeBackgroundUpload plugin is not implemented on ios',
      'IMG_0003.jpeg：NativeBackgroundUpload plugin is not implemented on ios',
    ])
    expect(result).toBe('3 项未能加入上传队列。主要原因：NativeBackgroundUpload plugin is not implemented on ios')
    expect(result).not.toContain('IMG_0002.jpeg')
    expect(result).not.toContain('IMG_0003.jpeg')
  })
})
