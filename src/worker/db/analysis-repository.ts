import type { AssetRow } from '../domain/types'
import { refreshAssetSearchIndex } from './assets-repository'

export interface AnalysisResult {
  primaryCategory: string
  tags: string[]
  personCount: number
  scene: 'indoor' | 'outdoor' | 'unknown'
  confidence: number
}

export async function markAnalyzing(db: D1Database, assetId: string): Promise<void> {
  await db.prepare(`UPDATE assets SET status = 'analyzing', analysis_status = 'analyzing', updated_at = ? WHERE id = ?`)
    .bind(new Date().toISOString(), assetId).run()
}

export async function saveAnalysis(db: D1Database, asset: AssetRow, result: AnalysisResult): Promise<void> {
  const now = new Date().toISOString()
  const statements: D1PreparedStatement[] = [
    db.prepare(`UPDATE assets SET primary_category = ?, person_count = ?, scene = ?, status = 'ready',
      analysis_status = 'ready', updated_at = ? WHERE id = ?`)
      .bind(result.primaryCategory, result.personCount, result.scene, now, asset.id),
    db.prepare(`DELETE FROM asset_tags WHERE asset_id = ? AND source = 'ai'`).bind(asset.id),
  ]
  for (const slug of result.tags) {
    const tagId = `tag-${slug}`
    statements.push(
      db.prepare(`INSERT INTO tags (id, slug, name, kind) VALUES (?, ?, ?, 'ai')
        ON CONFLICT(slug) DO UPDATE SET name = excluded.name`).bind(tagId, slug, slug.replaceAll('-', ' ')),
      db.prepare(`INSERT INTO asset_tags (asset_id, tag_id, confidence, source) VALUES (?, ?, ?, 'ai')
        ON CONFLICT(asset_id, tag_id) DO UPDATE SET confidence = excluded.confidence, source = 'ai'`)
        .bind(asset.id, tagId, result.confidence),
    )
  }
  await db.batch(statements)
  await refreshAssetSearchIndex(db, asset.id)
}

export async function markAnalysisLimited(db: D1Database, assetId: string): Promise<void> {
  await db.prepare(`UPDATE assets SET status = 'limited', analysis_status = 'limited', updated_at = ? WHERE id = ?`)
    .bind(new Date().toISOString(), assetId).run()
}

export async function markAnalysisFailed(db: D1Database, assetId: string): Promise<void> {
  await db.prepare(`UPDATE assets SET status = CASE WHEN storage_file_id IS NULL THEN 'failed' ELSE 'stored' END,
    analysis_status = 'failed', updated_at = ? WHERE id = ?`)
    .bind(new Date().toISOString(), assetId).run()
}

