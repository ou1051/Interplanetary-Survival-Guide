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
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://localhost:4173');
  await page.waitForFunction(() => window.__isg?.journey, null, { timeout: 90000 });
  await page.screenshot({ path: 'test-results/01-launch.png' });
  await page.getByRole('button', { name: 'Mission & sources' }).click();
  assert.equal(await page.locator('#sourcesDialog').evaluate(el => el.open), true);
  await page.getByRole('button', { name: 'Close mission information' }).click();
  await page.getByRole('button', { name: /BOARD THE ROCKET/ }).click();
  await page.waitForFunction(() => window.__isg.journey.active);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  const frozen = await page.evaluate(() => window.__isg.journey.elapsed);
  await page.waitForTimeout(250);
  assert.equal(await page.evaluate(() => window.__isg.journey.elapsed), frozen);
  await page.screenshot({ path: 'test-results/02-boarding.png' });
  await page.getByRole('button', { name: 'Next chapter →', exact: true }).click();
  await page.waitForFunction(() => window.__isg.journey.lastChapter === 1);
  await page.screenshot({ path: 'test-results/03-cockpit.png' });
  await page.getByRole('button', { name: 'Next chapter →', exact: true }).click();
  await page.waitForFunction(() => window.__isg.journey.lastChapter === 2);
  await page.screenshot({ path: 'test-results/04-orbit.png' });
  await page.getByRole('button', { name: 'Next chapter →', exact: true }).click();
  await page.getByRole('button', { name: 'Next chapter →', exact: true }).click();
  await page.waitForFunction(() => window.__isg.journey.lastChapter === 4);
  await page.screenshot({ path: 'test-results/05-mars.png' });
  await page.getByRole('button', { name: 'Next chapter →', exact: true }).click();
  await page.waitForFunction(() => window.__isg.journey.lastChapter === 5);
  await page.getByRole('button', { name: 'Begin surface mission →' }).click();
  await page.waitForFunction(() => window.__isg.journey.done && window.__isg.mission.state !== 'brief');
  assert.equal(await page.locator('#hud').isVisible(), true);
  await page.screenshot({ path: 'test-results/06-surface.png' });
  const before = await page.evaluate(() => window.__isg.mission.s);
  await page.keyboard.down('w'); await page.waitForTimeout(1200); await page.keyboard.up('w');
  assert.ok(await page.evaluate(() => window.__isg.mission.s) > before, 'Surface rover responds to driving input');
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
  mobile.on('pageerror', e => errors.push(e.message));
  await mobile.goto('http://localhost:4173');
  await mobile.waitForFunction(() => window.__isg?.journey, null, { timeout: 90000 });
  assert.equal(await mobile.evaluate(() => window.__isg.journey.reduced), true);
  await mobile.screenshot({ path: 'test-results/07-mobile.png' });
  await mobile.getByRole('button', { name: /Skip to surface/ }).click();
  await mobile.waitForFunction(() => window.__isg.mission.state !== 'brief');
  assert.deepEqual(errors, [], 'No runtime errors');
  console.log('Browser checks passed: desktop journey, pause, all six chapters, sources, surface handoff, driving, mobile skip and reduced motion.');
} finally { await browser.close(); }
