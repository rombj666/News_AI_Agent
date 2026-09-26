ALTER TABLE job_runs ADD CONSTRAINT job_runs_owner_id UNIQUE (user_id,id);

CREATE TABLE digests (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL CHECK (period_end > period_start),
  digest_type text NOT NULL CHECK (digest_type IN ('quick','normal','deep')),
  revision integer NOT NULL CHECK (revision > 0),
  status text NOT NULL CHECK (status IN ('running','succeeded','failed')),
  model text NOT NULL CHECK (model = 'gpt-5.6-luna'),
  preference_version integer NOT NULL CHECK (preference_version > 0),
  input_story_count integer NOT NULL CHECK (input_story_count BETWEEN 1 AND 30),
  output_story_count integer NOT NULL DEFAULT 0 CHECK (output_story_count BETWEEN 0 AND 30),
  generated_at timestamptz,
  document jsonb,
  created_at timestamptz NOT NULL,
  error_code text CHECK (error_code ~ '^[A-Z0-9_]{1,80}$'),
  UNIQUE (user_id,id),
  UNIQUE (user_id,period_start,period_end,digest_type,revision),
  FOREIGN KEY (user_id,id) REFERENCES job_runs(user_id,id),
  CHECK ((status = 'succeeded') = (document IS NOT NULL AND generated_at IS NOT NULL))
);
CREATE INDEX digests_by_owner_period ON digests(user_id,period_start,period_end,digest_type,revision DESC);
CREATE UNIQUE INDEX one_running_digest ON digests(user_id,period_start,period_end,digest_type) WHERE status='running';

CREATE TABLE digest_items (
  user_id uuid NOT NULL,
  digest_id uuid NOT NULL,
  story_cluster_id uuid NOT NULL REFERENCES story_clusters(id),
  position integer NOT NULL CHECK (position BETWEEN 1 AND 30),
  section text NOT NULL,
  headline text NOT NULL,
  summary text NOT NULL,
  why_it_matters text NOT NULL,
  metadata jsonb NOT NULL CHECK (jsonb_typeof(metadata)='object'),
  PRIMARY KEY (user_id,digest_id,position),
  UNIQUE (user_id,digest_id,story_cluster_id),
  FOREIGN KEY (user_id,digest_id) REFERENCES digests(user_id,id)
);

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['digests','digest_items'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY own_rows ON %I USING (user_id=request_user_id()) WITH CHECK (user_id=request_user_id())',table_name);
  END LOOP;
END $$;
