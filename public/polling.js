const POLICIES = {
  waiting: { initial: 2000, maximum: 8000 },
  playing: { initial: 1200, maximum: 5000 },
  finished: { initial: 3000, maximum: 10000 },
  rematch: { initial: 1200, maximum: 4000 },
};

function phase(state) {
  if (state.status === 'finished' && state.rematch?.includes(state.side)) return 'rematch';
  return state.status;
}

export function needsRoomUpdates(state) {
  // The API only permits the current player to move. Their successful POST
  // already returns the latest board, so polling on their own turn is redundant.
  return state.status !== 'playing' || state.turn !== state.side;
}

export function pollDelay(state, { unchanged = 0, failures = 0, random = Math.random } = {}) {
  const policy = POLICIES[phase(state)] || POLICIES.waiting;
  const base = failures > 0
    ? Math.min(30000, 2000 * 2 ** Math.min(failures - 1, 5))
    : Math.min(policy.maximum, policy.initial * 1.5 ** Math.min(unchanged, 12));
  // Small per-client jitter prevents idle rooms from checking in lockstep.
  return Math.round(base * (1 + random() * .1));
}

export function retryAfterMs(value, now = Date.now()) {
  if (!value) return 0;
  const seconds = /^\d+$/.test(value) ? Number(value) : null;
  const delay = seconds === null ? Date.parse(value) - now : seconds * 1000;
  return Number.isFinite(delay) ? Math.max(0, Math.min(delay, 2147483647)) : 0;
}

export class RoomPoller {
  constructor({ getState, load, onData, onError, now = Date.now, random = Math.random, setTimer = (fn, delay) => setTimeout(fn, delay), clearTimer = timer => clearTimeout(timer), requestTimeout = 10000 }) {
    Object.assign(this, { getState, load, onData, onError, now, random, setTimer, clearTimer, requestTimeout });
    this.timer = null;
    this.flight = null;
    this.generation = 0;
    this.context = null;
    this.resetProgress();
  }

  resetProgress() {
    this.unchanged = 0;
    this.failures = 0;
    this.retryUntil = 0;
    this.recovering = false;
    this.halted = false;
    this.lastPhase = null;
    this.lastStarted = -Infinity;
  }

  clearScheduled() {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  pause() {
    this.clearScheduled();
    this.generation++;
    if (this.flight) {
      this.clearTimer(this.flight.timeout);
      this.flight.controller.abort();
      this.flight = null;
    }
  }

  stop() {
    this.pause();
    this.context = null;
    this.resetProgress();
  }

  available(state) {
    return Boolean(state && state.visible && state.online && !state.busy);
  }

  contextOf(state) {
    return state ? `${state.session}:${state.room}` : null;
  }

  sync({ reset = false, immediate = false, force = false, retryAfter = 0 } = {}) {
    this.clearScheduled();
    const state = this.getState();
    const context = this.contextOf(state);
    if (context !== this.context) {
      this.stop();
      this.context = context;
    }
    // An expired/invalid room cannot recover by repeatedly fetching it.
    if (this.halted) return;
    if (!this.available(state)) { this.pause(); return; }
    if (this.flight) return;
    if (reset) this.resetProgress();
    this.retryUntil = Math.max(this.retryUntil, this.now() + retryAfter);
    const currentPhase = phase(state);
    if (currentPhase !== this.lastPhase) { this.unchanged = 0; this.lastPhase = currentPhase; }
    force ||= this.recovering;
    if (!force && !needsRoomUpdates(state)) return;
    const delay = immediate
      ? Math.max(0, 1000 - (this.now() - this.lastStarted))
      : pollDelay(state, { unchanged: this.unchanged, failures: this.failures, random: this.random });
    const wait = Math.max(delay, this.retryUntil - this.now());
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.run(force);
    }, wait);
  }

  async run(force) {
    const state = this.getState();
    if (this.flight || this.halted || !this.available(state) || this.contextOf(state) !== this.context) return;
    if (!force && !needsRoomUpdates(state)) return;
    const ticket = { controller: new AbortController(), generation: this.generation, timeout: null };
    this.flight = ticket;
    this.lastStarted = this.now();
    const isCurrent = () => this.flight === ticket && ticket.generation === this.generation && this.contextOf(this.getState()) === this.context;
    ticket.timeout = this.setTimer(() => ticket.controller.abort(new Error('Hết thời gian kiểm tra phòng.')), this.requestTimeout);
    try {
      const result = await this.load(state, ticket.controller.signal);
      if (!isCurrent()) return;
      this.failures = 0;
      this.retryUntil = 0;
      this.recovering = false;
      this.unchanged = result.game && result.game.revision !== state.revision ? 0 : this.unchanged + 1;
      this.onData(result);
    } catch (error) {
      if (!isCurrent()) return;
      this.failures++;
      this.recovering = true;
      this.retryUntil = this.now() + (error.retryAfterMs || 0);
      this.halted = [400, 403, 404, 410].includes(error.status);
      this.onError(error, { terminal: this.halted });
    } finally {
      this.clearTimer(ticket.timeout);
      if (this.flight === ticket) {
        this.flight = null;
        this.sync();
      }
    }
  }
}
