/**
 * Sizes for a screen that could be anything from 960 to 3840 pixels wide.
 *
 * A television's browser reports a width that depends on how the set was
 * configured - a 1080p panel can be 960 or 1920 of them - so a fixed pixel size
 * is either unreadable or enormous. Everything on the TV is sized in a unit that
 * is one 160th of the screen's width (or of the width a 16:9 picture of its
 * height would have, whichever is smaller), set once on the TV's root element.
 *
 * `u(3)` is three of those: about 36 px on a 1920-wide screen, about 18 on a
 * 960-wide one, and the same share of the picture in both.
 */
export const UNIT = 'clamp(5px, calc(min(100vw, 177.78vh) / 160), 16px)';

export const u = (n: number): string => `calc(var(--u) * ${n})`;
