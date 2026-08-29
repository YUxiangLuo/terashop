-- ============================================================
-- 演示数据（bunx supabase db reset 时自动加载）
-- ============================================================

do $$
declare
  -- 分类
  c_apparel uuid; c_home uuid; c_elec uuid; c_acc uuid;
  -- 商品
  p_tee uuid; p_kb uuid; p_mug uuid; p_cable uuid;
  -- 选项
  o_color uuid; o_size uuid; o_switch uuid;
  -- 选项值
  ov_black uuid; ov_white uuid; ov_s uuid; ov_m uuid; ov_l uuid;
  ov_red uuid; ov_brown uuid;
  -- 变体
  v_tee uuid; v_kb uuid; v_mug uuid; v_cable uuid;
  -- 仓库
  loc uuid;
  -- metaobject
  def_sg uuid; mo_s uuid; mo_m uuid; mo_l uuid;
begin

-- ---------- 分类 ----------
insert into public.categories (slug, name, parent_id, position) values
  ('apparel',     '服装',     null, 1) returning id into c_apparel;
insert into public.categories (slug, name, parent_id, position) values
  ('home',        '家居生活', null, 2) returning id into c_home;
insert into public.categories (slug, name, parent_id, position) values
  ('electronics', '数码电子', null, 3) returning id into c_elec;
insert into public.categories (slug, name, parent_id, position) values
  ('accessories', '数码配件', c_elec, 1) returning id into c_acc;

-- ---------- 商品 1：基础款 T 恤（颜色 × 尺寸 = 6 变体） ----------
insert into public.products (slug, name, description, status, vendor, product_type, tags) values
  ('essential-tee', 'Essential Tee', '220g 新疆棉基础款 T 恤，预缩处理，男女同款。',
   'active', 'ACME', 'T恤', '{基础款,纯棉}') returning id into p_tee;

insert into public.product_categories (product_id, category_id) values (p_tee, c_apparel);

insert into public.product_options (product_id, name, position) values (p_tee, '颜色', 1) returning id into o_color;
insert into public.product_options (product_id, name, position) values (p_tee, '尺寸', 2) returning id into o_size;

insert into public.product_option_values (option_id, value, position) values (o_color, '黑', 1) returning id into ov_black;
insert into public.product_option_values (option_id, value, position) values (o_color, '白', 2) returning id into ov_white;
insert into public.product_option_values (option_id, value, position) values (o_size, 'S', 1) returning id into ov_s;
insert into public.product_option_values (option_id, value, position) values (o_size, 'M', 2) returning id into ov_m;
insert into public.product_option_values (option_id, value, position) values (o_size, 'L', 3) returning id into ov_l;

-- 6 个变体：价格 19.90，划线价 29.90
for v_tee in
  with combos as (
    select c.value as color, s.value as size
    from (values ('黑', ov_black), ('白', ov_white)) c(value, id)
    cross join (values ('S', ov_s), ('M', ov_m), ('L', ov_l)) s(value, id)
  )
  insert into public.product_variants (product_id, sku, price, compare_at_price, cost, position)
  select p_tee,
         'TEE-' || upper(case color when '黑' then 'BLK' else 'WHT' end) || '-' || size,
         19.90, 29.90, 8.00,
         row_number() over ()
  from combos
  returning id
loop
  -- 给变体挂选项值（按 sku 解析颜色和尺寸）
  insert into public.variant_option_values (variant_id, option_value_id)
  select v_tee, ov from (values
    (case when (select sku from public.product_variants where id = v_tee) like 'TEE-BLK%' then ov_black else ov_white end),
    (case when (select sku from public.product_variants where id = v_tee) like '%-S' then ov_s
          when (select sku from public.product_variants where id = v_tee) like '%-M' then ov_m
          else ov_l end)
  ) t(ov);
end loop;

insert into public.product_images (product_id, url, alt, position) values
  (p_tee, 'https://picsum.photos/seed/tee1/800/800', 'T恤主图', 1),
  (p_tee, 'https://picsum.photos/seed/tee2/800/800', '细节图', 2);

-- ---------- 商品 2：机械键盘（轴体 2 变体） ----------
insert into public.products (slug, name, description, status, vendor, product_type, tags) values
  ('mechanical-keyboard-87', 'Mechanical Keyboard 87',
   '87 键热插拔机械键盘，三模连接，PBT 键帽。', 'active', 'KeyPro', '键盘', '{机械键盘,热插拔}')
returning id into p_kb;

insert into public.product_categories (product_id, category_id) values (p_kb, c_elec);

insert into public.product_options (product_id, name, position) values (p_kb, '轴体', 1) returning id into o_switch;
insert into public.product_option_values (option_id, value, position) values (o_switch, '红轴', 1) returning id into ov_red;
insert into public.product_option_values (option_id, value, position) values (o_switch, '茶轴', 2) returning id into ov_brown;

insert into public.product_variants (product_id, sku, price, compare_at_price, cost, position) values
  (p_kb, 'KB87-RED',   89.00, 109.00, 45.00, 1) returning id into v_kb;
insert into public.variant_option_values (variant_id, option_value_id) values (v_kb, ov_red);

insert into public.product_variants (product_id, sku, price, compare_at_price, cost, position) values
  (p_kb, 'KB87-BROWN', 95.00, 119.00, 48.00, 2) returning id into v_tee;  -- 复用变量
insert into public.variant_option_values (variant_id, option_value_id) values (v_tee, ov_brown);

insert into public.product_images (product_id, url, alt, position) values
  (p_kb, 'https://picsum.photos/seed/kb1/800/800', '键盘主图', 1);

-- ---------- 商品 3：陶瓷马克杯（无选项 → 单个默认变体） ----------
insert into public.products (slug, name, description, status, vendor, product_type, tags) values
  ('ceramic-mug-350', 'Ceramic Mug 350ml', '哑光釉面陶瓷马克杯，350ml。', 'active', 'ACME', '杯具', '{马克杯}')
returning id into p_mug;

insert into public.product_categories (product_id, category_id) values (p_mug, c_home);

insert into public.product_variants (product_id, sku, price, cost) values
  (p_mug, 'MUG-350', 9.90, 3.50) returning id into v_mug;

-- ---------- 商品 4：USB-C 数据线（低库存，用于超卖测试） ----------
insert into public.products (slug, name, description, status, vendor, product_type, tags) values
  ('usb-c-cable-1m', 'USB-C Cable 1m', '100W 快充编织数据线，1 米。', 'active', 'ACME', '数据线', '{快充}')
returning id into p_cable;

insert into public.product_categories (product_id, category_id) values (p_cable, c_acc);

insert into public.product_variants (product_id, sku, price, cost) values
  (p_cable, 'CABLE-1M', 4.90, 1.20) returning id into v_cable;

-- ---------- 仓库与库存 ----------
insert into public.locations (code, name, is_default) values ('WH-SH', '上海仓', true) returning id into loc;

insert into public.inventory_levels (variant_id, location_id, on_hand)
select v.id, loc, case
  when v.sku like 'TEE-%'    then 50
  when v.sku = 'KB87-RED'    then 20
  when v.sku = 'KB87-BROWN'  then 15
  when v.sku = 'MUG-350'     then 200
  when v.sku = 'CABLE-1M'    then 5
  else 0 end
from public.product_variants v;

-- ---------- Metaobject：尺码表定义 + 3 条条目 ----------
insert into public.metaobject_definitions (type, name, description, fields) values
  ('size_guide', '尺码表', '服装尺码测量数据', '[
    {"key": "size",      "name": "尺码",     "type": "text",   "required": true},
    {"key": "bust_cm",   "name": "胸围(cm)", "type": "number", "required": true},
    {"key": "length_cm", "name": "衣长(cm)", "type": "number", "required": true},
    {"key": "note",      "name": "备注",     "type": "text",   "required": false}
  ]') returning id into def_sg;

insert into public.metaobjects (definition_id, handle, values) values
  (def_sg, 's', '{"size":"S","bust_cm":96,"length_cm":66}')              returning id into mo_s;
insert into public.metaobjects (definition_id, handle, values) values
  (def_sg, 'm', '{"size":"M","bust_cm":102,"length_cm":69}')             returning id into mo_m;
insert into public.metaobjects (definition_id, handle, values) values
  (def_sg, 'l', '{"size":"L","bust_cm":108,"length_cm":72,"note":"偏宽松"}') returning id into mo_l;

-- ---------- Metafield 定义 ----------
insert into public.metafield_definitions (owner_type, namespace, key, name, type, description, position) values
  ('product', 'custom', 'care_instructions', '洗护说明', 'text',     '洗涤保养说明',      1),
  ('product', 'custom', 'material',          '材质',     'list_text', '面料成分列表',      2),
  ('product', 'specs',  'size_guide',        '尺码表',   'list_metaobject_reference', '引用 size_guide metaobject', 3),
  ('variant', 'custom', 'weight_g',          '重量(g)',  'number',   '用于运费估算',      1),
  ('order',   'custom', 'gift_message',      '礼品留言', 'text',     '礼品卡留言',        1);

-- ---------- Metafield 值（挂到 T 恤商品） ----------
insert into public.metafields (owner_type, owner_id, namespace, key, type, value) values
  ('product', p_tee, 'custom', 'care_instructions', 'text', '"冷水机洗，勿漂白，低温熨烫"'),
  ('product', p_tee, 'custom', 'material', 'list_text', '["100% 棉"]'),
  ('product', p_tee, 'specs', 'size_guide', 'list_metaobject_reference',
    jsonb_build_array(mo_s::text, mo_m::text, mo_l::text));

-- 变体重量 metafield（所有 T 恤变体 220g）
insert into public.metafields (owner_type, owner_id, namespace, key, type, value)
select 'variant', v.id, 'custom', 'weight_g', 'number', '220'
from public.product_variants v where v.sku like 'TEE-%';

-- ---------- 运费方式 ----------
insert into public.shipping_methods (name, description, countries, price, free_above, estimated_days, position) values
  ('标准快递', '三通一达', '{}',            8.00, 99.00, '3-5天', 1),
  ('顺丰速运', '次日达',   '{}',           18.00, null,  '1-2天', 2),
  ('国际挂号', '海外订单', '{US,JP,SG}',   30.00, null,  '7-15天', 3);

-- ---------- 税率 ----------
insert into public.tax_rates (name, country, rate) values
  ('增值税 13%', 'CN', 0.13);

-- ---------- 促销 ----------
-- 输码型（半自动）
insert into public.promotions (name, code, type, params, usage_limit) values
  ('新客9折',   'WELCOME10', 'order_percentage', '{"percent": 10, "threshold": 50}', null),
  ('满100减20', 'SAVE20',    'order_fixed',      '{"threshold": 100, "amount": 20}', 100);

-- 自动型（预览/下单自动生效）
declare
  promo_apparel uuid; promo_mug uuid; promo_bogo uuid;
begin
  insert into public.promotions (name, type, params, priority, stackable) values
    ('服饰分类8折', 'item_percentage', '{"percent": 20}', 100, false)
  returning id into promo_apparel;
  insert into public.promotion_targets (promotion_id, category_id) values (promo_apparel, c_apparel);

  insert into public.promotions (name, type, params, priority, stackable) values
    ('马克杯满3件7折', 'item_percentage', '{"percent": 30, "min_quantity": 3}', 100, true)
  returning id into promo_mug;
  insert into public.promotion_targets (promotion_id, product_id) values (promo_mug, p_mug);

  insert into public.promotions (name, type, params, priority, stackable) values
    ('数据线买一送一', 'buy_x_get_y', '{"buy": 1, "get": 1, "get_percent": 100}', 100, true)
  returning id into promo_bogo;
  insert into public.promotion_targets (promotion_id, product_id) values (promo_bogo, p_cable);
end;

end $$;
