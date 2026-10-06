import { Icon } from './Icon.js';

/** Account and region pickers, refresh and user menu (visual only for now). */
export function TopBar({ lastUpdated }: { lastUpdated: string }) {
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
        <button type="button" className="avatar" aria-label="Account menu">JD<Icon name="chevronDown" size={16} /></button>
      </div>
    </header>
  );
}
