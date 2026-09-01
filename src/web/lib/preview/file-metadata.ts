import { unzipSync, type UnzipFileInfo } from 'fflate'

export type ExtractedMetadata = Record<string, string | number | boolean | string[]>

const ZIP_INSPECTION_MAX_BYTES = 12 * 1024 * 1024
const PDF_INSPECTION_MAX_BYTES = 8 * 1024 * 1024
const TEXT_INSPECTION_MAX_BYTES = 2 * 1024 * 1024
const ZIP_ENTRY_EXTRACT_MAX_BYTES = 1024 * 1024
const ZIP_ENTRY_SCAN_MAX = 5000

function extensionOf(name: string): string {
  const lower = name.toLowerCase()
  if (lower.endsWith('.tar.gz')) return 'tar.gz'
  const dot = lower.lastIndexOf('.')
  return dot > 0 ? lower.slice(dot + 1) : ''
}

function decodeXml(bytes: Uint8Array | undefined): string | null {
  if (!bytes || bytes.byteLength > ZIP_ENTRY_EXTRACT_MAX_BYTES) return null
  try {
    return new TextDecoder().decode(bytes)
  } catch {
    return null
  }
}

function decodeXmlEntity(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
}

function xmlTagValue(xml: string | null, localName: string): string | undefined {
  if (!xml) return undefined
  const match = xml.match(new RegExp(`<[^>]*:?${localName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/[^>]*:?${localName}>`, 'i'))
  if (!match?.[1]) return undefined
  return decodeXmlEntity(match[1].replace(/<[^>]+>/g, '').trim()).slice(0, 300) || undefined
}

function inspectZipBuffer(bytes: Uint8Array, extension: string): ExtractedMetadata {
  let entryCount = 0
  let uncompressedSize = 0
  let compressedSize = 0
  let truncated = false
  const wanted = new Set<string>()
  if (['xlsx', 'xlsm'].includes(extension)) {
    wanted.add('xl/workbook.xml')
    wanted.add('docProps/core.xml')
  } else if (extension === 'docx') {
    wanted.add('docProps/core.xml')
    wanted.add('word/document.xml')
  }

  const extracted = unzipSync(bytes, {
    filter: (info: UnzipFileInfo) => {
      entryCount += 1
      if (entryCount <= ZIP_ENTRY_SCAN_MAX) {
        compressedSize += info.size
        uncompressedSize += info.originalSize
      } else {
        truncated = true
      }
      return entryCount <= ZIP_ENTRY_SCAN_MAX
        && wanted.has(info.name)
        && info.originalSize <= ZIP_ENTRY_EXTRACT_MAX_BYTES
        && [0, 8].includes(info.compression)
    },
  })

  const metadata: ExtractedMetadata = {
    archiveEntryCount: entryCount,
    archiveCompressedBytes: compressedSize,
    archiveUncompressedBytes: uncompressedSize,
    archiveEntryScanTruncated: truncated,
  }

  if (['xlsx', 'xlsm'].includes(extension)) {
    metadata.workbookType = extension
    const workbook = decodeXml(extracted['xl/workbook.xml'])
    const sheetNames = workbook
      ? [...workbook.matchAll(/<sheet\b[^>]*\bname="([^"]+)"/gi)].slice(0, 100).map((match) => decodeXmlEntity(match[1]).slice(0, 120))
      : []
    metadata.sheetCount = sheetNames.length
    if (sheetNames.length) metadata.sheetNames = sheetNames
  }

  const core = decodeXml(extracted['docProps/core.xml'])
  const title = xmlTagValue(core, 'title')
  const author = xmlTagValue(core, 'creator')
  const created = xmlTagValue(core, 'created')
  if (title) metadata.title = title
  if (author) metadata.author = author
  if (created) metadata.createdMetadata = created

  if (extension === 'docx') {
    const document = decodeXml(extracted['word/document.xml'])
    if (document) {
      const text = document.replace(/<w:tab\b[^>]*\/>/gi, ' ').replace(/<[^>]+>/g, ' ')
      const words = decodeXmlEntity(text).trim().split(/\s+/u).filter(Boolean)
      metadata.wordCount = words.length
    }
  }
  return metadata
}

async function inspectZip(file: File, extension: string): Promise<ExtractedMetadata> {
  if (file.size > ZIP_INSPECTION_MAX_BYTES) return { metadataInspectionSkipped: true, metadataInspectionReason: 'archive-too-large' }
  try {
    return inspectZipBuffer(new Uint8Array(await file.arrayBuffer()), extension)
  } catch {
    return { metadataInspectionFailed: true }
  }
}

async function inspectPdf(file: File): Promise<ExtractedMetadata> {
  if (file.size > PDF_INSPECTION_MAX_BYTES) return { metadataInspectionSkipped: true, metadataInspectionReason: 'pdf-too-large' }
  try {
    const text = new TextDecoder('latin1').decode(await file.arrayBuffer())
    const pageCount = (text.match(/\/Type\s*\/Page\b/g) ?? []).length
    const title = text.match(/\/Title\s*\(([^)]{1,300})\)/)?.[1]
    const author = text.match(/\/Author\s*\(([^)]{1,300})\)/)?.[1]
    const created = text.match(/\/CreationDate\s*\(([^)]{1,120})\)/)?.[1]
    return {
      ...(pageCount > 0 ? { pageCount } : {}),
      ...(title ? { title: title.slice(0, 300) } : {}),
      ...(author ? { author: author.slice(0, 300) } : {}),
      ...(created ? { createdMetadata: created.slice(0, 120) } : {}),
    }
  } catch {
    return { metadataInspectionFailed: true }
  }
}

async function inspectDelimitedText(file: File): Promise<ExtractedMetadata> {
  if (file.size > TEXT_INSPECTION_MAX_BYTES) return { metadataInspectionSkipped: true, metadataInspectionReason: 'text-too-large' }
  try {
    const text = await file.text()
    const lines = text.replace(/\r\n?/g, '\n').split('\n')
    const nonEmpty = lines.filter((line) => line.length > 0)
    const first = nonEmpty[0] ?? ''
    const delimiter = first.includes('\t') ? '\t' : first.includes(';') && !first.includes(',') ? ';' : ','
    return {
      rowCountApprox: nonEmpty.length,
      columnCountApprox: first ? first.split(delimiter).length : 0,
    }
  } catch {
    return { metadataInspectionFailed: true }
  }
}

export async function extractFileMetadata(file: File): Promise<ExtractedMetadata | undefined> {
  const extension = extensionOf(file.name)
  if (extension === 'pdf') return inspectPdf(file)
  if (['zip', 'xlsx', 'xlsm', 'docx'].includes(extension)) return inspectZip(file, extension)
  if (extension === 'csv') return inspectDelimitedText(file)
  return undefined
}

export const metadataInspectionLimits = {
  zipBytes: ZIP_INSPECTION_MAX_BYTES,
  pdfBytes: PDF_INSPECTION_MAX_BYTES,
  textBytes: TEXT_INSPECTION_MAX_BYTES,
  zipEntryBytes: ZIP_ENTRY_EXTRACT_MAX_BYTES,
  zipEntries: ZIP_ENTRY_SCAN_MAX,
} as const
