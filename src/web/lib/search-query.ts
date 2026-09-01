import type { FileCategory, MediaType } from '../types'

export interface ParsedArchiveSearch {
  q?: string
  mediaType?: MediaType
  favorite?: boolean
  archived?: boolean
  fileCategory?: FileCategory
  extension?: string
  tag?: string
  takenAfter?: string
  takenBefore?: string
  minSizeBytes?: number
  maxSizeBytes?: number
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
  let archived: boolean | undefined
  let fileCategory: FileCategory | undefined
  let extension: string | undefined
  let tag: string | undefined
  let minSizeBytes: number | undefined
  let maxSizeBytes: number | undefined

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
  if (/(?:^|\s)(?:已归档|archive|archived)(?=\s|$)/iu.test(remaining)) {
    archived = true
    remaining = remaining.replace(/(?:^|\s)(?:已归档|archive|archived)(?=\s|$)/giu, ' ')
  }

  const categoryAliases: ReadonlyArray<readonly [RegExp, FileCategory]> = [
    [/(?:^|\s)(?:excel|表格|电子表格|spreadsheet)(?=\s|$)/iu, 'spreadsheets'],
    [/(?:^|\s)(?:压缩包|archive-file|archives)(?=\s|$)/iu, 'archives'],
    [/(?:^|\s)(?:音频|audio)(?=\s|$)/iu, 'audio'],
    [/(?:^|\s)(?:代码|code)(?=\s|$)/iu, 'code'],
    [/(?:^|\s)(?:文档|documents?)(?=\s|$)/iu, 'documents'],
  ]
  for (const [pattern, category] of categoryAliases) {
    if (!pattern.test(remaining)) continue
    fileCategory = category
    remaining = remaining.replace(pattern, ' ')
    break
  }

  const extensionAliases: ReadonlyArray<readonly [RegExp, string]> = [
    [/(?:^|\s)pdf(?=\s|$)/iu, 'pdf'],
    [/(?:^|\s)zip(?=\s|$)/iu, 'zip'],
    [/(?:^|\s)docx?(?=\s|$)/iu, 'docx'],
    [/(?:^|\s)xlsx?(?=\s|$)/iu, 'xlsx'],
    [/(?:^|\s)csv(?=\s|$)/iu, 'csv'],
  ]
  for (const [pattern, ext] of extensionAliases) {
    if (!pattern.test(remaining)) continue
    extension = ext
    remaining = remaining.replace(pattern, ' ')
    break
  }

  const tagMatch = remaining.match(/(?:^|\s)(?:tag|标签)\s*[:=]\s*([^\s]+)/iu)
  if (tagMatch) {
    tag = tagMatch[1].trim().toLowerCase()
    remaining = remaining.replace(tagMatch[0], ' ')
  }

  const sizeMatch = remaining.match(/(?:^|\s)(>=|<=|>|<)\s*(\d+(?:\.\d+)?)\s*(kb|mb|gb)(?=\s|$)/iu)
  if (sizeMatch) {
    const factor = sizeMatch[3].toLowerCase() === 'gb' ? 1024 ** 3 : sizeMatch[3].toLowerCase() === 'mb' ? 1024 ** 2 : 1024
    const bytes = Math.max(0, Math.floor(Number(sizeMatch[2]) * factor))
    if (sizeMatch[1] === '>') minSizeBytes = bytes + 1
    else if (sizeMatch[1] === '>=') minSizeBytes = bytes
    else if (sizeMatch[1] === '<') maxSizeBytes = Math.max(0, bytes - 1)
    else maxSizeBytes = bytes
    remaining = remaining.replace(sizeMatch[0], ' ')
  }

  let recentMonth = false
  if (/(?:最近一个月|近一个月|past\s+month)/iu.test(remaining)) {
    recentMonth = true
    remaining = remaining.replace(/(?:最近一个月|近一个月|past\s+month)/giu, ' ')
  }

  let year: number | undefined
  if (remaining.includes('去年')) {
    year = now.getFullYear() - 1
    remaining = remaining.replaceAll('去年', ' ')
  } else if (remaining.includes('今年')) {
    year = now.getFullYear()
    remaining = remaining.replaceAll('今年', ' ')
  } else {
    // Treat a numeric year as a structured filter only when it starts a search token.
    // Otherwise filenames/IDs such as "bulk-trash-...-2084-..." are accidentally
    // interpreted as year 2084 and valid current assets disappear from results.
    const yearMatch = remaining.match(/(?:^|\s)((?:19|20)\d{2})\s*年?/u)
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
  if (recentMonth) {
    const after = new Date(now)
    after.setUTCMonth(after.getUTCMonth() - 1)
    takenAfter = after.toISOString()
    takenBefore = now.toISOString()
  } else if (month) {
    const resolvedYear = year ?? now.getFullYear()
    takenAfter = isoStart(resolvedYear, month)
    takenBefore = month === 12 ? isoStart(resolvedYear + 1, 1) : isoStart(resolvedYear, month + 1)
  } else if (year) {
    takenAfter = isoStart(year, 1)
    takenBefore = isoStart(year + 1, 1)
  }

  const q = remaining.replace(/\s+/gu, ' ').trim() || undefined
  return { q, mediaType, favorite, archived, fileCategory, extension, tag, takenAfter, takenBefore, minSizeBytes, maxSizeBytes }
}
