-- Women's fashion demonstration catalog (loaded by `supabase db reset`).
-- Prices are USD; illustrative AI images are served by the sample storefront.
do $$
declare
  category_id uuid; child_category_id uuid; current_product_id uuid; color_option uuid; size_option uuid;
  location_id uuid;
  definition_id uuid; guide_s uuid; guide_m uuid; guide_l uuid; item record;
begin
  insert into public.categories (slug,name,position) values ('womens-fashion','Women',1) returning id into category_id;
  insert into public.categories (slug,name,parent_id,position) values
    ('dresses','Dresses',category_id,1),
    ('tops','Tops',category_id,2),
    ('knitwear','Knitwear',category_id,3),
    ('skirts','Skirts',category_id,4),
    ('trousers','Trousers',category_id,5);

  insert into public.locations (code,name,is_default) values ('WH-US','Default warehouse',true) returning id into location_id;

  insert into public.metaobject_definitions (type,name,description,access,fields) values
    ('size_guide','Size guide','Women''s garment measurements','public','[{"key":"size","name":"Size","type":"text","required":true},{"key":"bust_cm","name":"Bust (cm)","type":"number","required":true},{"key":"length_cm","name":"Length (cm)","type":"number","required":true},{"key":"note","name":"Notes","type":"text","required":false}]') returning id into definition_id;
  insert into public.metaobjects(definition_id,handle,values) values(definition_id,'s','{"size":"S","bust_cm":84,"length_cm":88}') returning id into guide_s;
  insert into public.metaobjects(definition_id,handle,values) values(definition_id,'m','{"size":"M","bust_cm":90,"length_cm":90}') returning id into guide_m;
  insert into public.metaobjects(definition_id,handle,values) values(definition_id,'l','{"size":"L","bust_cm":98,"length_cm":92,"note":"Measurements vary slightly by style"}') returning id into guide_l;

  insert into public.metafield_definitions(owner_type,namespace,key,name,type,description,position,access) values
    ('product','custom','care_instructions','Care instructions','text','Garment care guidance',1,'public'),
    ('product','custom','material','Material','list_text','Fabric composition',2,'public'),
    ('product','specs','size_guide','Size guide','list_metaobject_reference','References size_guide entries',3,'public'),
    ('variant','custom','weight_g','Weight (g)','number','Shipping weight',1,'public'),
    ('order','custom','gift_message','Gift message','text','Gift card message',1,'customer');

  for item in select * from (values
    ('linen-wrap-dress','Linen Wrap Dress','A softly tailored midi wrap dress with a removable waist tie.','Dresses',array['Sage','Navy'],129.00,165.00,array['55% linen','45% viscose'],'Machine wash cold; reshape and line dry.'),
    ('silk-slip-dress','Silk Slip Dress','Bias-cut midi dress with adjustable straps and a fluid drape.','Dresses',array['Black','Champagne'],168.00,210.00,array['100% silk'],'Dry clean only.'),
    ('cotton-poplin-shirt','Cotton Poplin Shirt','Relaxed button-front shirt with a crisp collar and curved hem.','Tops',array['White','Sky'],78.00,null,array['100% organic cotton'],'Machine wash cold with like colors.'),
    ('draped-satin-blouse','Draped Satin Blouse','Elegant long-sleeve blouse with a softly draped neckline.','Tops',array['Ivory','Burgundy'],92.00,115.00,array['58% viscose','42% rayon'],'Hand wash cold; lay flat to dry.'),
    ('merino-crewneck','Merino Crewneck Sweater','Fine-gauge merino knit with a classic crew neck and ribbed trims.','Knitwear',array['Oatmeal','Charcoal'],110.00,null,array['100% merino wool'],'Hand wash cold with wool detergent.'),
    ('cashmere-cardigan','Cashmere Cardigan','Lightweight V-neck cardigan finished with tonal shell buttons.','Knitwear',array['Camel','Rose'],185.00,225.00,array['100% cashmere'],'Dry clean or hand wash cold.'),
    ('pleated-midi-skirt','Pleated Midi Skirt','Fluid permanent-pleat skirt with a comfortable lined waistband.','Skirts',array['Forest','Black'],98.00,null,array['100% recycled polyester'],'Machine wash gentle; do not iron pleats.'),
    ('denim-a-line-skirt','Denim A-Line Skirt','Structured high-rise denim skirt with front patch pockets.','Skirts',array['Indigo','Ecru'],86.00,null,array['99% cotton','1% elastane'],'Machine wash cold inside out.'),
    ('tailored-wide-leg-trouser','Tailored Wide-Leg Trouser','High-rise trousers with front pleats and a full-length wide leg.','Trousers',array['Black','Stone'],118.00,148.00,array['64% recycled polyester','34% viscose','2% elastane'],'Dry clean recommended.'),
    ('relaxed-linen-trouser','Relaxed Linen Trouser','Breathable pull-on trousers with an elastic back waist.','Trousers',array['Natural','Olive'],104.00,null,array['100% linen'],'Machine wash cold; line dry.')
  ) x(slug,name,description,kind,colors,price,compare_price,materials,care)
  loop
    insert into public.products(slug,name,description,status,vendor,product_type,tags)
      values(item.slug,item.name,item.description,'draft','Atelier Tera',item.kind,array['women',lower(item.kind)]) returning id into current_product_id;
    select id into child_category_id from public.categories where slug=lower(item.kind);
    insert into public.product_categories values
      (current_product_id,category_id),
      (current_product_id,child_category_id);
    insert into public.product_options(product_id,name,position) values(current_product_id,'Color',1) returning id into color_option;
    insert into public.product_options(product_id,name,position) values(current_product_id,'Size',2) returning id into size_option;
    insert into public.product_option_values(option_id,value,position)
      select color_option,c,ord from unnest(item.colors) with ordinality u(c,ord);
    insert into public.product_option_values(option_id,value,position) values
      (size_option,'S',1),(size_option,'M',2),(size_option,'L',3);
    -- option values are shared per product; create every color/size combination.
    insert into public.product_variants(product_id,sku,price,compare_at_price,cost,position)
      select current_product_id, upper(replace(substr(item.slug,1,12),'-',''))||'-'||c.position||'-'||s.value,
             item.price,item.compare_price,round(item.price*.42,2),row_number() over(order by c.position,s.position)
      from public.product_option_values c cross join public.product_option_values s
      where c.option_id=color_option and s.option_id=size_option;
    insert into public.variant_option_values(variant_id,option_value_id)
      select v.id,ov.id from public.product_variants v join public.product_option_values ov on ov.option_id in(color_option,size_option)
      where v.product_id=current_product_id and
        ((ov.option_id=color_option and split_part(v.sku,'-',2)=ov.position::text) or
         (ov.option_id=size_option and split_part(v.sku,'-',3)=ov.value));
    insert into public.product_images(product_id,url,alt,position) values(current_product_id,'/images/'||item.slug||'.webp',item.name,1);
    insert into public.inventory_levels(variant_id,location_id,on_hand)
      select id,location_id,case when position in (4,6) then 0 else 18+position end from public.product_variants where product_variants.product_id=current_product_id;
    insert into public.metafields(owner_type,owner_id,namespace,key,type,value) values
      ('product',current_product_id,'custom','care_instructions','text',to_jsonb(item.care)),
      ('product',current_product_id,'custom','material','list_text',to_jsonb(item.materials)),
      ('product',current_product_id,'specs','size_guide','list_metaobject_reference',jsonb_build_array(guide_s::text,guide_m::text,guide_l::text));
    insert into public.metafields(owner_type,owner_id,namespace,key,type,value)
      select 'variant',id,'custom','weight_g','number','450'::jsonb from public.product_variants where product_variants.product_id=current_product_id;
    update public.products set status='active' where id=current_product_id;
  end loop;

  insert into public.shipping_methods(name,description,countries,price,free_above,estimated_days,position) values
    ('Standard shipping','Tracked worldwide delivery','{}',8.00,99.00,'3-5 business days',1),
    ('Express shipping','Expedited delivery within the United States','{US}',18.00,null,'1-2 business days',2),
    ('Regional shipping','Tracked delivery to selected international destinations','{CA,JP,SG}',30.00,null,'7-15 business days',3);
end $$;
