import type { LaunchWindow, Run } from './contracts';
import { openWindows } from './scouting';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Turn counter + departure windows (open / closes next turn / closed). */
export function clockMarkup(run: Pick<Run, 'turn'>, windows: LaunchWindow[]): string {
  const open = openWindows(run.turn, windows);
  const wins = windows
    .map((w) => {
      const isOpen = run.turn <= w.lastOpenTurn;
      const soon = isOpen && run.turn === w.lastOpenTurn;
      const state = !isOpen ? 'closed' : soon ? 'soon' : 'open';
      const tip = `${w.label} · ${isOpen ? `open through turn ${w.lastOpenTurn}` : 'closed'}`;
      return `<li class="${state}" title="${esc(tip)}" aria-label="${esc(tip)}">${esc(w.label.replace(/^Window\s*/i, ''))}</li>`;
    })
    .join('');
  return `<div class="mm-turn"><span>Turn</span><b>${run.turn}</b></div>
    <ul class="mm-wins">${wins}</ul>
    <span class="mm-sr-only">${open.length} of ${windows.length} departure windows open</span>`;
}
