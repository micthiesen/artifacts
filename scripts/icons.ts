// Renders the PNG icons from their SVG sources in src/shell/icons. Needs
// rsvg-convert (brew install librsvg). Usage: bun scripts/icons.ts
const DIR = "src/shell/icons";
const renders: [source: string, out: string, width: number][] = [
  ["icon.svg", "favicon-32.png", 32],
  ["icon-full.svg", "apple-touch-icon.png", 180],
  ["icon-full.svg", "icon-192.png", 192],
  ["icon-full.svg", "icon-512.png", 512],
  ["og.svg", "og.png", 1200],
];
for (const [source, out, width] of renders) {
  const proc = Bun.spawnSync(["rsvg-convert", "-w", String(width), "-o", `${DIR}/${out}`, `${DIR}/${source}`]);
  if (proc.exitCode !== 0) throw new Error(`${out}: ${proc.stderr.toString()}`);
  console.log(`${out} (${width}px)`);
}
