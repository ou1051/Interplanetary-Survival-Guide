import { LIFE_SUPPORT } from '../config/mission.js';
import { forecastReturn, forecastWeather, SUNSET, TWILIGHT_LIMIT, COLD_WORK_LIMIT_C, clock, temperatureAt } from './fieldGuidance.js';
export { forecastReturn, SUNSET, TWILIGHT_LIMIT, COLD_WORK_LIMIT_C, temperatureAt } from './fieldGuidance.js';

// Public clear-weather drive estimate retained for route callers.
export function driveMinutes(route, fromS, toS) {
  return forecastReturn({ route, s: fromS, lmst: 0, met: 0, o2Remaining: 480, batteryWh: 1600 },
    { fromS, toS, includeIngress: false }).driveMinutes;
}

const pendingTasks = station => {
  const tasks = station?.tasks ?? [];
  return tasks.filter(task => !task.done && !task.skipped && (!tasks.some(item => item.artifact) || task.artifact));
};

// What each option would cost, given where the crew stands now.
function plan(mission, { target, work, label, short, id, detail, route }) {
  const tasks = work;
  work = tasks.reduce((sum, task) => sum + task.minutes, 0);
  const targetS = target ? route.stations.find(station => station.id === target.id).s : mission.s;
  const forecast = forecastReturn(mission, { workMinutes: work, workAtS: targetS, route, homeOnly: id === 'home' });
  const arrival = forecast.workStartMinutes;
  const legDrive = arrival;
  let taskElapsed = arrival * 60;
  let outsideMinutes = (mission.outsideMinutes ?? 0) + forecast.walkingMinutes;
  let coldest = null;
  let coldOK = true;
  for (const task of tasks) {
    const weather = forecastWeather(mission, targetS, taskElapsed, route);
    if (task.outside !== false) {
      const endTemperature = temperatureAt(mission.lmst + taskElapsed / 60 + task.minutes);
      const temperature = endTemperature + (weather.temperatureOffsetC ?? 0);
      coldest = coldest === null ? temperature : Math.min(coldest, temperature);
      outsideMinutes = Number.isFinite(weather.exposureMinutes) ? outsideMinutes + task.minutes : 0;
      coldOK &&= endTemperature >= COLD_WORK_LIMIT_C && outsideMinutes <= (weather.exposureMinutes ?? Infinity);
    }
    taskElapsed += task.minutes * 60;
  }
  const { oxygenLeft: o2Left, batteryPct, backAtMinutes, oxygenUsed: oxygen } = forecast;
  const checks = [
    {
      id: 'oxygen', label: 'Oxygen',
      ok: o2Left >= LIFE_SUPPORT.reserveMinutes,
      value: `${Math.round(oxygen)} min needed · ${Math.round(Math.max(0, o2Left))} min left after`,
      rule: `Keep ${LIFE_SUPPORT.reserveMinutes} min reserve`,
    },
    {
      id: 'daylight', label: 'Daylight',
      ok: backAtMinutes <= TWILIGHT_LIMIT,
      value: `Back at habitat ${forecast.backAt} · ${Math.round(forecast.daylightMinutes)} min daylight`,
      rule: `Sunset ${clock(SUNSET)} · home by ${clock(TWILIGHT_LIMIT)}`,
    },
    {
      id: 'cold', label: 'Temperature',
      ok: coldOK,
      value: coldest === null ? 'No work on foot' : `${Math.round(coldest)} °C · ${work} min outside`,
      rule: `Baseline ≥ ${COLD_WORK_LIMIT_C} °C` + (Number.isFinite(mission.weather.exposureMinutes)
        ? ` · cold weather allows ${mission.weather.exposureMinutes} min outside` : ''),
    },
    {
      id: 'battery', label: 'Rover battery',
      ok: batteryPct >= 10,
      value: `${Math.round(batteryPct)} % left at habitat`,
      rule: 'Keep 10 %',
    },
    {
      id: 'dust', label: 'Dust',
      ok: !mission.dustWarning || id === 'home',
      value: mission.dustWarning ? 'Dust front ahead' : mission.weather.label,
      rule: 'Head home if a dust front is coming',
    },
  ];
  const failed = checks.filter((check) => !check.ok);
  return {
    id, label, short, detail, target, quick: id === 'quick',
    minutes: Math.round(forecast.totalMinutes), legMinutes: Math.round(legDrive + work), backAt: forecast.backAt, forecast,
    checks, allowed: id === 'home' || failed.length === 0,
    reason: id === 'home' && failed.length ? 'Always allowed: getting home comes first'
      : failed.map((check) => check.label).join(' · '),
  };
}

export function legOptions(mission, route = mission.route) {
  const remaining = mission.route.stations.filter((station) => !station.final && !station.done && !station.skipped
    && station !== (mission.legPending ?? mission.currentStation));
  const [next, after] = remaining;
  const options = [];
  if (next) {
    options.push(plan(mission, { id: 'continue', label: `Full stop at ${next.id}`, short: 'Full stop', detail: `${next.name} · ${pendingTasks(next).length} remaining tasks`, target: next, work: pendingTasks(next), route }));
    if (pendingTasks(next).length > 1) options.push(plan(mission, { id: 'quick', label: `Quick stop at ${next.id}`, short: 'Quick stop', detail: `${pendingTasks(next)[0].label} only`, target: next, work: pendingTasks(next).slice(0, 1), route }));
    if (after) options.push(plan(mission, { id: 'skip', label: `Skip ${next.id}`, short: `Skip ${next.id}`, detail: `On to ${after.id}`, target: after, work: pendingTasks(after), route }));
  }
  options.push(plan(mission, { id: 'home', label: 'Head home now', short: 'Go home', detail: 'No more stops', target: null, work: [], route }));
  return {
    now: clock(mission.lmst),
    temperature: Math.round(temperatureAt(mission.lmst) + (mission.weather.temperatureOffsetC ?? 0)),
    next,
    options,
    recommended: options.find((option) => option.allowed && option.id !== 'home') ?? options.at(-1),
  };
}
