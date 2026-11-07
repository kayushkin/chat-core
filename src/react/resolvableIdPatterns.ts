import { useEffect, useState } from 'react';
import type { ResolveClient } from '../net/ResolveClient.js';
import {
  isResolvableReferenceType,
  type ReferenceStoreClient,
  type ReferenceType,
} from '../net/ReferenceStoreClient.js';
import { useChatContext } from './context.js';

// The list of reference types and the id patterns the ref-chip matcher spots.
//
// Read once per client and shared: every message a transcript renders asks,
// and the list changes only when a store joins reference-store's list. A
// failed read is logged and leaves the matcher on its built-in grammars — the
// chat still draws, and ids of the registered types stay text, which is what
// they were before the list existed.

const typesByClient = new WeakMap<ReferenceStoreClient, Promise<readonly ReferenceType[]>>();
const loadedTypesByClient = new WeakMap<ReferenceStoreClient, ReadonlyMap<string, ReferenceType>>();
const patternsByResolver = new WeakMap<ResolveClient, Promise<readonly string[]>>();
const loadedPatternsByResolver = new WeakMap<ResolveClient, readonly string[]>();

function typesFor(client: ReferenceStoreClient): Promise<readonly ReferenceType[]> {
  let pending = typesByClient.get(client);
  if (!pending) {
    pending = client.types().then((types) => {
      loadedTypesByClient.set(client, new Map(types.map((type) => [type.type, type])));
      return types;
    });
    // A rejection is not kept, so a later mount tries again.
    pending.catch(() => typesByClient.delete(client));
    typesByClient.set(client, pending);
  }
  return pending;
}

const patternsByTypes = new WeakMap<ReadonlyMap<string, ReferenceType>, readonly string[]>();

/** One array per loaded list, so a consumer's memo sees the same patterns
 *  from render to render. */
function patternsOf(types: ReadonlyMap<string, ReferenceType>): readonly string[] {
  let patterns = patternsByTypes.get(types);
  if (!patterns) {
    const collected: string[] = [];
    for (const type of types.values()) {
      if (isResolvableReferenceType(type)) collected.push(...(type.id_patterns ?? []));
    }
    patterns = collected;
    patternsByTypes.set(types, patterns);
  }
  return patterns;
}

/** The old resolver's patterns, for a host that has not moved to
 *  reference-store yet. Goes with the old resolver. */
function resolverPatternsFor(client: ResolveClient): Promise<readonly string[]> {
  let pending = patternsByResolver.get(client);
  if (!pending) {
    pending = client.resolvableTypes().then((types) => {
      const patterns = types.flatMap((type) => type.id_patterns);
      loadedPatternsByResolver.set(client, patterns);
      return patterns;
    });
    pending.catch(() => patternsByResolver.delete(client));
    patternsByResolver.set(client, pending);
  }
  return pending;
}

/** Every reference type by name, or null until the list arrives, when the
 *  host configured no reference-store, or when the read failed. A chip reads
 *  its type's label field, summary fields and glyph from here. */
export function useReferenceTypes(): ReadonlyMap<string, ReferenceType> | null {
  const { references } = useChatContext();
  const [types, setTypes] = useState<ReadonlyMap<string, ReferenceType> | null>(() =>
    references ? (loadedTypesByClient.get(references) ?? null) : null,
  );
  useEffect(() => {
    if (!references) return;
    let live = true;
    typesFor(references).then(
      () => {
        if (live) setTypes(loadedTypesByClient.get(references) ?? null);
      },
      (error: unknown) => {
        console.error('chat-core: could not read reference-store\'s list of types:', error);
      },
    );
    return () => {
      live = false;
    };
  }, [references]);
  return types;
}

/** The id patterns the matcher spots, or null until they arrive, when the
 *  host configured nowhere to look ids up, or when the read failed. Pass the
 *  result to `parseRefChips` / `remarkRefChips` as `resolvableIdPatterns`. */
export function useResolvableIdPatterns(): readonly string[] | null {
  const { resolve, references } = useChatContext();
  const types = useReferenceTypes();
  const [resolverPatterns, setResolverPatterns] = useState<readonly string[] | null>(() =>
    resolve ? (loadedPatternsByResolver.get(resolve) ?? null) : null,
  );
  useEffect(() => {
    if (references || !resolve) return;
    let live = true;
    resolverPatternsFor(resolve).then(
      (loaded) => {
        if (live) setResolverPatterns(loaded);
      },
      (error: unknown) => {
        console.error('chat-core: could not read the id patterns the reference resolver answers:', error);
      },
    );
    return () => {
      live = false;
    };
  }, [resolve, references]);
  if (references) return types ? patternsOf(types) : null;
  return resolverPatterns;
}
