// ---------------------------------------------------------------------------
// Site Topology data files (public/jezero, public/mars).
//
// Normal builds serve them next to the page. The one-file build (`npm run
// build:single`) has no folder beside it, and a sandboxed preview cannot fetch
// relative paths at all, so there the files ride inside the page: the
// `virtual:site-assets` module (vite.config.js) holds them as data: URLs, and
// the elevation grid as a ready object. Everywhere else it is empty.
// ---------------------------------------------------------------------------
import inline from 'virtual:site-assets';

/** URL to load a site image from: the inline copy when there is one, else the served file. */
export const siteAssetUrl = (path) => inline.urls?.[path] ?? path;

/** The Jezero elevation grid: inline when built into the page, otherwise fetched. */
export function loadTopographyGrid() {
  if (inline.grid) return Promise.resolve(inline.grid);
  return fetch('./jezero/topography_grid.json').then((r) => (r.ok ? r.json() : null));
}
