export interface DiscoverModuleRow {
  slug: string
  name: string
  description: string
  kind: 'category' | 'media'
  sort_order: number
  is_system: number
  asset_count: number
  cover_asset_id: string | null
}

export async function listDiscoverModules(db: D1Database): Promise<DiscoverModuleRow[]> {
  const result = await db.prepare(`SELECT
      modules.slug,
      modules.name,
      modules.description,
      modules.kind,
      modules.sort_order,
      modules.is_system,
      CASE
        WHEN modules.kind = 'media' AND modules.slug = 'video' THEN (
          SELECT COUNT(*) FROM assets
          WHERE status != 'trashed' AND media_type = 'video'
        )
        ELSE (
          SELECT COUNT(*) FROM assets
          WHERE status != 'trashed' AND media_type != 'video'
            AND COALESCE(category_override, primary_category, 'other') = modules.slug
        )
      END AS asset_count,
      CASE
        WHEN modules.kind = 'media' AND modules.slug = 'video' THEN (
          SELECT id FROM assets
          WHERE status != 'trashed' AND media_type = 'video'
          ORDER BY taken_at DESC, id DESC LIMIT 1
        )
        ELSE (
          SELECT id FROM assets
          WHERE status != 'trashed' AND media_type != 'video'
            AND COALESCE(category_override, primary_category, 'other') = modules.slug
          ORDER BY taken_at DESC, id DESC LIMIT 1
        )
      END AS cover_asset_id
    FROM discover_modules AS modules
    ORDER BY modules.sort_order ASC, modules.name ASC`).all<DiscoverModuleRow>()
  return result.results
}

export async function getDiscoverModule(db: D1Database, slug: string): Promise<DiscoverModuleRow | null> {
  return db.prepare(`SELECT slug, name, description, kind, sort_order, is_system, 0 AS asset_count, NULL AS cover_asset_id
    FROM discover_modules WHERE slug = ?`).bind(slug).first<DiscoverModuleRow>()
}

export async function createDiscoverModule(db: D1Database, name: string, description: string): Promise<DiscoverModuleRow> {
  const slug = `custom-${crypto.randomUUID().slice(0, 8)}`
  const now = new Date().toISOString()
  const orderRow = await db.prepare(`SELECT COALESCE(MAX(sort_order), 80) + 10 AS next_order
    FROM discover_modules WHERE kind = 'category'`).first<{ next_order: number }>()
  const sortOrder = orderRow?.next_order ?? 90
  await db.prepare(`INSERT INTO discover_modules
    (slug, name, description, kind, sort_order, is_system, created_at, updated_at)
    VALUES (?, ?, ?, 'category', ?, 0, ?, ?)`)
    .bind(slug, name, description, sortOrder, now, now).run()
  return {
    slug,
    name,
    description,
    kind: 'category',
    sort_order: sortOrder,
    is_system: 0,
    asset_count: 0,
    cover_asset_id: null,
  }
}

export async function deleteDiscoverModule(db: D1Database, slug: string): Promise<boolean> {
  const module = await db.prepare(`SELECT is_system FROM discover_modules WHERE slug = ?`).bind(slug).first<{ is_system: number }>()
  if (!module || module.is_system === 1) return false
  const now = new Date().toISOString()
  await db.batch([
    db.prepare(`UPDATE assets SET category_override = NULL, category_override_at = NULL, updated_at = ?
      WHERE category_override = ?`).bind(now, slug),
    db.prepare(`DELETE FROM discover_modules WHERE slug = ?`).bind(slug),
  ])
  return true
}

export async function listAiAssignableModules(db: D1Database): Promise<Array<{ slug: string; name: string; description: string }>> {
  const result = await db.prepare(`SELECT slug, name, description FROM discover_modules
    WHERE kind = 'category' ORDER BY sort_order ASC, name ASC`).all<{ slug: string; name: string; description: string }>()
  return result.results
}
