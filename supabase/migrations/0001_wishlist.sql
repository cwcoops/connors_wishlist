-- Connor's Wishlist: tables, grants, RLS, RPCs, storage, realtime.
-- Guests (anon) can READ the tables directly; every write goes through a
-- security-definer function below so the rules are enforced server-side.

-- ---------- tables ----------
create table public.people (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (char_length(btrim(name)) between 1 and 40),
  created_at timestamptz not null default now()
);
create unique index people_name_lower_idx on public.people (lower(name));

create table public.items (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) > 0),
  photo_url text,
  price numeric(10,2) check (price is null or price > 0),
  where_to_buy text,
  notes text,
  status text not null default 'available' check (status in ('available', 'reserved', 'bought')),
  reserved_by text,
  reserved_at timestamptz,
  bought_by text,
  created_at timestamptz not null default now()
);

create table public.contributions (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.items (id) on delete cascade,
  person_id uuid not null references public.people (id) on delete restrict,
  amount numeric(10,2) not null check (amount > 0),
  organised_with_rob boolean not null default false,
  created_at timestamptz not null default now()
);
create index contributions_item_idx on public.contributions (item_id);
create index contributions_person_idx on public.contributions (person_id);

-- ---------- grants (required explicitly for every public table) ----------
grant select on public.people, public.items, public.contributions to anon;
grant select, insert, update, delete on public.people, public.items, public.contributions to authenticated;
grant select, insert, update, delete on public.people, public.items, public.contributions to service_role;

-- ---------- RLS ----------
alter table public.people enable row level security;
alter table public.items enable row level security;
alter table public.contributions enable row level security;

create policy "anyone can read people" on public.people for select to anon, authenticated using (true);
create policy "anyone can read items" on public.items for select to anon, authenticated using (true);
create policy "anyone can read contributions" on public.contributions for select to anon, authenticated using (true);

-- ---------- private helpers (not exposed through the API) ----------
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- The admin password row is inserted by hand, not from this file (see README).
create table private.settings (
  key text primary key,
  value text not null
);

create function private.check_admin(p_password text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from private.settings where key = 'admin_password' and value = p_password) then
    perform pg_sleep(1);
    raise exception 'Wrong password';
  end if;
end $$;

create function private.person_id(p_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_name text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g');
  v_id uuid;
begin
  if char_length(v_name) < 1 or char_length(v_name) > 40 then
    raise exception 'Please pick or type your name';
  end if;
  select id into v_id from public.people where lower(name) = lower(v_name);
  if v_id is null then
    insert into public.people (name) values (v_name)
    on conflict do nothing
    returning id into v_id;
    if v_id is null then
      select id into v_id from public.people where lower(name) = lower(v_name);
    end if;
  end if;
  return v_id;
end $$;

-- ---------- guest RPCs ----------
create function public.add_person(p_name text) returns uuid
language sql security definer set search_path = '' as $$
  select private.person_id(p_name);
$$;

create function public.expire_reservations() returns integer
language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  update public.items
     set status = 'available', reserved_by = null, reserved_at = null
   where status = 'reserved' and reserved_at < now() - interval '5 days';
  get diagnostics v_count = row_count;
  return v_count;
end $$;

create function public.reserve_item(p_item_id uuid, p_name text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_person uuid := private.person_id(p_name);
  v_name text;
begin
  select name into v_name from public.people where id = v_person;
  perform public.expire_reservations();
  perform 1 from public.items where id = p_item_id for update;
  if exists (select 1 from public.contributions where item_id = p_item_id) then
    raise exception 'People are already chipping in for this one – use "Help buy" instead';
  end if;
  update public.items
     set status = 'reserved', reserved_by = v_name, reserved_at = now()
   where id = p_item_id and status = 'available';
  if not found then
    raise exception 'Sorry, someone else just got to this one first';
  end if;
end $$;

create function public.mark_bought(p_item_id uuid, p_name text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.items
     set status = 'bought', bought_by = reserved_by
   where id = p_item_id and status = 'reserved'
     and lower(reserved_by) = lower(regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g'));
  if not found then
    raise exception 'Only the person who reserved this can mark it as bought';
  end if;
end $$;

create function public.add_contribution(p_item_id uuid, p_name text, p_amount numeric) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_person uuid := private.person_id(p_name);
  v_item public.items%rowtype;
  v_pledged numeric;
  v_id uuid;
begin
  perform public.expire_reservations();
  select * into v_item from public.items where id = p_item_id for update;
  if not found then raise exception 'That item no longer exists'; end if;
  if v_item.price is null then raise exception 'This item has no price to chip in towards'; end if;
  if v_item.status <> 'available' then raise exception 'This item has already been taken'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Enter an amount more than £0'; end if;
  select coalesce(sum(amount), 0) into v_pledged from public.contributions where item_id = p_item_id;
  if p_amount > v_item.price - v_pledged then
    raise exception 'Only £% is still needed for this one', trim(to_char(v_item.price - v_pledged, 'FM999999990.00'));
  end if;
  insert into public.contributions (item_id, person_id, amount)
  values (p_item_id, v_person, round(p_amount, 2))
  returning id into v_id;
  return v_id;
end $$;

create function public.confirm_contribution(p_contribution_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_item_id uuid;
  v_price numeric;
  v_confirmed numeric;
begin
  update public.contributions set organised_with_rob = true
   where id = p_contribution_id
  returning item_id into v_item_id;
  if v_item_id is null then raise exception 'That contribution no longer exists'; end if;
  select price into v_price from public.items where id = v_item_id for update;
  select coalesce(sum(amount), 0) into v_confirmed
    from public.contributions where item_id = v_item_id and organised_with_rob;
  if v_price is not null and v_confirmed >= v_price then
    update public.items
       set status = 'bought', bought_by = 'Group gift', reserved_by = null, reserved_at = null
     where id = v_item_id and status <> 'bought';
  end if;
end $$;

-- ---------- admin RPCs (password checked server-side) ----------
create function public.admin_login(p_password text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  perform private.check_admin(p_password);
  return true;
end $$;

create function public.admin_save_item(
  p_password text, p_id uuid, p_name text, p_photo_url text,
  p_price numeric, p_where_to_buy text, p_notes text
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform private.check_admin(p_password);
  if p_id is null then
    insert into public.items (name, photo_url, price, where_to_buy, notes)
    values (btrim(p_name), nullif(btrim(p_photo_url), ''), p_price,
            nullif(btrim(p_where_to_buy), ''), nullif(btrim(p_notes), ''))
    returning id into v_id;
  else
    update public.items
       set name = btrim(p_name), photo_url = nullif(btrim(p_photo_url), ''), price = p_price,
           where_to_buy = nullif(btrim(p_where_to_buy), ''), notes = nullif(btrim(p_notes), '')
     where id = p_id
    returning id into v_id;
    if v_id is null then raise exception 'That item no longer exists'; end if;
  end if;
  return v_id;
end $$;

create function public.admin_delete_item(p_password text, p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.check_admin(p_password);
  delete from public.items where id = p_id;
end $$;

revoke execute on all functions in schema public from public;
revoke execute on all functions in schema private from public, anon, authenticated;
grant execute on function
  public.add_person(text),
  public.expire_reservations(),
  public.reserve_item(uuid, text),
  public.mark_bought(uuid, text),
  public.add_contribution(uuid, text, numeric),
  public.confirm_contribution(uuid),
  public.admin_login(text),
  public.admin_save_item(text, uuid, text, text, numeric, text, text),
  public.admin_delete_item(text, uuid)
to anon, authenticated, service_role;

-- ---------- storage ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('item-photos', 'item-photos', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

create policy "anyone can upload item photos" on storage.objects
  for insert to anon, authenticated with check (bucket_id = 'item-photos');

-- ---------- realtime ----------
alter publication supabase_realtime add table public.items, public.people, public.contributions;
