export function summarizeWalk(site, result) {
  const missing = site.stations.filter(station => !result.observedStationIds.includes(station.id));
  const overtime = result.elapsedSeconds > site.walkBudgetSeconds;
  const title = !result.returnedToBase ? 'Walk ended before returning to base'
    : missing.length || overtime ? 'Round trip incomplete' : 'Round trip complete';
  const details = [];
  if (missing.length) details.push('Still to record: ' + missing.map(station => station.name).join(', ') + '.');
  if (overtime) details.push('The walk exceeded the site time budget.');
  if (!result.returnedToBase) details.push('Leave base, then return within its interaction radius to finish the trip.');
  if (!details.length) details.push('Both field observations were recorded and you returned within the walk budget.');
  return { title, details: details.join(' ') };
}
