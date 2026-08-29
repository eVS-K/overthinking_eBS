-- Private PvP presets are account-owned convenience data.  They are never
-- part of a live room's authority: the Socket server still re-validates every
-- setting when a preset is applied.

ALTER TABLE public.oauth_transactions
  ADD COLUMN IF NOT EXISTS return_path VARCHAR(16) NOT NULL DEFAULT '/ranked'
    CHECK (return_path IN ('/', '/ranked'));

CREATE TABLE IF NOT EXISTS public.private_pvp_presets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(user_id) ON DELETE CASCADE,
  preset_slot SMALLINT NOT NULL CHECK (preset_slot BETWEEN 1 AND 10),
  name VARCHAR(32) NOT NULL
    CHECK (char_length(btrim(name)) BETWEEN 1 AND 32)
    CHECK (name !~ '[[:cntrl:]]'),
  normalized_name VARCHAR(32) NOT NULL,
  config JSONB NOT NULL CHECK (jsonb_typeof(config) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, preset_slot),
  UNIQUE (user_id, normalized_name)
);

CREATE INDEX IF NOT EXISTS private_pvp_presets_user_updated_idx
  ON public.private_pvp_presets(user_id, updated_at DESC, id ASC);

-- The direct application database role owns this table.  Supabase browser
-- roles must not be able to enumerate, edit, or infer another user's saved
-- room preferences.
ALTER TABLE public.private_pvp_presets ENABLE ROW LEVEL SECURITY;

DO $hardening$
DECLARE
  role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.private_pvp_presets FROM %I', role_name);
    END IF;
  END LOOP;
END
$hardening$;
