import { buildDeltaTraverse, buildDeltaApproaches } from '../data/deltaTraverse.js';
import { mountHabitatRoom } from './habitatRoom.js';
import { mountHabitatExterior } from './habitatExterior.js';
import { SiteTopologyWidget } from './siteTopology.js';
import { imagery, observationSource } from '../data/galeSite.js';
import './habitat.css';

export function mountHabitat(root, launch) {
  let approaches = null;
  let originalTraverse = null;

  root.innerHTML = `
    <div class="hab-stage hab-before-entry hab-topology-mode" inert>
      <canvas class="hab-room" data-room aria-hidden="true"></canvas>
      <header class="hab-overlay">
        <span>EVA-01 <b>·</b> <span data-site-name>GALE CRATER · VERA RUBIN RIDGE</span></span>
        <span>Inside habitat</span>
      </header>
      <div class="hab-wall">
        <div class="hab-screen">
          <header class="hab-header">
            <h1>Mission briefing</h1>
            <span class="hab-eva"><i></i> EVA-01</span>
            <nav class="hab-nav" aria-label="Mission navigation">
              <label class="hab-scenario-nav" title="Simulated surface weather conditions">
                <select data-scenario aria-label="Simulation conditions">
                  <option value="variable">Variable weather</option>
                  <option value="clear">Nominal conditions</option>
                </select>
              </label>
              <button type="button" id="collectionBtn">Collection</button>
              <button type="button" id="sourcesBtn">Mission &amp; sources</button>
              <button type="button" data-review-close>← Habitat view</button>
            </nav>
          </header>
          <div class="hab-topology-panel" data-hab-topology></div>
          <button type="button" data-screen-open class="hab-screen-open" aria-label="Zoom in to mission briefing"></button>
        </div>
      </div>
      <button type="button" data-review-open class="hab-review"><kbd>E</kbd> Review route</button>
    </div>
    <section class="hab-intro" data-intro aria-labelledby="hab-intro-title">
      <canvas class="hab-exterior" data-exterior aria-hidden="true"></canvas>
      <div class="hab-intro-shade" aria-hidden="true"></div>
      <div class="hab-intro-card">
        <p class="hab-eyebrow">Interplanetary Survival Guide</p>
        <h1 id="hab-intro-title">Mars Surface<br>Operations</h1>
        <p>Plan a rover traverse from the habitat console. Visit the science stops and get back to the habitat with oxygen to spare.</p>
        <ol><li>Select a Mars landing site and run the live A* route planner.</li><li>Drive the route and use your wrist navigator.</li><li>Complete the science tasks and return to the airlock.</li></ol>
        <button type="button" data-intro-enter>Enter habitat <span aria-hidden="true">→</span></button>
      </div>
    </section>
    <div class="hab-cut" data-cut aria-hidden="true"></div>
    <div class="hab-airlock" data-airlock hidden>
      <div class="hab-hatch" aria-hidden="true"></div>
      <div class="hab-airlock-status" role="status" tabindex="-1">
        <span class="hab-eyebrow">EVA-01 / Surface access</span>
        <strong>Airlock cycle</strong>
        <span data-airlock-progress>Sealing inner hatch…</span>
      </div>
    </div>
    <dialog data-photo-dialog class="hab-photo" aria-label="Curiosity field reference">
      <div><h2>Layers of Vera Rubin Ridge</h2><button type="button" data-photo-close>× Close</button></div>
      <img src="${imagery.mastcam}" alt="Curiosity Mastcam panorama showing distinct horizontal layers at the base of Vera Rubin Ridge">
      <p>Look for a boundary between two horizontal beds. Sample one rock above and one below it in the simulation. The archived photo is a regional reference.</p>
      <a href="${observationSource}" target="_blank" rel="noopener">Curiosity Mastcam · Sol 1790 · NASA/JPL-Caltech/MSSS ↗</a>
    </dialog>`;

  const query = (selector) => root.querySelector(selector);
  const stage = query('.hab-stage');
  const wall = query('.hab-wall');
  const intro = query('[data-intro]');
  const enter = query('[data-intro-enter]');
  const airlock = query('[data-airlock]');
  const screenOpen = query('[data-screen-open]');
  const reviewOpen = query('[data-review-open]');
  const reviewClose = query('[data-review-close]');
  const observation = query('[data-photo-dialog]');
  const topoPanel = query('[data-hab-topology]');
  const motionReduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  root.classList.add('hab-topology-mode');

  const room = mountHabitatRoom(query('[data-room]'), (bounds) => {
    for (const [key, value] of Object.entries(bounds)) stage.style.setProperty(`--screen-${key}`, `${value}%`);
  });
  stage.classList.toggle('hab-has-room', Boolean(room));

  const returnToBriefing = history.state?.screen === 'briefing';
  const exterior = returnToBriefing ? null : mountHabitatExterior(query('[data-exterior]'));
  const cut = query('[data-cut]');
  const frontSeconds = 360 + Math.round(Math.random() * 240);
  let entering = false;
  let zoomed = false;
  let zoomAnimation;
  let lastZoomTrigger = reviewOpen;
  let scrollBeforeZoom = 0;
  let launching = false;

  async function runLaunchSequence(planToLaunch, scenarioToLaunch = 'variable') {
    if (launching || !planToLaunch) return;
    launching = true;
    stage.inert = true;
    airlock.hidden = false;
    root.scrollTop = 0;
    query('.hab-airlock-status').focus({ preventScroll: true });
    const progress = query('[data-airlock-progress]');
    const cycle = motionReduced()
      ? Promise.resolve()
      : airlock.animate([{ opacity: 0.15 }, { opacity: 1 }], { duration: 570, easing: 'ease-out' }).finished;
    for (const control of root.querySelectorAll('button, select')) control.disabled = true;
    try {
      await cycle;
      const plan = planToLaunch.traverse
        ? { ...planToLaunch, frontSeconds: scenarioToLaunch === 'variable' ? frontSeconds : 0 }
        : planToLaunch;
      await launch(plan, scenarioToLaunch, (message) => {
        progress.textContent = message;
      });
      if (!motionReduced()) {
        document.getElementById('viewport').animate([{ opacity: 0 }, { opacity: 1 }], { duration: 370, easing: 'ease-out' });
      }
      room?.dispose();
    } catch (error) {
      console.error(error);
      launching = false;
      airlock.hidden = true;
      stage.inert = false;
      reviewClose.disabled = false;
    }
  }

  const topoWidget = new SiteTopologyWidget(topoPanel, {
    screensaver: true,
    onDeploy: ({ site, pathId, sandboxPlan }) => {
      const siteHeader = query('[data-site-name]');
      if (siteHeader) siteHeader.textContent = site.name.toUpperCase();
      let plan = sandboxPlan;
      if (!plan) {
        if (!approaches) {
          originalTraverse = buildDeltaTraverse();
          approaches = buildDeltaApproaches(originalTraverse);
        }
        const chosenApproach = approaches.find((a) => a.id === pathId) || approaches[1] || approaches[0];
        plan = {
          ...chosenApproach,
          name: `${site.name.split('·')[0].trim()} · ${chosenApproach.label} to S1`,
          site: { name: site.name, eva: 'EVA-01', sol: 214 },
        };
      }
      topoWidget.dispose?.();
      const scenario = query('[data-scenario]')?.value || 'variable';
      runLaunchSequence(plan, scenario);
    },
  });

  const enterHabitat = async () => {
    if (entering) return;
    entering = true;
    enter.disabled = true;
    const still = returnToBriefing || motionReduced();
    if (!still) {
      query('.hab-intro-card').animate(
        [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateX(-28px)' }],
        { duration: 260, easing: 'ease-in', fill: 'forwards' }
      );
      query('.hab-intro-shade').animate([{ opacity: 1 }, { opacity: 0 }], { duration: 600, easing: 'ease-out', fill: 'forwards' });
      await exterior?.flyIn(1400);
      await cut.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150, easing: 'ease-in', fill: 'forwards' }).finished;
    }
    intro.hidden = true;
    exterior?.dispose();
    stage.inert = false;
    stage.classList.remove('hab-before-entry');
    if (!still) {
      cut.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 380, easing: 'ease-out', fill: 'forwards' });
      await new Promise((resolve) => {
        const t0 = performance.now();
        const step = (now) => {
          const t = Math.min(1, (now - t0) / 900);
          room?.setDolly(1 - (1 - t) ** 3);
          if (t < 1) requestAnimationFrame(step);
          else resolve();
        };
        requestAnimationFrame(step);
      });
    } else {
      room?.setDolly(1);
    }
    topoWidget.startScreensaver();
  };

  function setZoom(open, trigger = reviewOpen) {
    if (zoomed === open || launching) return;
    zoomAnimation?.cancel();
    const before = wall.getBoundingClientRect();
    const scroll = root.scrollTop;
    zoomed = open;
    if (open) lastZoomTrigger = trigger;
    root.classList.toggle('hab-zoomed', open);
    screenOpen.hidden = reviewOpen.hidden = open;
    reviewClose.hidden = !open;
    root.scrollTop = open ? 0 : scrollBeforeZoom;
    if (open) scrollBeforeZoom = scroll;
    const after = wall.getBoundingClientRect();

    topoWidget.setConsoleZoomed(open);

    if (!motionReduced()) {
      zoomAnimation = wall.animate(
        [
          {
            transformOrigin: '0 0',
            transform: `translate(${before.left - after.left}px, ${before.top - after.top}px) scale(${before.width / after.width}, ${before.height / after.height})`,
          },
          { transformOrigin: '0 0', transform: 'none' },
        ],
        { duration: 340, easing: 'cubic-bezier(.22,.75,.18,1)' }
      );
      zoomAnimation.finished
        .then(() => {
          topoWidget._scheduleDraw();
        })
        .catch(() => {});
    }
    topoWidget._scheduleDraw();
    (open ? reviewClose : lastZoomTrigger).focus({ preventScroll: true });
  }

  window.addEventListener('keydown', (event) => {
    if (document.querySelector('dialog[open]') || launching) return;
    if (zoomed && !root.classList.contains('hidden') && intro.hidden && topoWidget.handleKeyDown(event)) return;
    if (
      event.key.toLowerCase() === 'e' &&
      !event.repeat &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      intro.hidden &&
      !root.classList.contains('hidden') &&
      !zoomed
    ) {
      event.preventDefault();
      setZoom(true);
    }
    if (event.key === 'Escape' && !root.classList.contains('hidden') && zoomed && !event.defaultPrevented) {
      setZoom(false);
    }
  });

  root.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button || launching) return;
    if (button === enter) enterHabitat();
    if (button === reviewOpen || button === screenOpen) setZoom(true, button);
    if (button === reviewClose) setZoom(false);
    if (button.hasAttribute('data-observation')) observation?.showModal();
    if (button.hasAttribute('data-photo-close')) observation?.close();
  });

  reviewClose.hidden = true;
  if (returnToBriefing) {
    history.replaceState(null, '');
    entering = true;
    intro.hidden = true;
    stage.inert = false;
    stage.classList.remove('hab-before-entry');
    room?.setDolly(1);
    setZoom(true);
  }
}
