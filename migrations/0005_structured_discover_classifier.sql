UPDATE discover_modules SET description = '以单人、双人或少量人物为构图中心的人像、肖像、自拍与摆拍合照', updated_at = datetime('now') WHERE slug = 'people';
UPDATE discover_modules SET description = '多人正在聚餐、聊天、庆祝、游戏或共同活动的社交场景', updated_at = datetime('now') WHERE slug = 'gathering';
UPDATE discover_modules SET description = '公路、开车、车内车窗、交通工具、车站机场、沿途、旅游景点与带明显旅程过程感的场景', updated_at = datetime('now') WHERE slug = 'travel';
UPDATE discover_modules SET description = '城市建筑、街道、商业空间、建筑群与城市天际线；普通城市建筑不因旅行背景而归入旅途', updated_at = datetime('now') WHERE slug = 'city';
UPDATE discover_modules SET description = '不带明显交通、旅程过程或景点线索的山水、森林、海湖、花草与纯自然景观', updated_at = datetime('now') WHERE slug = 'nature';
UPDATE discover_modules SET description = '食物或饮品本身为画面主体；多人围桌社交优先归聚会', updated_at = datetime('now') WHERE slug = 'food';
UPDATE discover_modules SET description = '手机、电脑、App、网页或聊天界面的真实数字截屏，不包括相机拍摄的屏幕或文字场景', updated_at = datetime('now') WHERE slug = 'screenshot';
UPDATE discover_modules SET description = '只有人物、聚会、旅途、城市、自然、食物、截屏都不匹配时才使用', updated_at = datetime('now') WHERE slug = 'other';
