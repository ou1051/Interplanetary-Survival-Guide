// Minimal inline icons (24×24, stroke = currentColor).
const svg = (d: string) =>
  `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;

export const ICON = {
  wind: svg('<path d="M3 8h10a3 3 0 1 0-3-3M2 12h16a3 3 0 1 0-2.7-4.4M4 16h8a3 3 0 1 1-2.8 4"/>'),
};
