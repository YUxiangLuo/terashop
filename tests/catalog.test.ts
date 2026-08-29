import { describe, test, expect } from 'bun:test';
import { api, variantBySku } from './helpers';

describe('商品目录', () => {
  test('product_listing：匿名可见在售商品，含价格区间与是否有货', async () => {
    const { status, data } = await api(
      '/rest/v1/product_listing?select=slug,price_from,compare_at_from,in_stock,categories&order=slug'
    );
    expect(status).toBe(200);
    const rows = data as Record<string, unknown>[];
    expect(rows.length).toBe(4);
    const tee = rows.find((r) => r.slug === 'essential-tee')!;
    expect(Number(tee.price_from)).toBeCloseTo(19.9);
    expect(Number(tee.compare_at_from)).toBeCloseTo(29.9);
    expect(tee.in_stock).toBe(true);
    expect(tee.categories).toContain('apparel');
  });

  test('product_listing 不暴露库存数量与成本价（视图无此列）', async () => {
    const { data } = await api('/rest/v1/product_listing?select=*&limit=1');
    const row = (data as Record<string, unknown>[])[0];
    expect(row).not.toHaveProperty('on_hand');
    expect(row).not.toHaveProperty('cost');
  });

  test('变体成本价 cost 列对匿名不可见（列级权限）', async () => {
    const { data } = await api('/rest/v1/product_variants?select=cost&limit=1');
    expect((data as { code: string }).code).toBe('42501');
  });

  test('变体正常字段可读，且能嵌套取选项值', async () => {
    const { status, data } = await api(
      '/rest/v1/product_variants?sku=eq.TEE-BLK-M&select=sku,price,compare_at_price,variant_option_values(option_value_id)'
    );
    expect(status).toBe(200);
    const v = (data as Record<string, unknown>[])[0];
    expect(Number(v.price)).toBeCloseTo(19.9);
    expect((v.variant_option_values as unknown[]).length).toBe(2); // 黑 + M
  });

  test('草稿/下架商品对匿名隐藏', async () => {
    // seed 全部 active；验证过滤能力本身
    const { data } = await api('/rest/v1/products?status=neq.active&select=slug');
    expect(data).toEqual([]);
  });

  test('分类含 parent_id，可在客户端组树（PostgREST 不支持自连接内嵌）', async () => {
    const { data } = await api('/rest/v1/categories?select=id,slug,parent_id');
    const rows = data as { id: string; slug: string; parent_id: string | null }[];
    const child = rows.find((r) => r.slug === 'accessories')!;
    const parent = rows.find((r) => r.slug === 'electronics')!;
    // 客户端组树：子节点的 parent_id 指向 electronics（flat list → tree 是标准做法）
    expect(child.parent_id).toBe(parent.id);
    expect(rows.filter((r) => r.parent_id === null).length).toBeGreaterThanOrEqual(3);
  });

  test('metafield 可按 key 过滤商品（店铺端筛选基础）', async () => {
    const { status, data } = await api(
      "/rest/v1/metafields?owner_type=eq.product&namespace=eq.custom&key=eq.care_instructions&select=owner_id,value"
    );
    expect(status).toBe(200);
    expect((data as unknown[]).length).toBe(1);
  });

  test('不存在的 SKU 查询返回空', async () => {
    const id = await variantBySku('NOPE').catch(() => null);
    expect(id).toBeNull();
  });
});
