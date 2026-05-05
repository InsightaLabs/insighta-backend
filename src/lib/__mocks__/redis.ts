// In-memory mock for Redis — used automatically by Vitest when tests import src/lib/redis
// No real network connection is made. Supports get, set, del, keys, ttl.

const store = new Map<string, { value: string; expiresAt: number | null }>();

function isExpired(key: string): boolean {
  const entry = store.get(key);
  if (!entry) return true;
  if (entry.expiresAt === null) return false;
  return Date.now() > entry.expiresAt;
}

export const redis = {
  get: async (key: string): Promise<string | null> => {
    if (isExpired(key)) {
      store.delete(key);
      return null;
    }
    return store.get(key)?.value ?? null;
  },

  set: async (
    key: string,
    value: string,
    exFlag?: string,
    exSeconds?: number,
  ): Promise<"OK"> => {
    const expiresAt =
      exFlag === "EX" && exSeconds ? Date.now() + exSeconds * 1000 : null;
    store.set(key, { value, expiresAt });
    return "OK";
  },

  del: async (...keys: string[]): Promise<number> => {
    let count = 0;
    for (const key of keys) {
      if (store.delete(key)) count++;
    }
    return count;
  },

  keys: async (pattern: string): Promise<string[]> => {
    // Simple glob: support "prefix:*" patterns only
    const prefix = pattern.replace(/\*$/, "");
    return [...store.keys()].filter(
      (k) => k.startsWith(prefix) && !isExpired(k),
    );
  },

  ttl: async (key: string): Promise<number> => {
    const entry = store.get(key);
    if (!entry || isExpired(key)) return -2;
    if (entry.expiresAt === null) return -1;
    return Math.ceil((entry.expiresAt - Date.now()) / 1000);
  },

  // Allow tests to clear the store between runs
  flushall: async (): Promise<void> => {
    store.clear();
  },
};
