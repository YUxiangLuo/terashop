import { beforeAll, describe, test, expect } from 'bun:test';
import { api, checked, onlyRow } from './helpers';
import { Cleanup } from './support/cleanup';
import { installLegacyCatalogFixture } from './support/legacy-catalog';

beforeAll(() => installLegacyCatalogFixture());

describe('商品目录', () => {
  test('product_listing：演示目录的在售商品含价格区间与是否有货', async () => {
    const { status, data } = await api(
      '/rest/v1/product_listing?slug=in.(essential-tee,mechanical-keyboard-87,ceramic-mug-350,usb-c-cable-1m)&select=slug,price_from,compare_at_from,in_stock,categories&order=slug'
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
    const row = await onlyRow<Record<string, unknown>>(api('/rest/v1/product_listing?select=*&limit=1'));
    expect(row.id).toEqual(expect.any(String));
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
    const cleanup = new Cleanup();
    try {
      for (const status of ['draft', 'archived']) {
        const product = await onlyRow<{ id: string }>(api('/rest/v1/products?select=id', {
          service: true, method: 'POST', body: { slug: crypto.randomUUID(), name: 'Hidden fixture', status },
        }));
        cleanup.defer(() => checked(api(`/rest/v1/products?id=eq.${product.id}`, { service: true, method: 'DELETE' })));
        const path = `/rest/v1/products?id=eq.${product.id}&select=id,status`;
        expect(await checked<Array<{ id: string; status: string }>>(api(path, { service: true }))).toEqual([{ id: product.id, status }]);
        expect(await api(path)).toEqual({ status: 200, data: [] });
      }
    } finally { await cleanup.run(); }
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
    const product = await onlyRow<{ id: string }>(api('/rest/v1/products?slug=eq.essential-tee&select=id'));
    const { status, data } = await api(
      `/rest/v1/metafields?owner_type=eq.product&owner_id=eq.${product.id}&namespace=eq.custom&key=eq.care_instructions&select=owner_id,value`
    );
    expect(status).toBe(200);
    expect(data).toEqual([{ owner_id: product.id, value: 'Machine wash cold' }]);
  });

  test('不存在的 SKU 查询返回空', async () => {
    expect(await api(`/rest/v1/product_variants?sku=eq.MISSING-${crypto.randomUUID()}&select=id`))
      .toEqual({ status: 200, data: [] });
  });
});
