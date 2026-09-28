-- ============================================================
-- Climate Game — Supabase schema
-- Run this once in Supabase SQL Editor (Project > SQL Editor > New query)
-- ============================================================

-- 1) Legacy key/value store for server-managed settings and migration.
--    Do not expose this whole-store shape to anonymous browser clients.
create table if not exists kv_store (
  key         text primary key,
  value       jsonb not null,
  updated_by  text,
  updated_at  timestamptz not null default now()
);

alter table kv_store enable row level security;

-- The legacy browser KV mirror contains contact/profile data and cannot be
-- safely exposed row-by-row. Only trusted server-side code may access it.
drop policy if exists "kv_read_all" on kv_store;
drop policy if exists "kv_write_all" on kv_store;
drop policy if exists "kv_update_all" on kv_store;
drop policy if exists "kv_service_role_only" on kv_store;
create policy "kv_service_role_only" on kv_store
  for all to service_role using (true) with check (true);
revoke all on table kv_store from anon, authenticated;
grant all on table kv_store to service_role;

-- Realtime: let clients subscribe to changes on kv_store
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'kv_store'
  ) then
    alter publication supabase_realtime add table kv_store;
  end if;
end $$;

-- 2) Individual player rows keyed by a verified Supabase Auth UUID. They are
--    private; the server API exposes only opted-in display names and scores.
create table if not exists players (
  id              text primary key,               -- Supabase Auth UUID as text
  telegram_id     bigint,
  telegram_username text,
  display_name    text not null default 'Player',
  avatar          jsonb,
  score           integer not null default 0,
  level           integer not null default 1,
  referral_code   text unique,
  referred_by     text references players(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

alter table players enable row level security;

-- Browser clients cannot directly read or modify player/score rows. The API
-- verifies Supabase Auth tokens and performs bounded writes with service role.
drop policy if exists "players_read_all" on players;
drop policy if exists "players_write_own" on players;
drop policy if exists "players_update_own" on players;
drop policy if exists "players_service_role_only" on players;
create policy "players_service_role_only" on players
  for all to service_role using (true) with check (true);
revoke all on table players from anon, authenticated;
grant all on table players to service_role;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'players'
  ) then
    alter publication supabase_realtime add table players;
  end if;
end $$;

-- Multiplayer web accounts use Supabase Auth UUIDs as player IDs. The service
    -- API verifies each Auth token before creating or changing these rows.
    alter table players add column if not exists best_level integer not null default 0;
    alter table players add column if not exists games_played integer not null default 0;
    alter table players add column if not exists status text not null default 'active';
    alter table players add column if not exists leaderboard_opt_in boolean not null default false;
    alter table players alter column best_level set default 0;
    update players set best_level = 0 where games_played = 0 and score = 0 and best_level = 1;

    -- Email is account metadata, not public leaderboard data. Keep it inaccessible
    -- to browser roles even though the leaderboard exposes display_name and score.
    revoke all on table players from anon, authenticated;
    grant all on table players to service_role;

    -- Each level attempt is started and finished through authenticated API calls.
    -- Unique run IDs prevent replaying a previously submitted score.
    create table if not exists game_runs (
      id uuid primary key default gen_random_uuid(),
      player_id text not null references players(id) on delete cascade,
      level integer not null check (level between 1 and 100),
      target integer not null check (target between 1 and 100000),
      started_at timestamptz not null default now(),
      finished_at timestamptz,
      delta integer,
      result text check (result in ('completed', 'failed'))
    );
    alter table game_runs enable row level security;
    drop policy if exists "game_runs_service_role_only" on game_runs;
    create policy "game_runs_service_role_only" on game_runs
      for all to service_role using (true) with check (true);
    revoke all on table game_runs from anon, authenticated;
    grant all on table game_runs to service_role;
    create index if not exists idx_game_runs_player_started on game_runs(player_id, started_at desc);

    create table if not exists score_events (
      id bigint generated always as identity primary key,
      player_id text references players(id) on delete cascade,
      delta integer not null,
      reason text,
      created_at timestamptz not null default now()
    );
    alter table score_events enable row level security;
    drop policy if exists "score_events_read_all" on score_events;
    drop policy if exists "score_events_insert_own" on score_events;
    drop policy if exists "score_events_service_role_only" on score_events;
    create policy "score_events_service_role_only" on score_events
      for all to service_role using (true) with check (true);
    revoke all on table score_events from anon, authenticated;
    grant all on table score_events to service_role;
    create index if not exists idx_score_events_player_created on score_events(player_id, created_at desc);

    -- Server-only run creation. Enforces level progression, derives the score
    -- target on the server, and rate-limits run creation per verified account.
    create or replace function start_game_run(p_player_id text, p_level integer)
    returns uuid
    language plpgsql
    security definer
    set search_path = public
    as $$
    declare
      v_player players%rowtype;
      v_target integer;
      v_target_base integer;
      v_target_step integer;
      v_run_id uuid;
      v_recent_starts integer;
    begin
      delete from game_runs where started_at < now() - interval '30 days';
      select * into v_player from players where id = p_player_id and status = 'active' for update;
      if not found then raise exception 'Player account is unavailable'; end if;
      if p_level < 1 or p_level > least(100, greatest(1, v_player.best_level + 1)) then
        raise exception 'Complete the previous level first';
      end if;
      select count(*) into v_recent_starts from game_runs
        where player_id = p_player_id and started_at > now() - interval '1 hour';
      if v_recent_starts >= 20 then raise exception 'Game start limit reached; try again later'; end if;
      select coalesce((select (value->'difficulty'->>'targetBase')::integer from kv_store where key = 'climateGameConfig_v1'), 100)
        into v_target_base;
      select coalesce((select (value->'difficulty'->>'targetStep')::integer from kv_store where key = 'climateGameConfig_v1'), 50)
        into v_target_step;
      v_target_base := greatest(1, least(100000, v_target_base));
      v_target_step := greatest(0, least(100000, v_target_step));
      v_target := least(100000, v_target_base + (p_level - 1) * v_target_step);
      insert into game_runs(player_id, level, target)
        values (p_player_id, p_level, v_target) returning id into v_run_id;
      return v_run_id;
    end;
    $$;
    revoke all on function start_game_run(text, integer) from public, anon, authenticated;
    grant execute on function start_game_run(text, integer) to service_role;

    -- One-time scoring: only a live run owned by the authenticated API player can
    -- be submitted. A result is bounded by server-derived level targets and server
    -- elapsed time; retry/replay submissions are rejected atomically.
    create or replace function finish_game_run(
      p_run_id uuid,
      p_player_id text,
      p_delta integer,
      p_level integer,
      p_elapsed_seconds integer,
      p_result text
    )
    returns jsonb
    language plpgsql
    security definer
    set search_path = public
    as $$
    declare
      v_run game_runs%rowtype;
      v_player players%rowtype;
      v_actual_seconds integer;
      v_stats record;
    begin
      select * into v_run from game_runs
        where id = p_run_id and player_id = p_player_id for update;
      if not found or v_run.finished_at is not null then raise exception 'Game run is invalid or already submitted'; end if;
      select * into v_player from players where id = p_player_id and status = 'active' for update;
      if not found then raise exception 'Player account is unavailable'; end if;

      v_actual_seconds := floor(extract(epoch from (now() - v_run.started_at)))::integer;
      if v_actual_seconds < 3 or v_actual_seconds > 3600 then raise exception 'Game run duration is invalid'; end if;
      if p_elapsed_seconds < 0 or p_elapsed_seconds > 3600 then raise exception 'Reported game duration is invalid'; end if;
      if p_level <> v_run.level or p_delta < -v_run.target or p_delta > v_run.target + 75 then
        raise exception 'Score is outside the allowed range for this level';
      end if;
      if p_result not in ('completed', 'failed') then raise exception 'Game result is invalid'; end if;

      update game_runs set finished_at = now(), delta = p_delta, result = p_result where id = p_run_id;
      delete from score_events where created_at < now() - interval '8 days';
      if p_delta <> 0 then
        insert into score_events(player_id, delta, reason) values (p_player_id, p_delta, 'level_' || p_result);
      end if;
      update players set
        score = greatest(0, score + p_delta),
        level = case when p_result = 'completed' then least(100, p_level + 1) else p_level end,
        best_level = case when p_result = 'completed' then greatest(best_level, p_level) else best_level end,
        games_played = games_played + 1,
        updated_at = now()
        where id = p_player_id;
      select * into v_stats from player_period_scores(p_player_id);
      return jsonb_build_object(
        'score', greatest(0, v_player.score + p_delta),
        'dailyScore', coalesce(v_stats.daily_score, 0),
        'weeklyScore', coalesce(v_stats.weekly_score, 0),
        'level', case when p_result = 'completed' then least(100, p_level + 1) else p_level end,
        'bestLevel', case when p_result = 'completed' then greatest(v_player.best_level, p_level) else v_player.best_level end,
        'gamesPlayed', v_player.games_played + 1
      );
    end;
    $$;
    revoke all on function finish_game_run(uuid, text, integer, integer, integer, text) from public, anon, authenticated;
    grant execute on function finish_game_run(uuid, text, integer, integer, integer, text) to service_role;

    create or replace function player_period_scores(p_player_id text)
    returns table(daily_score bigint, weekly_score bigint)
    language sql
    security definer
    set search_path = public
    as $$
      select
        coalesce(sum(delta) filter (where created_at >= now() - interval '1 day'), 0)::bigint,
        coalesce(sum(delta) filter (where created_at >= now() - interval '7 days'), 0)::bigint
      from score_events where player_id = p_player_id;
    $$;
    revoke all on function player_period_scores(text) from public, anon, authenticated;
    grant execute on function player_period_scores(text) to service_role;

    -- Deliberately returns only pseudonymous public names and scores.
    create or replace function public_leaderboard(p_period text, p_limit integer default 50)
    returns table(player_id text, display_name text, period_score bigint, daily_score bigint, weekly_score bigint, level integer)
    language sql
    security definer
    set search_path = public
    as $$
      select p.id, p.display_name,
        case
          when p_period = 'alltime' then p.score::bigint
          when p_period = 'weekly' then coalesce(sum(e.delta) filter (where e.created_at >= now() - interval '7 days'), 0)::bigint
          else coalesce(sum(e.delta) filter (where e.created_at >= now() - interval '1 day'), 0)::bigint
        end as period_score,
        coalesce(sum(e.delta) filter (where e.created_at >= now() - interval '1 day'), 0)::bigint as daily_score,
        coalesce(sum(e.delta) filter (where e.created_at >= now() - interval '7 days'), 0)::bigint as weekly_score,
        p.level
      from players p left join score_events e on e.player_id = p.id
      where p.status = 'active' and p.leaderboard_opt_in = true and p.display_name is not null
      group by p.id, p.display_name, p.score, p.level
      order by period_score desc, p.updated_at asc
      limit greatest(1, least(p_limit, 100));
    $$;
    revoke all on function public_leaderboard(text, integer) from public, anon, authenticated;
    grant execute on function public_leaderboard(text, integer) to service_role;

    create or replace function admin_player_list()
    returns table(
      player_id text,
      display_name text,
      score integer,
      daily_score bigint,
      weekly_score bigint,
      level integer,
      best_level integer,
      games_played integer,
      status text,
      created_at timestamptz,
      updated_at timestamptz
    )
    language sql
    security definer
    set search_path = public
    as $$
      select p.id, p.display_name, p.score,
        coalesce(sum(e.delta) filter (where e.created_at >= now() - interval '1 day'), 0)::bigint,
        coalesce(sum(e.delta) filter (where e.created_at >= now() - interval '7 days'), 0)::bigint,
        p.level, p.best_level, p.games_played, p.status, p.created_at, p.updated_at
      from players p left join score_events e on e.player_id = p.id
      group by p.id, p.display_name, p.score, p.level, p.best_level, p.games_played, p.status, p.created_at, p.updated_at
      order by p.score desc, p.updated_at desc
      limit 500;
    $$;
    revoke all on function admin_player_list() from public, anon, authenticated;
grant execute on function admin_player_list() to service_role;

-- 3) Score history (for period leaderboards: daily/weekly/monthly)
create table if not exists score_events (
  id          bigint generated always as identity primary key,
  player_id   text references players(id) on delete cascade,
  delta       integer not null,
  reason      text,
  created_at  timestamptz not null default now()
);

alter table score_events enable row level security;
drop policy if exists "score_events_read_all" on score_events;
drop policy if exists "score_events_insert_own" on score_events;
drop policy if exists "score_events_service_role_only" on score_events;
create policy "score_events_service_role_only" on score_events
  for all to service_role using (true) with check (true);
revoke all on table score_events from anon, authenticated;
grant all on table score_events to service_role;

create index if not exists idx_score_events_player_created on score_events(player_id, created_at desc);

-- Convenience view: leaderboard for a rolling window, e.g. last 24h
create or replace view leaderboard_daily as
  select player_id, sum(delta) as period_score
  from score_events
  where created_at > now() - interval '1 day'
  group by player_id
  order by period_score desc;
revoke all on leaderboard_daily from anon, authenticated;
grant select on leaderboard_daily to service_role;

-- 4) Admin accounts (Supabase Auth handles passwords — this table just
--    maps an authenticated Supabase user to a dashboard role).
create table if not exists admin_users (
  user_id   uuid primary key references auth.users(id) on delete cascade,
  name      text not null,
  role      text not null default 'admin', -- 'superadmin' | 'admin' | 'supervisor' | 'readonly'
  created_at timestamptz not null default now()
);

alter table admin_users enable row level security;
drop policy if exists "admin_users_read_own" on admin_users;
drop policy if exists "admin_users_service_role_only" on admin_users;
create policy "admin_users_service_role_only" on admin_users
  for all to service_role using (true) with check (true);
revoke all on table admin_users from anon, authenticated;
grant all on table admin_users to service_role;

-- 5) Audit log for admin actions
create table if not exists audit_log (
  id          bigint generated always as identity primary key,
  admin_name  text,
  action      text not null,
  details     jsonb,
  created_at  timestamptz not null default now()
);
alter table audit_log enable row level security;
drop policy if exists "audit_log_read_all" on audit_log;
drop policy if exists "audit_log_insert_admin" on audit_log;
drop policy if exists "audit_log_service_role_only" on audit_log;
create policy "audit_log_service_role_only" on audit_log
  for all to service_role using (true) with check (true);
revoke all on table audit_log from anon, authenticated;
grant all on table audit_log to service_role;
