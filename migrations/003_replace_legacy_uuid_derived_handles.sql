-- Earlier releases used a prefix of the private auth UUID for untouched
-- default handles. Replace only those never-customized handles with a stable
-- value derived from the separate public profile id. Handle collisions are
-- resolved before each update so an existing custom name cannot abort the
-- migration or be overwritten.
LOCK TABLE public.profiles IN SHARE ROW EXCLUSIVE MODE;

DO $replace_legacy_handles$
DECLARE
  profile_row RECORD;
  candidate TEXT;
  attempt INTEGER;
BEGIN
  FOR profile_row IN
    SELECT user_id, public_id
    FROM public.profiles
    WHERE handle_changed_at IS NULL
      AND handle = 'player-' || substring(replace(user_id::text, '-', '') FROM 1 FOR 13)
  LOOP
    attempt := 0;
    candidate := 'player-' || substring(md5(profile_row.public_id::text) FROM 1 FOR 13);
    WHILE EXISTS (
      SELECT 1 FROM public.profiles
      WHERE normalized_handle = candidate AND user_id <> profile_row.user_id
    ) LOOP
      attempt := attempt + 1;
      IF attempt > 100 THEN
        RAISE EXCEPTION 'could not allocate a replacement public handle';
      END IF;
      candidate := 'player-' || substring(md5(profile_row.public_id::text || ':' || attempt::text) FROM 1 FOR 13);
    END LOOP;
    UPDATE public.profiles
    SET handle = candidate, normalized_handle = candidate, updated_at = now()
    WHERE user_id = profile_row.user_id;
  END LOOP;
END
$replace_legacy_handles$;
