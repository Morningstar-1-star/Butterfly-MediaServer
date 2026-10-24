// Tiny in-memory TTL cache (free tier friendly: capped size, no deps).
export function createCache({ ttlMs = 10 * 60 * 1000, max = 500 } = {}) {
  const store = new Map();
  return {
    get(key) {
      const hit = store.get(key);
      if (!hit) return undefined;
      if (hit.exp < Date.now()) { store.delete(key); return undefined; }
      return hit.val;
    },
    set(key, val, customTtlMs) {
      if (store.size >= max) store.delete(store.keys().next().value); // drop oldest
      store.set(key, { val, exp: Date.now() + (customTtlMs ?? ttlMs) });
    },
    size: () => store.size
  };
}

// Run fn with a hard timeout (does not cancel fn, just stops waiting).
export function withTimeout(promise, ms, label = "timeout") {
  let t;
  return Promise.race([
    promise,
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(label)), ms); })
  ]).finally(() => clearTimeout(t));
}
