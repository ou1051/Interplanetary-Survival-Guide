import { ROUTE_OPTIONS } from '../config/mission.js';
import { formatHMS } from '../core/math.js';

// ---------------------------------------------------------------------------
// Liftoff animation (Earth pad, weather from the chosen window) and the final
// decision debrief with Retry / New weather.
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);

export function playLiftoff(window, forecast, done) {
  const sec = $('liftoff');
  const canvas = $('liftoffCanvas');
  sec.classList.remove('hidden');
  $('liftoffCaption').innerHTML = `<span>LIFTOFF · ${window.label.toUpperCase()} · ${window.depart.toUpperCase()}</span><b>Next stop: Mars · arrival ${window.arrive}</b>`;
  const g = canvas.getContext('2d');
  const cloudy = forecast.earth.risk !== 'low';
  const smoke = [];
  const stars = Array.from({ length: 160 }, () => [Math.random(), Math.random() * 0.7, Math.random()]);
  const t0 = performance.now();
  const DUR = 7.5;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    sec.classList.add('hidden');
    sec.removeEventListener('click', finish);
    done();
  };
  sec.addEventListener('click', finish);

  function frame(now) {
    if (finished) return;
    const t = (now - t0) / 1000;
    const W = (canvas.width = innerWidth);
    const H = (canvas.height = innerHeight);
    const lift = Math.max(0, t - 1.6);
    const alt = lift * lift * 60; // px climbed
    const space = Math.min(1, alt / (H * 3));

    // sky → space
    const sky = g.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, mix('#3b6ea8', '#020409', space));
    sky.addColorStop(1, mix(cloudy ? '#9aa6b2' : '#f0b98a', '#05070c', space));
    g.fillStyle = sky;
    g.fillRect(0, 0, W, H);
    g.fillStyle = `rgba(255,255,255,${space})`;
    for (const [x, y, s] of stars) g.fillRect(x * W, y * H, 1 + s, 1 + s);

    const cam = Math.max(0, alt - H * 0.35); // camera follows after a while
    const groundY = H * 0.82 + cam;
    // clouds
    if (cloudy) {
      g.fillStyle = 'rgba(220,226,232,0.55)';
      for (let i = 0; i < 7; i++) {
        const cy = H * 0.3 + cam * 0.6 + i * 18;
        g.beginPath();
        g.ellipse(((i * 241 + t * 12) % (W + 400)) - 200, cy, 180, 26, 0, 0, Math.PI * 2);
        g.fill();
      }
    }
    // ground + pad
    g.fillStyle = '#1d1a17';
    g.fillRect(0, groundY, W, H);
    g.fillStyle = '#3a3633';
    g.fillRect(W / 2 - 120, groundY - 8, 240, 8);
    g.fillStyle = '#5a5551';
    g.fillRect(W / 2 + 40, groundY - 220, 14, 212); // tower

    // rocket
    const rx = W / 2;
    const ry = groundY - 30 - alt;
    const shake = lift > 0 && lift < 2 ? (Math.random() - 0.5) * 2 : 0;
    g.save();
    g.translate(rx + shake, ry);
    if (t > 1.0) {
      const fl = 60 + Math.random() * 30 + Math.min(lift, 2) * 30;
      const grd = g.createLinearGradient(0, 0, 0, fl);
      grd.addColorStop(0, '#fffbe0');
      grd.addColorStop(0.4, '#ffb03d');
      grd.addColorStop(1, 'rgba(255,90,40,0)');
      g.fillStyle = grd;
      g.beginPath();
      g.moveTo(-11, 0);
      g.quadraticCurveTo(0, fl * 1.2, 11, 0);
      g.fill();
      for (let k = 0; k < 4; k++) smoke.push({ x: rx + (Math.random() - 0.5) * 30, y: ry + 30 - cam, vx: (Math.random() - 0.5) * 90, vy: 20 + Math.random() * 40, r: 12, a: 0.6 });
    }
    g.fillStyle = '#f2f2f2';
    g.fillRect(-12, -150, 24, 150);
    g.fillStyle = '#c8c8c8';
    g.fillRect(-12, -150, 8, 150);
    g.fillStyle = '#9af4ff';
    g.beginPath();
    g.moveTo(-12, -150);
    g.lineTo(0, -190);
    g.lineTo(12, -150);
    g.fill();
    g.fillStyle = '#2a2a2a';
    g.beginPath();
    g.moveTo(-12, -10); g.lineTo(-24, 6); g.lineTo(-12, 0);
    g.moveTo(12, -10); g.lineTo(24, 6); g.lineTo(12, 0);
    g.fill();
    g.restore();

    // smoke
    for (const p of smoke) {
      p.x += p.vx / 60;
      p.y += p.vy / 60;
      p.r += 0.9;
      p.a *= 0.985;
    }
    while (smoke.length > 500) smoke.shift();
    for (const p of smoke) {
      g.fillStyle = `rgba(230,225,220,${p.a * 0.35})`;
      g.beginPath();
      g.arc(p.x, p.y + cam, p.r, 0, Math.PI * 2);
      g.fill();
    }

    g.fillStyle = `rgba(0,0,0,${Math.max(0, (t - DUR + 1) / 1)})`;
    g.fillRect(0, 0, W, H);
    if (t >= DUR) finish();
    else requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

function mix(a, b, t) {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (s) => Math.round(((pa >> s) & 255) * (1 - t) + ((pb >> s) & 255) * t);
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}

const TITLES = {
  launched: ['LAUNCHED', 'You made the call — the crew is on its way'],
  deferred: ['MISSION DEFERRED', 'You chose not to fly this time'],
  expired: ['WINDOWS CLOSED', 'Every launch window passed before launch'],
};

export function showOutcome(game, { onRetry, onNewWeather }) {
  const run = game.run;
  const [title, sub] = TITLES[run.outcome] || TITLES.deferred;
  $('outcomeTitle').innerHTML = `${title}<span>${sub}</span>`;
  const w = run.launchedWindowId ? game.windowById(run.launchedWindowId) : null;
  const f = w ? game.forecast(w) : null;
  const route = ROUTE_OPTIONS.find((o) => o.id === run.routeId);
  const r = run.rehearsal;
  const items = [
    ['ROUTE', route ? route.name : '—'],
    ['REHEARSAL', r ? (game.approval().ok ? 'APPROVED' : 'NOT APPROVED') : 'NONE'],
    ['REHEARSAL MET', r ? formatHMS(r.met) : '—'],
    ['SITES SCOUTED', `${run.revealed.length} / 4`],
    ['PREP TURNS', run.turn],
    ['WINDOW', w ? `${w.id} · ${w.depart}` : '—'],
    ['EARTH WX', f ? f.earth.risk.toUpperCase() : '—'],
    ['TRAVERSE WX', f ? f.walk.visibility.toUpperCase() : '—'],
  ];
  $('outcomeGrid').innerHTML = items.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('');
  $('decisionLog').innerHTML = run.decisions.map((d) => `<li><span>T${d.turn} · ${d.kind.toUpperCase()}</span>${d.text}</li>`).join('');
  $('outcomeEyebrow').textContent = `MISSION DECISION · WEATHER SCENARIO ${game.scenario.id} (SIMULATED)`;
  $('outcome').classList.remove('hidden');
  $('retryBtn').onclick = onRetry;
  $('newWxBtn').onclick = onNewWeather;
}
