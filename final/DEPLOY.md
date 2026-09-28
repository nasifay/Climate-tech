# Climate Game multiplayer release

## Current live site

The current public release at https://climate-game-frontendvercelapp.vercel.app/ is still the earlier play-and-learn preview. **It does not yet use the multiplayer code in this workspace.** Do not advertise public rankings until the database configuration and release checks below are complete.

This workspace now contains the multiplayer implementation: players sign up with email/password, verified sessions follow them across browsers/devices, level results are checked against one-use server-created runs, PostgreSQL stores the roster and score history, and the leaderboard returns public names and scores only. Server-side score bounds/rate limits discourage casual tampering; they do not make a browser game cheat-proof for prizes or high-stakes competition.

## Required configuration (not present yet)

The account did not have an active database connection available to this workspace, and the linked Vercel project currently has no database or admin environment variables. The new multiplayer build must not be promoted until an active Supabase project is provided/configured.

1. In an **active Supabase project**, run all of `schema.sql` in **SQL Editor**. Verify the functions `start_game_run`, `finish_game_run`, `player_period_scores`, `public_leaderboard`, and `admin_player_list` are created successfully.
2. In Supabase **Authentication → URL Configuration**, set the site URL to `https://climate-game-frontendvercelapp.vercel.app` and allow that exact URL in Redirect URLs. Configure email delivery/SMTP so account-confirmation emails reach players. Keep email confirmation enabled for public signup.
3. In Vercel Project Settings → Environment Variables, add these for **Production** (and Preview if preview deployments should share test data):
   - `SUPABASE_URL` — project URL.
   - `SUPABASE_ANON_KEY` — public/anon key. It is returned to the browser by `/api/public-config`; it is safe to be public.
   - `SUPABASE_SERVICE_ROLE_KEY` — service-role secret. Server only; never put this in HTML, JavaScript, or a `NEXT_PUBLIC_` variable.
   - `ADMIN_API_KEY` — a newly generated, long random secret used by the admin portal. Every holder can administer the whole game; treat it like an owner password.
4. Keep real credentials out of chat and source control. A variable-name-only template is in [.env.example](.env.example).
5. Redeploy only after all four variables are saved. Vercel environment-variable changes require a new deployment.

## Pre-production checks

From this folder, run `npm test`, then `vercel build`. Deploy a Preview first with `vercel deploy`, and test:

- Visit `/`, create a test account, confirm the email, play and complete a level.
- Sign in from a second browser/device with that account. The same display name and confirmed score should load.
- Create a second account on a separate browser/device. Complete levels and verify both players appear in Daily, Weekly, and All-Time rankings.
- Inspect public leaderboard output: it must contain display names/scores only, never emails, contact info, or auth tokens.
- Attempt score submission without a session, with an altered player ID, reused run ID, excessive score delta, and a replayed result. Each must be rejected.
- Verify the admin portal at `/admin` accepts the configured `ADMIN_API_KEY`, shows actual database players rather than samples, and that ban/reset changes persist after refresh.
- Verify scores and settings remain after a fresh deployment/cold start.

If any check fails, do not promote that build. Once Preview passes, publish with `vercel deploy --prod`, then verify the stable URL and configure any Telegram bot separately if desired. Email/password accounts work in ordinary web browsers; Telegram is optional.

## Data and scoring notes

- Players must confirm email before a Supabase Auth session is issued; set Supabase redirects to the production site.
- Score events are written server-side only after an authenticated player finishes a server-created run. Replays and out-of-range scores are rejected. For prizes/valuable competition, add server-simulated gameplay or independent anti-cheat review before announcing awards.
- Period scores use server timestamps over rolling 24-hour and 7-day windows. All-time score is held on the player record.
- Public accounts use a display name. Private email is not returned in leaderboard or public player API responses.
- Admin access uses one shared server key in this release. Do not give the key to moderators/players; named dashboard roles are UI organization, not separate server-enforced permissions.
