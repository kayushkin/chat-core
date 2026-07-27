# chat-core public API

The surface the dashv2 page consumes. The client implementation (`src/react/*`, `src/store/*`)
must export exactly these; the dash page imports only these. Kept stable so the page and the
library can be built in parallel.

```ts
import type { ReactNode } from 'react';
import type { SessionSummary, TurnModel, Entry, Turn } from '@kayushkin/chat-core';

// ---- Provider ----
export interface ChatProviderProps {
  fetch: typeof fetch;          // dash passes its cookie-credentialed apiFetch
  basePath: string;             // '/api/bridge'
  recentN?: number;             // warm-cache size, default 20
  turnsPerBundle?: number;      // last-N turns per bundled session, default 30
  cache?: boolean;              // enable IndexedDB persistence, default true
  children: ReactNode;
}
export function ChatProvider(props: ChatProviderProps): JSX.Element;

// ---- Selectors / hooks (all read from the in-memory store; no network on the hot path) ----

// Sidebar list, already filtered + grouped + sorted by the current filter/folder state.
export function useSessionList(): {
  groups: { folder: string; sessions: SessionSummary[] }[];
  total: number;
  loading: boolean;
};

// Active session id + setter. select() is synchronous: it swaps the active id and renders
// from cache immediately (sub-10ms); any needed fetch/reconcile happens in the background.
export function useActiveSession(): {
  id: string | null;
  select: (id: string) => void;
  summary: SessionSummary | null;
};

// Turns for a session. `view: 'turns'` = collapsed (dupes hidden); `view: 'raw'` = every
// entry incl. duplicates, ordered by eventId. `sourcesFor(entryId)` returns the group's
// members for the sources badge. Never throws on a cold session — returns loading + triggers
// a background tail fetch.
export function useTurns(sessionId: string | null, view?: 'turns' | 'raw'): {
  turns: Turn[];
  entries: Record<string, Entry>;
  visibleEntryIds: (turnId: string) => string[]; // respects `view`
  sourcesFor: (entryId: string) => Entry[];       // all copies in the entry's group
  loading: boolean;
  more: boolean;
  loadOlder: () => void;
};

// Composer for a session (or the pending/new pane). Optimistic: append() shows the user
// text instantly and reconciles the message id after POST. Creating the real session is
// lazy on first send for a pending pane.
export function useComposer(sessionId: string | null): {
  send: (text: string) => void;
  draft: string;
  setDraft: (t: string) => void;
  sending: boolean;
};

// Filters + folders (client-side over the loaded list; switching is sub-10ms).
export function useFilters(): {
  filter: FilterState;
  set: (patch: Partial<FilterState>) => void;
  openFolder: (folder: string) => void;
};

// Optimistic mutations. Each updates the store first, POSTs in the background, reverts on error.
export function useSessionActions(): {
  newSession: (opts?: { instanceId?: string; harness?: string }) => void; // opens pending pane, 0 network
  archive: (id: string) => void;
  unarchive: (id: string) => void;
  rename: (id: string, name: string) => void;
};

// Prefetch hint (call on sidebar row hover) — warms a cold session so the click is instant.
export function usePrefetch(): (sessionId: string) => void;

export interface FilterState {
  harness: string | null;
  status: string | null;
  type: string | null;
  purpose: string | null;
  mode: string | null;
  folder: string | null; // e.g. 'archive'
  search: string;
}
```

Notes for implementers:
- All hooks read via Zustand selector subscriptions so only components whose slice changed
  re-render.
- `select()` / filter changes / `newSession` / `archive` must never await the network on the
  path that updates the UI.
- `useTurns(view:'raw')` and `sourcesFor` are the audit surface — they must expose every
  stored copy (see WIRE.md non-destructive dedup).
