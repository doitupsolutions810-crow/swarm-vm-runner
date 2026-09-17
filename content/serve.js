import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const PORT = Number(process.env.CONTENT_PORT || 8088);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "www");
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let rel = url.pathname === "/" ? "/index.html" : url.pathname;
  const file = path.normalize(path.join(root, rel));
  if (!file.startsWith(root)) { res.writeHead(403); return res.end("forbidden"); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { "content-type": "text/plain" }); return res.end("not found"); }
    res.writeHead(200, { "content-type": file.endsWith(".html") ? "text/html" : "text/plain" });
    res.end(buf);
  });
});
server.listen(PORT, () => console.log(`content host on ${PORT}`));
