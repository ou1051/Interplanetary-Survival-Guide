// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountHabitat } from '../src/ui/habitat.js';

vi.mock('../src/ui/habitatRoom.js', () => ({ mountHabitatRoom: () => null }));
vi.mock('../src/ui/habitatExterior.js', () => ({ mountHabitatExterior: () => null }));
vi.mock('../src/ui/consoleMap3D.js', () => ({ mountConsoleMap3D: vi.fn() }));
vi.mock('../src/ui/siteTopology.js', () => ({ MARS_SITES: [], SiteTopologyWidget: class {} }));
vi.mock('../src/ui/deltaOverview.js', () => ({ makeDeltaOverview: () => ({ draw: vi.fn(), s1: [100, 100] }) }));

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = ''; });

function setup() {
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
  click('[data-s1]');
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
});
