-- Durable receipt before webhook acknowledgement. A claimed update is never
-- automatically retried after possible billing or an uncertain Telegram send.
CREATE TABLE telegram_webhook_inbox (
  bot_id text NOT NULL,
  update_id bigint NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id),
  payload jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','completed','failed')),
  received_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  PRIMARY KEY(bot_id,update_id),
  CHECK(payload IS NULL OR jsonb_typeof(payload)='object')
);
CREATE INDEX webhook_pending ON telegram_webhook_inbox(user_id,bot_id,received_at) WHERE status='pending';
ALTER TABLE telegram_webhook_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE telegram_webhook_inbox FORCE ROW LEVEL SECURITY;
CREATE POLICY own_rows ON telegram_webhook_inbox USING(user_id=request_user_id()) WITH CHECK(user_id=request_user_id());
