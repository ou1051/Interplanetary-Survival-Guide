import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';

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
  console.log('Browser checks passed: habitat entry on desktop and mobile, sources, Delta driving, weather controls and wrist navigator, Gale dust return.');
} finally { await browser.close(); }
