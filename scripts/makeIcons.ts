/**
 * Rasterise app/icon.svg into the PNG icons referenced by the web manifest and
 * iOS apple-touch-icon. Run after editing the SVG:
 *
 *   npm run icons
 *
 * The generated PNGs (public/icon-192.png, public/icon-512.png, app/apple-icon.png)
 * are committed so Vercel doesn't need to regenerate them at build time.
 */
import sharp from "sharp";
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

async function main() {
  const root = process.cwd();
  const svg = readFileSync(join(root, "app", "icon.svg"));
  const pub = join(root, "public");
  mkdirSync(pub, { recursive: true });

  const targets: [string, number][] = [
    [join(pub, "icon-192.png"), 192],
    [join(pub, "icon-512.png"), 512],
    [join(root, "app", "apple-icon.png"), 180],
  ];

  for (const [file, size] of targets) {
    await sharp(svg, { density: 512 }).resize(size, size).png().toFile(file);
    console.log(`→ ${file} (${size}×${size})`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
