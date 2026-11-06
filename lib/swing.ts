// Cut scoring by swing size: wind up before the block, follow through after it, cut near its center.
// Phones only report orientation, so "swing size" is how far the blade turned, in degrees.
export const PRE_FULL = 90, POST_FULL = 60; // degrees of arc that earn the full part
const PRE_PTS = 50, POST_PTS = 30, ACC_PTS = 20; // out of 100 per block

/** Points for one cut, plus a word for the player. `off` is 0 (dead center) to 1 (grazed the edge). */
export function swingScore(preDeg: number, postDeg: number, off: number) {
  const c = (x: number) => Math.min(1, Math.max(0, x));
  const pre = c(preDeg / PRE_FULL), post = c(postDeg / POST_FULL), acc = c(1 - off);
  const pts = Math.round(PRE_PTS * pre + POST_PTS * post + ACC_PTS * acc);
  const text = pts >= 90 ? 'PERFECT' : pts >= 80 ? 'GREAT' : pre < 0.5 ? 'UNDERSWING' : post < 0.5 ? 'FOLLOW THROUGH' : 'GOOD';
  return { pts, text };
}
