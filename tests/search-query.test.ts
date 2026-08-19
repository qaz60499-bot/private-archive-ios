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
})
