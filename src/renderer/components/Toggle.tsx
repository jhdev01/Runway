import React from 'react';

interface Props {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  ariaLabel?: string;
  title?: string;
}

/**
 * Pill-style switch matching the rest of the app's outlined-on-dark
 * vocabulary. Use instead of a native <input type="checkbox"> for any
 * binary preference — the OS checkbox looks foreign on the Runway UI.
 */
export function Toggle({ checked, onChange, disabled, ariaLabel, title }: Props) {
  return (
    <button
      type="button"
      className={`toggle-switch ${checked ? 'on' : ''}`}
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      title={title}
      disabled={disabled}
      onClick={() => { if (!disabled) onChange(!checked); }}
    >
      <span className="toggle-thumb" aria-hidden />
    </button>
  );
}
