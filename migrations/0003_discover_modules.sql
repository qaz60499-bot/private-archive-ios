ALTER TABLE assets ADD COLUMN category_override TEXT;
ALTER TABLE assets ADD COLUMN category_override_at TEXT;

CREATE TABLE IF NOT EXISTS discover_modules (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'category' CHECK (kind IN ('category', 'media')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_system INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO discover_modules (slug, name, description, kind, sort_order, is_system, created_at, updated_at) VALUES
  ('people', '人物', '肖像、合照与以人为主体的照片', 'category', 10, 1, datetime('now'), datetime('now')),
  ('gathering', '聚会', '聚餐、聚会与共同经历', 'category', 20, 1, datetime('now'), datetime('now')),
  ('travel', '旅途', '出行、车站、机场与旅程片段', 'category', 30, 1, datetime('now'), datetime('now')),
  ('city', '城市', '街道、建筑与城市空间', 'category', 40, 1, datetime('now'), datetime('now')),
  ('nature', '自然', '风景、植物、山水与户外', 'category', 50, 1, datetime('now'), datetime('now')),
  ('food', '食物', '餐桌、饮品与食物记录', 'category', 60, 1, datetime('now'), datetime('now')),
  ('screenshot', '截屏', '手机、电脑、App、网页或聊天界面的真实数字截图', 'category', 70, 1, datetime('now'), datetime('now')),
  ('other', '其他', '暂时没有更合适模块的内容', 'category', 80, 1, datetime('now'), datetime('now')),
  ('video', '视频', '有声音的时间片段', 'media', 90, 1, datetime('now'), datetime('now'));

CREATE INDEX IF NOT EXISTS idx_assets_category_override_taken ON assets(category_override, taken_at DESC);
CREATE INDEX IF NOT EXISTS idx_discover_modules_sort ON discover_modules(sort_order, name);
