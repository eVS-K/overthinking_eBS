BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS profiles (
  user_id UUID PRIMARY KEY,
  public_id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  handle VARCHAR(20) NOT NULL UNIQUE CHECK (handle ~ '^[A-Za-z0-9_-]{3,20}$'),
  normalized_handle VARCHAR(20) NOT NULL UNIQUE CHECK (normalized_handle = lower(handle)),
  status VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'banned', 'deactivated')),
  handle_changed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(user_id) ON DELETE CASCADE,
  session_token_hash CHAR(64) NOT NULL UNIQUE,
  csrf_token_hash CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  idle_expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  user_agent_hash CHAR(64),
  ip_hash CHAR(64)
);
CREATE INDEX IF NOT EXISTS app_sessions_active_user_idx ON app_sessions(user_id, expires_at) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS oauth_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  state_hash CHAR(64) NOT NULL UNIQUE,
  provider VARCHAR(16) NOT NULL CHECK (provider IN ('google', 'github')),
  code_verifier VARCHAR(128) NOT NULL,
  redirect_uri TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS oauth_transactions_expires_idx ON oauth_transactions(expires_at);

CREATE TABLE IF NOT EXISTS seasons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  rules_version VARCHAR(80) NOT NULL,
  ai_policy_version VARCHAR(80) NOT NULL,
  evaluation_version VARCHAR(80) NOT NULL,
  rating_version VARCHAR(80) NOT NULL,
  value_table_checksum CHAR(64) NOT NULL,
  initial_ev NUMERIC(30,20) NOT NULL,
  initial_ev_numerator BIGINT NOT NULL,
  initial_ev_denominator BIGINT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS seasons_one_active_idx ON seasons(status) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS ranked_profiles (
  user_id UUID NOT NULL REFERENCES profiles(user_id) ON DELETE CASCADE,
  season_id UUID NOT NULL REFERENCES seasons(id) ON DELETE RESTRICT,
  rated_games INTEGER NOT NULL DEFAULT 0 CHECK (rated_games >= 0),
  wins INTEGER NOT NULL DEFAULT 0 CHECK (wins >= 0),
  draws INTEGER NOT NULL DEFAULT 0 CHECK (draws >= 0),
  losses INTEGER NOT NULL DEFAULT 0 CHECK (losses >= 0),
  forfeits INTEGER NOT NULL DEFAULT 0 CHECK (forfeits >= 0),
  ew_weight DOUBLE PRECISION NOT NULL DEFAULT 0,
  ew_weight_sq DOUBLE PRECISION NOT NULL DEFAULT 0,
  ew_sum DOUBLE PRECISION NOT NULL DEFAULT 0,
  ew_sum_sq DOUBLE PRECISION NOT NULL DEFAULT 0,
  decision_ev DOUBLE PRECISION,
  rating DOUBLE PRECISION,
  last_ranked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, season_id)
);
CREATE INDEX IF NOT EXISTS ranked_profiles_leaderboard_idx
  ON ranked_profiles(season_id, decision_ev DESC, rating DESC, rated_games DESC)
  WHERE rated_games >= 50;

CREATE TABLE IF NOT EXISTS ranked_games (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(user_id) ON DELETE RESTRICT,
  season_id UUID NOT NULL REFERENCES seasons(id) ON DELETE RESTRICT,
  status VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'forfeited')),
  rules_version VARCHAR(80) NOT NULL,
  ai_policy_version VARCHAR(80) NOT NULL,
  evaluation_version VARCHAR(80) NOT NULL,
  rating_version VARCHAR(80) NOT NULL,
  value_table_checksum CHAR(64) NOT NULL,
  player_hand_mask SMALLINT NOT NULL CHECK (player_hand_mask BETWEEN 0 AND 127),
  ai_hand_mask SMALLINT NOT NULL CHECK (ai_hand_mask BETWEEN 0 AND 127),
  player_score SMALLINT NOT NULL CHECK (player_score >= 0),
  ai_score SMALLINT NOT NULL CHECK (ai_score >= 0),
  stack_count SMALLINT NOT NULL CHECK (stack_count >= 0 AND stack_count % 2 = 0),
  current_round SMALLINT NOT NULL CHECK (current_round BETWEEN 1 AND 7),
  turn_started_at TIMESTAMPTZ NOT NULL,
  deadline TIMESTAMPTZ NOT NULL,
  encrypted_seed BYTEA NOT NULL,
  seed_iv BYTEA NOT NULL,
  seed_auth_tag BYTEA NOT NULL,
  seed_commitment CHAR(64) NOT NULL,
  total_regret BIGINT NOT NULL DEFAULT 0 CHECK (total_regret >= 0),
  decision_performance BIGINT,
  actual_result VARCHAR(8) CHECK (actual_result IN ('win', 'draw', 'loss', 'forfeit')),
  match_score DOUBLE PRECISION CHECK (match_score IN (0, 0.5, 1)),
  luck DOUBLE PRECISION,
  rating_before DOUBLE PRECISION,
  rating_after DOUBLE PRECISION,
  rating_finalized_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ranked_games_one_active_per_user_idx
  ON ranked_games(user_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS ranked_games_active_deadline_idx
  ON ranked_games(status, deadline) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS ranked_games_user_created_idx ON ranked_games(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ranked_moves (
  id BIGSERIAL PRIMARY KEY,
  game_id UUID NOT NULL REFERENCES ranked_games(id) ON DELETE CASCADE,
  round SMALLINT NOT NULL CHECK (round BETWEEN 1 AND 7),
  request_id UUID,
  state_key VARCHAR(100) NOT NULL,
  player_card_id VARCHAR(16) NOT NULL,
  ai_card_id VARCHAR(16) NOT NULL,
  optimal_v BIGINT NOT NULL CHECK (optimal_v >= 0),
  chosen_q BIGINT NOT NULL CHECK (chosen_q >= 0 AND chosen_q <= optimal_v),
  regret BIGINT NOT NULL CHECK (regret >= 0 AND regret = optimal_v - chosen_q),
  timeout BOOLEAN NOT NULL DEFAULT false,
  thinking_time_ms INTEGER NOT NULL DEFAULT 0 CHECK (thinking_time_ms >= 0),
  response_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (game_id, round)
);
CREATE UNIQUE INDEX IF NOT EXISTS ranked_moves_game_request_idx
  ON ranked_moves(game_id, request_id) WHERE request_id IS NOT NULL;

COMMIT;
