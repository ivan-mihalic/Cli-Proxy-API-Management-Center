import { expect, test } from 'bun:test';
import { createQuotaHistoryClock } from '../src/features/quota/quotaHistoryClock';

test('sleep with paused monotonic clock invalidates trust and advances elapsed conservatively', () => {
  let wall = 10000000;
  let mono = 1000;
  let tick = () => {};
  let cleared = false;
  const events = new EventTarget();
  const clock = createQuotaHistoryClock(
    () => wall,
    () => mono,
    events,
    {
      set: (fn) => {
        tick = fn;
        return 1 as unknown as ReturnType<typeof setInterval>;
      },
      clear: () => {
        cleared = true;
      },
    }
  );
  const unsubscribe = clock.subscribe(() => {});
  const initial = clock.getSnapshot();
  wall += 7260000;
  mono += 60000;
  tick();
  expect(clock.getSnapshot().elapsed).toBe(7260000);
  expect(clock.getSnapshot().epoch).toBe(initial.epoch + 1);
  const beforeResume = clock.getSnapshot().epoch;
  events.dispatchEvent(new Event('pageshow'));
  expect(clock.getSnapshot().epoch).toBe(beforeResume + 1);
  unsubscribe();
  expect(cleared).toBe(true);
  const stopped = clock.getSnapshot();
  events.dispatchEvent(new Event('focus'));
  expect(clock.getSnapshot()).toBe(stopped);
});

test('absolute browser skew is irrelevant; backward wall jump invalidates without reversing time', () => {
  let wall = -7200000;
  let mono = 0;
  const clock = createQuotaHistoryClock(
    () => wall,
    () => mono
  );
  wall += 60000;
  mono += 60000;
  expect(clock.checkpoint()).toEqual({ elapsed: 60000, epoch: 0 });
  wall -= 7200000;
  mono += 60000;
  expect(clock.checkpoint()).toEqual({ elapsed: 120000, epoch: 1 });
});
