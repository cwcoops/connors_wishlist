-- Undo: the person who reserved an item (or chipped in) can take it back.

create function public.cancel_reservation(p_item_id uuid, p_name text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.items
     set status = 'available', reserved_by = null, reserved_at = null
   where id = p_item_id and status = 'reserved'
     and lower(reserved_by) = lower(regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g'));
  if not found then
    raise exception 'Only the person who reserved this can remove the reservation';
  end if;
end $$;

create function public.remove_contribution(p_contribution_id uuid, p_name text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_item_id uuid;
begin
  select c.item_id into v_item_id
    from public.contributions c
    join public.people p on p.id = c.person_id
   where c.id = p_contribution_id
     and lower(p.name) = lower(regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g'));
  if v_item_id is null then
    raise exception 'Only the person who chipped in can remove this';
  end if;
  if exists (select 1 from public.items where id = v_item_id and status = 'bought') then
    raise exception 'This item has already been bought';
  end if;
  delete from public.contributions where id = p_contribution_id;
end $$;

revoke execute on function public.cancel_reservation(uuid, text), public.remove_contribution(uuid, text) from public;
grant execute on function public.cancel_reservation(uuid, text), public.remove_contribution(uuid, text)
  to anon, authenticated, service_role;
