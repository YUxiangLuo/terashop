-- 演示商品数据（db reset 时自动加载）
insert into public.products (slug, name, description, category, price, stock, images) values
  ('essential-tee-black',  'Essential Tee · Black',  '220g 纯棉基础款 T 恤，黑色',   'apparel',     19.90, 100, '{}'),
  ('essential-tee-white',  'Essential Tee · White',  '220g 纯棉基础款 T 恤，白色',   'apparel',     19.90,  80, '{}'),
  ('ceramic-mug-350ml',    'Ceramic Mug 350ml',      '哑光陶瓷马克杯',              'home',         9.90, 200, '{}'),
  ('notebook-a5-dotted',   'Notebook A5 · Dotted',   'A5 点阵笔记本，160 页',        'stationery',   6.50, 150, '{}'),
  ('mechanical-keyboard',  'Mechanical Keyboard 87', '87 键热插拔机械键盘',          'electronics', 89.00,  20, '{}'),
  ('usb-c-cable-1m',       'USB-C Cable 1m',         '100W 快充编织线，1 米',        'electronics',  4.90,   5, '{}');
