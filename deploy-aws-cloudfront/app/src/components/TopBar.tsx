import { useEffect, useRef, useState } from 'react';
import { fetchRegions, type RegionList } from '../api.js';
import { currentUser, signOut } from '../auth.js';
import { setRegion, useRegion } from '../region.js';
import { Icon } from './Icon.js';

/** "jane.doe@example.com" -> "JD", "jane@example.com" -> "JA" */
export function initialsOf(email: string): string {
  const parts = (email.split('@')[0] ?? '').split(/[._+-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? parts[0]?.[1] ?? '')).toUpperCase() || '?';
}

/**
 * The region the API Gateway and Lambda panels read. The dashboard's own region is the default, and
 * the only one with recorded deployments to restore; CloudFront is global and the rollbacks stay as they are.
 */
function RegionPicker() {
  const picked = useRegion();
  const [list, setList] = useState<RegionList>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetchRegions(controller.signal).then(
      (regions) => {
        setList(regions);
        // a remembered region the dashboard no longer offers: back to its own
        if (picked && !regions.regions.some((r) => r.code === picked)) setRegion(undefined);
      },
      () => { if (!controller.signal.aborted) setFailed(true); },
    );
    return () => controller.abort();
  }, []);

  const value = picked ?? list?.home ?? '';
  return (
    <label className="picker">
      <span>Region</span>
      <select id="region-picker" value={value} disabled={!list}
        onChange={(e) => setRegion(e.target.value === list?.home ? undefined : e.target.value)}>
        {!list && <option value={value}>{failed ? 'Regions unavailable' : 'Loading regions…'}</option>}
        {list?.regions.map(({ code, name }) => (
          <option key={code} value={code}>{`${code} (${name})${code === list.home ? ' · this dashboard' : ''}`}</option>
        ))}
      </select>
    </label>
  );
}

/** The region picker, refresh, and the signed-in user's menu. */
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
      <RegionPicker />
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
