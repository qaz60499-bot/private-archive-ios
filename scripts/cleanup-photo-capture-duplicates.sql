-- One-time/idempotent repair for historical photo duplicates created by older builds.
-- A duplicate capture is deliberately conservative: same normalized filename stem,
-- exact EXIF taken_at, exact width and height. Prefer a stored HEIC/HEIF original.
-- Exact duplicates that already share one storage_object_id are naturally covered too.
-- The losing logical asset is moved to Trash (not hard-deleted), so its distinct
-- Telegram object remains recoverable and can be purged through the normal safe flow.

-- 1) Preserve tags on the canonical capture.
WITH active AS (
  SELECT id,
    lower(substr(original_name, 1, CASE WHEN instr(original_name, '.') > 0 THEN instr(original_name, '.') - 1 ELSE length(original_name) END)) AS base,
    taken_at, width, height, mime_type, created_at
  FROM assets
  WHERE workspace_id = 'personal' AND media_type = 'photo'
    AND status NOT IN ('trashed', 'failed', 'pending_upload')
), ranked AS (
  SELECT *,
    row_number() OVER (
      PARTITION BY base, taken_at, width, height
      ORDER BY CASE WHEN lower(mime_type) IN ('image/heic', 'image/heif') THEN 0 ELSE 1 END,
        created_at DESC, id DESC
    ) AS rn,
    count(*) OVER (PARTITION BY base, taken_at, width, height) AS cnt,
    first_value(id) OVER (
      PARTITION BY base, taken_at, width, height
      ORDER BY CASE WHEN lower(mime_type) IN ('image/heic', 'image/heif') THEN 0 ELSE 1 END,
        created_at DESC, id DESC
    ) AS canonical_id
  FROM active
  WHERE base != '' AND taken_at IS NOT NULL AND width IS NOT NULL AND height IS NOT NULL
), mapping AS (
  SELECT id AS duplicate_id, canonical_id FROM ranked WHERE cnt > 1 AND rn > 1
)
INSERT OR IGNORE INTO asset_tags (asset_id, tag_id, confidence, source)
SELECT mapping.canonical_id, asset_tags.tag_id, asset_tags.confidence, asset_tags.source
FROM mapping JOIN asset_tags ON asset_tags.asset_id = mapping.duplicate_id;

-- 2) Preserve useful analysis/manual state when the preferred original lacks it.
WITH active AS (
  SELECT id,
    lower(substr(original_name, 1, CASE WHEN instr(original_name, '.') > 0 THEN instr(original_name, '.') - 1 ELSE length(original_name) END)) AS base,
    taken_at, width, height, mime_type, created_at
  FROM assets
  WHERE workspace_id = 'personal' AND media_type = 'photo'
    AND status NOT IN ('trashed', 'failed', 'pending_upload')
), ranked AS (
  SELECT *,
    row_number() OVER (
      PARTITION BY base, taken_at, width, height
      ORDER BY CASE WHEN lower(mime_type) IN ('image/heic', 'image/heif') THEN 0 ELSE 1 END,
        created_at DESC, id DESC
    ) AS rn,
    count(*) OVER (PARTITION BY base, taken_at, width, height) AS cnt,
    first_value(id) OVER (
      PARTITION BY base, taken_at, width, height
      ORDER BY CASE WHEN lower(mime_type) IN ('image/heic', 'image/heif') THEN 0 ELSE 1 END,
        created_at DESC, id DESC
    ) AS canonical_id
  FROM active
  WHERE base != '' AND taken_at IS NOT NULL AND width IS NOT NULL AND height IS NOT NULL
), mapping AS (
  SELECT id AS duplicate_id, canonical_id FROM ranked WHERE cnt > 1 AND rn > 1
)
UPDATE assets SET
  primary_category = coalesce(primary_category, (
    SELECT duplicate.primary_category FROM mapping
    JOIN assets duplicate ON duplicate.id = mapping.duplicate_id
    WHERE mapping.canonical_id = assets.id AND duplicate.primary_category IS NOT NULL LIMIT 1
  )),
  category_override = coalesce(category_override, (
    SELECT duplicate.category_override FROM mapping
    JOIN assets duplicate ON duplicate.id = mapping.duplicate_id
    WHERE mapping.canonical_id = assets.id AND duplicate.category_override IS NOT NULL LIMIT 1
  )),
  person_count = coalesce(person_count, (
    SELECT duplicate.person_count FROM mapping
    JOIN assets duplicate ON duplicate.id = mapping.duplicate_id
    WHERE mapping.canonical_id = assets.id AND duplicate.person_count IS NOT NULL LIMIT 1
  )),
  scene = coalesce(scene, (
    SELECT duplicate.scene FROM mapping
    JOIN assets duplicate ON duplicate.id = mapping.duplicate_id
    WHERE mapping.canonical_id = assets.id AND duplicate.scene IS NOT NULL LIMIT 1
  )),
  place_id = coalesce(place_id, (
    SELECT duplicate.place_id FROM mapping
    JOIN assets duplicate ON duplicate.id = mapping.duplicate_id
    WHERE mapping.canonical_id = assets.id AND duplicate.place_id IS NOT NULL LIMIT 1
  )),
  favorite = max(favorite, coalesce((
    SELECT max(duplicate.favorite) FROM mapping
    JOIN assets duplicate ON duplicate.id = mapping.duplicate_id
    WHERE mapping.canonical_id = assets.id
  ), 0)),
  archived = max(archived, coalesce((
    SELECT max(duplicate.archived) FROM mapping
    JOIN assets duplicate ON duplicate.id = mapping.duplicate_id
    WHERE mapping.canonical_id = assets.id
  ), 0)),
  analysis_status = CASE
    WHEN analysis_status IN ('pending', 'skipped', 'failed') AND EXISTS (
      SELECT 1 FROM mapping
      JOIN assets duplicate ON duplicate.id = mapping.duplicate_id
      WHERE mapping.canonical_id = assets.id AND duplicate.analysis_status = 'ready'
    ) THEN 'ready'
    ELSE analysis_status
  END,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id IN (SELECT canonical_id FROM mapping);

-- 3) Keep activity history attached to the canonical asset.
WITH active AS (
  SELECT id,
    lower(substr(original_name, 1, CASE WHEN instr(original_name, '.') > 0 THEN instr(original_name, '.') - 1 ELSE length(original_name) END)) AS base,
    taken_at, width, height, mime_type, created_at
  FROM assets
  WHERE workspace_id = 'personal' AND media_type = 'photo'
    AND status NOT IN ('trashed', 'failed', 'pending_upload')
), ranked AS (
  SELECT *,
    row_number() OVER (
      PARTITION BY base, taken_at, width, height
      ORDER BY CASE WHEN lower(mime_type) IN ('image/heic', 'image/heif') THEN 0 ELSE 1 END,
        created_at DESC, id DESC
    ) AS rn,
    count(*) OVER (PARTITION BY base, taken_at, width, height) AS cnt,
    first_value(id) OVER (
      PARTITION BY base, taken_at, width, height
      ORDER BY CASE WHEN lower(mime_type) IN ('image/heic', 'image/heif') THEN 0 ELSE 1 END,
        created_at DESC, id DESC
    ) AS canonical_id
  FROM active
  WHERE base != '' AND taken_at IS NOT NULL AND width IS NOT NULL AND height IS NOT NULL
), mapping AS (
  SELECT id AS duplicate_id, canonical_id FROM ranked WHERE cnt > 1 AND rn > 1
)
UPDATE activity_log
SET asset_id = (SELECT canonical_id FROM mapping WHERE duplicate_id = activity_log.asset_id)
WHERE asset_id IN (SELECT duplicate_id FROM mapping);

-- 4) Move duplicate logical assets to Trash. Do not directly delete Telegram media.
WITH active AS (
  SELECT id,
    lower(substr(original_name, 1, CASE WHEN instr(original_name, '.') > 0 THEN instr(original_name, '.') - 1 ELSE length(original_name) END)) AS base,
    taken_at, width, height, mime_type, created_at
  FROM assets
  WHERE workspace_id = 'personal' AND media_type = 'photo'
    AND status NOT IN ('trashed', 'failed', 'pending_upload')
), ranked AS (
  SELECT *,
    row_number() OVER (
      PARTITION BY base, taken_at, width, height
      ORDER BY CASE WHEN lower(mime_type) IN ('image/heic', 'image/heif') THEN 0 ELSE 1 END,
        created_at DESC, id DESC
    ) AS rn,
    count(*) OVER (PARTITION BY base, taken_at, width, height) AS cnt
  FROM active
  WHERE base != '' AND taken_at IS NOT NULL AND width IS NOT NULL AND height IS NOT NULL
), duplicates AS (
  SELECT id FROM ranked WHERE cnt > 1 AND rn > 1
)
UPDATE assets SET
  pre_trash_status = status,
  status = 'trashed',
  deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  purge_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+30 days'),
  purge_state = 'active',
  purge_error = NULL,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id IN (SELECT id FROM duplicates);

-- 5) Rebuild search rows for surviving active photos so merged tags are searchable.
DELETE FROM asset_search
WHERE asset_id IN (
  SELECT id FROM assets
  WHERE workspace_id = 'personal' AND media_type = 'photo'
    AND status NOT IN ('trashed', 'failed', 'pending_upload')
);

INSERT INTO asset_search (asset_id, workspace_id, search_text)
SELECT assets.id, assets.workspace_id,
  trim(
    assets.original_name || ' ' || assets.extension || ' ' || assets.file_category || ' ' || assets.mime_type || ' ' ||
    coalesce(assets.logical_path, '') || ' ' || coalesce(assets.scene, '') || ' ' ||
    coalesce((SELECT group_concat(tags.name, ' ') FROM asset_tags JOIN tags ON tags.id = asset_tags.tag_id WHERE asset_tags.asset_id = assets.id), '') || ' ' ||
    coalesce((SELECT group_concat(albums.name, ' ') FROM album_assets JOIN albums ON albums.id = album_assets.album_id WHERE album_assets.asset_id = assets.id), '')
  )
FROM assets
WHERE assets.workspace_id = 'personal' AND assets.media_type = 'photo'
  AND assets.status NOT IN ('trashed', 'failed', 'pending_upload');

-- 6) Refresh the user-visible usage snapshot from final database truth.
UPDATE usage_snapshots SET
  file_count = (SELECT count(*) FROM assets WHERE workspace_id = 'personal' AND status != 'trashed' AND media_type != 'photo'),
  photo_count = (SELECT count(*) FROM assets WHERE workspace_id = 'personal' AND status != 'trashed' AND media_type = 'photo'),
  storage_bytes = (SELECT coalesce(sum(size_bytes), 0) FROM storage_objects WHERE workspace_id = 'personal' AND delete_state != 'deleted'),
  upload_count = (SELECT count(*) FROM assets WHERE workspace_id = 'personal'),
  upload_bytes = (SELECT coalesce(sum(size_bytes), 0) FROM assets WHERE workspace_id = 'personal'),
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE workspace_id = 'personal';
