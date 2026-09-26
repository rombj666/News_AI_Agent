ALTER TABLE articles ADD COLUMN image_url text CHECK(image_url IS NULL OR (length(image_url)<=2048 AND image_url LIKE 'https://%'));
ALTER TABLE telegram_sessions ADD COLUMN current_story_position integer CHECK(current_story_position BETWEEN 1 AND 30);
