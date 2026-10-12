-- Reservations no longer expire: buyers get as long as they need.

create or replace function public.reserve_item(p_item_id uuid, p_name text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_person uuid := private.person_id(p_name);
  v_name text;
begin
  select name into v_name from public.people where id = v_person;
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

create or replace function public.add_contribution(p_item_id uuid, p_name text, p_amount numeric) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_person uuid := private.person_id(p_name);
  v_item public.items%rowtype;
  v_pledged numeric;
  v_id uuid;
begin
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

-- Pages still open from before this change call this on a timer; an error makes them stop
-- (a successful no-op would have them retry in a loop).
create or replace function public.expire_reservations() returns integer
language plpgsql security definer set search_path = '' as $$
begin
  raise exception 'Reservations no longer expire – refresh the page';
end $$;
