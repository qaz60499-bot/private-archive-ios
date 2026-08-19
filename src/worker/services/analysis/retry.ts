import type { Env } from '../../env'

export async function retryFailedAnalysis(env: Env, limit = 50): Promise<number> {
  const result = await env.DB.prepare(`SELECT id, preview_file_id FROM assets
    WHERE analysis_status = 'failed' AND status != 'trashed' AND preview_file_id IS NOT NULL AND category_override IS NULL
    ORDER BY updated_at DESC LIMIT ?`).bind(limit).all<{ id: string; preview_file_id: string }>()
  const rows = result.results ?? []
  if (!rows.length) return 0

  await env.ANALYSIS_QUEUE.sendBatch(rows.map((row) => ({
    body: { assetId: row.id, previewFileId: row.preview_file_id, jobType: 'analyze' as const },
  })))

  const now = new Date().toISOString()
  await env.DB.batch(rows.map((row) => env.DB.prepare(`UPDATE assets SET status = 'queued', analysis_status = 'queued', updated_at = ? WHERE id = ? AND analysis_status = 'failed'`).bind(now, row.id)))
  return rows.length
}
