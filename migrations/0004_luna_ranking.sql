-- Additive extensions of the existing ledger and jobs; existing RLS applies.
ALTER TABLE ai_usage ADD COLUMN reserved_cost_nanodollars bigint NOT NULL DEFAULT 0 CHECK (reserved_cost_nanodollars >= 0);
ALTER TABLE ai_usage ADD COLUMN error_code text CHECK (error_code ~ '^[A-Z0-9_]{1,80}$');
ALTER TABLE job_runs ADD COLUMN request_key text;
ALTER TABLE job_runs ADD COLUMN result jsonb;
ALTER TABLE job_runs ADD COLUMN error_code text CHECK (error_code ~ '^[A-Z0-9_]{1,80}$');
