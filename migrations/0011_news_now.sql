-- A private request envelope prevents retries across all interactive entry points,
-- including interrupted retrieval before a model job exists. No query in shared state.
ALTER TABLE digests ADD COLUMN purpose text NOT NULL DEFAULT 'scheduled'
 CHECK(purpose IN ('scheduled','news_now','current_question'));

CREATE TABLE news_now_runs (
 user_id uuid NOT NULL REFERENCES users(id),
 id uuid NOT NULL,
 request_key text NOT NULL,
 status text NOT NULL DEFAULT 'running' CHECK(status IN ('running','completed','no_fresh','failed')),
 digest_id uuid,
 failure_stage text,
 failure_code text,
 created_at timestamptz NOT NULL,
 completed_at timestamptz,
 PRIMARY KEY(user_id,id),
 FOREIGN KEY(user_id,digest_id) REFERENCES digests(user_id,id)
);
ALTER TABLE news_now_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE news_now_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY own_rows ON news_now_runs USING(user_id=request_user_id()) WITH CHECK(user_id=request_user_id());
