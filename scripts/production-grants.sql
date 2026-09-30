      DO $$ BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'news_runtime') THEN
          CREATE ROLE news_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS;
        END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'news_collector') THEN
          CREATE ROLE news_collector NOLOGIN NOSUPERUSER NOBYPASSRLS;
        END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'news_quality') THEN
          CREATE ROLE news_quality NOLOGIN NOSUPERUSER NOBYPASSRLS;
        END IF;
      END $$;
      GRANT USAGE ON SCHEMA public TO news_runtime;
      GRANT SELECT ON users TO news_runtime;
      GRANT SELECT, INSERT, UPDATE, DELETE ON user_preferences, pending_preference_changes,
        conversations, messages, ai_usage, job_runs TO news_runtime;
      GRANT SELECT ON articles, article_urls, sources, retrieval_runs, article_retrievals TO news_runtime;
      GRANT USAGE ON SCHEMA public TO news_collector;
      GRANT SELECT, INSERT, UPDATE ON sources, articles, article_urls, retrieval_runs, article_retrievals TO news_collector;
      GRANT SELECT, INSERT, UPDATE ON ai_usage TO news_collector;
      GRANT USAGE ON SCHEMA public TO news_quality;
      GRANT SELECT ON articles, article_urls TO news_quality;
      GRANT SELECT, INSERT ON quality_runs TO news_quality;
      GRANT SELECT, INSERT, UPDATE, DELETE ON story_clusters, article_cluster_members TO news_quality;
      GRANT SELECT ON story_clusters, article_cluster_members TO news_runtime;
      GRANT SELECT, INSERT, UPDATE ON digests, digest_items TO news_runtime;
      GRANT SELECT, INSERT, UPDATE ON telegram_sessions, telegram_updates, telegram_deliveries, user_feedback TO news_runtime;
      GRANT SELECT ON delivery_settings TO news_runtime;
      GRANT SELECT, INSERT, UPDATE ON scheduled_pipeline_runs TO news_runtime;
      GRANT SELECT, INSERT, UPDATE ON scheduled_collection_batches TO news_collector;
      GRANT SELECT, INSERT, UPDATE ON telegram_webhook_inbox TO news_runtime;
      GRANT SELECT, INSERT, UPDATE ON news_now_runs TO news_runtime;
