CREATE TABLE telegram_sessions (
  user_id uuid NOT NULL REFERENCES users(id),
  bot_id text NOT NULL CHECK (bot_id ~ '^[1-9][0-9]{0,15}$'),
  chat_id text NOT NULL CHECK (chat_id ~ '^[1-9][0-9]{0,15}$'),
  conversation_id uuid NOT NULL,
  current_digest_id uuid,
  PRIMARY KEY (user_id,bot_id,chat_id),
  UNIQUE (bot_id,chat_id),
  FOREIGN KEY (user_id,conversation_id) REFERENCES conversations(user_id,id),
  FOREIGN KEY (user_id,current_digest_id) REFERENCES digests(user_id,id)
);

CREATE TABLE telegram_updates (
  bot_id text NOT NULL,
  update_id bigint NOT NULL CHECK (update_id >= 0),
  user_id uuid NOT NULL,
  chat_id text NOT NULL,
  operation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  callback_id text,
  telegram_message_id bigint,
  reply_to_message_id bigint,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bot_id,update_id),
  UNIQUE (user_id,bot_id,update_id),
  UNIQUE (bot_id,callback_id),
  UNIQUE (operation_id),
  FOREIGN KEY (user_id,bot_id,chat_id) REFERENCES telegram_sessions(user_id,bot_id,chat_id)
);

CREATE TABLE telegram_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  bot_id text NOT NULL,
  update_id bigint NOT NULL,
  part integer NOT NULL CHECK (part >= 0),
  message_record_id uuid NOT NULL,
  telegram_message_id bigint,
  digest_id uuid,
  story_position integer,
  status text NOT NULL CHECK (status IN ('sending','sent','uncertain','failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bot_id,update_id,part),
  FOREIGN KEY (user_id,bot_id,update_id) REFERENCES telegram_updates(user_id,bot_id,update_id),
  FOREIGN KEY (user_id,message_record_id) REFERENCES messages(user_id,id),
  FOREIGN KEY (user_id,digest_id) REFERENCES digests(user_id,id)
);

CREATE TABLE user_feedback (
  user_id uuid NOT NULL,
  digest_id uuid NOT NULL,
  story_position integer NOT NULL,
  direction text NOT NULL CHECK (direction IN ('more','less')),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (user_id,digest_id,story_position),
  FOREIGN KEY (user_id,digest_id,story_position) REFERENCES digest_items(user_id,digest_id,position)
);

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['telegram_sessions','telegram_updates','telegram_deliveries','user_feedback'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY own_rows ON %I USING (user_id=request_user_id()) WITH CHECK (user_id=request_user_id())',table_name);
  END LOOP;
END $$;
