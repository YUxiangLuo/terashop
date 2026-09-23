import { expect, test } from 'bun:test';
import type { SupabaseClient } from '@supabase/supabase-js';
import { watchAdminChanges } from '../../admin/src/lib/realtime';

test('same-topic remount waits for removal and abandoned mounts never subscribe', async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: Object.assign(new EventTarget(), { visibilityState: 'visible' }),
  });
  const callbacks: (() => void)[] = [];
  const removal = Promise.withResolvers<void>();
  let created = 0,
    removed = 0,
    refreshes = 0;
  const client = {
    auth: {
      getSession: async () => ({ data: { session: { user: { id: 'owner' }, access_token: 'token' } } }),
    },
    realtime: { setAuth: async () => {} },
    channel(topic: string) {
      expect(topic).toBe('admin:orders');
      created++;
      return {
        on(_type: string, _filter: unknown, callback: () => void) {
          callbacks.push(callback);
          return this;
        },
        subscribe() {
          return this;
        },
      };
    },
    removeChannel() {
      removed++;
      return removal.promise;
    },
  } as unknown as SupabaseClient;
  const stops: (() => void)[] = [];
  const mount = () => {
    const stop = watchAdminChanges(
      client,
      'orders',
      () => refreshes++,
      () => {},
    );
    stops.push(stop);
    return stop;
  };
  try {
    const first = mount();
    await Bun.sleep(0);
    expect(created).toBe(1);
    first();
    first();
    expect(removed).toBe(1);
    const abandoned = mount();
    await Bun.sleep(0);
    expect(created).toBe(1);
    abandoned();
    mount();
    await Bun.sleep(0);
    expect(created).toBe(1);
    removal.resolve();
    await Bun.sleep(0);
    expect(created).toBe(2);
    callbacks[0]();
    await Bun.sleep(250);
    expect(refreshes).toBe(0);
    callbacks[1]();
    await Bun.sleep(250);
    expect(refreshes).toBe(1);
  } finally {
    removal.resolve();
    for (const stop of stops) stop();
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});

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
