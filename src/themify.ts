// Post-step: make an Arrow SVG read on light and dark backgrounds.
// Ported from Piper's (caboose/desk) light/dark theming script for the Tube map, 2026-10-15.
// Arrow draws text in fixed near-black; this swaps low-saturation darks and lights
// for --ink and --paper variables that follow prefers-color-scheme or data-theme.

const hex = (h: string): [number, number, number] => {
  let s = h.slice(1);
  if (s.length === 3) {s = s.split("").map((c) => c + c).join("");}
  const channel = (at: number) => Number.parseInt(s.slice(at, at + 2), 16);
  return [channel(0), channel(2), channel(4)];
};
const lum = ([r, g, b]: [number, number, number]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
const sat = ([r, g, b]: [number, number, number]) => (Math.max(r, g, b) - Math.min(r, g, b)) / 255;

const swap = (h: string) => {
  const c = hex(h);
  if (sat(c) < 0.18 && lum(c) < 0.55) {return "var(--ink)";}
  if (sat(c) < 0.18 && lum(c) > 0.85) {return "var(--paper)";}
  return h;
};

export const THEME_STYLE =
  '<style>svg{--ink:#1b1a17;--paper:#f4efe3}@media (prefers-color-scheme:dark){svg{--ink:#ece6d8;--paper:#15140f}}svg[data-theme="light"]{--ink:#1b1a17;--paper:#f4efe3}svg[data-theme="dark"]{--ink:#ece6d8;--paper:#15140f}</style>';

export const themify = (input: string) =>
  input
    .replaceAll(/(?<prop>fill|stroke|stop-color|color)(?<sep>="|:\s*)(?<hex>#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?)\b/gu, (_: string, k: string, sep: string, h: string) => `${k}${sep}${swap(h)}`)
    .replaceAll(/(?<prop>fill|stroke)="(?<colour>black|white)"/gu, (_: string, k: string, c: string) => `${k}="var(--${c === "black" ? "ink" : "paper"})"`)
    .replace(/<svg[^>]*>/u, (m) => `${m}${THEME_STYLE}`);
