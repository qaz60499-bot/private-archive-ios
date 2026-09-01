import { describe, expect, it } from 'vitest'
import { classifyFileCategory, inferExtension, normalizeMimeType, sanitizeLogicalPath, sanitizeMetadata } from '../../src/worker/domain/asset-metadata'

describe('digital asset metadata normalization', () => {
  it('classifies common Files categories from extension with MIME fallback', () => {
    expect(classifyFileCategory('合同.pdf', 'application/octet-stream', 'file')).toBe('documents')
    expect(classifyFileCategory('报价表.XLSX', '', 'file')).toBe('spreadsheets')
    expect(classifyFileCategory('backup.tar.gz', 'application/octet-stream', 'file')).toBe('archives')
    expect(classifyFileCategory('records.json', 'application/octet-stream', 'file')).toBe('code')
    expect(classifyFileCategory('voice.m4a', 'application/octet-stream', 'file')).toBe('audio')
    expect(classifyFileCategory('capture.bin', 'image/png', 'file')).toBe('images')
  })

  it('normalizes compound extensions and octet-stream MIME safely', () => {
    expect(inferExtension('backup.TAR.GZ')).toBe('tar.gz')
    expect(normalizeMimeType('table.csv', 'application/octet-stream')).toBe('text/csv')
    expect(normalizeMimeType('unknown.bin', '')).toBe('application/octet-stream')
  })

  it('keeps logical paths relative to the workspace and strips traversal segments', () => {
    expect(sanitizeLogicalPath('\\项目\\合同\\2026')).toBe('/项目/合同/2026')
    expect(sanitizeLogicalPath('../../secret/../合同')).toBe('/secret/合同')
    expect(sanitizeLogicalPath('')).toBe('/')
  })

  it('accepts only bounded JSON-like metadata values', () => {
    const value = sanitizeMetadata({ title: '报价单', pageCount: 3, encrypted: false, sheets: ['一月', '二月'], nested: { bad: true } })
    expect(value).toEqual({ title: '报价单', pageCount: 3, encrypted: false, sheets: ['一月', '二月'] })
  })
})
