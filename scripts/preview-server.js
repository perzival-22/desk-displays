// A local, static-only preview. Explicit allowlist keeps credentials and APIs private.
import http from "node:http";
import { readFile } from "node:fs/promises";
const files = new Map([
  ["/", ["index.html", "text/html"]],
  ["/index.html", ["index.html", "text/html"]],
  ["/preview.html", ["preview.html", "text/html"]],
  ["/preview.js", ["preview.js", "text/javascript"]],
  ["/assets/preview-landscape.svg", ["assets/preview-landscape.svg", "image/svg+xml"]],
]);
const server = http.createServer(async (req, res) => {
  const file = files.get(new URL(req.url, "http://localhost").pathname);
  if (!file || !["GET", "HEAD"].includes(req.method)) { res.writeHead(404); res.end("Not found"); return; }
  try {
    const content = await readFile(new URL(`../${file[0]}`, import.meta.url));
    res.writeHead(200, { "Content-Type": `${file[1]}; charset=utf-8`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.end(req.method === "HEAD" ? undefined : content);
  } catch { res.writeHead(500); res.end("Could not load preview file"); }
});
server.listen(Number(process.env.PORT) || 4173, "127.0.0.1", () => {
  console.log(`Display preview: http://localhost:${server.address().port}/preview.html`);
});
