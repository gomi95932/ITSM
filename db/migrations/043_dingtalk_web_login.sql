CREATE TABLE dingtalk_web_login_attempts (
  state_hash text PRIMARY KEY CHECK(state_hash ~ '^[a-f0-9]{64}$'),
  browser_hash text NOT NULL CHECK(browser_hash ~ '^[a-f0-9]{64}$'),
  configuration_hash text NOT NULL CHECK(configuration_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL DEFAULT now()+interval '5 minutes'
);
CREATE INDEX dingtalk_web_login_attempts_expiry ON dingtalk_web_login_attempts(expires_at);
