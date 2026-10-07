// A button that opens a small menu of choices under it. The menu is rendered into document.body
// with fixed positioning, so the scrolling tables it sits in don't clip it.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon.js';

export interface MenuItem {
  key: string;
  label: ReactNode;
  /** a second, muted line, e.g. what the alias points to now */
  hint?: ReactNode;
  /** why it can't be chosen; the item is shown but disabled */
  disabledReason?: string;
  onSelect: () => void;
}

export function MenuButton({ label, heading, items, disabledReason, busy }: {
  label: string;
  /** shown at the top of the menu, e.g. "Point an alias to v3" */
  heading: string;
  items: MenuItem[];
  /** the whole button is disabled, with this tooltip */
  disabledReason?: string;
  /** a change is running: the button shows it and stays shut */
  busy?: boolean;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; right: number }>();
  const open = position !== undefined;
  const close = (refocus = true) => {
    setPosition(undefined);
    if (refocus) button.current?.focus();
  };

  function toggle() {
    if (open) return close();
    const rect = button.current!.getBoundingClientRect();
    setPosition({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
  }

  // keep the menu on screen: open upwards when there's no room below
  useLayoutEffect(() => {
    if (!open || !menu.current) return;
    const rect = menu.current.getBoundingClientRect();
    if (rect.bottom > window.innerHeight - 8) {
      const top = Math.max(8, button.current!.getBoundingClientRect().top - rect.height - 4);
      if (top !== position.top) setPosition({ ...position, top });
    }
    // focus the first choice on opening, not again when the menu follows a scroll
    if (!menu.current.contains(document.activeElement)) {
      menu.current.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
    }
  }, [open, position]);

  // close on Escape or a click elsewhere; on scrolling, follow the button (close once it's out of view)
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    const onPointer = (e: PointerEvent) => {
      if (!menu.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) close(false);
    };
    const onScroll = (e: Event) => {
      if (menu.current?.contains(e.target as Node) || !button.current) return;
      const rect = button.current.getBoundingClientRect();
      if (rect.bottom < 0 || rect.top > window.innerHeight) return close(false);
      setPosition({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open]);

  // arrow keys move between the enabled items
  function onMenuKey(e: React.KeyboardEvent) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const enabled = [...menu.current!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')];
    const at = enabled.indexOf(document.activeElement as HTMLButtonElement);
    enabled[(at + (e.key === 'ArrowDown' ? 1 : enabled.length - 1)) % enabled.length]?.focus();
  }

  return (
    <>
      <button ref={button} type="button" className="rollback menu-button" aria-haspopup="menu" aria-expanded={open}
        disabled={!!disabledReason || busy} title={disabledReason}
        onClick={(e) => { e.stopPropagation(); toggle(); }}>
        <Icon name="rollback" size={14} />{busy ? 'Working…' : label}<Icon name="chevronDown" size={14} />
      </button>
      {open && createPortal(
        <div ref={menu} className="menu" role="menu" aria-label={heading} style={{ top: position.top, right: position.right }}
          onKeyDown={onMenuKey}>
          <div className="menu-heading">{heading}</div>
          {items.length === 0 && <div className="menu-empty">Nothing to choose.</div>}
          {items.map((item) => (
            <button key={item.key} type="button" role="menuitem" className="menu-item"
              disabled={!!item.disabledReason} title={item.disabledReason}
              onClick={() => { close(); item.onSelect(); }}>
              <span>{item.label}</span>
              {(item.hint || item.disabledReason) && <span className="menu-hint">{item.disabledReason ?? item.hint}</span>}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
