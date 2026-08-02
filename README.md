# @kayushkin/chat-core

Framework-light data layer for the **dashv2** chat surface. The client renders from memory;
the network only reconciles in the background. Powers sub-10ms session switching, a warm
cache of the most-recent sessions, optimistic mutations, and **non-destructive** OTel/rollout
dedup (every source is kept and auditable — dedup only annotates the collapsed view).

- Design: `../dash/docs/dashv2-architecture.md`
- Baseline measurements + plan: `../dash/docs/dashv2-perf-plan.md`
- Wire contract (Go ↔ TS): `docs/WIRE.md`
- Public API (what the page consumes): `docs/PUBLIC-API.md`

## Layers
```
L0 render memo   virtualization + per-turn React.memo
L1 hot store     Zustand Maps: working set of sessions' TurnModels — every action renders here
L2 IndexedDB     persists L1 → cold boot paints with 0 network
   localStorage  composer drafts only — read SYNCHRONOUSLY at store construction, because a
                 draft has to be in the first paint and an async hydrate races the typing
   sync engine   1 list-SSE + 1 active-SSE + validator sweep → applies deltas, silent repair
L3 server cache  (in llm-bridge-server) serialized+compressed list & bundle
L4 SQLite        bridge.db + log-store events.db — source of truth
```

## Modules
```
src/store/   ChatStore (Zustand) + selectors + draftStorage (composer drafts → localStorage)
src/reduce/  TurnReducer (live tail, Map-indexed) + otelDedup (annotator) + refChips
src/cache/   SessionCache (IndexedDB via idb) + evict (LRU ~50 sessions)
src/sync/    SyncEngine + sse
src/net/     ApiClient + types (wire contract)
src/boot/    Prefetcher (boot sequence + hover/idle prefetch)
src/react/   ChatProvider + hooks (the public API)
```

## Build
```
npm install && npm run build && npm test
```
