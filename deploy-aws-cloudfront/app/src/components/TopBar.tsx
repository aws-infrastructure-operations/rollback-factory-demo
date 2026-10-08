import { useEffect, useRef, useState } from 'react';
import { currentUser, signOut } from '../auth.js';
import { Icon } from './Icon.js';

/** "jane.doe@example.com" -> "JD", "jane@example.com" -> "JA" */
export function initialsOf(email: string): string {
  const parts = (email.split('@')[0] ?? '').split(/[._+-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? parts[0]?.[1] ?? '')).toUpperCase() || '?';
}

/** Account and region pickers (visual only for now), refresh, and the signed-in user's menu. */
export function TopBar({ lastUpdated }: { lastUpdated: string }) {
  const email = currentUser() ?? '';
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);

  // close the menu on a click elsewhere, or Escape
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => { if (!menu.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <header className="topbar">
      <label className="picker">
        <span>AWS Account</span>
        <select disabled><option>Production (123456789012)</option></select>
      </label>
      <label className="picker">
        <span>Region</span>
        <select disabled><option>eu-west-1 (Ireland)</option></select>
      </label>
      <div className="topbar-end">
        <button type="button" className="icon-button" aria-label="Refresh"><Icon name="refresh" size={16} /></button>
        <div className="updated"><span>Last updated</span><span id="built">{lastUpdated}</span></div>
        <div className="user-menu" ref={menu}>
          <button type="button" id="account-menu" className="avatar" aria-label={`Account menu for ${email}`}
            aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
            {initialsOf(email)}<Icon name="chevronDown" size={16} />
          </button>
          {open && (
            <div className="user-menu-popup" role="menu">
              <div className="user-menu-email" id="signed-in-as">{email}</div>
              <button type="button" role="menuitem" id="sign-out" onClick={() => void signOut()}>Sign out</button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
