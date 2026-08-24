-- These tables contain app-session hashes, OAuth PKCE verifiers, encrypted
-- game seeds, and private game state. They must never be reachable through
-- Supabase's anon/authenticated Data API roles. The application server uses a
-- direct database role; table owners bypass RLS by default.
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.oauth_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.seasons ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ranked_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ranked_games ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ranked_moves ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_schema_migrations ENABLE ROW LEVEL SECURITY;

DO $hardening$
DECLARE
  role_name TEXT;
  table_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      FOREACH table_name IN ARRAY ARRAY[
        'profiles', 'app_sessions', 'oauth_transactions', 'seasons',
        'ranked_profiles', 'ranked_games', 'ranked_moves', 'app_schema_migrations'
      ] LOOP
        EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM %I', table_name, role_name);
      END LOOP;
      EXECUTE format('REVOKE ALL PRIVILEGES ON SEQUENCE public.ranked_moves_id_seq FROM %I', role_name);
    END IF;
  END LOOP;
END
$hardening$;
