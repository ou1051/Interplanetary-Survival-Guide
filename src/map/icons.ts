// Minimal inline icons (24×24, stroke = currentColor).
const svg = (d: string) =>
  `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;

export const ICON = {
  imagery: svg('<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M3 16l5-5 4 4 3-3 6 6"/><circle cx="16" cy="9" r="1.6"/>'),
  slope: svg('<path d="M3 19L10 8l4 6 3-4 4 9z"/>'),
  evidence: svg('<path d="M12 21s-6-5.6-6-11a6 6 0 1112 0c0 5.4-6 11-6 11z"/><circle cx="12" cy="10" r="2.2"/>'),
  up: svg('<path d="M6 14l6-6 6 6"/>'),
  down: svg('<path d="M6 10l6 6 6-6"/>'),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  move: svg('<path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3"/>'),
  target: svg('<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>'),
  chevron: svg('<path d="M9 6l6 6-6 6"/>'),
  external: svg('<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5"/>'),
  play: svg('<path d="M8 5l11 7-11 7z"/>'),
  swap: svg('<path d="M7 7h11l-3-3M17 17H6l3 3"/>'),
};
