/**
 * One bar at the top of a phone, not two.
 *
 * Every screen in this app grew its own header — an icon, its name, a line of
 * explanation, and its buttons — back when the only shell around it was a
 * sidebar. On a phone that shell is a title bar of its own, so Theatre showed
 * "LANTern" and then, directly underneath, "Theatre" with a search box and
 * three buttons: two bars of chrome above a screen 375px wide, and the
 * explanation truncated to nothing in the middle of them.
 *
 * So on a phone a screen's header does not draw itself. It sends its buttons
 * up into the app's title bar, beside the name, and the app bar is the only
 * bar. On a wide window nothing changes: the sidebar is the navigation, the
 * screen's own header is where it always was, and this renders inline.
 *
 * A portal rather than a store field holding a React node. Actions are markup
 * with handlers closed over the screen's own state; putting them in zustand
 * would make every screen's buttons a dependency of every other screen's
 * render, and the node would outlive the screen that made it.
 */
import React from 'react';
import { createPortal } from 'react-dom';

import { cn } from '../lib/utils';
import { useIsMobile } from '../lib/hooks';

const SLOT_ID = 'lantern-header-actions';

/** Where a screen's buttons land. Rendered once, by the app's title bar. */
export function HeaderSlot({ className }: { className?: string }) {
  return <div id={SLOT_ID} className={cn('flex items-center gap-1', className)} />;
}

/**
 * The slot element, once it exists.
 *
 * A screen mounts in the same commit as the bar it is portalling into, so the
 * first render finds nothing. The effect runs after that commit and the
 * second render finds it — which is one frame with no buttons, and not a
 * frame with the buttons in the wrong place.
 */
function useSlot(): HTMLElement | null {
  const [node, setNode] = React.useState<HTMLElement | null>(null);
  React.useEffect(() => setNode(document.getElementById(SLOT_ID)), []);
  return node;
}

export function HeaderActions({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const mobile = useIsMobile();
  const slot = useSlot();

  if (mobile) return slot ? createPortal(children, slot) : null;
  return <div className={cn('flex items-center gap-2', className)}>{children}</div>;
}

/**
 * A screen's own header, on the windows that still have one.
 *
 * `title` and `hint` are for a wide window. On a phone the app bar already
 * says which screen this is, and the hint is a sentence that has never once
 * fitted — so both are dropped and only `actions` travels.
 */
export function ScreenHeader({
  icon,
  title,
  hint,
  actions,
  children,
}: {
  icon?: React.ReactNode;
  title: string;
  hint?: string;
  /** Goes to the app bar on a phone, and to the right of this bar otherwise. */
  actions?: React.ReactNode;
  /** Stays on this row in both, for anything that is part of the screen. */
  children?: React.ReactNode;
}) {
  const mobile = useIsMobile();

  if (mobile) {
    return (
      <>
        {actions && <HeaderActions>{actions}</HeaderActions>}
        {children && (
          <div className="shrink-0 flex items-center gap-2 px-4 py-2 bg-surface">{children}</div>
        )}
      </>
    );
  }

  return (
    <header className="h-11 shrink-0 border-b border-edge bg-surface flex items-center px-4 gap-3">
      {icon && <span className="text-gold shrink-0">{icon}</span>}
      <span className="text-sm font-semibold shrink-0">{title}</span>
      {hint && <span className="text-2xs text-muted truncate hidden xl:block">{hint}</span>}
      {children}
      {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
    </header>
  );
}
