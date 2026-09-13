import { expect, test } from 'bun:test';
import { createApi, checked, onlyRow } from '../support/http';
import { Cleanup } from '../support/cleanup';
import { validateLocalSupabase } from '../../scripts/lib/local-supabase';

const config = { url: 'http://localhost:54321', anonKey: 'test-anon', serviceKey: 'test-service' };

test('HTTP helper 保留返回模式、认证和错误正文，不把失败冒充空结果', async () => {
  const requests: Request[] = [];
  const responses = [Response.json([{ id: 'one' }], { status: 201 }), new Response(null, { status: 204 }),
    Response.json({ code: '42501' }, { status: 403 }), new Response('upstream failed', { status: 502 })];
  const api = createApi(config, async (input, init) => {
    requests.push(new Request(input, init)); return responses.shift()!;
  });
  expect(await onlyRow<{ id: string }>(api('/rows', { method: 'POST', body: { value: 1 }, token: 'test-user' }))).toEqual({ id: 'one' });
  expect(requests[0].headers.get('prefer')).toBe('return=representation');
  expect(requests[0].headers.get('authorization')).toBe('Bearer test-user');
  expect(await requests[0].json()).toEqual({ value: 1 });
  expect(await checked(api('/rows', { method: 'PATCH', service: true, returning: 'minimal' }))).toBeNull();
  expect(requests[1].headers.get('prefer')).toBe('return=minimal');
  expect(requests[1].headers.get('apikey')).toBe('test-service');
  await expect(checked(api('/rows'))).rejects.toThrow('42501');
  await expect(checked(api('/rows'))).rejects.toThrow('upstream failed');
});

test('缺失/多行/无效形状与断网明确失败；200 空集合仍由调用方显式断言', async () => {
  for (const data of [[], [{ id: 1 }, { id: 2 }], null, { message: 'not rows' }]) {
    const api = createApi(config, async () => Response.json(data));
    await expect(onlyRow(api('/rows'))).rejects.toThrow('exactly one');
  }
  const empty = createApi(config, async () => Response.json([]));
  expect(await empty('/rows')).toEqual({ status: 200, data: [] });
  const offline = createApi(config, async () => { throw new Error('offline'); });
  await expect(checked(offline('/rows'))).rejects.toThrow('offline');
});

test('清理按逆序执行，单项失败不跳过其他资源，错误可见且不会重复清理', async () => {
  const cleanup = new Cleanup(); const calls: number[] = [];
  cleanup.defer(async () => { calls.push(1); });
  cleanup.defer(async () => { calls.push(2); throw new Error('failed cleanup'); });
  cleanup.defer(async () => { calls.push(3); });
  await expect(cleanup.run()).rejects.toMatchObject({ errors: [expect.objectContaining({ message: 'failed cleanup' })] });
  expect(calls).toEqual([3, 2, 1]);
  await cleanup.run(); expect(calls).toEqual([3, 2, 1]);
});

test('测试配置缺项或指向远程时失败关闭，不接受任意继承 DB_URL', () => {
  const env = { API_URL: config.url, DB_URL: 'postgresql://postgres:placeholder@127.0.0.1:54322/postgres',
    ANON_KEY: config.anonKey, SERVICE_ROLE_KEY: config.serviceKey };
  expect(validateLocalSupabase({ ...env, UNUSED_SECRET: 'not-forwarded' })).toEqual(env);
  for (const invalid of [{ ...env, DB_URL: 'postgresql://db.example.invalid/postgres' },
    { ...env, API_URL: 'https://shop.example.invalid' }, { ...env, DB_URL: '' }, { ...env, SERVICE_ROLE_KEY: '' }]) {
    expect(() => validateLocalSupabase(invalid)).toThrow();
  }
});
