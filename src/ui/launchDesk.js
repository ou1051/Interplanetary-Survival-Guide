import { ROUTE_OPTIONS } from '../config/mission.js';
// ---------------------------------------------------------------------------
// Launch desk: three fictional windows with Earth weather at departure and Mars
// conditions at arrival and during the traverse. Launch, hold or defer.
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const RISK = { low: 'LOW', moderate: 'MODERATE', high: 'HIGH' };

export class LaunchDesk {
  constructor({ game, onBack, onRehearse, onLaunch, onEnd }) {
    Object.assign(this, { game, onBack, onRehearse, onLaunch, onEnd });
    $('deskBack').addEventListener('click', () => onBack());
    $('holdBtn').addEventListener('click', () => {
      game.hold();
      if (game.run.outcome !== 'planning') onEnd();
      else this.render();
    });
    $('deferBtn').addEventListener('click', () => {
      game.defer();
      onEnd();
    });
    $('deskWindows').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const w = game.windowById(b.dataset.w);
      if (b.dataset.act === 'launch' && game.launch(w)) onLaunch(w);
      if (b.dataset.act === 'rehearse') {
        game.setRehearsalWindow(w.id);
        onRehearse();
      }
    });
  }

  show() {
    $('desk').classList.remove('hidden');
    this.render();
  }

  hide() {
    $('desk').classList.add('hidden');
  }

  render() {
    const { game } = this;
    const run = game.run;
    const sc = game.scenario;
    const ap = game.approval();
    const reh = run.rehearsal;

    $('deskTurn').textContent = `PREP TURN ${run.turn}`;
    $('deskSub').textContent = `Forecast: ${run.forecastUpdated ? 'UPDATED after hold' : 'initial'} · ${sc.source} · scenario ${sc.id}`;
    const banner = $('deskApproval');
    banner.className = `approval-banner ${ap.ok ? 'ok' : 'no'}`;
    banner.innerHTML = ap.ok
      ? `<b>SURFACE PLAN APPROVED</b><span>Rehearsed the ${(ROUTE_OPTIONS.find((o) => o.id === game.run.routeId)?.name || 'selected route').toLowerCase()} in ${reh.visibility} visibility. Pick a window.</span>`
      : `<b>LAUNCH LOCKED</b><span>${ap.reasons.join(' ')} Rehearse from the mission map first.</span>`;

    $('deskWindows').innerHTML = sc.windows
      .map((w) => {
        const f = game.forecast(w);
        const open = game.isOpen(w);
        const can = game.canLaunch(w);
        let cmp = '';
        if (reh) {
          cmp =
            reh.visibility === f.walk.visibility
              ? `<div class="cmp ok">Rehearsed in ${reh.visibility} visibility — matches this window.</div>`
              : `<div class="cmp warn">Rehearsed in ${reh.visibility}; this window expects <b>${f.walk.visibility}</b>.</div>`;
        }
        const row = (k, when, x, extra = '') =>
          `<div class="wx-row"><span>${k}<small>${when}</small></span><b class="risk-${x.risk}">${x.text}${extra}</b><em class="risk-${x.risk}">${RISK[x.risk]}</em></div>`;
        return `<div class="window-card ${open ? '' : 'closed'} ${run.rehearsalWindowId === w.id ? 'picked' : ''}">
          <div class="wc-head"><b>${w.label.toUpperCase()}</b><span>${open ? `OPEN UNTIL TURN ${w.lastOpenTurn}` : 'CLOSED'}</span></div>
          ${row('EARTH DEPARTURE', w.depart, f.earth)}
          ${row('MARS ARRIVAL', w.arrive, f.arrival)}
          ${row('TRAVERSE', w.walk, f.walk, ` · ${f.walk.visibility}`)}
          <p class="note">${f.note}</p>
          ${cmp}
          <div class="btn-col">
            <button class="primary small" data-act="launch" data-w="${w.id}" ${can.ok ? '' : 'disabled'} title="${can.reason || ''}">LAUNCH ${w.id}</button>
            <button class="ghost" data-act="rehearse" data-w="${w.id}" ${open ? '' : 'disabled'}>REHEARSE IN THESE CONDITIONS</button>
          </div>
        </div>`;
      })
      .join('');

    const hold = game.previewHold();
    const hb = $('holdBtn');
    hb.disabled = !hold;
    hb.textContent = hold
      ? `HOLD → TURN ${hold.turnAfter}${hold.closes.length ? ` · CLOSES ${hold.closes.map((w) => w.id).join(', ')}` : ''}${hold.endsAll ? ' · ENDS MISSION' : ''}`
      : 'HOLD';
    $('deskNote').textContent =
      'All weather is SIMULATED and fictional. Holding reveals the forecast update but spends turns; windows close when the turn passes their deadline.';
  }
}
