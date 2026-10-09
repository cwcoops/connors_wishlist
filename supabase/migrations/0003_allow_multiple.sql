-- "Allow multiple purchase": items more than one person can get.
-- They never get reserved or crossed off; people just add their name.

alter table public.items add column allow_multiple boolean not null default false;

create table public.item_buyers (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.items (id) on delete cascade,
  person_id uuid not null references public.people (id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (item_id, person_id)
);
create index item_buyers_person_idx on public.item_buyers (person_id);

grant select on public.item_buyers to anon;
grant select, insert, update, delete on public.item_buyers to authenticated;
grant select, insert, update, delete on public.item_buyers to service_role;

alter table public.item_buyers enable row level security;
create policy "anyone can read item buyers" on public.item_buyers for select to anon, authenticated using (true);

alter publication supabase_realtime add table public.item_buyers;

-- Multi-buy items stay available and can't be chipped in for.
create function private.guard_multi_item() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.allow_multiple and new.status <> 'available' then
    raise exception 'More than one person can get this – tick "I''m getting one" instead';
  end if;
  return new;
end $$;
create trigger guard_multi_item before insert or update on public.items
  for each row execute function private.guard_multi_item();

create function private.guard_multi_contribution() returns trigger
language plpgsql set search_path = '' as $$
begin
  if exists (select 1 from public.items where id = new.item_id and allow_multiple) then
    raise exception 'More than one person can get this – tick "I''m getting one" instead';
  end if;
  return new;
end $$;
create trigger guard_multi_contribution before insert on public.contributions
  for each row execute function private.guard_multi_contribution();

create function public.add_buyer(p_item_id uuid, p_name text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_person uuid := private.person_id(p_name);
begin
  if not exists (select 1 from public.items where id = p_item_id and allow_multiple) then
    raise exception 'That item can only be bought once';
  end if;
  insert into public.item_buyers (item_id, person_id) values (p_item_id, v_person)
  on conflict do nothing;
end $$;

create function public.remove_buyer(p_item_id uuid, p_name text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.item_buyers b
   using public.people p
   where b.item_id = p_item_id and p.id = b.person_id
     and lower(p.name) = lower(regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g'));
  if not found then
    raise exception 'That name isn''t down for this one';
  end if;
end $$;

-- admin_save_item gains p_allow_multiple; switching the setting carries existing names across.
drop function public.admin_save_item(text, uuid, text, text, numeric, text, text);

create function public.admin_save_item(
  p_password text, p_id uuid, p_name text, p_photo_url text,
  p_price numeric, p_where_to_buy text, p_notes text, p_allow_multiple boolean default false
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_old public.items%rowtype;
  v_first text;
begin
  perform private.check_admin(p_password);
  if p_id is null then
    insert into public.items (name, photo_url, price, where_to_buy, notes, allow_multiple)
    values (btrim(p_name), nullif(btrim(p_photo_url), ''), p_price,
            nullif(btrim(p_where_to_buy), ''), nullif(btrim(p_notes), ''), coalesce(p_allow_multiple, false))
    returning id into v_id;
    return v_id;
  end if;

  select * into v_old from public.items where id = p_id for update;
  if not found then raise exception 'That item no longer exists'; end if;

  update public.items
     set name = btrim(p_name), photo_url = nullif(btrim(p_photo_url), ''), price = p_price,
         where_to_buy = nullif(btrim(p_where_to_buy), ''), notes = nullif(btrim(p_notes), '')
   where id = p_id;

  if coalesce(p_allow_multiple, false) and not v_old.allow_multiple then
    -- Whoever had reserved/bought it becomes the first name on the list.
    insert into public.item_buyers (item_id, person_id)
    select p_id, p.id from public.people p
     where lower(p.name) = lower(coalesce(v_old.reserved_by, v_old.bought_by))
    on conflict do nothing;
    update public.items
       set allow_multiple = true, status = 'available', reserved_by = null, reserved_at = null, bought_by = null
     where id = p_id;
  elsif not coalesce(p_allow_multiple, false) and v_old.allow_multiple then
    -- Back to single purchase: the first person down for it holds the reservation.
    select p.name into v_first
      from public.item_buyers b join public.people p on p.id = b.person_id
     where b.item_id = p_id order by b.created_at limit 1;
    delete from public.item_buyers where item_id = p_id;
    update public.items
       set allow_multiple = false,
           status = case when v_first is null then 'available' else 'reserved' end,
           reserved_by = v_first,
           reserved_at = case when v_first is null then null else now() end
     where id = p_id;
  end if;
  return p_id;
end $$;

revoke execute on function
  public.add_buyer(uuid, text), public.remove_buyer(uuid, text),
  public.admin_save_item(text, uuid, text, text, numeric, text, text, boolean) from public;
revoke execute on function private.guard_multi_item(), private.guard_multi_contribution() from public, anon, authenticated;
grant execute on function
  public.add_buyer(uuid, text), public.remove_buyer(uuid, text),
  public.admin_save_item(text, uuid, text, text, numeric, text, text, boolean)
to anon, authenticated, service_role;
