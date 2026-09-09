/**
 * Zero-dependency static server for local viewing.
 *
 * index.html loads app.js as an ES module and fetches the catalog JSON, both
 * of which a browser blocks over file:// — so opening the file directly from
 * disk shows an empty page. This removes that footgun.
 *
 * Usage:
 *   node serve.mjs          (then open http://localhost:5173)
 *   PORT=8080 node serve.mjs
 *
 * Not needed in production: Vercel (or any static host) serves this folder as-is.
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PORT = Number(process.env.PORT ?? 5173);

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
};

const server = createServer(async (req, res) => {
  const requestPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
  const relative = requestPath === "/" ? "index.html" : requestPath.replace(/^\/+/, "");

  // Keep traversal inside ROOT — normalize resolves any ".." before the check.
  const filePath = join(ROOT, normalize(relative));
  if (!filePath.startsWith(ROOT.endsWith(sep) ? ROOT : ROOT + sep)) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("Forbidden");
    return;
  }

  try {
    const body = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": CONTENT_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
});

server.listen(PORT, () => {
  console.log(`Live casino demo: http://localhost:${PORT}`);
});
