interface ClockSnapshot {
  elapsed: number;
  epoch: number;
}

// Relativní wall/monotonic rozdíl odhalí sleep i změnu hodin; absolutní skew nevadí.
export function createQuotaHistoryClock(
  wall = () => Date.now(),
  monotonic = () => performance.now(),
  events: EventTarget | undefined = typeof window === 'undefined' ? undefined : window,
  timers = {
    set: (fn: () => void) => setInterval(fn, 60000),
    clear: (id: ReturnType<typeof setInterval>) => clearInterval(id),
  }
) {
  let previousWall = wall();
  let previousMono = monotonic();
  let snapshot: ClockSnapshot = { elapsed: 0, epoch: 0 };
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setInterval> | undefined;
  const sample = (invalidate = false) => {
    const nextWall = wall();
    const nextMono = monotonic();
    const wallDelta = nextWall - previousWall;
    const monoDelta = nextMono - previousMono;
    snapshot = {
      elapsed: snapshot.elapsed + Math.max(0, wallDelta, monoDelta),
      epoch:
        snapshot.epoch +
        (invalidate || monoDelta < 0 || Math.abs(wallDelta - monoDelta) > 5000 ? 1 : 0),
    };
    previousWall = nextWall;
    previousMono = nextMono;
    listeners.forEach((listener) => listener());
    return snapshot;
  };
  const resume = () => sample(true);
  const tick = () => sample();
  return {
    getSnapshot: () => snapshot,
    checkpoint: () => sample(),
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) {
        sample();
        timer = timers.set(tick);
        for (const event of ['pageshow', 'focus', 'visibilitychange'])
          events?.addEventListener(event, resume);
      }
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          if (timer !== undefined) timers.clear(timer);
          for (const event of ['pageshow', 'focus', 'visibilitychange'])
            events?.removeEventListener(event, resume);
        }
      };
    },
  };
}
