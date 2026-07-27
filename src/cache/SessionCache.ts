import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { SessionSummary, TurnModel, Validator } from '../net/types.js';

// L2 persistence (decision D3). Persists the projected list + the most-recent
// sessions' materialized turns so a cold reload paints instantly with 0 network.
// Bounded to ~50 recent sessions by evict.ts. Authoritative for DISPLAY; the
// server stays authoritative for TRUTH (the SyncEngine reconciles).

const DB_NAME = 'chat-core';
const DB_VERSION = 1;

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
        upgrade(db) {
          const list = db.createObjectStore('list', { keyPath: 'sessionId' });
          list.createIndex('updatedAt', 'updatedAt');
          db.createObjectStore('turns', { keyPath: 'sessionId' });
          db.createObjectStore('validators', { keyPath: 'sessionId' });
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
    await db.put('turns', model);
    await db.put('validators', { sessionId: model.sessionId, ...model.validator });
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
