export function createClient(url) {
  const state = { ok: Boolean(url), queues: new Map() };
  return {
    ok: state.ok,
    async lpush(key, value) {
      const list = state.queues.get(key) || [];
      list.unshift(value);
      state.queues.set(key, list);
      return list.length;
    },
  };
}
