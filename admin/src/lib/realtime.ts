import type { SupabaseClient } from "@supabase/supabase-js";

// Messages carry no facts. Always read through authorized RPCs, including after
// reconnect/focus; delivery and cached channel authorization are not guarantees.
export function watchAdminChanges(
  client: SupabaseClient,
  scope: "categories" | "products" | "calls",
  invalidate: () => void,
  status: (connected: boolean) => void,
) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let channel: ReturnType<SupabaseClient["channel"]> | undefined;
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
      const topic =
        scope === "calls"
          ? `admin:calls:${data.session.user.id}`
          : `admin:${scope}`;
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
    stopped = true;
    clearTimeout(timer);
    window.removeEventListener("focus", schedule);
    document.removeEventListener("visibilitychange", schedule);
    if (channel) void client.removeChannel(channel);
  };
}
