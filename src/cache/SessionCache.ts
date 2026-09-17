import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { SessionSummary, TurnModel, Validator } from '../net/types.js';

// L2 persistence (decision D3). Persists the projected list + the most-recent
// sessions' materialized turns so a cold reload paints instantly with 0 network.
// Both stores are bounded by evict.ts — turns to ~50 sessions, list rows to one
// sidebar page. Authoritative for DISPLAY; the server stays authoritative for
// TRUTH (the SyncEngine reconciles).

const DB_NAME = 'chat-core';
const DB_VERSION = 4;

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
}

/** Everything hydrated from the cache on boot, for an instant first paint. */
export interface HydratedCache {
  list: SessionSummary[];
  turns: Map<string, TurnModel>;
  validators: Map<string, Validator>;
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
    { model: TurnModel; timer: ReturnType<typeof setTimeout> }
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
        upgrade(db, oldVersion, _newVersion, transaction) {
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
          // Version 3 drops the stream resume points version 2 stored. Nothing read
          // them: resuming a stream from a page was withdrawn on 2026-08-27 (see
          // SyncEngine.streamCursors), and the store only grew.
          // Typed as a plain string: the schema no longer names this store.
          if ((db.objectStoreNames as DOMStringList).contains('streamResume')) {
            (db as unknown as IDBDatabase).deleteObjectStore('streamResume');
          }
          // Version 4 empties the cached transcripts a build before `Entry.origin` wrote.
          // Their live rows carry no stamp, so the merge would read them as page history
          // and draw the prompt twice one last time. The next page fetch refills them.
          if (oldVersion > 0 && oldVersion < 4) {
            void transaction.objectStore('turns').clear();
            void transaction.objectStore('validators').clear();
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

  async putTurns(model: TurnModel): Promise<void> {
    if (!this.enabled) return;
    const db = await this.db();
    // One transaction, so a transcript never lands without the validator row
    // `turnKeys` reads its timestamp from.
    const tx = db.transaction(['turns', 'validators'], 'readwrite');
    await Promise.all([
      tx.objectStore('turns').put(model),
      tx.objectStore('validators').put({ sessionId: model.sessionId, ...model.validator }),
      tx.done,
    ]);
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
  scheduleTurnsWrite(model: TurnModel): void {
    if (!this.enabled) return;
    const queued = this.queuedTurnWrites.get(model.sessionId);
    if (queued) {
      // A timer is already running for this session: keep it, take the newer model.
      // Restarting the timer instead would let a busy stream defer the write forever.
      queued.model = model;
      return;
    }
    const timer = setTimeout(() => {
      const pending = this.queuedTurnWrites.get(model.sessionId);
      this.queuedTurnWrites.delete(model.sessionId);
      if (pending) void this.putTurns(pending.model);
    }, SessionCache.TURNS_WRITE_COALESCE_MS);
    this.queuedTurnWrites.set(model.sessionId, { model, timer });
  }

  /** Write every queued model now. Called when a stream ends, so the last state of a
   *  finished turn reaches the cache instead of waiting out a timer nobody is left to
   *  fire. Safe to call when nothing is queued. */
  async flushTurnsWrites(): Promise<void> {
    const queued = [...this.queuedTurnWrites.values()];
    this.queuedTurnWrites.clear();
    for (const entry of queued) clearTimeout(entry.timer);
    await Promise.all(queued.map((entry) => this.putTurns(entry.model)));
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
      return { list: [], turns: new Map(), validators: new Map() };
    }
    const db = await this.db();
    const [listRows, turnRows, validatorRows] = await Promise.all([
      db.getAll('list'),
      db.getAll('turns'),
      db.getAll('validators'),
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
    return { list, turns, validators };
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

  /** Enumerate cached turn sessionIds + their updatedAt, for the evictor.
   *
   *  The ids come from the `turns` store's KEYS and the timestamps from the small
   *  `validators` rows, so no transcript is read. This used to `getAll('turns')`, which
   *  structured-cloned every cached transcript — up to 50, a megabyte or more each —
   *  onto the main thread; the evictor did that twice per sweep, every 15 seconds, in an
   *  idle tab too, only to learn ids and timestamps.
   *
   *  A transcript with no validator row can only come from a write interrupted before
   *  `putTurns` became one transaction. It reports an empty `updatedAt`, which sorts
   *  oldest, so it is the first thing evicted rather than a row nothing can reach. */
  async turnKeys(): Promise<{ sessionId: string; updatedAt: string }[]> {
    if (!this.enabled) return [];
    const db = await this.db();
    const [ids, validators] = await Promise.all([
      db.getAllKeys('turns'),
      db.getAll('validators'),
    ]);
    const updatedAtBySession = new Map(validators.map((v) => [v.sessionId, v.updatedAt]));
    return ids.map((sessionId) => ({
      sessionId,
      updatedAt: updatedAtBySession.get(sessionId) ?? '',
    }));
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
