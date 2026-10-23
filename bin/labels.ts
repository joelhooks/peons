// labels: put real, correctly spelled text on an Arrow artwork.
//
//   node bin/labels.ts <art.svg> <reference.svg> --anchors "Queue=x,y;THE NEST=x,y;Nodes=x,y;Hoard=x,y" \
//     --out <labelled.svg> [--subtitle "..."] [--nudge "Label=dx,dy;Hoard#2=dx,dy"] [--view-box "x y w h"] [--ring-pad n] [--text-scale n] [--label-scale n] [--only "Name;Name"]
//
// Arrow draws lettering as paths, and on dense maps it misspells or drops names.
// So the art is drawn with no text and every <text> from the reference is laid on
// top as outlined paths in a hand-lettered font, as Sticker Studio does: live
// <text> draws in whatever font the viewer has. Arrow picks its own canvas, so
// the reference is mapped into the art's space by a per-axis least-squares fit
// over named station anchors (station centre in art units). When the art places
// stations with <use …Station>, each label snaps to its own station.
// --nudge moves single labels, in art units; Name#2 is the second label with
// that text. --view-box widens the canvas for edge labels. --ring-pad pushes
// labels clear of rings drawn larger than the reference's.
import { readFileSync, writeFileSync } from "node:fs";
import nodePath from "node:path";
import { parse } from "opentype.js";
import { THEME_STYLE } from "../src/themify.ts";

type Point = readonly [number, number];

const flag = (name: string) => {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
};
const point = (xy: string): Point => {
  const [x = Number.NaN, y = Number.NaN] = xy.split(",").map(Number);
  return [x, y];
};
const pairs = (spec: string | undefined): Map<string, Point> =>
  new Map(
    (spec ?? "")
      .split(";")
      .filter((s) => s.includes("="))
      .map((s) => {
        const at = s.lastIndexOf("=");
        return [s.slice(0, at).trim(), point(s.slice(at + 1))];
      }),
  );

const [artPath, refPath] = process.argv.slice(2);
const out = flag("--out");
if (artPath === undefined || refPath === undefined || out === undefined) {
  console.error("usage: node bin/labels.ts <art.svg> <reference.svg> --anchors 'Queue=x,y;THE NEST=x,y;...' --out <file>");
  process.exit(2);
}
const art = readFileSync(artPath, "utf-8");
const ref = readFileSync(refPath, "utf-8");
const attr = (attrs: string, name: string) => new RegExp(`\\s${name}="([^"]+)"`, "u").exec(attrs)?.[1];
const refTexts = [...ref.matchAll(/<text(?<attrs>[^>]*)>(?<body>[^<]*)<\/text>/gu)].map(([, attrs = "", body = ""]) => ({
  at: [Number(attr(attrs, "x")), Number(attr(attrs, "y"))] as Point,
  attrs,
  body,
}));

// Stations: map circles in the reference, <use …Station> placements in the art.
const refStations = [...ref.matchAll(/<circle cx="(?<x>[\d.]+)" cy="(?<y>[\d.]+)"[^>]*class="(?:ring|dot)"/gu)].map(
  ([, x, y]): Point => [Number(x), Number(y)],
);
const nearest = (points: readonly Point[], [x, y]: Point) => {
  let best: { p: Point | undefined; d: number } = { d: Number.POSITIVE_INFINITY, p: undefined };
  for (const p of points) {
    const d = Math.hypot(p[0] - x, p[1] - y);
    if (d < best.d) {best = { d, p };}
  }
  return best;
};
// An anchor names a label; its reference station is the map circle nearest that label.
const anchors = [...pairs(flag("--anchors"))].flatMap(([name, drawn]) => {
  const named = refTexts.filter((t) => t.body === name);
  const label = named.find((t) => /\blbl\b/u.test(attr(t.attrs, "class") ?? "")) ?? named[0];
  const station = label === undefined ? undefined : nearest(refStations, label.at).p;
  return station === undefined ? [] : [{ drawn, station }];
});
const nudges = pairs(flag("--nudge"));
if (anchors.length < 2) {
  console.error("usage: node bin/labels.ts <art.svg> <reference.svg> --anchors 'Queue=x,y;THE NEST=x,y;...' --out <file>");
  process.exit(2);
}

const mean = (vs: number[]) => vs.reduce((s, v) => s + v, 0) / vs.length;
// art = ref * a + b, fitted separately per axis.
const fitAxis = (axis: 0 | 1) => {
  const xs = anchors.map((a) => a.station[axis]);
  const ys = anchors.map((a) => a.drawn[axis]);
  const mx = mean(xs);
  const my = mean(ys);
  const sxx = xs.reduce((s, v) => s + (v - mx) ** 2, 0);
  const a = sxx === 0 ? 1 : xs.reduce((s, v, i) => s + (v - mx) * ((ys[i] ?? my) - my), 0) / sxx;
  return { a, b: my - a * mx };
};
const fx = fitAxis(0);
const fy = fitAxis(1);
// reference px to art units, for font sizes and halos
const k = (fx.a + fy.a) / 2;
const toArt = ([x, y]: Point): Point => [x * fx.a + fx.b, y * fy.a + fy.b];

const subtitle = flag("--subtitle");
const svgTag = /<svg[^>]*>/u.exec(art)?.[0] ?? "";
const artViewBox = /viewBox="(?<box>[^"]+)"/u.exec(svgTag)?.[1] ?? "0 0 100 100";
const viewBox = flag("--view-box") ?? artViewBox;
const { 2: artW, 3: artH } = artViewBox.split(/\s+/u);
// The art's root presentation attributes (fill="none" above all) must still wrap it.
const rootAttrs = [...svgTag.matchAll(/\s(?<name>[\w:-]+)="[^"]*"/gu)]
  .filter(([, name = ""]) => !["width", "height", "viewBox", "xmlns", "data-theme"].includes(name))
  .map(([whole]) => whole);
const namespaces = rootAttrs.filter((a) => a.trim().startsWith("xmlns:")).join("");
const presentation = rootAttrs.filter((a) => !a.trim().startsWith("xmlns:")).join("");
const inner = art
  .replace(/^[\s\S]*?<svg[^>]*>/u, "")
  .replace(/<\/svg>\s*$/u, "")
  .replaceAll(/<style>[\s\S]*?<\/style>/gu, "")
  .replaceAll(/<text[\s\S]*?<\/text>/gu, "")
  // A full-canvas rect is a background Arrow added; the sticker rule is transparent.
  .replaceAll(new RegExp(`<rect width="${artW}" height="${artH}"[^>]*/>`, "gu"), "");
// Telos sometimes names its layers; a <g id="background"> is never part of the sticker.
const dropGroup = (svg: string, id: string) => {
  const start = svg.indexOf(`<g id="${id}"`);
  if (start === -1) {return svg;}
  let depth = 0;
  for (const m of svg.slice(start).matchAll(/<g\b[^>]*?(?<selfClosing>\/?)>|<\/g>/gu)) {
    if (m[0] === "</g>") {depth -= 1;} else if (m[1] !== "/") {depth += 1;}
    if (depth === 0) {return svg.slice(0, start) + svg.slice(start + (m.index ?? 0) + m[0].length);}
  }
  return svg;
};
const artwork = dropGroup(inner, "background");

// A label near a reference station keeps its offset from that station and
// follows the art's own station, so a route Arrow bent carries its label.
// Art stations are <use …Station> placements when Arrow drew them that way,
// plus the anchors, which are stations read off the art.
const artStations: Point[] = [
  ...[...art.matchAll(/<use transform="translate\((?<x>[\d.-]+)[ ,](?<y>[\d.-]+)\)[^>]*Station"/gu)].map(([, x, y]): Point => [Number(x), Number(y)]),
  ...anchors.map((a) => a.drawn),
];
const ringPad = Number(flag("--ring-pad") ?? 0);
const ringOffset = (anchor: string, oy: number): Point => {
  if (anchor === "start") {return [ringPad, 0];}
  if (anchor === "end") {return [-ringPad, 0];}
  return [0, Math.sign(oy) * ringPad];
};
const place = (label: Point, anchor: string): Point => {
  const station = nearest(refStations, label);
  if (station.p === undefined || station.d > 60 || artStations.length === 0) {return toArt(label);}
  const drawn = nearest(artStations, toArt(station.p));
  if (drawn.p === undefined || drawn.d > 60 * k) {return toArt(label);}
  const ox = (label[0] - station.p[0]) * k;
  const oy = (label[1] - station.p[1]) * k;
  const [px, py] = ringOffset(anchor, oy);
  return [drawn.p[0] + ox + px, drawn.p[1] + oy + py];
};

const load = (file: string) => {
  const bytes = readFileSync(nodePath.join(import.meta.dirname, "../assets/fonts", file));
  return parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
};
const hand = load("PatrickHand-Regular.ttf");
const marker = load("PermanentMarker-Regular.ttf");
// Sizes come from the reference's own CSS (px per class), times --text-scale,
// then into art units. The last class wins: "lbl big" is big. Title and big
// letter in marker, the rest by hand.
const textScale = Number(flag("--text-scale") ?? 1);
// --label-scale enlarges station names only; title, subtitle and legend keep their size.
const labelScale = Number(flag("--label-scale") ?? 1);
const refSizes = new Map(
  [...ref.matchAll(/\.(?<cls>[\w-]+)\s*\{(?<body>[^}]*)\}/gu)].flatMap(([, cls = "", body = ""]) => {
    const px = /(?<px>\d+(?:\.\d+)?)px/u.exec(body)?.[1];
    return px === undefined ? [] : [[cls, Number(px)] as const];
  }),
);
const outline = (text: string, cls: string, anchor: string, [x, y]: Point) => {
  const last = cls.split(" ").at(-1) ?? "lbl";
  const font = last === "title" || last === "big" ? marker : hand;
  const own = last === "title" || last === "sub" || last === "leg" ? 1 : labelScale;
  const size = (refSizes.get(last) ?? refSizes.get("lbl") ?? 16) * textScale * own * k;
  const width = font.getAdvanceWidth(text, size);
  let left = x;
  if (anchor === "middle") {left = x - width / 2;} else if (anchor === "end") {left = x - width;}
  const d = font.getPath(text, left, y, size).toPathData(k < 0.2 ? 2 : 1);
  return `<path aria-label="${text}" d="${d}"/>`;
};

const seen = new Map<string, number>();
const only = flag("--only")?.split(";").map((s) => s.trim());
const labels = refTexts.flatMap(({ attrs, body, at }) => {
  const cls = attr(attrs, "class") ?? "lbl";
  if (only !== undefined && cls.includes("lbl") && !only.includes(body)) {return [];}
  const anchor = attr(attrs, "text-anchor") ?? "start";
  const text = cls === "sub" && subtitle !== undefined ? subtitle : body;
  const nth = (seen.get(text) ?? 0) + 1;
  seen.set(text, nth);
  const [dx, dy] = nudges.get(`${text}#${nth}`) ?? (nth === 1 ? nudges.get(text) : undefined) ?? [0, 0];
  const [x, y] = place(at, anchor);
  return [outline(text, cls, anchor, [x + dx, y + dy])];
});

// The halo keeps lettering readable where it crosses a strip, in both modes.
const r = (n: number) => Math.round(n * 100) / 100;
const halo = ` fill="var(--ink)" stroke="var(--paper)" stroke-width="${r(4 * k)}" stroke-linejoin="round" paint-order="stroke"`;
writeFileSync(
  out,
  `<svg xmlns="http://www.w3.org/2000/svg"${namespaces} viewBox="${viewBox}" role="img" aria-label="Piper Tube map">${THEME_STYLE}
<g${presentation}>${artwork}</g>
<g class="labels"${halo}>${labels.join("\n")}</g>
</svg>
`,
);
console.log(JSON.stringify({ anchors: anchors.length, fit: { x: fx, y: fy }, labels: labels.length, out, snapped: artStations.length > 0 }));
