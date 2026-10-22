// Låtsas-Scrapling för tests/scrapling.test.ts: samma protokoll som
// scrapers/worker.py, utan Python. Beteendet styrs av URL:en.
//   fake://ok        → 200 med anropet som body (så testet ser vad som skickades)
//   fake://json      → 200 med {"a":1}
//   fake://404       → 404
//   fake://error     → ok:false
//   fake://slow      → svarar aldrig
//   fake://crash     → processen dör
// Argumentet --missing gör att workern svarar som om scrapling saknas.
import { createInterface } from "node:readline";

const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

if (process.argv.includes("--missing")) {
  send({ ready: false, error: "scrapling_missing" });
  process.exit(2);
}

process.stderr.write("fake: igång\n");
send({ ready: true });

createInterface({ input: process.stdin }).on("line", (line) => {
  const req = JSON.parse(line);
  if (req.op === "close") process.exit(0);
  switch (req.url) {
    case "fake://ok":
      send({ id: req.id, ok: true, status: 200, url: req.url, body: JSON.stringify({ req, argv: process.argv.slice(2) }) });
      break;
    case "fake://json":
      send({ id: req.id, ok: true, status: 200, url: req.url, body: '{"a":1}' });
      break;
    case "fake://404":
      send({ id: req.id, ok: true, status: 404, url: req.url, body: "nope" });
      break;
    case "fake://error":
      send({ id: req.id, ok: false, error: "TimeoutError: boom" });
      break;
    case "fake://slow":
      break;
    case "fake://crash":
      process.exit(3);
      break;
    default:
      send({ id: req.id, ok: false, error: "unknown" });
  }
});
