// Process-local token buckets. Keys must be transport peers or verified user IDs,
// never unverified token claims, forwarded headers, or raw bearer tokens.
export function createRateLimit(burst: number, perSecond: number, entries = 1024) {
  const buckets = new Map<string, { tokens: number; at: number }>();
  return (key: string, now = performance.now()): number => {
    let bucket = buckets.get(key);
    if (!bucket) {
      if (buckets.size >= entries) {
        for (const [id, candidate] of buckets) {
          if (candidate.tokens + ((now - candidate.at) * perSecond) / 1000 >= burst) buckets.delete(id);
        }
        // Do not evict active identities: key churn must not reset their budget.
        if (buckets.size >= entries) return Math.ceil(burst / perSecond);
      }
      bucket = { tokens: burst, at: now };
      buckets.set(key, bucket);
    }
    bucket.tokens = Math.min(burst, bucket.tokens + (Math.max(0, now - bucket.at) * perSecond) / 1000);
    bucket.at = now;
    if (bucket.tokens < 1) return Math.ceil((1 - bucket.tokens) / perSecond);
    bucket.tokens--;
    return 0;
  };
}
