import { useEffect, useState } from 'react';
import type { ResolveClient } from '../net/ResolveClient.js';
import { useChatContext } from './context.js';

// The id patterns the host's resolver can answer, for the ref-chip matcher.
//
// Read once per resolver and shared: every message a transcript renders asks,
// and the list changes only when a store joins kanban-store's registry. A
// failed read is logged and leaves the matcher on its built-in grammars — the
// chat still draws, and ids of the registered types stay text, which is what
// they were before the list existed.

const patternsByClient = new WeakMap<ResolveClient, Promise<readonly string[]>>();
const loadedByClient = new WeakMap<ResolveClient, readonly string[]>();

function patternsFor(client: ResolveClient): Promise<readonly string[]> {
  let pending = patternsByClient.get(client);
  if (!pending) {
    pending = client.resolvableTypes().then((types) => {
      const patterns = types.flatMap((type) => type.id_patterns);
      loadedByClient.set(client, patterns);
      return patterns;
    });
    // A rejection is not kept, so a later mount tries again.
    pending.catch(() => patternsByClient.delete(client));
    patternsByClient.set(client, pending);
  }
  return pending;
}

/** The resolver's id patterns, or null until they arrive, when the host
 *  configured no resolver, or when the read failed. Pass the result to
 *  `parseRefChips` / `remarkRefChips` as `resolvableIdPatterns`. */
export function useResolvableIdPatterns(): readonly string[] | null {
  const { resolve } = useChatContext();
  const [patterns, setPatterns] = useState<readonly string[] | null>(() =>
    resolve ? (loadedByClient.get(resolve) ?? null) : null,
  );
  useEffect(() => {
    if (!resolve) return;
    let live = true;
    patternsFor(resolve).then(
      (loaded) => {
        if (live) setPatterns(loaded);
      },
      (error: unknown) => {
        console.error('chat-core: could not read the id patterns the reference resolver answers:', error);
      },
    );
    return () => {
      live = false;
    };
  }, [resolve]);
  return patterns;
}
