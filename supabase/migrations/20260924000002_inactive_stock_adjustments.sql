begin;

create or replace function public.adjust_inventory(variant_id uuid, delta integer, idempotency_key text,
  reason text default 'adjust', note text default null, location_id uuid default null)
returns public.inventory_levels language plpgsql security definer set search_path='' as $$
declare
  v_location_id uuid; v_level public.inventory_levels;
  v_subject_id constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  v_key text := btrim(idempotency_key); v_hash text; v_record commerce.command_idempotency;
begin
  if not public.is_admin() then raise exception using errcode='42501',message='admin only'; end if;
  if coalesce(v_key,'')='' or length(v_key)>200 then
    raise exception using errcode='22023',message='idempotency_key is required and must be at most 200 characters';
  end if;
  if delta is null or delta=0 then raise exception using errcode='22023',message='delta must be a non-zero integer'; end if;
  if reason is null or reason not in ('restock','adjust') then raise exception using errcode='22023',message='reason must be restock or adjust'; end if;
  v_hash:=private.command_request_hash(jsonb_build_object('variant_id',variant_id,'delta',delta,'reason',reason,'note',note,'location_id',location_id));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('inventory.adjust:'||v_subject_id||':'||v_key,0));
  select * into v_record from commerce.command_idempotency c
    where c.scope='inventory.adjust' and c.subject_id=v_subject_id and c.idempotency_key=v_key;
  if found then
    if v_record.request_hash<>v_hash then raise exception using errcode='PT409',message='idempotency key was used with different inventory parameters'; end if;
    select * into v_level from public.inventory_levels il where il.variant_id=v_record.resource_id and il.location_id=v_record.resource_location_id;
    if not found then raise exception using errcode='PT404',message='idempotency resource no longer exists'; end if;
    return v_level;
  end if;
  v_location_id:=coalesce(adjust_inventory.location_id,(select id from public.locations where is_default and is_active limit 1));
  if v_location_id is null then raise exception 'no location available'; end if;
  -- Replay above remains readable after deactivation; only NEW commands require an active warehouse.
  -- Lock through the movement commit so deactivation cannot pass this eligibility check concurrently.
  perform 1 from public.locations where id=v_location_id and is_active for share;
  if not found then raise exception using errcode='PT409',message='active warehouse required for a new adjustment'; end if;
  insert into public.inventory_levels(variant_id,location_id,on_hand)
    values(adjust_inventory.variant_id,v_location_id,0) on conflict on constraint inventory_levels_pkey do nothing;
  update public.inventory_levels il set on_hand=il.on_hand+delta
    where il.variant_id=adjust_inventory.variant_id and il.location_id=v_location_id returning * into v_level;
  insert into public.inventory_movements(variant_id,location_id,delta,on_hand_after,reason,actor_id,note)
    values(adjust_inventory.variant_id,v_location_id,adjust_inventory.delta,v_level.on_hand,adjust_inventory.reason,auth.uid(),note);
  insert into commerce.command_idempotency(scope,subject_id,idempotency_key,request_hash,resource_type,resource_id,resource_location_id)
    values('inventory.adjust',v_subject_id,v_key,v_hash,'inventory_level',variant_id,v_location_id);
  return v_level;
end;
$$;
notify pgrst,'reload schema';
commit;
