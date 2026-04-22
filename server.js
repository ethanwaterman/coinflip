const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");

const clients = new Set();
let activeFlip = null;
let lastCompletedFlip = null;
let flipCounter = 0;

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8"
};

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(payload));
}

function broadcast(event, payload) {
  const message = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;

  for (const client of clients) {
    client.write(message);
  }
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function createFlip() {
  const id = ++flipCounter;
  const result = crypto.randomInt(0, 2) === 0 ? "heads" : "tails";
  const secret = crypto.randomBytes(32).toString("hex");
  const timestamp = new Date().toISOString();
  const revealAt = Date.now() + 4500;
  const commitment = sha256(`${id}:${result}:${secret}`);

  return {
    id,
    commitment,
    result,
    secret,
    startedAt: timestamp,
    revealAt
  };
}

function sanitizePath(urlPath) {
  const requestedPath = urlPath === "/" ? "/index.html" : urlPath;
  const normalizedPath = path.normalize(requestedPath).replace(/^(\.\.[/\\])+/, "");
  return path.join(PUBLIC_DIR, normalizedPath);
}

function serveFile(filePath, response) {
  fs.readFile(filePath, (error, content) => {
    if (error) {
      sendJson(response, 404, { error: "Not found" });
      return;
    }

    const extension = path.extname(filePath).toLowerCase();
    response.writeHead(200, {
      "Content-Type": MIME_TYPES[extension] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    response.end(content);
  });
}

function handleEvents(_request, response) {
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive"
  });

  response.write("\n");
  clients.add(response);

  const snapshot = {
    activeFlip: activeFlip
      ? {
          id: activeFlip.id,
          commitment: activeFlip.commitment,
          startedAt: activeFlip.startedAt,
          revealAt: activeFlip.revealAt
        }
      : null,
    lastCompletedFlip
  };

  response.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);

  _request.on("close", () => {
    clients.delete(response);
  });
}

function handleStartFlip(_request, response) {
  if (activeFlip) {
    sendJson(response, 409, {
      error: "A coin flip is already in progress."
    });
    return;
  }

  activeFlip = createFlip();

  const flipStartedPayload = {
    id: activeFlip.id,
    commitment: activeFlip.commitment,
    startedAt: activeFlip.startedAt,
    revealAt: activeFlip.revealAt
  };

  broadcast("flip-started", flipStartedPayload);
  sendJson(response, 200, flipStartedPayload);

  setTimeout(() => {
    if (!activeFlip) {
      return;
    }

    const revealedPayload = {
      id: activeFlip.id,
      commitment: activeFlip.commitment,
      result: activeFlip.result,
      secret: activeFlip.secret,
      startedAt: activeFlip.startedAt,
      revealedAt: new Date().toISOString()
    };

    lastCompletedFlip = revealedPayload;
    activeFlip = null;
    broadcast("flip-revealed", revealedPayload);
  }, Math.max(0, activeFlip.revealAt - Date.now()));
}

function isLocalHost(hostname) {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "0.0.0.0"
  );
}

function getServerUrls(request) {
  const hostHeader = request.headers.host || `localhost:${PORT}`;
  const forwardedProto = request.headers["x-forwarded-proto"];
  const protocol = typeof forwardedProto === "string" ? forwardedProto : "http";
  const origin = `${protocol}://${hostHeader}`;
  const hostname = hostHeader.split(":")[0];
  const port = hostHeader.includes(":") ? hostHeader.split(":").pop() : PORT;
  const urls = new Set([origin]);

  if (!isLocalHost(hostname)) {
    return Array.from(urls);
  }

  urls.add(`http://localhost:${port}`);
  const interfaces = os.networkInterfaces();

  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) {
        urls.add(`http://${entry.address}:${port}`);
      }
    }
  }

  return Array.from(urls);
}

function handleRequest(request, response) {
  const requestUrl = new URL(request.url, `http://${request.headers.host}`);

  if (request.method === "GET" && requestUrl.pathname === "/events") {
    handleEvents(request, response);
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/flip") {
    handleStartFlip(request, response);
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/state") {
    sendJson(response, 200, {
      activeFlip: activeFlip
        ? {
            id: activeFlip.id,
            commitment: activeFlip.commitment,
            startedAt: activeFlip.startedAt,
            revealAt: activeFlip.revealAt
          }
        : null,
      lastCompletedFlip
    });
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/healthz") {
    sendJson(response, 200, {
      ok: true
    });
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/hosts") {
    sendJson(response, 200, {
      urls: getServerUrls(request)
    });
    return;
  }

  if (request.method !== "GET") {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }

  const filePath = sanitizePath(requestUrl.pathname);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendJson(response, 403, { error: "Forbidden" });
    return;
  }

  serveFile(filePath, response);
}

const server = http.createServer(handleRequest);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Coin flip app running on http://0.0.0.0:${PORT}`);
});
