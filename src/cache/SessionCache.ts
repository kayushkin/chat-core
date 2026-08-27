import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { SessionSummary, TurnModel, Validator } from '../net/types.js';

// L2 persistence (decision D3). Persists the projected list + the most-recent
// sessions' materialized turns so a cold reload paints instantly with 0 network.
// Both stores are bounded by evict.ts — turns to ~50 sessions, list rows to one
// sidebar page. Authoritative for DISPLAY; the server stays authoritative for
// TRUTH (the SyncEngine reconciles).

const DB_NAME = 'chat-core';
const DB_VERSION = 2;

/** A cached list row: the summary plus the updatedAt used for LRU eviction. */
export interface CachedListRow {
  sessionId: string;
  summary: SessionSummary;
  updatedAt: string;
}

interface ChatCoreDB extends DBSchema {
  list: {
    key: string; // sessionId
    value: CachedListRow;
    indexes: { updatedAt: string };
  };
  turns: {
    key: string; // sessionId
    value: TurnModel;
  };
  validators: {
    key: string; // sessionId
    value: Validator & { sessionId: string };
  };
  /** Where each cached session's event stream can be resumed from.
   *
   *  ITS OWN STORE, deliberately, rather than another field on `validators`. A
   *  `Validator` carries log-store ids and this carries llm-bridge-server ids; the two
   *  number the same events independently, and putting both in one record is exactly the
   *  confusion that once made every reconnect resume from a number the server could not
   *  interpret. Separate stores make reaching for the wrong one take effort. */
  streamResume: {
    key: string; // sessionId
    value: { sessionId: string; head: number };
  };
}

/** Everything hydrated from the cache on boot, for an instant first paint. */
export interface HydratedCache {
  list: SessionSummary[];
  turns: Map<string, TurnModel>;
  validators: Map<string, Validator>;
  /** Where each cached session's event stream can be resumed from. A session with no
   *  entry here is opened without a resume point — the server then replays its current
   *  turn, which is correct and merely slower. */
  streamResume: Map<string, number>;
}

export class SessionCache {
  /** How long a live-stream cache write waits for more events before going to disk.
   *
   *  One second: long enough that a turn streaming at token rate produces one write
   *  rather than hundreds, short enough that a tab closed mid-turn loses at most a
   *  second of tail — which the next open refetches anyway. */
  static readonly TURNS_WRITE_COALESCE_MS = 1000;

  /** Models waiting to be written, by session id. At most one per session. */
  private readonly queuedTurnWrites = new Map<
    string,
    { model: TurnModel; streamHead?: number; timer: ReturnType<typeof setTimeout> }
  >();

  private dbPromise: Promise<IDBPDatabase<ChatCoreDB>> | null = null;
  private readonly enabled: boolean;

  constructor(enabled = true) {
    this.enabled = enabled;
  }

  private db(): Promise<IDBPDatabase<ChatCoreDB>> {
    if (!this.enabled) {
      return Promise.reject(new Error('SessionCache disabled'));
    }
    if (!this.dbPromise) {
      this.dbPromise = openDB<ChatCoreDB>(DB_NAME, DB_VERSION, {
        // Each store is created only if absent, so this runs correctly both for a fresh
        // database and for one left at an earlier version by a previous build.
        upgrade(db) {
          if (!db.objectStoreNames.contains('list')) {
            db.createObjectStore('list', { keyPath: 'sessionId' }).createIndex(
              'updatedAt',
              'updatedAt',
            );
          }
          if (!db.objectStoreNames.contains('turns')) {
            db.createObjectStore('turns', { keyPath: 'sessionId' });
          }
          if (!db.objectStoreNames.contains('validators')) {
            db.createObjectStore('validators', { keyPath: 'sessionId' });
          }
          if (!db.objectStoreNames.contains('streamResume')) {
            db.createObjectStore('streamResume', { keyPath: 'sessionId' });
          }
        },
      });
    }
    return this.dbPromise;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  // --- list ---

  async putList(summaries: SessionSummary[]): Promise<void> {
    if (!this.enabled) return;
    const db = await this.db();
    const tx = db.transaction('list', 'readwrite');
    for (const s of summaries) {
      await tx.store.put({ sessionId: s.sessionId, summary: s, updatedAt: s.updatedAt });
    }
    await tx.done;
  }

  async putSummary(summary: SessionSummary): Promise<void> {
    if (!this.enabled) return;
    const db = await this.db();
    await db.put('list', {
      sessionId: summary.sessionId,
      summary,
      updatedAt: summary.updatedAt,
    });
  }

  async getList(): Promise<SessionSummary[]> {
    if (!this.enabled) return [];
    const db = await this.db();
    const rows = await db.getAll('list');
    return rows
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
      .map((r) => r.summary);
  }

  async deleteSession(sessionId: string): Promise<void> {
    if (!this.enabled) return;
    const db = await this.db();
    await Promise.all([
      db.delete('list', sessionId),
      db.delete('turns', sessionId),
      db.delete('validators', sessionId),
    ]);
  }

  // --- turns ---

  /**
   * @param streamHead where this session's event stream can be resumed from, if known.
   *   Cached so a session painted from disk on the next boot still opens its stream with
   *   a resume point instead of having the whole current turn replayed at it. A STALE
   *   head is safe and a missing one is safe; both resume earlier than necessary and
   *   replay events the model already holds, which the reducer folds idempotently. Only
   *   a head that is too HIGH could skip content, and nothing here can produce one — it
   *   is only ever written alongside the model it was read with.
   */
  async putTurns(model: TurnModel, streamHead?: number): Promise<void> {
    if (!this.enabled) return;
    const db = await this.db();
    await db.put('turns', model);
    await db.put('validators', { sessionId: model.sessionId, ...model.validator });
    if (streamHead !== undefined) {
      await db.put('streamResume', { sessionId: model.sessionId, head: streamHead });
    }
  }

  /**
   * Write this model to the cache SOON, coalescing with any write already queued for
   * the same session.
   *
   * For the live stream, which calls this once per event. Writing straight through was
   * costing more than everything else the client does put together: measured
   * 2026-08-26 across eight session opens on the real dashboard, `putTurns` ran 2,449
   * times — about 300 per open, because opening a session replays the current turn and
   * every replayed frame wrote the WHOLE model again. IndexedDB structured-clones its
   * argument on the main thread, so each of those was a full copy of a
   * megabyte-scale object graph, and the main thread was blocked 25.6s over those
   * eight switches.
   *
   * Coalescing is sound here because the cache is not a source of truth. Its only
   * reader is the cold-boot paint (`Prefetcher.hydrateFromCache`), and a cached tail is
   * validated against the server on open anyway (`SyncEngine.revalidateActive`). Being
   * a second behind costs nothing; a stale cache entry is repaired, not trusted.
   *
   * At most one write per session per `TURNS_WRITE_COALESCE_MS`, and it is always the
   * NEWEST model — a later call replaces the queued value rather than adding a write.
   */
  scheduleTurnsWrite(model: TurnModel, streamHead?: number): void {
    if (!this.enabled) return;
    const queued = this.queuedTurnWrites.get(model.sessionId);
    if (queued) {
      // A timer is already running for this session: keep it, take the newer model.
      // Restarting the timer instead would let a busy stream defer the write forever.
      queued.model = model;
      if (streamHead !== undefined) queued.streamHead = streamHead;
      return;
    }
    const timer = setTimeout(() => {
      const pending = this.queuedTurnWrites.get(model.sessionId);
      this.queuedTurnWrites.delete(model.sessionId);
      if (pending) void this.putTurns(pending.model, pending.streamHead);
    }, SessionCache.TURNS_WRITE_COALESCE_MS);
    this.queuedTurnWrites.set(model.sessionId, { model, streamHead, timer });
  }

  /** Write every queued model now. Called when a stream ends, so the last state of a
   *  finished turn reaches the cache instead of waiting out a timer nobody is left to
   *  fire. Safe to call when nothing is queued. */
  async flushTurnsWrites(): Promise<void> {
    const queued = [...this.queuedTurnWrites.values()];
    this.queuedTurnWrites.clear();
    for (const entry of queued) clearTimeout(entry.timer);
    await Promise.all(queued.map((entry) => this.putTurns(entry.model, entry.streamHead)));
  }

  async getTurns(sessionId: string): Promise<TurnModel | undefined> {
    if (!this.enabled) return undefined;
    const db = await this.db();
    return db.get('turns', sessionId);
  }

  // --- validators ---

  async putValidator(sessionId: string, validator: Validator): Promise<void> {
    if (!this.enabled) return;
    const db = await this.db();
    await db.put('validators', { sessionId, ...validator });
  }

  async getValidator(sessionId: string): Promise<Validator | undefined> {
    if (!this.enabled) return undefined;
    const db = await this.db();
    const row = await db.get('validators', sessionId);
    if (!row) return undefined;
    const { sessionId: _omit, ...validator } = row;
    void _omit;
    return validator;
  }

  // --- boot hydrate: everything, in one shot ---

  async hydrate(): Promise<HydratedCache> {
    if (!this.enabled) {
      return { list: [], turns: new Map(), validators: new Map(), streamResume: new Map() };
    }
    const db = await this.db();
    const [listRows, turnRows, validatorRows, resumeRows] = await Promise.all([
      db.getAll('list'),
      db.getAll('turns'),
      db.getAll('validators'),
      db.getAll('streamResume'),
    ]);
    const list = listRows
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
      .map((r) => r.summary);
    const turns = new Map<string, TurnModel>();
    for (const t of turnRows) turns.set(t.sessionId, t);
    const validators = new Map<string, Validator>();
    for (const v of validatorRows) {
      const { sessionId, ...validator } = v;
      validators.set(sessionId, validator);
    }
    const streamResume = new Map<string, number>();
    for (const r of resumeRows) streamResume.set(r.sessionId, r.head);
    return { list, turns, validators, streamResume };
  }

  /** Every list row's sessionId, oldest `updatedAt` first, for the list evictor.
   *  Reads the `updatedAt` INDEX, so it orders the store without deserializing a
   *  single summary — this is the store the bound exists to stop growing, and
   *  reading all of it to decide what to drop would defeat the point. */
  async listKeysOldestFirst(): Promise<string[]> {
    if (!this.enabled) return [];
    const db = await this.db();
    return db.getAllKeysFromIndex('list', 'updatedAt');
  }

  /** Drop list rows, keeping each session's turns and validator. Used by the
   *  list LRU; `deleteSession` is the one that drops all three. */
  async evictListRows(sessionIds: string[]): Promise<void> {
    if (!this.enabled || sessionIds.length === 0) return;
    const db = await this.db();
    const tx = db.transaction('list', 'readwrite');
    for (const id of sessionIds) await tx.store.delete(id);
    await tx.done;
  }

  /** Enumerate cached turn sessionIds + their updatedAt, for the evictor. */
  async turnKeys(): Promise<{ sessionId: string; updatedAt: string }[]> {
    if (!this.enabled) return [];
    const db = await this.db();
    const rows = await db.getAll('turns');
    return rows.map((r) => ({ sessionId: r.sessionId, updatedAt: r.validator.updatedAt }));
  }

  /** Drop a session's turns + validator (keeps the list row). Used by the LRU. */
  async evictTurns(sessionId: string): Promise<void> {
    if (!this.enabled) return;
    const db = await this.db();
    await Promise.all([db.delete('turns', sessionId), db.delete('validators', sessionId)]);
  }

  async close(): Promise<void> {
    if (!this.dbPromise) return;
    const db = await this.dbPromise;
    db.close();
    this.dbPromise = null;
  }
}
