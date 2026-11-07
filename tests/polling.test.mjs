import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomPoller, needsRoomUpdates, pollDelay, retryAfterMs } from '../public/polling.js';

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
class Clock {
  time = 0;
  sequence = 0;
  timers = new Map();
  now = () => this.time;
  setTimer = (fn, delay) => {
    const id = ++this.sequence;
    this.timers.set(id, { fn, at: this.time + delay });
    return id;
  };
  clearTimer = id => this.timers.delete(id);
  async tick(ms) {
    const end = this.time + ms;
    await flush();
    while (true) {
      const next = [...this.timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      this.time = next[1].at;
      this.timers.delete(next[0]);
      next[1].fn();
      await flush();
    }
    this.time = end;
    await flush();
  }
}

function scenario(overrides = {}, load = async () => ({})) {
  const clock = new Clock();
  let state = { session: 1, room: 'ABC123', revision: 1, status: 'playing', turn: 'O', side: 'X', rematch: [], visible: true, online: true, busy: false, ...overrides };
  const calls = [], updates = [], errors = [];
  const poller = new RoomPoller({
    getState: () => state,
    load: (snapshot, signal) => { calls.push({ time: clock.time, snapshot: { ...snapshot }, signal }); return load(snapshot, signal); },
    onData: data => { updates.push(data); if (data.game) state = { ...state, ...data.game }; },
    onError: (error, options) => errors.push({ error, ...options }),
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, random: () => 0,
  });
  return { clock, poller, calls, updates, errors, get state() { return state; }, set state(value) { state = value; } };
}

test('a player on their own turn makes no periodic requests', async () => {
  const s = scenario({ turn: 'X' });
  assert.equal(needsRoomUpdates(s.state), false);
  s.poller.sync();
  await s.clock.tick(60000);
  assert.equal(s.calls.length, 0);
});

test('an idle opponent turn stays responsive with at most 16 checks per minute', async t => {
  const s = scenario();
  s.poller.sync();
  await s.clock.tick(60000);
  assert(s.calls.length >= 8 && s.calls.length <= 16);
  assert(s.calls[0].time <= 1500);
  const gaps = s.calls.slice(1).map((call, index) => call.time - s.calls[index].time);
  assert(gaps.every(gap => gap <= 5500));
  assert(gaps.at(-1) > gaps[0]);
  t.diagnostic(`Idle opponent: ${s.calls.length} requests in 60 seconds; own turn: 0.`);
});

test('empty lobbies and finished games use slower idle schedules', async () => {
  for (const status of ['waiting', 'finished']) {
    const s = scenario({ status });
    s.poller.sync();
    await s.clock.tick(60000);
    assert(s.calls.length > 0 && s.calls.length <= 12, status);
  }
  const state = { status: 'finished', side: 'X', rematch: [] };
  assert(pollDelay({ ...state, rematch: ['X'] }, { random: () => 0 }) < pollDelay(state, { random: () => 0 }));
});

test('receiving the opponent move updates the revision and stops on our turn', async () => {
  const s = scenario({}, async () => ({ game: { revision: 2, status: 'playing', turn: 'X' } }));
  s.poller.sync();
  await s.clock.tick(60000);
  assert.equal(s.calls.length, 1);
  assert.equal(s.state.revision, 2);
});

test('a completed POST resumes checks at the current revision after activity', async () => {
  const s = scenario({ turn: 'X' });
  s.poller.sync();
  s.state.busy = true;
  s.poller.pause();
  await s.clock.tick(10000);
  assert.equal(s.calls.length, 0);
  s.state = { ...s.state, turn: 'O', revision: 8, busy: false };
  s.poller.sync({ reset: true });
  await s.clock.tick(1200);
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].snapshot.revision, 8);
});

test('hidden and offline pages make no checks and resume on return', async () => {
  for (const property of ['visible', 'online']) {
    const s = scenario({ [property]: false });
    s.poller.sync();
    await s.clock.tick(60000);
    assert.equal(s.calls.length, 0, property);
    s.state[property] = true;
    s.poller.sync({ immediate: true, force: true });
    await s.clock.tick(0);
    assert.equal(s.calls.length, 1, property);
  }
});

test('pausing aborts an in-flight request and ignores its late response', async () => {
  let resolve;
  const s = scenario({}, () => new Promise(done => { resolve = done; }));
  s.poller.sync();
  await s.clock.tick(1200);
  s.state.visible = false;
  s.poller.sync();
  assert.equal(s.calls[0].signal.aborted, true);
  resolve({ game: { revision: 99 } });
  await s.clock.tick(60000);
  assert.equal(s.calls.length, 1);
  assert.equal(s.updates.length, 0);
  assert.equal(s.errors.length, 0);
});

test('changing session rejects stale data even when rejoining the same room', async () => {
  let resolve;
  const s = scenario({}, () => new Promise(done => { resolve = done; }));
  s.poller.sync();
  await s.clock.tick(1200);
  s.state = { ...s.state, session: 2, revision: 5, turn: 'X' };
  s.poller.sync();
  resolve({ game: { revision: 3 } });
  await s.clock.tick(60000);
  assert.equal(s.state.revision, 5);
  assert.equal(s.updates.length, 0);
});

test('focus/visibility bursts never overlap requests or bypass a one-second cooldown', async () => {
  let resolve;
  const s = scenario({}, () => new Promise(done => { resolve = done; }));
  for (let i = 0; i < 5; i++) s.poller.sync({ immediate: true, force: true });
  await s.clock.tick(0);
  for (let i = 0; i < 5; i++) s.poller.sync({ immediate: true, force: true });
  assert.equal(s.calls.length, 1);
  resolve({});
  await flush();
  s.poller.sync({ immediate: true, force: true });
  await s.clock.tick(999);
  assert.equal(s.calls.length, 1);
  await s.clock.tick(1);
  assert.equal(s.calls.length, 2);
});

test('server failures back off instead of retrying in a tight loop', async () => {
  const s = scenario({}, async () => { throw Object.assign(Error('busy'), { status: 503 }); });
  s.poller.sync();
  await s.clock.tick(100000);
  const gaps = s.calls.slice(1).map((call, index) => call.time - s.calls[index].time);
  assert.deepEqual(gaps.slice(0, 4), [2000, 4000, 8000, 16000]);
  assert(gaps.slice(4).every(gap => gap === 30000));
  assert(s.calls.length <= 8);
});

test('Retry-After applies to background retries and explicit refreshes', async () => {
  const s = scenario({}, async () => { throw Object.assign(Error('rate limited'), { status: 429, retryAfterMs: 15000 }); });
  s.poller.sync({ immediate: true });
  await s.clock.tick(0);
  s.poller.sync({ immediate: true, force: true });
  await s.clock.tick(14999);
  assert.equal(s.calls.length, 1);
  await s.clock.tick(1);
  assert.equal(s.calls.length, 2);
  const post = scenario({ turn: 'X' });
  post.poller.sync({ immediate: true, force: true, retryAfter: 10000 });
  await post.clock.tick(9999);
  assert.equal(post.calls.length, 0);
  await post.clock.tick(1);
  assert.equal(post.calls.length, 1);
});

test('expired rooms stop permanently until a new session starts', async () => {
  const s = scenario({}, async () => { throw Object.assign(Error('expired'), { status: 404 }); });
  s.poller.sync();
  await s.clock.tick(1200);
  s.poller.sync({ reset: true, immediate: true, force: true });
  await s.clock.tick(60000);
  assert.equal(s.calls.length, 1);
  assert.equal(s.errors[0].terminal, true);
  s.state.session++;
  s.poller.sync({ immediate: true });
  await s.clock.tick(0);
  assert.equal(s.calls.length, 2);
});

test('a hung fetch is aborted and can retry without overlapping the old fetch', async () => {
  const s = scenario({}, (_, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })));
  s.poller.sync();
  await s.clock.tick(11200);
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].signal.aborted, true);
  assert.equal(s.errors.length, 1);
  await s.clock.tick(2000);
  assert.equal(s.calls.length, 2);
});

test('stopping polling leaves no work running for a departed room', async () => {
  const s = scenario();
  s.poller.sync();
  s.poller.stop();
  s.state = null;
  await s.clock.tick(60000);
  assert.equal(s.calls.length, 0);
});

test('Retry-After supports seconds and HTTP dates and rejects invalid values', () => {
  const now = Date.parse('2026-11-08T00:00:00Z');
  assert.equal(retryAfterMs('7', now), 7000);
  assert.equal(retryAfterMs('Sun, 08 Nov 2026 00:00:15 GMT', now), 15000);
  assert.equal(retryAfterMs('bad-date', now), 0);
  assert.equal(retryAfterMs(null, now), 0);
  assert.equal(retryAfterMs('9999999999', now), 2147483647);
});
