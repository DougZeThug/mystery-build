// Tiny synchronous event bus.
const handlers = new Map();

export const bus = {
  on(type, fn) {
    if (!handlers.has(type)) handlers.set(type, new Set());
    handlers.get(type).add(fn);
    return () => handlers.get(type)?.delete(fn);
  },
  off(type, fn) { handlers.get(type)?.delete(fn); },
  emit(type, payload = {}) {
    const set = handlers.get(type);
    if (set) for (const fn of [...set]) {
      try { fn(payload); } catch (e) { console.error(`[bus] ${type} handler failed`, e); }
    }
    const any = handlers.get('*');
    if (any) for (const fn of [...any]) { try { fn(type, payload); } catch (e) { console.error(e); } }
  },
};
