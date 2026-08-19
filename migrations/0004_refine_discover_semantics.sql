UPDATE discover_modules SET description = '以单人、双人或少量人物为构图中心的人像、肖像、自拍与摆拍合照', updated_at = datetime('now') WHERE slug = 'people';
UPDATE discover_modules SET description = '多人正在聚餐、聊天、庆祝、游戏或共同活动的社交场景', updated_at = datetime('now') WHERE slug = 'gathering';
UPDATE discover_modules SET description = '公路、开车、车内车窗、交通工具、车站机场、沿途与带明显旅程过程感的风景', updated_at = datetime('now') WHERE slug = 'travel';
UPDATE discover_modules SET description = '城市建筑、街道、商业空间、建筑群与城市天际线', updated_at = datetime('now') WHERE slug = 'city';
UPDATE discover_modules SET description = '不带明显交通或旅程过程线索的山水、森林、海湖、花草与纯自然景观', updated_at = datetime('now') WHERE slug = 'nature';
