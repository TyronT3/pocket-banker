-- Pocket Banker schema (re-runnable)
-- All money movement happens through SECURITY DEFINER functions so balances
-- can't be edited directly from the browser. Clients may only SELECT rows for
-- games they are a player in.
--
-- Approval mode (games.require_approval): any move that takes money out of
-- the bank, the pot, or someone else's balance becomes a pending request that
-- someone else must approve. Paying out of your own balance is always instant.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- tables

create table if not exists public.games (
  id               uuid primary key default gen_random_uuid(),
  code             text not null unique,
  name             text not null default 'Game night',
  currency         text not null default '$',
  starting_balance bigint not null check (starting_balance >= 0),
  go_amount        bigint not null default 200 check (go_amount >= 0),
  free_parking     boolean not null default false,
  pot              bigint not null default 0 check (pot >= 0),
  allow_negative   boolean not null default false,
  require_approval boolean not null default false,
  rules_notes      text not null default '',
  host_id          uuid not null references auth.users(id),
  created_at       timestamptz not null default now()
);
alter table public.games add column if not exists require_approval boolean not null default false;

create table if not exists public.players (
  id         uuid primary key default gen_random_uuid(),
  game_id    uuid not null references public.games(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  name       text not null,
  color      text not null,
  balance    bigint not null default 0,
  created_at timestamptz not null default now(),
  unique (game_id, user_id)
);
create unique index if not exists players_game_name_uq on public.players (game_id, lower(name));
create index if not exists players_user_idx on public.players (user_id);

create table if not exists public.transactions (
  id          bigint generated always as identity primary key,
  game_id     uuid not null references public.games(id) on delete cascade,
  from_type   text not null check (from_type in ('bank','pot','player')),
  from_player uuid references public.players(id) on delete cascade,
  to_type     text not null check (to_type in ('bank','pot','player')),
  to_player   uuid references public.players(id) on delete cascade,
  amount      bigint not null check (amount > 0),
  note        text,
  kind        text not null default 'normal' check (kind in ('normal','start','reversal')),
  created_by  uuid references public.players(id) on delete set null,
  approved_by uuid references public.players(id) on delete set null,
  reverses    bigint references public.transactions(id) on delete set null,
  reversed_by bigint references public.transactions(id) on delete set null,
  created_at  timestamptz not null default now()
);
alter table public.transactions add column if not exists approved_by uuid references public.players(id) on delete set null;
create index if not exists transactions_game_idx on public.transactions (game_id, id desc);

-- A pending money move waiting for someone else's OK.
create table if not exists public.payment_requests (
  id          bigint generated always as identity primary key,
  game_id     uuid not null references public.games(id) on delete cascade,
  requester   uuid not null references public.players(id) on delete cascade,
  from_type   text not null check (from_type in ('bank','pot','player')),
  from_player uuid references public.players(id) on delete cascade,
  to_type     text not null check (to_type in ('bank','pot','player')),
  to_player   uuid references public.players(id) on delete cascade,
  amount      bigint not null check (amount > 0),
  note        text,
  reverses    bigint references public.transactions(id) on delete cascade,
  status      text not null default 'pending' check (status in ('pending','approved','rejected','cancelled')),
  resolved_by uuid references public.players(id) on delete set null,
  created_at  timestamptz not null default now(),
  resolved_at timestamptz
);
create index if not exists payment_requests_game_idx on public.payment_requests (game_id, status);

-- ---------------------------------------------------------------- RLS

alter table public.games            enable row level security;
alter table public.players          enable row level security;
alter table public.transactions     enable row level security;
alter table public.payment_requests enable row level security;

create or replace function public.is_member(p_game uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.players where game_id = p_game and user_id = auth.uid());
$$;

drop policy if exists games_select on public.games;
create policy games_select on public.games for select to authenticated using (public.is_member(id));
drop policy if exists players_select on public.players;
create policy players_select on public.players for select to authenticated using (public.is_member(game_id));
drop policy if exists tx_select on public.transactions;
create policy tx_select on public.transactions for select to authenticated using (public.is_member(game_id));
drop policy if exists req_select on public.payment_requests;
create policy req_select on public.payment_requests for select to authenticated using (public.is_member(game_id));

revoke all on public.games, public.players, public.transactions, public.payment_requests from anon, authenticated;
grant select on public.games, public.players, public.transactions, public.payment_requests to authenticated;

-- ---------------------------------------------------------------- old signatures

drop function if exists public.create_game(text, text, text, bigint, bigint, boolean, boolean, text);
drop function if exists public.update_game(uuid, text, text, bigint, bigint, boolean, boolean, text);
drop function if exists public.transfer(uuid, text, uuid, text, uuid, bigint, text);
drop function if exists public.undo_transaction(bigint);

-- ---------------------------------------------------------------- internals

-- Moves money between parties. Locks the game row first so every money
-- movement in one game is serialized (no races, no deadlocks).
create or replace function public._apply_move(
  p_game uuid, p_from_type text, p_from uuid, p_to_type text, p_to uuid,
  p_amount bigint, p_check boolean
) returns void language plpgsql security definer set search_path = '' as $$
declare
  v_allow boolean; v_pot bigint; v_bal bigint; v_name text;
begin
  select allow_negative, pot into v_allow, v_pot from public.games where id = p_game for update;

  if p_from_type = 'player' then
    select balance, name into v_bal, v_name from public.players where id = p_from and game_id = p_game for update;
    if not found then raise exception 'Player not found'; end if;
    if p_check and not v_allow and v_bal < p_amount then
      raise exception '% doesn''t have enough money (balance is %)', v_name, v_bal;
    end if;
    update public.players set balance = balance - p_amount where id = p_from;
  elsif p_from_type = 'pot' then
    if v_pot < p_amount then raise exception 'There is not enough in the pot'; end if;
    update public.games set pot = pot - p_amount where id = p_game;
  end if;

  if p_to_type = 'player' then
    update public.players set balance = balance + p_amount where id = p_to and game_id = p_game;
    if not found then raise exception 'Player not found'; end if;
  elsif p_to_type = 'pot' then
    update public.games set pot = pot + p_amount where id = p_game;
  end if;
end $$;

create or replace function public._add_player(p_game uuid, p_name text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_name text := btrim(coalesce(p_name, ''));
  v_colors text[] := array['#e53935','#1e88e5','#43a047','#fb8c00','#8e24aa','#00897b','#f4511e','#3949ab','#c0ca33','#6d4c41'];
  v_count int; v_start bigint; v_id uuid;
begin
  if length(v_name) < 1 or length(v_name) > 20 then raise exception 'Name must be 1 to 20 characters'; end if;
  select count(*) into v_count from public.players where game_id = p_game;
  if v_count >= 10 then raise exception 'This game is full (10 players)'; end if;
  select starting_balance into v_start from public.games where id = p_game;
  begin
    insert into public.players (game_id, user_id, name, color, balance)
    values (p_game, auth.uid(), v_name, v_colors[(v_count % 10) + 1], v_start)
    returning id into v_id;
  exception when unique_violation then
    raise exception 'The name "%" is already taken in this game', v_name;
  end;
  if v_start > 0 then
    insert into public.transactions (game_id, from_type, to_type, to_player, amount, note, kind, created_by)
    values (p_game, 'bank', 'player', v_id, v_start, 'Starting money', 'start', v_id);
  end if;
  return v_id;
end $$;

-- Who may approve a pending request (player ids).
--  * undo:                     anyone except the person asking
--  * money from a player:      that player
--  * money from bank / pot:    the banker, unless the banker asked for it or
--                              receives it; then any other player
create or replace function public._approvers(r public.payment_requests)
returns uuid[] language plpgsql stable security definer set search_path = '' as $$
declare v_banker uuid; v_ids uuid[];
begin
  if r.reverses is not null then
    select coalesce(array_agg(id), '{}') into v_ids from public.players
      where game_id = r.game_id and id <> r.requester;
    return v_ids;
  end if;
  if r.from_type = 'player' then return array[r.from_player]; end if;

  select p.id into v_banker from public.players p
    join public.games g on g.id = p.game_id and g.host_id = p.user_id
    where g.id = r.game_id;
  if v_banker is not null and v_banker <> r.requester and v_banker is distinct from r.to_player then
    return array[v_banker];
  end if;
  select coalesce(array_agg(id), '{}') into v_ids from public.players
    where game_id = r.game_id and id <> r.requester
      and id is distinct from r.to_player and id is distinct from v_banker;
  if cardinality(v_ids) = 0 and r.to_player is not null and r.to_player <> r.requester then
    return array[r.to_player];  -- 2-player game: the only other person
  end if;
  return v_ids;
end $$;

-- True once anything other than starting money has happened.
create or replace function public._play_started(p_game uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.transactions where game_id = p_game and kind <> 'start');
$$;

create or replace function public._create_request(
  p_game uuid, p_requester uuid, p_from_type text, p_from uuid, p_to_type text, p_to uuid,
  p_amount bigint, p_note text, p_reverses bigint
) returns bigint language plpgsql security definer set search_path = '' as $$
declare v_id bigint;
begin
  insert into public.payment_requests (game_id, requester, from_type, from_player, to_type, to_player, amount, note, reverses)
  values (p_game, p_requester, p_from_type, p_from, p_to_type, p_to, p_amount,
          nullif(left(btrim(coalesce(p_note, '')), 80), ''), p_reverses)
  returning id into v_id;
  return v_id;
end $$;

create or replace function public._record(
  p_game uuid, p_from_type text, p_from uuid, p_to_type text, p_to uuid,
  p_amount bigint, p_note text, p_kind text, p_by uuid, p_approved_by uuid, p_reverses bigint
) returns bigint language plpgsql security definer set search_path = '' as $$
declare v_id bigint;
begin
  insert into public.transactions (game_id, from_type, from_player, to_type, to_player, amount, note, kind, created_by, approved_by, reverses)
  values (p_game, p_from_type, p_from, p_to_type, p_to, p_amount,
          nullif(left(btrim(coalesce(p_note, '')), 80), ''), p_kind, p_by, p_approved_by, p_reverses)
  returning id into v_id;
  if p_reverses is not null then
    update public.transactions set reversed_by = v_id where id = p_reverses;
  end if;
  return v_id;
end $$;

-- ---------------------------------------------------------------- RPCs

create or replace function public.create_game(
  p_game_name text, p_player_name text, p_currency text, p_starting bigint, p_go bigint,
  p_free_parking boolean, p_allow_negative boolean, p_require_approval boolean, p_rules text
) returns text language plpgsql security definer set search_path = '' as $$
declare
  v_chars text := 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  v_code text; v_game uuid;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if p_starting is null or p_starting < 0 then raise exception 'Starting money must be 0 or more'; end if;
  if p_go is null or p_go < 0 then raise exception 'GO amount must be 0 or more'; end if;
  loop
    v_code := '';
    for i in 1..4 loop
      v_code := v_code || substr(v_chars, 1 + floor(random() * length(v_chars))::int, 1);
    end loop;
    exit when not exists (select 1 from public.games where code = v_code);
  end loop;
  insert into public.games (code, name, currency, starting_balance, go_amount, free_parking, allow_negative, require_approval, rules_notes, host_id)
  values (v_code, coalesce(nullif(btrim(p_game_name), ''), 'Game night'), left(coalesce(nullif(btrim(p_currency), ''), '$'), 4),
          p_starting, p_go, coalesce(p_free_parking, false), coalesce(p_allow_negative, false),
          coalesce(p_require_approval, true), left(coalesce(p_rules, ''), 4000), auth.uid())
  returning id into v_game;
  perform public._add_player(v_game, p_player_name);
  return v_code;
end $$;

create or replace function public.join_game(p_code text, p_name text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_game uuid; v_code text := upper(btrim(coalesce(p_code, '')));
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  select id into v_game from public.games where code = v_code;
  if not found then raise exception 'No game with code %', v_code; end if;
  if not exists (select 1 from public.players where game_id = v_game and user_id = auth.uid()) then
    perform public._add_player(v_game, p_name);
  end if;
  return v_code;
end $$;

-- Null arguments leave a setting unchanged.
create or replace function public.update_game(
  p_game uuid, p_name text, p_currency text, p_starting bigint, p_go bigint,
  p_free_parking boolean, p_allow_negative boolean, p_require_approval boolean, p_rules text
) returns void language plpgsql security definer set search_path = '' as $$
declare g public.games;
begin
  select * into g from public.games where id = p_game and host_id = auth.uid();
  if not found then raise exception 'Only the banker can change the rules'; end if;
  if p_starting < 0 or p_go < 0 then raise exception 'Amounts must be 0 or more'; end if;
  -- with approval on, the banker can't loosen money rules once play has started
  if g.require_approval and public._play_started(p_game) then
    if p_require_approval = false then
      raise exception 'Approval can''t be turned off once play has started';
    end if;
    if (p_go is not null and p_go <> g.go_amount) or (p_starting is not null and p_starting <> g.starting_balance) then
      raise exception 'GO and starting money are locked once play has started';
    end if;
  end if;
  update public.games set
    name = coalesce(nullif(btrim(p_name), ''), name),
    currency = left(coalesce(nullif(btrim(p_currency), ''), currency), 4),
    starting_balance = coalesce(p_starting, starting_balance),
    go_amount = coalesce(p_go, go_amount),
    free_parking = coalesce(p_free_parking, free_parking),
    allow_negative = coalesce(p_allow_negative, allow_negative),
    require_approval = coalesce(p_require_approval, require_approval),
    rules_notes = left(coalesce(p_rules, rules_notes), 4000)
  where id = p_game;
end $$;

create or replace function public.make_banker(p_game uuid, p_player uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_user uuid;
begin
  if not exists (select 1 from public.games where id = p_game and host_id = auth.uid()) then
    raise exception 'Only the banker can hand over the bank';
  end if;
  select user_id into v_user from public.players where id = p_player and game_id = p_game;
  if not found then raise exception 'Player not found'; end if;
  update public.games set host_id = v_user where id = p_game;
end $$;

-- Returns 'done' when money moved, 'pending' when it's waiting for approval.
create or replace function public.transfer(
  p_game uuid, p_from_type text, p_from uuid, p_to_type text, p_to uuid,
  p_amount bigint, p_note text default null
) returns text language plpgsql security definer set search_path = '' as $$
declare
  g public.games; v_me uuid; v_host boolean; v_own boolean;
begin
  select * into g from public.games where id = p_game;
  if not found then raise exception 'Game not found'; end if;
  select id into v_me from public.players where game_id = p_game and user_id = auth.uid();
  if v_me is null then raise exception 'You are not in this game'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Amount must be more than zero'; end if;
  if p_from_type not in ('bank','pot','player') or p_to_type not in ('bank','pot','player') then
    raise exception 'Invalid payer or payee';
  end if;
  if p_from_type <> 'player' then p_from := null; end if;
  if p_to_type <> 'player' then p_to := null; end if;
  if (p_from_type = 'player' and p_from is null) or (p_to_type = 'player' and p_to is null) then
    raise exception 'Choose a player';
  end if;
  if p_from_type = p_to_type and p_from is not distinct from p_to then
    raise exception 'Payer and payee are the same';
  end if;
  if (p_from_type = 'pot' or p_to_type = 'pot') and not g.free_parking then
    raise exception 'The pot is turned off for this game';
  end if;

  v_host := g.host_id = auth.uid();
  v_own := p_from_type = 'player' and p_from = v_me;

  -- non-bankers may pay from their own balance, or claim money for themselves
  if not v_host and not v_own and (p_to_type <> 'player' or p_to <> v_me) then
    raise exception 'You can only pay from your own balance';
  end if;

  if not v_own then
    if g.require_approval then
      perform public._create_request(p_game, v_me, p_from_type, p_from, p_to_type, p_to, p_amount, p_note, null);
      return 'pending';
    end if;
    if not v_host then
      if p_from_type = 'player' then raise exception 'Use Request money to ask another player'; end if;
    end if;
  end if;

  perform public._apply_move(p_game, p_from_type, p_from, p_to_type, p_to, p_amount, v_own or not v_host);
  perform public._record(p_game, p_from_type, p_from, p_to_type, p_to, p_amount, p_note, 'normal', v_me, null, null);
  return 'done';
end $$;

-- Fixed GO payout to yourself; always instant.
create or replace function public.pass_go(p_game uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare v_me uuid; v_go bigint;
begin
  select go_amount into v_go from public.games where id = p_game;
  if not found then raise exception 'Game not found'; end if;
  select id into v_me from public.players where game_id = p_game and user_id = auth.uid();
  if v_me is null then raise exception 'You are not in this game'; end if;
  if v_go <= 0 then raise exception 'Passing GO pays nothing in this game'; end if;
  perform public._apply_move(p_game, 'bank', null, 'player', v_me, v_go, false);
  perform public._record(p_game, 'bank', null, 'player', v_me, v_go, 'Passed GO', 'normal', v_me, null, null);
  return 'done';
end $$;

create or replace function public.request_payment(p_game uuid, p_payer uuid, p_amount bigint, p_note text default null)
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_me uuid;
begin
  select id into v_me from public.players where game_id = p_game and user_id = auth.uid();
  if v_me is null then raise exception 'You are not in this game'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Amount must be more than zero'; end if;
  if p_payer = v_me then raise exception 'You can''t request money from yourself'; end if;
  if not exists (select 1 from public.players where id = p_payer and game_id = p_game) then
    raise exception 'Player not found';
  end if;
  return public._create_request(p_game, v_me, 'player', p_payer, 'player', v_me, p_amount, p_note, null);
end $$;

create or replace function public.undo_transaction(p_tx bigint)
returns text language plpgsql security definer set search_path = '' as $$
declare
  t public.transactions; g public.games; v_me uuid; v_host boolean;
begin
  select * into t from public.transactions where id = p_tx;
  if not found then raise exception 'Transaction not found'; end if;
  select * into g from public.games where id = t.game_id;
  select id into v_me from public.players where game_id = t.game_id and user_id = auth.uid();
  if v_me is null then raise exception 'You are not in this game'; end if;
  v_host := g.host_id = auth.uid();
  if t.kind <> 'normal' then raise exception 'That entry can''t be undone'; end if;
  if t.created_by is distinct from v_me and not v_host then
    raise exception 'Only the person who made it (or the banker) can undo it';
  end if;

  perform 1 from public.games where id = t.game_id for update;
  select * into t from public.transactions where id = p_tx;
  if t.reversed_by is not null then raise exception 'Already undone'; end if;

  -- handing back money you received is always fine; anything else needs an OK
  if g.require_approval and not (t.to_type = 'player' and t.to_player = v_me) then
    if exists (select 1 from public.payment_requests where reverses = t.id and status = 'pending') then
      raise exception 'An undo for that is already waiting for approval';
    end if;
    perform public._create_request(t.game_id, v_me, t.to_type, t.to_player, t.from_type, t.from_player,
                                   t.amount, 'Undo' || coalesce(': ' || t.note, ''), t.id);
    return 'pending';
  end if;

  perform public._apply_move(t.game_id, t.to_type, t.to_player, t.from_type, t.from_player, t.amount, false);
  perform public._record(t.game_id, t.to_type, t.to_player, t.from_type, t.from_player, t.amount,
                         'Undo' || coalesce(': ' || t.note, ''), 'reversal', v_me, null, t.id);
  return 'done';
end $$;

-- accept = true approves/pays; false rejects (approver) or cancels (requester)
create or replace function public.respond_request(p_request bigint, p_accept boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare r public.payment_requests; v_me uuid; v_can boolean;
begin
  select * into r from public.payment_requests where id = p_request;
  if not found then raise exception 'Request not found'; end if;
  select id into v_me from public.players where game_id = r.game_id and user_id = auth.uid();
  if v_me is null then raise exception 'You are not in this game'; end if;

  perform 1 from public.games where id = r.game_id for update;
  select * into r from public.payment_requests where id = p_request;
  if r.status <> 'pending' then raise exception 'That request was already handled'; end if;
  v_can := v_me = any (public._approvers(r));

  if p_accept then
    if not v_can then raise exception 'You can''t approve this one'; end if;
    if r.reverses is not null and exists (select 1 from public.transactions where id = r.reverses and reversed_by is not null) then
      raise exception 'That was already undone';
    end if;
    perform public._apply_move(r.game_id, r.from_type, r.from_player, r.to_type, r.to_player, r.amount, r.reverses is null);
    perform public._record(r.game_id, r.from_type, r.from_player, r.to_type, r.to_player, r.amount, r.note,
                           case when r.reverses is null then 'normal' else 'reversal' end,
                           r.requester, v_me, r.reverses);
    update public.payment_requests set status = 'approved', resolved_by = v_me, resolved_at = now() where id = r.id;
  else
    if v_me <> r.requester and not v_can then raise exception 'Not your request'; end if;
    update public.payment_requests
      set status = case when v_me = r.requester then 'cancelled' else 'rejected' end,
          resolved_by = v_me, resolved_at = now()
      where id = r.id;
  end if;
end $$;

-- ---------------------------------------------------------------- grants

revoke all on function public._apply_move(uuid, text, uuid, text, uuid, bigint, boolean) from public, anon, authenticated;
revoke all on function public._add_player(uuid, text) from public, anon, authenticated;
revoke all on function public._approvers(public.payment_requests) from public, anon, authenticated;
revoke all on function public._play_started(uuid) from public, anon, authenticated;
revoke all on function public._create_request(uuid, uuid, text, uuid, text, uuid, bigint, text, bigint) from public, anon, authenticated;
revoke all on function public._record(uuid, text, uuid, text, uuid, bigint, text, text, uuid, uuid, bigint) from public, anon, authenticated;

revoke all on function public.is_member(uuid) from public, anon;
revoke all on function public.create_game(text, text, text, bigint, bigint, boolean, boolean, boolean, text) from public, anon;
revoke all on function public.join_game(text, text) from public, anon;
revoke all on function public.update_game(uuid, text, text, bigint, bigint, boolean, boolean, boolean, text) from public, anon;
revoke all on function public.make_banker(uuid, uuid) from public, anon;
revoke all on function public.transfer(uuid, text, uuid, text, uuid, bigint, text) from public, anon;
revoke all on function public.pass_go(uuid) from public, anon;
revoke all on function public.undo_transaction(bigint) from public, anon;
revoke all on function public.request_payment(uuid, uuid, bigint, text) from public, anon;
revoke all on function public.respond_request(bigint, boolean) from public, anon;

grant execute on function public.is_member(uuid) to authenticated;
grant execute on function public.create_game(text, text, text, bigint, bigint, boolean, boolean, boolean, text) to authenticated;
grant execute on function public.join_game(text, text) to authenticated;
grant execute on function public.update_game(uuid, text, text, bigint, bigint, boolean, boolean, boolean, text) to authenticated;
grant execute on function public.make_banker(uuid, uuid) to authenticated;
grant execute on function public.transfer(uuid, text, uuid, text, uuid, bigint, text) to authenticated;
grant execute on function public.pass_go(uuid) to authenticated;
grant execute on function public.undo_transaction(bigint) to authenticated;
grant execute on function public.request_payment(uuid, uuid, bigint, text) to authenticated;
grant execute on function public.respond_request(bigint, boolean) to authenticated;

-- ---------------------------------------------------------------- realtime

do $$
declare t text;
begin
  foreach t in array array['games','players','transactions','payment_requests'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
