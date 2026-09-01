import { describe, expect, it } from 'vitest'
import { parseArchiveSearch } from '../src/web/lib/search-query'

describe('parseArchiveSearch', () => {
  const now = new Date('2026-08-13T08:00:00.000Z')

  it('turns year plus place into an indexed time range and residual text query', () => {
    expect(parseArchiveSearch('杭州 2025', now)).toEqual({
      q: '杭州',
      mediaType: undefined,
      favorite: undefined,
      takenAfter: '2025-01-01T00:00:00.000Z',
      takenBefore: '2026-01-01T00:00:00.000Z',
    })
  })

  it('understands last-year Chinese month phrases', () => {
    const parsed = parseArchiveSearch('去年八月', now)
    expect(parsed.takenAfter).toBe('2025-08-01T00:00:00.000Z')
    expect(parsed.takenBefore).toBe('2025-09-01T00:00:00.000Z')
    expect(parsed.q).toBeUndefined()
  })

  it('extracts cheap structured media and favorite filters', () => {
    expect(parseArchiveSearch('收藏 视频', now)).toMatchObject({ favorite: true, mediaType: 'video', q: undefined })
  })

  it('extracts file category, extension, tag and size filters for global search', () => {
    expect(parseArchiveSearch('Excel tag=合同 >10MB 最近版本', now)).toMatchObject({
      fileCategory: 'spreadsheets',
      tag: '合同',
      minSizeBytes: 10 * 1024 * 1024 + 1,
      q: '最近版本',
    })
    expect(parseArchiveSearch('PDF 已归档', now)).toMatchObject({ extension: 'pdf', archived: true, q: undefined })
  })

  it('does not treat year-like digits inside filenames or ids as a date filter', () => {
    expect(parseArchiveSearch('bulk-trash-1788170412084-11111', now)).toMatchObject({
      q: 'bulk-trash-1788170412084-11111',
      takenAfter: undefined,
      takenBefore: undefined,
    })
    expect(parseArchiveSearch('photo-1926-final.jpg', now)).toMatchObject({
      q: 'photo-1926-final.jpg',
      takenAfter: undefined,
      takenBefore: undefined,
    })
  })
})
