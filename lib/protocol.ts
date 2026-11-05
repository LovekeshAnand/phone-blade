export type Hand = 'L' | 'R';
export const HANDS: Hand[] = ['L', 'R'];
export type Remotes = Record<Hand, boolean>;

export const HAND_COLOR: Record<Hand, string> = { L: '#ff7a1a', R: '#19e6ff' };
export const HAND_NAME: Record<Hand, string> = { L: 'Left', R: 'Right' };
