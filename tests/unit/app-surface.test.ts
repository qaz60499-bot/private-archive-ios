import { describe, expect, it } from 'vitest'
import { resolveAppSurface } from '../../src/web/lib/app-surface'

describe('resolveAppSurface', () => {
  it('keeps the full archive UI only on the local desktop shell', () => {
    expect(resolveAppSurface({ hostname: '127.0.0.1', search: '?app=personal-desktop' })).toBe('desktop')
    expect(resolveAppSurface({ hostname: 'localhost', search: '' })).toBe('desktop')
  })

  it('forces hosted photo.joye.cc.cd into the upload-only surface even with a desktop query flag', () => {
    expect(resolveAppSurface({ hostname: 'photo.joye.cc.cd', search: '' })).toBe('web-upload')
    expect(resolveAppSurface({ hostname: 'photo.joye.cc.cd', search: '?app=personal-desktop' })).toBe('web-upload')
  })

  it('preserves the explicit shared surface', () => {
    expect(resolveAppSurface({ hostname: 'share.photo.joye.cc.cd', search: '' })).toBe('shared')
    expect(resolveAppSurface({ hostname: 'photo.joye.cc.cd', search: '?app=shared' })).toBe('shared')
  })
})
