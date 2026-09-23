import { expect, test } from 'bun:test';
import type { SupabaseClient } from '@supabase/supabase-js';
import { watchAdminChanges } from '../../admin/src/lib/realtime';

test('invalidation coalesces bursts, reconciles reconnect/focus, and cancels work on unmount', async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const window = new EventTarget(),
    document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: window });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: document });
  let receive = () => {},
    state = (_: string) => {},
    refreshes = 0,
    removed = 0;
  const statuses: boolean[] = [];
  const channel = {
    on(type: string, filter: unknown, callback: () => void) {
      expect(type).toBe('broadcast');
      expect(filter).toEqual({ event: 'invalidate' });
      receive = callback;
      return this;
    },
    subscribe(callback: (status: string) => void) {
      state = callback;
      return this;
    },
  };
  const client = {
    auth: {
      getSession: async () => ({
        data: { session: { user: { id: 'own-user' }, access_token: 'secret' } },
        error: null,
      }),
    },
    realtime: {
      setAuth: async (token: string) => {
        expect(token).toBe('secret');
      },
    },
    channel(topic: string, config: unknown) {
      expect(topic).toBe('admin:calls:own-user');
      expect(config).toEqual({ config: { private: true } });
      return channel;
    },
    removeChannel: async () => {
      removed++;
    },
  } as unknown as SupabaseClient;
  const stop = watchAdminChanges(
    client,
    'calls',
    () => refreshes++,
    (s) => statuses.push(s),
  );
  try {
    await Bun.sleep(0);
    state('SUBSCRIBED');
    receive();
    receive();
    await Bun.sleep(250);
    expect(refreshes).toBe(1);
    state('CHANNEL_ERROR');
    state('SUBSCRIBED');
    await Bun.sleep(250);
    expect(refreshes).toBe(2);
    expect(statuses).toEqual([true, false, true]);
    document.visibilityState = 'hidden';
    receive();
    await Bun.sleep(250);
    expect(refreshes).toBe(2);
    document.visibilityState = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
    await Bun.sleep(250);
    expect(refreshes).toBe(3);
    receive();
    stop();
    window.dispatchEvent(new Event('focus'));
    state('SUBSCRIBED');
    await Bun.sleep(250);
    expect(refreshes).toBe(3);
    expect(removed).toBe(1);
    expect(statuses).toEqual([true, false, true]);
  } finally {
    if (!removed) stop();
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});
