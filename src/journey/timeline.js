export const DURATION = 42;
export const CHAPTERS = [
  ['EARTH · DEPARTURE', 'Our pale blue home', 'Board the transfer vehicle. Your next assignment lies beneath a different sky.'],
  ['EARTH · ASCENT', 'Leaving everything familiar', 'The atmosphere thins. The planet curves away beneath the spacecraft.'],
  ['INTERPLANETARY TRANSFER', 'Across the quiet', 'Months of travel become moments in this compressed mission preview.'],
  ['MARS · ORBITAL INSERTION', 'A new horizon', 'Gale Crater comes into view. Prepare to investigate Vera Rubin Ridge.'],
  ['VERA RUBIN RIDGE', 'Make every step count', 'Scout orbital evidence, compare routes and rehearse before committing your crew.'],
];
export function chapterAt(seconds) {
  if (seconds < 9) return 1;
  if (seconds < 27) return 2;
  if (seconds < DURATION) return 3;
  return 4;
}
export function smooth(value) {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}
