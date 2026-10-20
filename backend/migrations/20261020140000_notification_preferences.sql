-- Persistent notification channel preferences (#1949).
-- One row per (user, template, channel). enabled = false is an opt-out; enabled = true is an
-- explicit opt-in. A missing row means the default (every channel enabled), so existing users
-- keep receiving everything until they change a preference.
CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id    TEXT        NOT NULL,
  template   TEXT        NOT NULL,
  channel    TEXT        NOT NULL,
  enabled    BOOLEAN     NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT notification_preferences_user_template_channel_key UNIQUE (user_id, template, channel)
);

CREATE INDEX IF NOT EXISTS notification_preferences_user_id_idx ON notification_preferences(user_id);
