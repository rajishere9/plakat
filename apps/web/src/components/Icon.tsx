/**
 * Small inline SVG icon set (24×24, stroke-based, currentColor). No icon dependency.
 * Icons are decorative (aria-hidden); the surrounding control carries the label.
 */
import type { JSX } from 'react';

const P = (d: string) => <path d={d} />;

const ICONS = {
  // navigation / app
  home: (
    <>
      {P('M3.5 10.5 12 4l8.5 6.5')}
      {P('M5.5 9v10.5h13V9')}
      {P('M10 19.5v-5h4v5')}
    </>
  ),
  back: P('M15 5l-7 7 7 7'),
  chevronDown: P('M6 9l6 6 6-6'),
  chevronUp: P('M6 15l6-6 6 6'),
  chevronRight: P('M9 6l6 6-6 6'),
  chevronLeft: P('M15 6l-6 6 6 6'),
  close: (
    <>
      {P('M6 6l12 12')}
      {P('M18 6 6 18')}
    </>
  ),
  plus: (
    <>
      {P('M12 5v14')}
      {P('M5 12h14')}
    </>
  ),
  minus: P('M5 12h14'),
  check: P('M5 12.5l4.5 4.5L19 7.5'),
  more: (
    <>
      <circle cx="5.5" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="18.5" cy="12" r="1.4" fill="currentColor" stroke="none" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      {P('M16 16l4.5 4.5')}
    </>
  ),
  undo: (
    <>
      {P('M9 7 4.5 11.5 9 16')}
      {P('M4.5 11.5H15a4.5 4.5 0 0 1 0 9h-2')}
    </>
  ),
  redo: (
    <>
      {P('M15 7l4.5 4.5L15 16')}
      {P('M19.5 11.5H9a4.5 4.5 0 0 0 0 9h2')}
    </>
  ),
  zoomIn: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      {P('M16 16l4.5 4.5')}
      {P('M11 8v6M8 11h6')}
    </>
  ),
  zoomOut: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      {P('M16 16l4.5 4.5')}
      {P('M8 11h6')}
    </>
  ),
  download: (
    <>
      {P('M12 4v11')}
      {P('M7.5 10.5 12 15l4.5-4.5')}
      {P('M5 19.5h14')}
    </>
  ),
  upload: (
    <>
      {P('M12 15.5V4.5')}
      {P('M7.5 9 12 4.5 16.5 9')}
      {P('M5 19.5h14')}
    </>
  ),
  share: (
    <>
      {P('M12 15V4')}
      {P('M8 8l4-4 4 4')}
      {P('M6 12v7.5h12V12')}
    </>
  ),
  file: (
    <>
      {P('M14 3.5H7a1.5 1.5 0 0 0-1.5 1.5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8z')}
      {P('M14 3.5V8h4.5')}
    </>
  ),
  keyboard: (
    <>
      <rect x="3" y="6.5" width="18" height="11" rx="2" />
      {P('M7 10.5h.01M10.5 10.5h.01M14 10.5h.01M17.5 10.5h.01M8 14h8')}
    </>
  ),
  help: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      {P('M9.6 9.5a2.5 2.5 0 0 1 4.8.9c0 1.6-2.4 2-2.4 3.6')}
      {P('M12 17h.01')}
    </>
  ),
  cloud: P('M7 18.5h10a4 4 0 0 0 .6-7.96A5.5 5.5 0 0 0 7 9.5a4.5 4.5 0 0 0 0 9z'),
  cloudCheck: (
    <>
      {P('M7 18.5h10a4 4 0 0 0 .6-7.96A5.5 5.5 0 0 0 7 9.5a4.5 4.5 0 0 0 0 9z')}
      {P('M9.5 14l2 2 3.5-3.5')}
    </>
  ),
  cloudOff: (
    <>
      {P('M7 18.5h10a4 4 0 0 0 .6-7.96A5.5 5.5 0 0 0 7 9.5a4.5 4.5 0 0 0 0 9z')}
      {P('M4 4l16 16')}
    </>
  ),
  warning: (
    <>
      {P('M12 4 2.8 19.5h18.4z')}
      {P('M12 10v4.5M12 17h.01')}
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      {P('M12 11v5.5M12 8h.01')}
    </>
  ),
  // rail
  templates: (
    <>
      <rect x="3.5" y="3.5" width="7" height="9" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="5" rx="1.5" />
      <rect x="13.5" y="11.5" width="7" height="9" rx="1.5" />
      <rect x="3.5" y="15.5" width="7" height="5" rx="1.5" />
    </>
  ),
  shapes: (
    <>
      <circle cx="8" cy="8" r="4.5" />
      <rect x="12.5" y="12.5" width="8" height="8" rx="1.5" />
      {P('M16.5 3.5l4 7h-8z')}
    </>
  ),
  text: (
    <>
      {P('M5 6.5V5h14v1.5')}
      {P('M12 5v14')}
      {P('M9 19h6')}
    </>
  ),
  uploads: (
    <>
      {P('M12 15V4.5')}
      {P('M8 8.5 12 4.5l4 4')}
      {P('M4.5 14v4a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-4')}
    </>
  ),
  photos: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <circle cx="9" cy="10" r="1.8" />
      {P('M20.5 16 15 10.5 5 19.5')}
    </>
  ),
  brand: (
    <>
      {P('M12 3.5a8.5 8.5 0 1 0 0 17c1.2 0 1.8-.8 1.8-1.7 0-1.4-1.3-1.6-1.3-3 0-1 .8-1.8 1.8-1.8h2.2a4 4 0 0 0 4-4c0-3.6-3.8-6.5-8.5-6.5z')}
      <circle cx="7.8" cy="11.5" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="10" cy="7.6" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="14.6" cy="7.6" r="1.1" fill="currentColor" stroke="none" />
    </>
  ),
  layers: (
    <>
      {P('M12 4 3.5 8.5 12 13l8.5-4.5z')}
      {P('M3.5 12.5 12 17l8.5-4.5')}
      {P('M3.5 16.5 12 21l8.5-4.5')}
    </>
  ),
  pages: (
    <>
      <rect x="7.5" y="3.5" width="12" height="14" rx="1.5" />
      {P('M4.5 7v12a1.5 1.5 0 0 0 1.5 1.5h10')}
    </>
  ),
  // element props
  lock: (
    <>
      <rect x="5" y="10.5" width="14" height="10" rx="2" />
      {P('M8 10.5V8a4 4 0 0 1 8 0v2.5')}
    </>
  ),
  unlock: (
    <>
      <rect x="5" y="10.5" width="14" height="10" rx="2" />
      {P('M8 10.5V8a4 4 0 0 1 7.7-1.5')}
    </>
  ),
  eye: (
    <>
      {P('M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z')}
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  eyeOff: (
    <>
      {P('M10 5.7a9 9 0 0 1 2-.2c6 0 9.5 6.5 9.5 6.5a16 16 0 0 1-2.4 3.2')}
      {P('M6.2 7.2A15 15 0 0 0 2.5 12S6 18.5 12 18.5a9 9 0 0 0 4.7-1.3')}
      {P('M9.9 9.9a3 3 0 0 0 4.2 4.2')}
      {P('M3.5 3.5l17 17')}
    </>
  ),
  trash: (
    <>
      {P('M4.5 7h15')}
      {P('M9.5 7V4.5h5V7')}
      {P('M6.5 7l1 13h9l1-13')}
      {P('M10 11v5.5M14 11v5.5')}
    </>
  ),
  duplicate: (
    <>
      <rect x="8.5" y="8.5" width="12" height="12" rx="2" />
      {P('M15.5 8.5V5a1.5 1.5 0 0 0-1.5-1.5H5A1.5 1.5 0 0 0 3.5 5v9A1.5 1.5 0 0 0 5 15.5h3.5')}
    </>
  ),
  edit: (
    <>
      {P('M4 20h4L19 9l-4-4L4 16z')}
      {P('M13.5 6.5l4 4')}
    </>
  ),
  grip: (
    <>
      <circle cx="9" cy="6.5" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="15" cy="6.5" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="9" cy="12" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="15" cy="12" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="9" cy="17.5" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="15" cy="17.5" r="1.3" fill="currentColor" stroke="none" />
    </>
  ),
  crop: (
    <>
      {P('M6.5 2.5v13.5a1.5 1.5 0 0 0 1.5 1.5h13.5')}
      {P('M2.5 6.5H16a1.5 1.5 0 0 1 1.5 1.5v13.5')}
    </>
  ),
  flipH: (
    <>
      {P('M12 3v18')}
      {P('M8.5 7 3.5 17h5z')}
      {P('M15.5 7l5 10h-5z')}
    </>
  ),
  flipV: (
    <>
      {P('M3 12h18')}
      {P('M7 8.5 17 3.5v5z')}
      {P('M7 15.5l10 5v-5z')}
    </>
  ),
  replace: (
    <>
      {P('M4.5 9.5A7.5 7.5 0 0 1 18 7')}
      {P('M18.5 3.5V7.5h-4')}
      {P('M19.5 14.5A7.5 7.5 0 0 1 6 17')}
      {P('M5.5 20.5v-4h4')}
    </>
  ),
  reset: (
    <>
      {P('M4.5 12a7.5 7.5 0 1 0 2.2-5.3')}
      {P('M4.5 4v4h4')}
    </>
  ),
  slot: (
    <>
      <rect x="3.5" y="5.5" width="17" height="13" rx="2" strokeDasharray="3 2.5" />
      {P('M9 12h6M12 9v6')}
    </>
  ),
  group: (
    <>
      <rect x="3.5" y="3.5" width="17" height="17" rx="2" strokeDasharray="3 2.5" />
      <rect x="7" y="7" width="6" height="6" rx="1" />
      <rect x="11" y="11" width="6" height="6" rx="1" />
    </>
  ),
  ungroup: (
    <>
      <rect x="4" y="4" width="7" height="7" rx="1" />
      <rect x="13" y="13" width="7" height="7" rx="1" />
    </>
  ),
  image: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <circle cx="9" cy="10" r="1.8" />
      {P('M20.5 16 15 10.5 5 19.5')}
    </>
  ),
  shape: (
    <>
      <rect x="4" y="4" width="10" height="10" rx="1.5" />
      <circle cx="15" cy="15" r="5" />
    </>
  ),
  page: <rect x="5.5" y="3.5" width="13" height="17" rx="1.5" />,
  // align
  alignLeft: (
    <>
      {P('M4 3.5v17')}
      <rect x="7" y="6" width="11" height="4" rx="1" />
      <rect x="7" y="14" width="7" height="4" rx="1" />
    </>
  ),
  alignCenterH: (
    <>
      {P('M12 3.5v17')}
      <rect x="5.5" y="6" width="13" height="4" rx="1" />
      <rect x="8" y="14" width="8" height="4" rx="1" />
    </>
  ),
  alignRight: (
    <>
      {P('M20 3.5v17')}
      <rect x="6" y="6" width="11" height="4" rx="1" />
      <rect x="10" y="14" width="7" height="4" rx="1" />
    </>
  ),
  alignTop: (
    <>
      {P('M3.5 4h17')}
      <rect x="6" y="7" width="4" height="11" rx="1" />
      <rect x="14" y="7" width="4" height="7" rx="1" />
    </>
  ),
  alignMiddleV: (
    <>
      {P('M3.5 12h17')}
      <rect x="6" y="5.5" width="4" height="13" rx="1" />
      <rect x="14" y="8" width="4" height="8" rx="1" />
    </>
  ),
  alignBottom: (
    <>
      {P('M3.5 20h17')}
      <rect x="6" y="6" width="4" height="11" rx="1" />
      <rect x="14" y="10" width="4" height="7" rx="1" />
    </>
  ),
  distributeH: (
    <>
      {P('M4 3.5v17M20 3.5v17')}
      <rect x="9.5" y="7" width="5" height="10" rx="1" />
    </>
  ),
  distributeV: (
    <>
      {P('M3.5 4h17M3.5 20h17')}
      <rect x="7" y="9.5" width="10" height="5" rx="1" />
    </>
  ),
  // z-order
  bringForward: (
    <>
      <rect x="8.5" y="8.5" width="12" height="12" rx="1.5" />
      {P('M15.5 5.5V4a.5.5 0 0 0-.5-.5H4a.5.5 0 0 0-.5.5v11a.5.5 0 0 0 .5.5h1.5')}
      {P('M14.5 17v-5M12 14.5l2.5-2.5 2.5 2.5')}
    </>
  ),
  sendBackward: (
    <>
      <rect x="3.5" y="3.5" width="12" height="12" rx="1.5" />
      {P('M18.5 8.5H20a.5.5 0 0 1 .5.5v11a.5.5 0 0 1-.5.5H9a.5.5 0 0 1-.5-.5v-1.5')}
      {P('M9.5 7v5M7 9.5 9.5 12 12 9.5')}
    </>
  ),
  bringToFront: (
    <>
      {P('M12 20V8')}
      {P('M7 12.5 12 7.5l5 5')}
      {P('M5 4h14')}
    </>
  ),
  sendToBack: (
    <>
      {P('M12 4v12')}
      {P('M7 11.5l5 5 5-5')}
      {P('M5 20h14')}
    </>
  ),
  // text
  textAlignLeft: P('M4 6h16M4 10h10M4 14h16M4 18h10'),
  textAlignCenter: P('M4 6h16M7 10h10M4 14h16M7 18h10'),
  textAlignRight: P('M4 6h16M10 10h10M4 14h16M10 18h10'),
  textAlignJustify: P('M4 6h16M4 10h16M4 14h16M4 18h16'),
  vAlignTop: (
    <>
      {P('M4 4h16')}
      {P('M12 20V8M8 12l4-4 4 4')}
    </>
  ),
  vAlignMiddle: (
    <>
      {P('M4 12h16')}
      {P('M12 3v5M9.5 5.5 12 8l2.5-2.5M12 21v-5M9.5 18.5 12 16l2.5 2.5')}
    </>
  ),
  vAlignBottom: (
    <>
      {P('M4 20h16')}
      {P('M12 4v12M8 12l4 4 4-4')}
    </>
  ),
  bold: P('M7 5h6a3.5 3.5 0 0 1 0 7H7zM7 12h7a3.5 3.5 0 0 1 0 7H7z'),
  italic: P('M14 5h-4M14 19h-4M13 5l-2 14M19 5h-5M10 19H5'),
  underline: (
    <>
      {P('M7 4.5V11a5 5 0 0 0 10 0V4.5')}
      {P('M5 20h14')}
    </>
  ),
  strikethrough: (
    <>
      {P('M4 12h16')}
      {P('M16.5 7.5c-.5-1.8-2.3-3-4.5-3-2.6 0-4.5 1.5-4.5 3.5 0 1.5 1 2.6 3 3.3')}
      {P('M8 16.5c.6 1.8 2.3 3 4.5 3 2.6 0 4.5-1.5 4.5-3.5 0-.9-.3-1.6-1-2.2')}
    </>
  ),
  letterCase: (
    <>
      {P('M3 18 7.5 6 12 18M4.6 14h5.8')}
      <circle cx="17" cy="15" r="3" />
      {P('M20 12v6')}
    </>
  ),
  lineHeight: (
    <>
      {P('M10 6h10M10 12h10M10 18h10')}
      {P('M5 4v16M3 6l2-2 2 2M3 18l2 2 2-2')}
    </>
  ),
  letterSpacing: (
    <>
      {P('M6 14 9.5 4l3.5 10M7.2 10.5h4.6')}
      {P('M3 19h18M5 17l-2 2 2 2M19 17l2 2-2 2')}
    </>
  ),
  // misc
  palette: (
    <>
      {P('M12 3.5a8.5 8.5 0 1 0 0 17c1.2 0 1.8-.8 1.8-1.7 0-1.4-1.3-1.6-1.3-3 0-1 .8-1.8 1.8-1.8h2.2a4 4 0 0 0 4-4c0-3.6-3.8-6.5-8.5-6.5z')}
    </>
  ),
  noFill: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      {P('M5 19 19 5')}
    </>
  ),
  link: (
    <>
      {P('M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1')}
      {P('M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1')}
    </>
  ),
  external: (
    <>
      {P('M13.5 4.5h6v6')}
      {P('M19.5 4.5 11 13')}
      {P('M17.5 14v4a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 18V8A1.5 1.5 0 0 1 6 6.5h4')}
    </>
  ),
  sparkle: (
    <>
      {P('M12 3.5l1.8 5.2 5.2 1.8-5.2 1.8L12 17.5l-1.8-5.2L5 10.5l5.2-1.8z')}
      {P('M18.5 16v4M16.5 18h4')}
    </>
  ),
  rotate: (
    <>
      {P('M19.5 12a7.5 7.5 0 1 1-2.2-5.3')}
      {P('M19.5 4v4h-4')}
    </>
  ),
  opacity: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      {P('M12 3.5v17')}
      {P('M12 6h5M12 9.5h7.5M12 13h8.5M12 16.5h7M12 19.5h4')}
    </>
  ),
  logo: (
    <>
      <rect x="4" y="3.5" width="16" height="17" rx="2.5" />
      {P('M8.5 16V8h4a2.5 2.5 0 0 1 0 5h-4')}
    </>
  ),
} as const;

export type IconName = keyof typeof ICONS;
export const ICON_NAMES = Object.keys(ICONS) as IconName[];

export interface IconProps {
  name: IconName;
  size?: number;
  className?: string;
  strokeWidth?: number;
}

export function Icon({ name, size = 20, className, strokeWidth = 1.75 }: IconProps): JSX.Element {
  return (
    <svg
      className={className ? `icon ${className}` : 'icon'}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {ICONS[name]}
    </svg>
  );
}
