CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_user_id text NOT NULL UNIQUE CHECK (telegram_user_id ~ '^[1-9][0-9]{0,15}$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_preferences (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE pending_preference_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  old_value jsonb NOT NULL CHECK (jsonb_typeof(old_value) = 'object'),
  new_value jsonb NOT NULL CHECK (jsonb_typeof(new_value) = 'object'),
  expected_version integer NOT NULL CHECK (expected_version > 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'cancelled', 'expired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  decided_at timestamptz,
  UNIQUE (user_id, id),
  CHECK (expires_at > created_at),
  CHECK ((status IN ('confirmed', 'cancelled')) = (decided_at IS NOT NULL))
);
CREATE INDEX pending_by_owner_status ON pending_preference_changes(user_id, status, expires_at);

CREATE TABLE conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (user_id, id)
);

CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL CHECK (length(content) BETWEEN 1 AND 20000),
  created_at timestamptz NOT NULL DEFAULT now(),
  search_document tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
  UNIQUE (user_id, id),
  FOREIGN KEY (user_id, conversation_id) REFERENCES conversations(user_id, id) ON DELETE CASCADE
);
CREATE INDEX messages_by_owner_time ON messages(user_id, created_at DESC);
CREATE INDEX messages_search ON messages USING gin(search_document);

CREATE TABLE ai_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (scope IN ('user', 'shared')),
  operation_id uuid NOT NULL,
  attempt integer NOT NULL CHECK (attempt > 0),
  provider text NOT NULL CHECK (provider IN ('openai', 'brave', 'demo')),
  model text CHECK (model = 'gpt-5.6-luna'),
  job_type text NOT NULL,
  request_id text,
  status text NOT NULL CHECK (status IN ('succeeded', 'failed', 'unknown')),
  input_tokens bigint CHECK (input_tokens >= 0),
  cached_input_tokens bigint CHECK (cached_input_tokens >= 0),
  output_tokens bigint CHECK (output_tokens >= 0),
  search_calls bigint CHECK (search_calls >= 0),
  estimated_cost_nanodollars bigint CHECK (estimated_cost_nanodollars >= 0),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  rate_snapshot jsonb NOT NULL CHECK (jsonb_typeof(rate_snapshot) = 'object'),
  execution_time_ms bigint NOT NULL CHECK (execution_time_ms >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope = 'user' AND user_id IS NOT NULL) OR (scope = 'shared' AND user_id IS NULL)),
  CHECK (cached_input_tokens IS NULL OR (input_tokens IS NOT NULL AND cached_input_tokens <= input_tokens)),
  CHECK (provider <> 'openai' OR (model IS NOT NULL AND model = 'gpt-5.6-luna')),
  CHECK (provider <> 'brave' OR model IS NULL),
  CHECK (provider <> 'openai' OR estimated_cost_nanodollars IS NULL
    OR (input_tokens IS NOT NULL AND cached_input_tokens IS NOT NULL AND output_tokens IS NOT NULL)),
  CHECK (provider <> 'brave' OR estimated_cost_nanodollars IS NULL OR search_calls IS NOT NULL),
  UNIQUE NULLS NOT DISTINCT (scope, user_id, provider, operation_id, attempt)
);
CREATE INDEX usage_by_owner_time ON ai_usage(user_id, created_at);

CREATE TABLE job_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_type text NOT NULL,
  occurrence_key text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'uncertain')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, job_type, occurrence_key)
);

-- app.user_id is set only by trusted authenticated application code, locally to
-- one transaction. An unset scope yields no private rows, not unrestricted access.
CREATE FUNCTION request_user_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid
$$;

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY own_user ON users USING (id = request_user_id()) WITH CHECK (id = request_user_id());

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'user_preferences', 'pending_preference_changes', 'conversations', 'messages', 'ai_usage', 'job_runs'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY own_rows ON %I USING (user_id = request_user_id()) WITH CHECK (user_id = request_user_id())', table_name);
  END LOOP;
END $$;
