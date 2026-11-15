import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';

async function checkMobileActions(page, label) {
  const issues = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('.field-tools button')].filter(button => button.getClientRects().length);
    const issues = [];
    for (const button of buttons) {
      const r = button.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      if (r.left < 0 || r.right > innerWidth || r.top < 0 || r.bottom > innerHeight) issues.push(`${button.textContent.trim()}: outside viewport`);
      if (!button.contains(hit)) issues.push(`${button.textContent.trim()}: covered by ${hit?.id || hit?.className}`);
    }
    for (let i = 0; i < buttons.length; i++) for (let j = i + 1; j < buttons.length; j++) {
      const a = buttons[i].getBoundingClientRect(), b = buttons[j].getBoundingClientRect();
      if (Math.min(a.right, b.right) > Math.max(a.left, b.left) && Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top)) issues.push(`${buttons[i].id} overlaps ${buttons[j].id}`);
    }
    return issues;
  });
  assert.deepEqual(issues, [], `Mobile ${label}: all weather and crew buttons are visible and reachable`);
}

await mkdir('test-results', { recursive: true });
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors = [];
for (let attempt = 0; attempt < 100; attempt++) {
  try { if ((await fetch('http://localhost:4173')).ok) break; } catch {}
  if (attempt === 99) throw new Error('Preview server did not start');
  await new Promise(resolve => setTimeout(resolve, 100));
}
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  page.on('pageerror', e => { errors.push(e.message); console.log('PAGE ERROR:', e.stack); });
  await page.goto('http://localhost:4173');
  await page.getByRole('heading', { name: /Mars Surface Operations/ }).waitFor();
  assert.equal(await page.getByLabel('Mission site').isVisible(), false);
  await page.screenshot({ path: 'test-results/01-welcome.png' });
  await page.getByRole('button', { name: 'Enter habitat' }).click();
  await page.getByRole('button', { name: /Review route/ }).click();
  await page.getByLabel('Mission site').waitFor();
  const forecast = page.locator('[data-cabin-weather] summary');
  await forecast.click();
  assert.equal(await page.locator('[data-cabin-visibility]').isVisible(), true);
  await forecast.click();
  assert.equal(await page.getByLabel('Simulation conditions').inputValue(), 'variable');
  assert.equal(await page.locator('#viewport canvas').count(), 0);
  assert.equal(await page.getByRole('link', { name: 'Explore Mars' }).getAttribute('href'), './map.html');
  await page.getByRole('button', { name: 'Mission & sources' }).click();
  assert.equal(await page.locator('#sourcesDialog').evaluate(el => el.open), true);
  await page.getByRole('button', { name: 'Close mission information' }).click();
  await page.getByRole('button', { name: /Plan leg to S1/ }).click();
  await page.getByRole('button', { name: /Longer/ }).click();
  await page.getByRole('button', { name: /Go outside/ }).click();
  await page.waitForFunction(() => window.__isg?.mission?.state === 'drive');
  assert.equal(await page.evaluate(() => window.__isg.route.planName), 'Delta Front · Longer to S1');
  await page.keyboard.press('p');
  await page.getByRole('button', { name: 'Route', exact: true }).click();
  assert.equal(await page.locator('#planningBoard [data-route-name]').textContent(), 'Delta Front · Longer to S1');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#hud').isVisible(), true);
  await page.screenshot({ path: 'test-results/02-surface.png' });
  const before = await page.evaluate(() => window.__isg.mission.s);
  console.log('Surface state:', await page.evaluate(() => ({ state: window.__isg.mission.state, s: window.__isg.mission.s, nextStop: window.__isg.mission.nextStop?.s })));
  assert.deepEqual(errors, [], 'No runtime errors before driving');
  await page.keyboard.down('w');
  try { await page.waitForFunction(start => window.__isg.mission.s > start, before, { timeout: 20000 }); }
  finally { await page.keyboard.up('w'); }
  assert.ok(await page.evaluate(() => window.__isg.mission.s) > before, 'Surface rover responds to driving input');
  const weather = await page.evaluate(() => {
    const { mission, simulate } = window.__isg;
    for (let i = 0; i < 35 && mission.weather.label === 'Clear'; i++) simulate(1, { throttle: false });
    return mission.weather.label;
  });
  assert.notEqual(weather, 'Clear', 'Default Delta launch gets variable weather');
  await page.waitForFunction(label => document.querySelector('#fieldWeather').textContent === label, weather);
  await page.getByRole('button', { name: 'Weather now ' + weather, exact: true }).click();
  await page.locator('[data-route-view]').waitFor();
  assert.equal(await page.locator('#planningBoard [data-scenario]').count(), 0);
  const wristWeather = await page.locator('[data-route-weather]').textContent();
  assert.ok(wristWeather.includes(weather));
  await page.keyboard.press('Escape');
  await page.keyboard.press('m');
  await page.waitForFunction(label => document.querySelector('#mapWeather').textContent === label, wristWeather);
  await page.locator('.map-weather').press('Enter');
  await page.locator('[data-route-view]').waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.map-weather').evaluate(el => el === document.activeElement), true);
  await page.locator('#mapClose').click();
  // Free roaming EVA: drive to S1, get out, collect a find on foot, board again.
  await page.evaluate(() => {
    const { mission, simulate } = window.__isg;
    for (let i = 0; i < 900 && mission.currentStation?.id !== 'S1'; i++) simulate(0.5, { boost: true });
    for (let i = 0; i < 300 && Math.abs(mission.rover.speed) > 0.01; i++) mission.update(1 / 30, { brake: true }, 0);
  });
  assert.equal(await page.evaluate(() => window.__isg.mission.currentStation?.id), 'S1');
  await page.keyboard.press('f');
  await page.waitForFunction(() => window.__isg.mission.state === 'walk');
  await page.evaluate(() => {
    const { mission, artifacts } = window.__isg;
    const find = artifacts.find(a => a.stationId === 'S1');
    mission.walker.x = find.x + 1.2;
    mission.walker.z = find.z;
  });
  await page.waitForFunction(() => !document.getElementById('collectBtn').hidden);
  await page.screenshot({ path: 'test-results/02b-on-foot.png' });
  await page.keyboard.down('e');
  try { await page.waitForFunction(() => window.__isg.mission.collected.length > 0, null, { timeout: 20000 }); }
  finally { await page.keyboard.up('e'); }
  assert.equal(await page.evaluate(() => window.__isg.mission.collected.length), 1);
  assert.equal(await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('isg.collection.v1')).items).length), 1);
  await page.evaluate(() => { const { mission } = window.__isg; const r = mission.rover; mission.walker.x = r.x - Math.cos(r.heading) * 2.4; mission.walker.z = r.z + Math.sin(r.heading) * 2.4; });
  await page.waitForFunction(() => window.__isg.mission.canBoard);
  await page.keyboard.press('f');
  await page.waitForFunction(() => window.__isg.mission.state === 'drive');
  // Reproduce the cold S1 card, then run the previously blocked scan through the keyboard.
  await page.evaluate(() => {
    const { mission } = window.__isg;
    mission._weather = { ...mission.weather, label: 'Cold spell', exposureMinutes: 10 };
    mission._weatherAt = mission.met + 360;
  });
  const scan = page.locator('#card .tasks .task').filter({ hasText: 'VNIR spectrometer scan' });
  await page.locator('#viewport').focus();
  await page.keyboard.down('e');
  try { await scan.getByText(/cold window/).waitFor(); }
  finally { await page.keyboard.up('e'); }
  assert.equal(await page.evaluate(() => window.__isg.mission.currentStation.tasks[0].done), false);
  await page.locator('#card [data-action="wait"]').click();
  await page.locator('#viewport').focus();
  await page.keyboard.down('e');
  try { await scan.getByText(/olivine-rich/).waitFor(); }
  finally { await page.keyboard.up('e'); }
  assert.equal(await page.evaluate(() => window.__isg.mission.currentStation.tasks.filter(task => !task.artifact && task.done).length), 1);
  await page.close();
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
  mobile.on('pageerror', e => errors.push(e.message));
  await mobile.goto('http://localhost:4173', { waitUntil: 'domcontentloaded', timeout: 90000 });
  await mobile.getByRole('heading', { name: /Mars Surface Operations/ }).waitFor();
  assert.equal(await mobile.getByLabel('Mission site').isVisible(), false);
  await mobile.screenshot({ path: 'test-results/03-welcome.png' });
  await mobile.getByRole('button', { name: 'Enter habitat' }).click();
  await mobile.getByRole('button', { name: /Review route/ }).click();
  await mobile.getByLabel('Mission site').waitFor();
  await mobile.getByLabel('Mission site').selectOption('gale');
  await mobile.getByRole('button', { name: /Shortest/ }).click();
  await mobile.locator('[data-rehearsal-settings] summary').click();
  await mobile.getByLabel('Simulation conditions').selectOption('dust');
  await mobile.getByRole('button', { name: /Go outside/ }).click();
  await mobile.waitForFunction(() => window.__isg?.mission?.state === 'drive');
  assert.equal(await mobile.evaluate(() => window.__isg.route.planName), 'Shortest route');
  await checkMobileActions(mobile, 'driving');
  await mobile.locator('#crewBtn').click();
  await mobile.waitForFunction(() => window.__isg.mission.onFoot);
  await mobile.waitForFunction(() => window.__isg.mission.canBoard);
  await mobile.locator('#crewBtn').click();
  await mobile.waitForFunction(() => window.__isg.mission.state === 'drive');
  await mobile.locator('#crewBtn').click();
  await mobile.waitForFunction(() => window.__isg.mission.onFoot);
  await mobile.evaluate(() => {
    const { mission, artifacts } = window.__isg;
    const find = artifacts.find(a => a.stationId === 'S1');
    mission.walker.x = find.x + 1.2;
    mission.walker.z = find.z;
  });
  await mobile.waitForFunction(() => !document.getElementById('collectBtn').hidden);
  await checkMobileActions(mobile, 'artifact pickup');
  await mobile.screenshot({ path: 'test-results/04-mobile-pickup.png' });
  await mobile.locator('#collectBtn').dispatchEvent('pointerdown');
  try { await mobile.waitForFunction(() => window.__isg.mission.collected.length === 1); }
  finally { await mobile.locator('#collectBtn').dispatchEvent('pointerup'); }
  await mobile.evaluate(() => {
    const { mission } = window.__isg;
    const r = mission.rover, distance = Math.hypot(r.x, r.z);
    mission.walker.x = r.x + r.x / distance * 2.4;
    mission.walker.z = r.z + r.z / distance * 2.4;
  });
  await mobile.waitForFunction(() => window.__isg.mission.canBoard);
  await mobile.locator('#crewBtn').click();
  await mobile.waitForFunction(() => window.__isg.mission.state === 'drive');
  await mobile.evaluate(() => { window.__isg.mission.leftHome = true; });
  await mobile.waitForFunction(() => !document.getElementById('endBtn').hidden);
  await checkMobileActions(mobile, 'airlock return');
  // Reproject the outbound leg after moving the test walker back to the parked rover.
  await mobile.evaluate(() => {
    const m = window.__isg.mission;
    m.leftHome = false;
    m.s = m.route.nearestS(m.rover.x, m.rover.z);
  });
  await mobile.evaluate(() => {
    const { mission, route, simulate } = window.__isg;
    for (let i = 0; i < 300 && mission.s < route.length * 0.29; i++) {
      if (mission.state === 'gate') mission.acknowledge();
      if (mission.state !== 'drive') throw new Error('Unexpected stop before the dust front: ' + mission.state);
      simulate(1, { boost: true });
    }
    if (mission.s < route.length * 0.29) throw new Error('Rover did not reach the dust front');
  });
  await mobile.getByRole('button', { name: /Turn around and return/ }).click();
  assert.equal(await mobile.evaluate(() => window.__isg.mission.aborted), true);
  assert.deepEqual(errors, [], 'No runtime errors');
  console.log('Browser checks passed for forecasts, field weather, rover driving, station task holds, artifact collection, reboarding and Gale dust return.');
} finally { await browser.close(); }
