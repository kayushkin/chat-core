import type { JSX, ReactNode } from 'react';
import type { RefKind } from '../reduce/refChips.js';

/** Props for the {@link RefChip} renderer. When used as a ReactMarkdown custom
 *  component the mdast hProperties (`kind` / `refId`) arrive as props; rehype may
 *  lowercase the attribute, so `refid` is accepted too. Extra props are ignored. */
export interface RefChipProps {
  kind?: RefKind | string;
  refId?: string;
  /** Lowercased alias react-markdown/rehype may pass instead of `refId`. */
  refid?: string;
  className?: string;
  children?: ReactNode;
  /** Optional activation callback (click / Enter) — e.g. open the session or todo. */
  onActivate?: (kind: string, refId: string) => void;
  [key: string]: unknown;
}

/**
 * Minimal, dependency-light renderer for a reference chip. Wire it into
 * ReactMarkdown as the `ref-chip` component alongside `remarkRefChips` so the dash
 * TurnList can linkify bare session ids / todo uuids:
 *
 *   <ReactMarkdown
 *     remarkPlugins={[remarkRefChips]}
 *     components={{ 'ref-chip': RefChip }}
 *   >{text}</ReactMarkdown>
 *
 * It reads `kind` / `refId` from the mdast hProperties (accepting the lowercased
 * `refid`), and renders a `<span>` carrying `data-ref-kind` / `data-ref-id` so all
 * theming stays at the edge (the caller's CSS). Depends only on React.
 */
export function RefChip(props: RefChipProps): JSX.Element {
  const kind = String(props.kind ?? 'session');
  const refId = String(props.refId ?? props.refid ?? '');
  const label = props.children ?? refId;
  const activate = props.onActivate;
  const handleClick = activate ? () => activate(kind, refId) : undefined;
  const handleKey = activate
    ? (e: { key: string; preventDefault: () => void }) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          activate(kind, refId);
        }
      }
    : undefined;

  return (
    <span
      className={props.className ?? `ref-chip ref-chip-${kind}`}
      data-ref-kind={kind}
      data-ref-id={refId}
      role={activate ? 'button' : undefined}
      tabIndex={activate ? 0 : undefined}
      onClick={handleClick}
      onKeyDown={handleKey}
    >
      {label}
    </span>
  );
}
