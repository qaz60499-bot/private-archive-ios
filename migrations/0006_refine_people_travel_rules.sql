UPDATE discover_modules
SET description = '专门拍人的人像、自拍、摆拍或明显以人为主体的照片', updated_at = datetime('now')
WHERE slug = 'people';

UPDATE discover_modules
SET description = '公路、沿途、交通工具、景点与带明显旅行过程感的场景', updated_at = datetime('now')
WHERE slug = 'travel';

UPDATE discover_modules
SET description = '山水、森林、海湖、花草等自然风景；与旅途允许轻度重叠', updated_at = datetime('now')
WHERE slug = 'nature';
