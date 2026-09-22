CREATE TABLE sources (
  id text PRIMARY KEY,
  name text NOT NULL,
  feed_url text NOT NULL UNIQUE,
  category text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  etag text,
  last_modified text,
  cache_key text,
  last_fetched_at timestamptz
);

CREATE TABLE articles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_url text NOT NULL UNIQUE CHECK (length(canonical_url) <= 2048),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 1000),
  normalized_title text NOT NULL,
  title_hash text NOT NULL UNIQUE CHECK (title_hash ~ '^[0-9a-f]{64}$'),
  source_name text NOT NULL,
  source_domain text NOT NULL,
  description text NOT NULL,
  published_at timestamptz,
  fetched_at timestamptz NOT NULL,
  date_kind text NOT NULL CHECK (date_kind IN ('published', 'page_age', 'unknown')),
  content_kind text NOT NULL CHECK (content_kind IN ('feed_excerpt', 'snippet', 'full_text')),
  CHECK ((published_at IS NULL) = (date_kind = 'unknown'))
);
CREATE INDEX articles_publication ON articles(published_at DESC);
CREATE INDEX articles_publisher ON articles(source_domain, published_at DESC);

-- Retain duplicate URL aliases: a later title edit must not create a second article.
CREATE TABLE article_urls (
  canonical_url text PRIMARY KEY,
  article_id uuid NOT NULL REFERENCES articles(id) ON DELETE CASCADE
);
CREATE INDEX article_urls_article ON article_urls(article_id);

CREATE TABLE retrieval_runs (
  id uuid PRIMARY KEY,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('rss', 'brave')),
  source_id text REFERENCES sources(id),
  query text NOT NULL,
  category text NOT NULL,
  since_at timestamptz NOT NULL,
  request_key text NOT NULL,
  item_limit integer NOT NULL CHECK (item_limit BETWEEN 1 AND 100),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'partial', 'failed')),
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  number_fetched integer NOT NULL DEFAULT 0 CHECK (number_fetched >= 0),
  number_inserted integer NOT NULL DEFAULT 0 CHECK (number_inserted >= 0),
  number_duplicates integer NOT NULL DEFAULT 0 CHECK (number_duplicates >= 0),
  number_filtered integer NOT NULL DEFAULT 0 CHECK (number_filtered >= 0),
  number_failures integer NOT NULL DEFAULT 0 CHECK (number_failures >= 0),
  failures jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(failures) = 'array'),
  not_modified boolean NOT NULL DEFAULT false,
  reserved_cost_nanodollars bigint NOT NULL CHECK (reserved_cost_nanodollars >= 0),
  estimated_cost_nanodollars bigint CHECK (estimated_cost_nanodollars >= 0),
  pricing_version text NOT NULL,
  CHECK ((status = 'running') = (finished_at IS NULL)),
  CHECK ((provider = 'rss') = (source_id IS NOT NULL))
);
CREATE INDEX retrieval_runs_accounting ON retrieval_runs(provider, started_at);
CREATE INDEX retrieval_runs_owner ON retrieval_runs(user_id, started_at DESC);

-- Query, category, original item metadata and alternate source spelling belong
-- to the run's visibility scope, not to the shared public article row.
CREATE TABLE article_retrievals (
  run_id uuid NOT NULL REFERENCES retrieval_runs(id) ON DELETE CASCADE,
  item_index integer NOT NULL CHECK (item_index >= 0),
  article_id uuid NOT NULL REFERENCES articles(id),
  original_url text NOT NULL,
  source_name text NOT NULL,
  fetched_at timestamptz NOT NULL,
  duplicate boolean NOT NULL,
  raw_metadata jsonb NOT NULL CHECK (jsonb_typeof(raw_metadata) = 'object'),
  PRIMARY KEY (run_id, item_index)
);
CREATE INDEX article_retrievals_article ON article_retrievals(article_id);

ALTER TABLE retrieval_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE retrieval_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY read_own_runs ON retrieval_runs FOR SELECT USING (user_id = request_user_id());
CREATE POLICY collect_runs ON retrieval_runs TO PUBLIC
  USING (current_user = 'news_collector') WITH CHECK (current_user = 'news_collector');

ALTER TABLE article_retrievals ENABLE ROW LEVEL SECURITY;
ALTER TABLE article_retrievals FORCE ROW LEVEL SECURITY;
CREATE POLICY read_own_retrievals ON article_retrievals FOR SELECT USING (
  EXISTS (SELECT 1 FROM retrieval_runs r WHERE r.id = run_id AND r.user_id = request_user_id())
);
CREATE POLICY collect_retrievals ON article_retrievals TO PUBLIC
  USING (current_user = 'news_collector') WITH CHECK (current_user = 'news_collector');

-- Collector service can meter only its Brave collection attempts. It cannot
-- access existing private conversations/preferences or unrelated usage records.
CREATE POLICY collect_usage ON ai_usage TO PUBLIC
  USING (current_user = 'news_collector' AND provider = 'brave' AND job_type = 'news_collection')
  WITH CHECK (current_user = 'news_collector' AND provider = 'brave' AND job_type = 'news_collection');
