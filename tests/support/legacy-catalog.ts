import { testDatabase } from '../database-concurrency';

let setup: Promise<void> | undefined;

/** Historical catalog used only by backend behavior tests. Never part of production seed. */
export function installLegacyCatalogFixture(): Promise<void> {
  return setup ??= (async () => {
    const db = testDatabase();
    try {
      await db.unsafe(`do $$ declare
      apparel uuid; electronics uuid; accessories uuid; tee uuid; kb uuid; mug uuid; cable uuid; loc uuid; promo uuid;
      o_color uuid; o_size uuid; o_switch uuid; black uuid; small uuid; medium uuid; large uuid; red uuid; brown uuid; v uuid;
    begin
      if exists(select 1 from public.products where slug='essential-tee') then return; end if;
      insert into public.categories(slug,name,position) values('apparel','Test apparel',900) returning id into apparel;
      insert into public.categories(slug,name,position) values('electronics','Test electronics',901) returning id into electronics;
      insert into public.categories(slug,name,parent_id,position) values('accessories','Test accessories',electronics,1) returning id into accessories;
      select id into loc from public.locations where is_default;
      insert into public.products(slug,name,status) values('essential-tee','Fixture tee','draft') returning id into tee;
      insert into public.products(slug,name,status) values('mechanical-keyboard-87','Fixture keyboard','draft') returning id into kb;
      insert into public.products(slug,name,status) values('ceramic-mug-350','Fixture mug','draft') returning id into mug;
      insert into public.products(slug,name,status) values('usb-c-cable-1m','Fixture cable','draft') returning id into cable;
      insert into public.product_categories values(tee,apparel),(kb,electronics),(mug,electronics),(cable,accessories);
      insert into public.product_options(product_id,name,position) values(tee,'Color',1) returning id into o_color;
      insert into public.product_options(product_id,name,position) values(tee,'Size',2) returning id into o_size;
      insert into public.product_option_values(option_id,value,position) values(o_color,'Black',1) returning id into black;
      insert into public.product_option_values(option_id,value,position) values(o_size,'S',1) returning id into small;
      insert into public.product_option_values(option_id,value,position) values(o_size,'M',2) returning id into medium;
      insert into public.product_option_values(option_id,value,position) values(o_size,'L',3) returning id into large;
      insert into public.product_options(product_id,name,position) values(kb,'Switch',1) returning id into o_switch;
      insert into public.product_option_values(option_id,value,position) values(o_switch,'Red',1) returning id into red;
      insert into public.product_option_values(option_id,value,position) values(o_switch,'Brown',2) returning id into brown;
      insert into public.product_variants(product_id,sku,price,compare_at_price,cost) values(tee,'TEE-BLK-S',19.9,29.9,8) returning id into v;
      insert into public.variant_option_values values(v,black),(v,small); insert into public.inventory_levels values(v,loc,50,0);
      insert into public.product_variants(product_id,sku,price,compare_at_price,cost) values(tee,'TEE-BLK-M',19.9,29.9,8) returning id into v;
      insert into public.variant_option_values values(v,black),(v,medium); insert into public.inventory_levels values(v,loc,50,0);
      insert into public.product_variants(product_id,sku,price,compare_at_price,cost) values(kb,'KB87-RED',89,109,45) returning id into v; insert into public.variant_option_values values(v,red); insert into public.inventory_levels values(v,loc,20,0);
      insert into public.product_variants(product_id,sku,price,compare_at_price,cost) values(kb,'KB87-BROWN',95,119,48) returning id into v; insert into public.variant_option_values values(v,brown); insert into public.inventory_levels values(v,loc,15,0);
      insert into public.product_variants(product_id,sku,price,cost) values(mug,'MUG-350',9.9,3.5) returning id into v; insert into public.inventory_levels values(v,loc,200,0);
      insert into public.product_variants(product_id,sku,price,cost) values(cable,'CABLE-1M',4.9,1.2) returning id into v; insert into public.inventory_levels values(v,loc,50,0);
      update public.products set status='active' where id in(tee,kb,mug,cable);
      insert into public.metafields(owner_type,owner_id,namespace,key,type,value)
        values('product',tee,'custom','care_instructions','text','"Machine wash cold"');
      insert into public.promotions(name,code,type,params) values('Fixture welcome','WELCOME10','order_percentage','{"percent":10,"threshold":50}');
      insert into public.promotions(name,code,type,params,usage_limit) values('Fixture save','SAVE20','order_fixed','{"threshold":100,"amount":20}',100);
      insert into public.promotions(name,type,params) values('服饰分类8折','item_percentage','{"percent":20}') returning id into promo; insert into public.promotion_targets(promotion_id,category_id) values(promo,apparel);
      insert into public.promotions(name,type,params,stackable) values('马克杯满3件7折','item_percentage','{"percent":30,"min_quantity":3}',true) returning id into promo; insert into public.promotion_targets(promotion_id,product_id) values(promo,mug);
      insert into public.promotions(name,type,params,stackable) values('数据线买一送一','buy_x_get_y','{"buy":1,"get":1,"get_percent":100}',true) returning id into promo; insert into public.promotion_targets(promotion_id,product_id) values(promo,cable);
    end $$`);
    } finally {
      await db.close();
    }
  })();
}
