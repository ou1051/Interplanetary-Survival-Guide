// A cinematic timeline, not an orbital mechanics or human-rating simulation.
export const CHAPTERS = [
  { id: 'board', name: 'Boarding', duration: 12, title: 'One last look at home.', caption: 'Cross the crew access arm. Your seat is waiting.', label: 'EARTH · CREW ACCESS', detail: 'T − 00:12' },
  { id: 'launch', name: 'Launch', duration: 16, title: 'Earth falls away.', caption: 'Harness secured. Engines nominal. We are go for ascent.', label: 'ASCENT · GUIDANCE NOMINAL', detail: 'POWERED FLIGHT' },
  { id: 'orbit', name: 'Earth orbit', duration: 14, title: 'Everything you know. Below you.', caption: 'Orbit established. Preparing the departure burn.', label: 'EARTH ORBIT · DEPARTURE', detail: '400 KM · ILLUSTRATIVE' },
  { id: 'cruise', name: 'Transfer', duration: 14, title: 'Months between two worlds.', caption: 'A journey of several months, compressed into a few moments.', label: 'INTERPLANETARY TRANSFER', detail: 'TIME COMPRESSED' },
  { id: 'approach', name: 'Mars approach', duration: 13, title: 'A new horizon.', caption: 'Mars fills the window. Review the terrain before you descend.', label: 'MARS · ARRIVAL', detail: 'ENTRY PREPARATION' },
  { id: 'land', name: 'Landing', duration: 15, title: 'Your next step is on Mars.', caption: 'Controlled descent. Touchdown at the simulated delta-front base.', label: 'MARS · POWERED DESCENT', detail: 'LANDING SIMULATION' },
];
export const TOTAL_DURATION = CHAPTERS.reduce((sum, stage) => sum + stage.duration, 0);
export function chapterAt(elapsed) {
  let start = 0;
  const time = Math.max(0, Number.isFinite(elapsed) ? elapsed : 0);
  for (let index = 0; index < CHAPTERS.length; index++) {
    const chapter = CHAPTERS[index];
    if (time < start + chapter.duration || index === CHAPTERS.length - 1) {
      return { ...chapter, index, start, progress: Math.min(1, (time - start) / chapter.duration), complete: time >= TOTAL_DURATION };
    }
    start += chapter.duration;
  }
}
export const ease = (t) => { const x = Math.max(0, Math.min(1, t)); return x * x * (3 - 2 * x); };
