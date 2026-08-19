import type { MediaType } from '../types'

export interface ParsedArchiveSearch {
  q?: string
  mediaType?: MediaType
  favorite?: boolean
  takenAfter?: string
  takenBefore?: string
}

const chineseMonths: ReadonlyArray<readonly [string, number]> = [
  ['十一月', 11], ['十二月', 12], ['十月', 10],
  ['一月', 1], ['二月', 2], ['三月', 3], ['四月', 4], ['五月', 5], ['六月', 6],
  ['七月', 7], ['八月', 8], ['九月', 9],
]

function isoStart(year: number, month = 1): string {
  return new Date(Date.UTC(year, month - 1, 1)).toISOString()
}

export function parseArchiveSearch(input: string | undefined, now = new Date()): ParsedArchiveSearch {
  if (!input?.trim()) return {}
  let remaining = input.trim()
  let mediaType: MediaType | undefined
  let favorite: boolean | undefined

  const mediaAliases: ReadonlyArray<readonly [RegExp, MediaType]> = [
    [/(?:^|\s)(?:视频|video)(?=\s|$)/iu, 'video'],
    [/(?:^|\s)(?:照片|图片|photo)(?=\s|$)/iu, 'photo'],
    [/(?:^|\s)(?:文件|file)(?=\s|$)/iu, 'file'],
  ]
  for (const [pattern, type] of mediaAliases) {
    if (!pattern.test(remaining)) continue
    mediaType = type
    remaining = remaining.replace(pattern, ' ')
    break
  }

  if (/(?:^|\s)(?:收藏|favorite)(?=\s|$)/iu.test(remaining)) {
    favorite = true
    remaining = remaining.replace(/(?:^|\s)(?:收藏|favorite)(?=\s|$)/giu, ' ')
  }

  let year: number | undefined
  if (remaining.includes('去年')) {
    year = now.getFullYear() - 1
    remaining = remaining.replaceAll('去年', ' ')
  } else if (remaining.includes('今年')) {
    year = now.getFullYear()
    remaining = remaining.replaceAll('今年', ' ')
  } else {
    const yearMatch = remaining.match(/((?:19|20)\d{2})\s*年?/u)
    if (yearMatch) {
      year = Number(yearMatch[1])
      remaining = remaining.replace(yearMatch[0], ' ')
    }
  }

  let month: number | undefined
  const numericMonth = remaining.match(/(?:^|\s)(1[0-2]|0?[1-9])\s*月/u)
  if (numericMonth) {
    month = Number(numericMonth[1])
    remaining = remaining.replace(numericMonth[0], ' ')
  } else {
    for (const [label, value] of chineseMonths) {
      if (!remaining.includes(label)) continue
      month = value
      remaining = remaining.replace(label, ' ')
      break
    }
  }

  let takenAfter: string | undefined
  let takenBefore: string | undefined
  if (month) {
    const resolvedYear = year ?? now.getFullYear()
    takenAfter = isoStart(resolvedYear, month)
    takenBefore = month === 12 ? isoStart(resolvedYear + 1, 1) : isoStart(resolvedYear, month + 1)
  } else if (year) {
    takenAfter = isoStart(year, 1)
    takenBefore = isoStart(year + 1, 1)
  }

  const q = remaining.replace(/\s+/gu, ' ').trim() || undefined
  return { q, mediaType, favorite, takenAfter, takenBefore }
}
