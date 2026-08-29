// Minimal static file server for local development and for the e2e tests.
// No dependencies: the site is plain HTML/CSS/JS and only needs to be served
// over http:// (not file://) so `fetch("config/site-config.json")` and the
// ES module imports in src/ work.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

export function createStaticServer() {
  return http.createServer((request, response) => {
    const requestUrl = new URL(request.url, "http://localhost");
    let relativePath = decodeURIComponent(requestUrl.pathname);
    if (relativePath === "/") {
      relativePath = "/index.html";
    }

    const filePath = path.join(root, relativePath);
    if (!filePath.startsWith(root)) {
      response.writeHead(403);
      response.end("Forbidden");
      return;
    }

    fs.readFile(filePath, (error, data) => {
      if (error) {
        response.writeHead(404);
        response.end("Not found");
        return;
      }

      const contentType = contentTypes[path.extname(filePath)] || "application/octet-stream";
      response.writeHead(200, { "Content-Type": contentType });
      response.end(data);
    });
  });
}

function isMainModule() {
  return process.argv[1] === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  const port = Number(process.env.PORT) || 8080;
  const server = createStaticServer();
  server.listen(port, () => {
    console.log(`Serving ${root} at http://localhost:${port}/`);
  });
}
