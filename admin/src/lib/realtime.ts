import type { SupabaseClient } from "@supabase/supabase-js";

// Supabase reuses same-topic channels until asynchronous unsubscribe completes.
const pendingRemovals = new WeakMap<SupabaseClient, Map<string, Promise<unknown>>>();

export type AdminChangeScope =
  | "categories"
  | "products"
  | "inventory"
  | "calls"
  | "connections"
  | "orders"
  | "quotes"
  | "customers"
  | "configuration"
  | "operations";

// Messages carry no facts. Always read through authorized RPCs, including after
// reconnect/focus; delivery and cached channel authorization are not guarantees.
export function watchAdminChanges(
  client: SupabaseClient,
  scope: AdminChangeScope,
  invalidate: () => void,
  status: (connected: boolean) => void,
) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let channel: ReturnType<SupabaseClient["channel"]> | undefined;
  let topic: string | undefined;
  const schedule = () => {
    if (stopped || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (!stopped && document.visibilityState === "visible") invalidate();
    }, 200);
  };
  window.addEventListener("focus", schedule);
  document.addEventListener("visibilitychange", schedule);
  void (async () => {
    try {
      const { data, error } = await client.auth.getSession();
      if (stopped) return;
      if (error || !data.session) throw Error("Session unavailable");
      await client.realtime.setAuth(data.session.access_token);
      if (stopped) return;
      topic =
        scope === "calls" || scope === "connections"
          ? `admin:${scope}:${data.session.user.id}`
          : `admin:${scope}`;
      await pendingRemovals.get(client)?.get(topic);
      if (stopped) return;
      channel = client.channel(topic, { config: { private: true } });
      channel
        .on("broadcast", { event: "invalidate" }, schedule)
        .subscribe((state) => {
          if (stopped) return;
          status(state === "SUBSCRIBED");
          if (state === "SUBSCRIBED") schedule();
        });
    } catch {
      if (!stopped) status(false);
    }
  })();
  return () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    window.removeEventListener("focus", schedule);
    document.removeEventListener("visibilitychange", schedule);
    if (channel && topic) {
      let removals = pendingRemovals.get(client);
      if (!removals) pendingRemovals.set(client, (removals = new Map()));
      const removedTopic = topic;
      const removal = client.removeChannel(channel);
      removals.set(removedTopic, removal);
      const clear = () => {
        if (removals.get(removedTopic) === removal) removals.delete(removedTopic);
      };
      void removal.then(clear, clear);
    }
  };
}
