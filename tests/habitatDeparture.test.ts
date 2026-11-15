// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountHabitat } from '../src/ui/habitat.js';
import { Mission } from '../src/sim/mission.js';

vi.mock('../src/ui/habitatRoom.js', () => ({ mountHabitatRoom: () => null }));
vi.mock('../src/ui/habitatExterior.js', () => ({ mountHabitatExterior: () => null }));
vi.mock('../src/ui/consoleMap3D.js', () => ({ map3DSupport: () => ({ ok: false }), mountConsoleMap3D: vi.fn() }));
vi.mock('../src/ui/siteTopology.js', () => ({ MARS_SITES: [], SiteTopologyWidget: class {
  constructor(host, { onDeploy }) {
    const deploy = document.createElement('button');
    deploy.dataset.topologyDeploy = '';
    deploy.onclick = () => onDeploy({ site: { name: 'Jezero' }, pathId: 'shortest' });
    host.append(deploy);
  }
} }));
vi.mock('../src/ui/deltaOverview.js', () => ({ makeDeltaOverview: () => ({ draw: vi.fn(), s1: [100, 100] }) }));

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = ''; });

function setup(focusS1 = true) {
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  vi.stubGlobal('Path2D', class { moveTo() {} lineTo() {} });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(new Proxy({}, {
    get: () => () => {},
  }) as CanvasRenderingContext2D);
  const root = document.createElement('div');
  document.body.append(root);
  const launch = vi.fn().mockResolvedValue(undefined);
  mountHabitat(root, launch);
  const click = (selector: string) => root.querySelector<HTMLButtonElement>(selector)!.click();
  if (focusS1) click('[data-s1]');
  return { root, launch, click };
}

describe('habitat weather departure decision', () => {
  it.each(['proceed', 'wait', 'detour'])('launches %s with its displayed route and charged wait', async choice => {
    const { root, launch, click } = setup();
    expect(root.querySelector('[data-departure-weather]')!.hasAttribute('hidden')).toBe(false);
    expect(root.querySelector('[data-weather-forecast]')!.textContent).toContain('from habitat');
    click(`[data-departure="${choice}"]`);
    expect(root.querySelector(`[data-departure="${choice}"]`)!.getAttribute('aria-pressed')).toBe('true');
    expect(root.querySelector('[data-departure-forecast]')!.textContent).toMatch(/O₂.*battery.*home.*sunset/);
    expect(root.querySelector('[data-departure-forecast]')!.textContent).not.toMatch(/NaN|Infinity|undefined/);
    click('[data-launch]');
    await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(1));
    const [plan, scenario] = launch.mock.calls[0];
    expect(scenario).toBe('variable');
    expect(plan.id).toBe(choice === 'detour' ? 'longer' : 'shortest');
    expect(plan.frontSeconds).toBeGreaterThanOrEqual(360);
    expect(plan.departureWaitSeconds).toBe(choice === 'wait' ? plan.frontSeconds : 0);
    expect(!!plan.traverse.route.weatherExposure).toBe(choice !== 'detour');
  });

  it.each(['variable', 'clear'])('carries the %s shortcut forecast into a topology deployment', async mode => {
    const { root, launch, click } = setup();
    const conditions = root.querySelector<HTMLSelectElement>('[data-scenario]')!;
    conditions.value = mode;
    conditions.dispatchEvent(new Event('change'));
    click('[data-topology-deploy]');
    await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce());
    const [plan, scenario] = launch.mock.calls[0];
    expect(scenario).toBe(mode);
    if (mode === 'clear') expect(plan.frontSeconds).toBe(0);
    else expect(plan.frontSeconds).toBeGreaterThanOrEqual(360);
    const { route, terrain } = plan.traverse;
    const mission = new Mission(route, terrain, {}, { frontSeconds: plan.frontSeconds, surprises: false });
    const patch = route.areaHazards.find(area => area.unsurveyed);
    const point = { x: patch.cx, z: patch.cz };
    expect(mission.weatherAt(0, 0, route, point).label).toBe(mode === 'variable' ? 'Dust front over shortcut' : 'Clear');
    expect(mission.weatherAt(0, plan.frontSeconds, route, point).label).toBe('Clear');
  });

  it('clears a wait choice when nominal conditions are selected', async () => {
    const { root, launch, click } = setup();
    click('[data-departure="wait"]');
    const scenario = root.querySelector<HTMLSelectElement>('[data-scenario]')!;
    scenario.value = 'clear';
    scenario.dispatchEvent(new Event('change'));
    expect(root.querySelector('[data-departure-weather]')!.hasAttribute('hidden')).toBe(true);
    click('[data-launch]');
    await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(1));
    expect(launch.mock.calls[0][0].frontSeconds).toBe(0);
    expect(launch.mock.calls[0][0].departureWaitSeconds).toBe(0);
  });

  it('shows an informative uncertain departure forecast before choosing S1', () => {
    const { root } = setup(false);
    const details = root.querySelector<HTMLDetailsElement>('[data-cabin-weather]')!;
    expect(details.open).toBe(false);
    expect(details.closest('[data-s1-picker]')).toBeNull();
    expect(details.querySelector('summary')!.textContent).toMatch(/Departure forecast.*Clear at habitat.*6–10 min.*uncertain/s);
    expect(details.textContent).toMatch(/visibility.*work.*reserve/is);
    expect(root.querySelector<HTMLDetailsElement>('[data-rehearsal-settings]')!.open).toBe(false);
  });

  it('updates the read-only forecast for the site, approach and deliberate training mode', () => {
    const { root, click } = setup();
    click('[data-departure="detour"]');
    expect(root.querySelector('[data-cabin-outlook]')!.textContent).toContain('avoids');
    const site = root.querySelector<HTMLSelectElement>('[data-site-select]')!;
    site.value = 'gale'; site.dispatchEvent(new Event('change'));
    expect(root.querySelector('[data-cabin-conditions]')!.textContent).toContain('Gale');
    expect(root.querySelector('[data-cabin-outlook]')!.textContent).toContain('uncertain');
    const scenario = root.querySelector<HTMLSelectElement>('[data-scenario]')!;
    scenario.value = 'dust'; scenario.dispatchEvent(new Event('change'));
    expect(root.querySelector('[data-cabin-conditions]')!.textContent).toContain('Dust-front rehearsal');
    scenario.value = 'clear'; scenario.dispatchEvent(new Event('change'));
    expect(root.querySelector('[data-cabin-outlook]')!.textContent).toContain('Nominal');
    expect(root.querySelector('[data-cabin-outlook]')!.textContent).not.toContain('6–10');
  });

  it('opening forecast details does not change the training mode, wait or simulation', () => {
    const wait = vi.spyOn(Mission.prototype, 'waitForWeather');
    const start = vi.spyOn(Mission.prototype, 'start');
    const { root, launch } = setup(false);
    wait.mockClear(); start.mockClear();
    root.querySelector<HTMLElement>('[data-cabin-weather] summary')!.click();
    expect(root.querySelector<HTMLDetailsElement>('[data-cabin-weather]')!.open).toBe(true);
    expect(root.querySelector<HTMLSelectElement>('[data-scenario]')!.value).toBe('variable');
    expect(wait).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
    expect(root.querySelector('[data-departure="wait"]')!.getAttribute('aria-pressed')).not.toBe('true');
  });

});
