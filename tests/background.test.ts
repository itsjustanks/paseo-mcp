import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { backgroundPass } from "../server/background";
import { markClientSeen, resetPresence, WATCH_WINDOW_MS } from "../server/presence";

/** Let the pass's promise chain settle between timer ticks. */
async function flush(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

test("the background pass rests while no app is connected and resumes when one is", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  resetPresence();
  try {
    let runs = 0;
    const lines: string[] = [];
    const pass = backgroundPass({ name: "test", firstDelayMs: 1000, intervalMs: () => 10 * 60_000, run: async () => void (runs += 1), log: (line) => lines.push(line) });
    pass.start();
    mock.timers.tick(1000);
    await flush();
    mock.timers.tick(60_000 * 5);
    await flush();
    assert.equal(runs, 0, "nobody looking, nothing probed");
    assert.equal(lines.filter((line) => /pausing/.test(line)).length, 1, "the pause is logged once");

    markClientSeen();
    mock.timers.tick(60_000);
    await flush();
    assert.equal(runs, 1);
    mock.timers.tick(10 * 60_000);
    await flush();
    assert.equal(runs, 2, "then on the normal interval");

    // The app goes away: after the watch window the pass rests again.
    mock.timers.tick(WATCH_WINDOW_MS + 10 * 60_000);
    await flush();
    const settled = runs;
    mock.timers.tick(60 * 60_000);
    await flush();
    assert.equal(runs, settled);
    pass.stop();
  } finally {
    mock.timers.reset();
    resetPresence();
  }
});

test("a failing pass is retried sooner, backing off 1, 2, 4 minutes, never past the interval", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 5_000_000 });
  resetPresence();
  try {
    const times: number[] = [];
    let fail = true;
    const pass = backgroundPass({
      name: "test",
      firstDelayMs: 0,
      intervalMs: () => 30 * 60_000,
      run: async () => {
        markClientSeen();
        times.push(Date.now());
        if (fail) throw new Error("host busy");
      },
      log: () => undefined,
    });
    markClientSeen();
    pass.start();
    mock.timers.tick(0);
    await flush();
    for (const minutes of [1, 2, 4]) {
      mock.timers.tick(minutes * 60_000);
      await flush();
    }
    const gaps = times.slice(1).map((time, index) => (time - times[index]!) / 60_000);
    assert.deepEqual(gaps, [1, 2, 4]);
    fail = false;
    mock.timers.tick(8 * 60_000);
    await flush();
    const afterSuccess = times.length;
    mock.timers.tick(29 * 60_000);
    await flush();
    markClientSeen(); // the app is still open (its chip reads health every minute)
    assert.equal(times.length, afterSuccess, "back on the 30 minute interval after a success");
    mock.timers.tick(60_000);
    await flush();
    assert.equal(times.length, afterSuccess + 1);
    pass.stop();
  } finally {
    mock.timers.reset();
    resetPresence();
  }
});

test("a switched-off pass never runs", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 9_000_000 });
  resetPresence();
  try {
    let runs = 0;
    markClientSeen();
    const pass = backgroundPass({ name: "test", firstDelayMs: 0, intervalMs: () => null, run: async () => void (runs += 1), log: () => undefined });
    pass.start();
    mock.timers.tick(3 * 60 * 60_000);
    await flush();
    assert.equal(runs, 0);
    assert.equal(pass.nextRunAt(), null);
    pass.stop();
  } finally {
    mock.timers.reset();
    resetPresence();
  }
});
