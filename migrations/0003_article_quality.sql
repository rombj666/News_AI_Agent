ALTER TABLE articles ADD COLUMN last_seen_at timestamptz;
UPDATE articles SET last_seen_at = fetched_at;
ALTER TABLE articles ALTER COLUMN last_seen_at SET NOT NULL;
-- Existing writers remain valid during rollout; updated collector supplies a timestamp.
ALTER TABLE articles ALTER COLUMN last_seen_at SET DEFAULT now();

CREATE TABLE quality_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evaluated_at timestamptz NOT NULL,
  algorithm_version text NOT NULL,
  config jsonb NOT NULL,
  statistics jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE story_clusters (
  id uuid PRIMARY KEY,
  representative_article_id uuid NOT NULL REFERENCES articles(id),
  cluster_title text NOT NULL,
  normalized_topic_label text NOT NULL,
  first_seen_at timestamptz NOT NULL,
  latest_seen_at timestamptz NOT NULL,
  source_count integer NOT NULL CHECK (source_count > 0),
  article_count integer NOT NULL CHECK (article_count > 0),
  active boolean NOT NULL DEFAULT true,
  quality_run_id uuid NOT NULL REFERENCES quality_runs(id),
  CHECK (latest_seen_at >= first_seen_at)
);
CREATE INDEX story_clusters_seen ON story_clusters(latest_seen_at DESC);

CREATE TABLE article_cluster_members (
  cluster_id uuid NOT NULL REFERENCES story_clusters(id),
  article_id uuid NOT NULL REFERENCES articles(id),
  match_kind text NOT NULL CHECK (match_kind IN ('seed','canonical_url','normalized_title','near_title')),
  similarity double precision NOT NULL CHECK (similarity BETWEEN 0 AND 1),
  PRIMARY KEY (cluster_id, article_id),
  UNIQUE (article_id)
);

-- Public content only. Runtime users get SELECT through role provisioning;
-- only the dedicated internal quality role may write derived cluster state.
