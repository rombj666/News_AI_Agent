-- Only stable sanitized codes; no request text, URLs or provider descriptions.
ALTER TABLE telegram_updates ADD COLUMN error_code text CHECK(length(error_code)<=180);
ALTER TABLE telegram_deliveries ADD COLUMN error_code text CHECK(length(error_code)<=180);
