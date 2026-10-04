// Packar upp HLTV:s demoarkiv. HLTV har levererat .rar i många år, men
// formatet avgörs av filens första byte — inte filändelsen — så .zip, .gz
// och en rå .dem fungerar också.

import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

export type ArchiveKind = "rar" | "zip" | "gzip" | "bzip2" | "dem" | "unknown";

export function detectArchive(head: Uint8Array): ArchiveKind {
  const b = (i: number) => head[i] ?? -1;
  if (b(0) === 0x52 && b(1) === 0x61 && b(2) === 0x72 && b(3) === 0x21) return "rar"; // "Rar!"
  if (b(0) === 0x50 && b(1) === 0x4b && (b(2) === 0x03 || b(2) === 0x05) && (b(3) === 0x04 || b(3) === 0x06)) return "zip";
  if (b(0) === 0x1f && b(1) === 0x8b) return "gzip";
  if (b(0) === 0x42 && b(1) === 0x5a && b(2) === 0x68) return "bzip2"; // "BZh"
  // CS2-demo: "PBDEMS2\0"
  if (String.fromCharCode(...Array.from(head.slice(0, 7))) === "PBDEMS2") return "dem";
  return "unknown";
}

async function readHead(file: string, n = 16): Promise<Uint8Array> {
  const fh = await fs.open(file, "r");
  try {
    const buf = Buffer.alloc(n);
    await fh.read(buf, 0, n, 0);
    return new Uint8Array(buf);
  } finally {
    await fh.close();
  }
}

async function extractZip(file: string, destDir: string): Promise<string[]> {
  const yauzl = await import("yauzl");
  const out: string[] = [];
  await new Promise<void>((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error("zip kunde inte öppnas"));
      zip.on("error", reject);
      zip.on("end", () => resolve());
      zip.on("entry", (entry: { fileName: string }) => {
        if (/\/$/.test(entry.fileName) || !/\.dem$/i.test(entry.fileName)) return zip.readEntry();
        zip.openReadStream(entry as never, (e, stream) => {
          if (e || !stream) return reject(e ?? new Error("zip-post kunde inte läsas"));
          const dest = path.join(destDir, path.basename(entry.fileName));
          pipeline(stream, createWriteStream(dest))
            .then(() => {
              out.push(dest);
              zip.readEntry();
            })
            .catch(reject);
        });
      });
      zip.readEntry();
    });
  });
  return out;
}

async function extractRar(file: string, destDir: string): Promise<string[]> {
  const { createExtractorFromFile } = await import("node-unrar-js");
  const extractor = await createExtractorFromFile({ filepath: file, targetPath: destDir, filenameTransform: (n) => path.basename(n) });
  const { files } = extractor.extract({ files: (h) => !h.flags.directory && /\.dem$/i.test(h.name) });
  const out: string[] = [];
  // Generatorn packar upp fil för fil när den itereras.
  for (const f of files) out.push(path.join(destDir, path.basename(f.fileHeader.name)));
  return out;
}

/** Packar upp alla .dem ur arkivet till `destDir` och returnerar sökvägarna. */
export async function extractDemos(file: string, destDir: string): Promise<string[]> {
  await fs.mkdir(destDir, { recursive: true });
  const kind = detectArchive(await readHead(file));
  switch (kind) {
    case "dem":
      return [file];
    case "zip":
      return extractZip(file, destDir);
    case "rar":
      return extractRar(file, destDir);
    case "gzip": {
      const dest = path.join(destDir, path.basename(file).replace(/\.gz$/i, "") || "demo.dem");
      await pipeline(createReadStream(file), createGunzip(), createWriteStream(dest));
      return extractDemos(dest, destDir);
    }
    case "bzip2":
      throw new Error("bzip2-arkiv stöds inte — packa upp demon manuellt och kör med --file");
    default:
      throw new Error(`Okänt arkivformat: ${path.basename(file)}`);
  }
}
