-- Participation in the public leaderboard is a profile-level choice.  A
-- player can hide immediately without altering their stored games or rating.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS leaderboard_visible BOOLEAN NOT NULL DEFAULT true;

-- The original eligibility threshold was 50 games.  Keep the ranking formula
-- unchanged, but index the new 10-game publication threshold.
DROP INDEX IF EXISTS public.ranked_profiles_leaderboard_idx;
CREATE INDEX IF NOT EXISTS ranked_profiles_leaderboard_idx
  ON public.ranked_profiles(season_id, decision_ev DESC, rating DESC, rated_games DESC)
  WHERE rated_games >= 10;
