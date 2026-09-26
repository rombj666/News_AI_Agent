-- Delivery settings remain authoritative in confirmed user_preferences.
CREATE VIEW delivery_settings WITH (security_invoker=true) AS
SELECT user_id,version,(document->>'deliveryEnabled')::boolean AS enabled,
 document->>'deliveryTime' AS local_time,document->>'timezone' AS timezone,
 document->>'digestLength' AS digest_type FROM user_preferences;

CREATE TABLE scheduled_collection_batches (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 batch_key text NOT NULL UNIQUE,
 started_at timestamptz NOT NULL,
 completed_at timestamptz,
 status text NOT NULL CHECK(status IN ('running','completed','failed')),
 results jsonb NOT NULL DEFAULT '[]'
);
CREATE TABLE scheduled_pipeline_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL REFERENCES users(id),
 local_date date NOT NULL,
 digest_type text NOT NULL CHECK(digest_type IN ('quick','normal','deep')),
 scheduled_for timestamptz NOT NULL,
 started_at timestamptz NOT NULL,
 completed_at timestamptz,
 status text NOT NULL DEFAULT 'running' CHECK(status IN ('running','completed','no_fresh','failed','uncertain')),
 retrieval_result jsonb,
 candidate_count integer CHECK(candidate_count>=0),
 ranking_id uuid NOT NULL DEFAULT gen_random_uuid(),
 ranking_status text NOT NULL DEFAULT 'not_started',
 digest_id uuid,
 delivery_status text NOT NULL DEFAULT 'not_started',
 failure_stage text,
 failure_code text,
 UNIQUE(user_id,local_date,digest_type),
 UNIQUE(user_id,id),
 FOREIGN KEY(user_id,digest_id) REFERENCES digests(user_id,id)
);
ALTER TABLE scheduled_pipeline_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_pipeline_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY own_rows ON scheduled_pipeline_runs USING(user_id=request_user_id()) WITH CHECK(user_id=request_user_id());
CREATE UNIQUE INDEX one_scheduled_delivery_per_digest ON scheduled_pipeline_runs(user_id,digest_id) WHERE digest_id IS NOT NULL;

ALTER TABLE telegram_deliveries ALTER COLUMN update_id DROP NOT NULL;
ALTER TABLE telegram_deliveries ADD COLUMN scheduled_run_id uuid;
ALTER TABLE telegram_deliveries ADD CONSTRAINT scheduled_delivery_owner FOREIGN KEY(user_id,scheduled_run_id) REFERENCES scheduled_pipeline_runs(user_id,id);
ALTER TABLE telegram_deliveries ADD CONSTRAINT delivery_origin CHECK((update_id IS NULL) <> (scheduled_run_id IS NULL));
ALTER TABLE telegram_deliveries ADD CONSTRAINT unique_scheduled_part UNIQUE(scheduled_run_id,part);
