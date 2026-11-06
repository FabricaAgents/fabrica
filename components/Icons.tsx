// Small line icons drawn for Fabrica. One stroke weight, 24px grid.
import type { ToolName } from '../shared/types';

const P = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

export const IconX = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path fill="currentColor" d="M17.75 3h3.07l-6.7 7.66L22 21h-6.17l-4.83-6.32L5.47 21H2.4l7.17-8.2L2 3h6.33l4.37 5.77zm-1.08 16.17h1.7L7.4 4.73H5.58z" />
  </svg>
);
export const IconSun = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" {...P}>
    <circle cx="12" cy="12" r="4.2" />
    <path d="M12 2.5v2.2M12 19.3v2.2M4.6 4.6l1.6 1.6M17.8 17.8l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.6 19.4l1.6-1.6M17.8 6.2l1.6-1.6" />
  </svg>
);
export const IconMoon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" {...P}>
    <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" />
  </svg>
);
export const IconMenu = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" {...P}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </svg>
);
export const IconClose = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" {...P}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);
export const IconArrow = ({ className = 'arrow' }: { className?: string }) => (
  <svg className={className} width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" {...P}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
);
export const IconCheck = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" {...P} strokeWidth={2.2}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </svg>
);
export const IconCross = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" {...P} strokeWidth={2.2}>
    <path d="M7 7l10 10M17 7L7 17" />
  </svg>
);
export const IconShield = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" {...P}>
    <path d="M12 3l7.5 3v5.5c0 4.6-3.2 8.3-7.5 9.5-4.3-1.2-7.5-4.9-7.5-9.5V6z" />
    <path d="M8.8 12.2l2.2 2.2 4.2-4.4" />
  </svg>
);
export const IconWallet = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" {...P}>
    <rect x="3" y="6" width="18" height="13" rx="2.5" />
    <path d="M3 9.5h18M16 14h2" />
    <path d="M6 6V5a2 2 0 0 1 2-2h8" />
  </svg>
);
export const IconReceipt = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" {...P}>
    <path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" />
    <path d="M9 8h6M9 12h6M9 16h3" />
  </svg>
);
export const IconFlame = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" {...P}>
    <path d="M12 21c-3.9 0-6.5-2.6-6.5-6.2 0-3.4 2.3-5.4 3.6-7.8.5 1.9 1.6 3 2.7 3.6C12 7.8 13.6 5 15.6 3c.4 3.3 2.9 5.5 2.9 10 0 4.3-2.7 8-6.5 8z" />
  </svg>
);
export const IconCopy = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" {...P}>
    <rect x="8" y="8" width="12" height="12" rx="2" />
    <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
  </svg>
);

export function ToolIcon({ tool }: { tool: ToolName | string }) {
  switch (tool) {
    case 'web_fetch':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" {...P}>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M3.5 12h17M12 3.5c2.5 2.6 3.6 5.5 3.6 8.5s-1.1 5.9-3.6 8.5c-2.5-2.6-3.6-5.5-3.6-8.5S9.5 6.1 12 3.5z" />
        </svg>
      );
    case 'code_run':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" {...P}>
          <path d="M8.5 7.5L4 12l4.5 4.5M15.5 7.5L20 12l-4.5 4.5M13.5 5l-3 14" />
        </svg>
      );
    case 'solana_read':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" {...P}>
          <path d="M6.5 6h13l-2 3h-13zM4.5 10.5h13l2 3h-13zM6.5 15h13l-2 3h-13z" />
        </svg>
      );
    case 'file_output':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" {...P}>
          <path d="M6 3h8l4 4v14H6z" />
          <path d="M14 3v4h4M12 11v6M9.5 14.5L12 17l2.5-2.5" />
        </svg>
      );
    default:
      return null;
  }
}

export const TOOL_LABEL: Record<string, string> = {
  web_fetch: 'Web fetch',
  code_run: 'Code runner',
  solana_read: 'Solana reads',
  file_output: 'File output',
};
export const IconRemix = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" {...P}>
    <circle cx="6" cy="5.5" r="2.2" />
    <circle cx="6" cy="18.5" r="2.2" />
    <circle cx="18" cy="12" r="2.2" />
    <path d="M6 7.7v8.6M6 10.5c0 2.2 1.6 3.5 4 3.5h3.2a2.6 2.6 0 0 0 2.6-2" />
  </svg>
);
