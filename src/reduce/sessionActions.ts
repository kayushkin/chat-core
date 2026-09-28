import type { Entry, SessionAction } from '../net/types.js';

/**
 * The newest record of every session action among `entries`, by `action_id`.
 *
 * Each change to an action arrives as its own `session_action` entry carrying the whole
 * record, so a button drawn at its offer reads its current state from here rather than
 * from the offer entry, which stays `offered` for good. Newest is the highest event id,
 * which is the order the server wrote them in.
 */
export function newestSessionActions(entries: Iterable<Entry>): Map<string, SessionAction> {
  const newest = new Map<string, { eventId: number; action: SessionAction }>();
  for (const entry of entries) {
    const action = entry.sessionAction;
    if (entry.kind !== 'action' || !action) continue;
    const seen = newest.get(action.action_id);
    if (!seen || entry.eventId > seen.eventId) newest.set(action.action_id, { eventId: entry.eventId, action });
  }
  return new Map([...newest].map(([actionId, { action }]) => [actionId, action]));
}
