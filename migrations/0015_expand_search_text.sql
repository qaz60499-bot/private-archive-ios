-- Rebuild the D1 FTS document so short-token fallback can stay inside asset_search
-- instead of running correlated LIKE scans across assets/tags/albums/places.
-- The reverse album index keeps asset -> album-name expansion linear at 50k+ rows.
CREATE INDEX IF NOT EXISTS idx_album_assets_asset_album ON album_assets(asset_id, album_id);

DELETE FROM asset_search WHERE workspace_id = 'personal';

INSERT INTO asset_search (asset_id, workspace_id, search_text)
SELECT assets.id, assets.workspace_id,
  trim(
    assets.original_name || ' ' || assets.extension || ' ' || assets.file_category || ' ' || assets.mime_type || ' ' ||
    COALESCE(assets.logical_path, '') || ' ' || COALESCE(assets.scene, '') || ' ' ||
    COALESCE(assets.category_override, assets.primary_category, '') || ' ' ||
    COALESCE((SELECT places.label || ' ' || COALESCE(places.city, '') FROM places WHERE places.id = assets.place_id), '') || ' ' ||
    COALESCE((SELECT group_concat(tags.name, ' ') FROM asset_tags JOIN tags ON tags.id = asset_tags.tag_id WHERE asset_tags.asset_id = assets.id), '') || ' ' ||
    COALESCE((SELECT group_concat(albums.name, ' ') FROM album_assets JOIN albums ON albums.id = album_assets.album_id WHERE album_assets.asset_id = assets.id), '')
  )
FROM assets
WHERE assets.workspace_id = 'personal';
