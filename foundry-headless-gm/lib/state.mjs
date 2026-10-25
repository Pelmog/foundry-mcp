import { EventEmitter } from 'node:events';

export class WorkerState extends EventEmitter {
  constructor() {
    super();
    this.value = { state: 'starting', generation: 0, since: new Date().toISOString() };
    this.page = null;
    this.tabId = null;
    this.generationReserved = false;
  }

  snapshot() { return { ...this.value }; }

  meta() {
    const { worldId, userId, userName, generation } = this.value;
    return { worldId: worldId ?? null, userId: userId ?? null,
      userName: userName ?? null, tabId: this.tabId, generation };
  }

  transition(state, fields = {}, page = null, { reserveGeneration = false } = {}) {
    const previous = this.value;
    this.page = state === 'ready' ? page : null;
    this.tabId = state === 'ready' ? fields.tabId : null;
    const { tabId: _tabId, ...statusFields } = fields;
    this.value = {
      ...statusFields, state,
      generation: previous.generation + (reserveGeneration || (state === 'ready' && !this.generationReserved) ? 1 : 0),
      since: state === previous.state && state !== 'ready'
        ? previous.since : new Date().toISOString()
    };
    // Recovery invalidates the old generation immediately. The replacement page
    // consumes that generation on readiness rather than incrementing it twice.
    this.generationReserved = reserveGeneration || (state !== 'ready' && this.generationReserved);
    this.emit('change', this.snapshot());
  }
}
