const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_HISTORY = 25;
const FLIP_DURATION_MS = 1800;
const SERIES_PAUSE_MS = 1000;

const clients = new Set();
let activeFlip = null;
let flipHistory = [];
let currentSeries = null;
let nextFlipTimeout = null;
let flipCounter = 0;
let historyCounter = 0;
let viewerCounter = 0;

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
    client.response.write(message);
  }
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function normalizeBestOf(value) {
  const numeric = Number(value);

  if (!Number.isFinite(numeric)) {
    return null;
  }

  let normalized = Math.max(1, Math.floor(numeric));

  if (normalized > 1 && normalized % 2 === 0) {
    normalized += 1;
  }

  return normalized > 1 ? normalized : null;
}

function createSeriesState(options) {
  return {
    id: ++historyCounter,
    bestOf: options.bestOf,
    targetWins: Math.floor(options.bestOf / 2) + 1,
    headsOption: options.headsOption,
    tailsOption: options.tailsOption,
    headsWins: 0,
    tailsWins: 0,
    startedAt: new Date().toISOString(),
    rounds: [],
    winner: null
  };
}

function createFlip(options) {
  const id = ++flipCounter;
  const result = crypto.randomInt(0, 2) === 0 ? "heads" : "tails";
  const secret = crypto.randomBytes(32).toString("hex");
  const startedAt = new Date().toISOString();
  const revealAt = Date.now() + FLIP_DURATION_MS;
  const commitment = sha256(`${id}:${result}:${secret}`);

  return {
    id,
    commitment,
    headsOption: options.headsOption,
    tailsOption: options.tailsOption,
    result,
    secret,
    startedAt,
    revealAt,
    roundNumber: options.roundNumber,
    bestOf: options.bestOf,
    targetWins: options.targetWins
  };
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let raw = "";

    request.on("data", (chunk) => {
      raw += chunk;

      if (raw.length > 1024 * 64) {
        reject(new Error("Request body too large"));
        request.destroy();
      }
    });

    request.on("end", () => {
      if (!raw) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });

    request.on("error", reject);
  });
}

function buildPublicSeriesState() {
  if (!currentSeries) {
    return null;
  }

  return {
    id: currentSeries.id,
    bestOf: currentSeries.bestOf,
    targetWins: currentSeries.targetWins,
    headsOption: currentSeries.headsOption,
    tailsOption: currentSeries.tailsOption,
    headsWins: currentSeries.headsWins,
    tailsWins: currentSeries.tailsWins,
    startedAt: currentSeries.startedAt,
    rounds: currentSeries.rounds.map((round) => ({
      id: round.id,
      result: round.result,
      revealedAt: round.revealedAt
    })),
    winner: currentSeries.winner
  };
}

function buildPresenceState() {
  const sortedClients = Array.from(clients).sort((left, right) => left.id - right.id);
  let anonymousCount = 0;

  return sortedClients.map((client) => {
    if (client.name) {
      return {
        id: client.id,
        label: client.name,
        named: true
      };
    }

    anonymousCount += 1;
    return {
      id: client.id,
      label: `Person ${anonymousCount}`,
      named: false
    };
  });
}

function buildHistoryEntryFromSeries(series) {
  return {
    id: series.id,
    bestOf: series.bestOf,
    targetWins: series.targetWins,
    headsOption: series.headsOption,
    tailsOption: series.tailsOption,
    startedAt: series.startedAt,
    revealedAt: series.rounds[series.rounds.length - 1].revealedAt,
    winner: series.winner,
    rounds: series.rounds.map((round) => ({
      id: round.id,
      result: round.result,
      startedAt: round.startedAt,
      revealedAt: round.revealedAt
    }))
  };
}

function buildHistoryEntryFromSingleFlip(flip) {
  return {
    id: ++historyCounter,
    bestOf: 1,
    targetWins: 1,
    headsOption: flip.headsOption,
    tailsOption: flip.tailsOption,
    startedAt: flip.startedAt,
    revealedAt: flip.revealedAt,
    winner: flip.result,
    rounds: [
      {
        id: flip.id,
        result: flip.result,
        startedAt: flip.startedAt,
        revealedAt: flip.revealedAt
      }
    ]
  };
}

function prependHistoryEntry(entry) {
  flipHistory = [entry, ...flipHistory.filter((item) => item.id !== entry.id)].slice(
    0,
    MAX_HISTORY
  );
  return entry;
}

function clearNextFlipTimeout() {
  if (nextFlipTimeout) {
    clearTimeout(nextFlipTimeout);
    nextFlipTimeout = null;
  }
}

function createFlipStartedPayload(flip) {
  return {
    id: flip.id,
    commitment: flip.commitment,
    headsOption: flip.headsOption,
    tailsOption: flip.tailsOption,
    startedAt: flip.startedAt,
    revealAt: flip.revealAt,
    roundNumber: flip.roundNumber,
    bestOf: flip.bestOf,
    targetWins: flip.targetWins,
    series: buildPublicSeriesState()
  };
}

function startNextRound() {
  const headsOption = currentSeries ? currentSeries.headsOption : "";
  const tailsOption = currentSeries ? currentSeries.tailsOption : "";
  const roundNumber = currentSeries ? currentSeries.rounds.length + 1 : 1;
  const bestOf = currentSeries ? currentSeries.bestOf : 1;
  const targetWins = currentSeries ? currentSeries.targetWins : 1;

  activeFlip = createFlip({
    headsOption,
    tailsOption,
    roundNumber,
    bestOf,
    targetWins
  });

  const payload = createFlipStartedPayload(activeFlip);
  broadcast("flip-started", payload);

  setTimeout(() => {
    revealActiveFlip();
  }, Math.max(0, activeFlip.revealAt - Date.now()));

  return payload;
}

function scheduleNextRound() {
  clearNextFlipTimeout();
  nextFlipTimeout = setTimeout(() => {
    nextFlipTimeout = null;

    if (!currentSeries || currentSeries.winner || activeFlip) {
      return;
    }

    startNextRound();
  }, SERIES_PAUSE_MS);
}

function revealActiveFlip() {
  if (!activeFlip) {
    return;
  }

  const flip = activeFlip;
  const revealedAt = new Date().toISOString();
  const revealedPayload = {
    id: flip.id,
    commitment: flip.commitment,
    headsOption: flip.headsOption,
    tailsOption: flip.tailsOption,
    result: flip.result,
    secret: flip.secret,
    startedAt: flip.startedAt,
    revealedAt,
    roundNumber: flip.roundNumber,
    bestOf: flip.bestOf,
    targetWins: flip.targetWins
  };

  activeFlip = null;

  if (currentSeries) {
    const roundSummary = {
      id: flip.id,
      result: flip.result,
      startedAt: flip.startedAt,
      revealedAt
    };

    currentSeries.rounds.push(roundSummary);

    if (flip.result === "heads") {
      currentSeries.headsWins += 1;
    } else {
      currentSeries.tailsWins += 1;
    }

    if (currentSeries.headsWins >= currentSeries.targetWins) {
      currentSeries.winner = "heads";
    } else if (currentSeries.tailsWins >= currentSeries.targetWins) {
      currentSeries.winner = "tails";
    }

    revealedPayload.series = buildPublicSeriesState();

    if (currentSeries.winner) {
      const historyEntry = prependHistoryEntry(
        buildHistoryEntryFromSeries(currentSeries)
      );
      revealedPayload.historyEntry = historyEntry;
      currentSeries = null;
      broadcast("series-updated", null);
    } else {
      scheduleNextRound();
    }
  } else {
    const historyEntry = prependHistoryEntry(
      buildHistoryEntryFromSingleFlip({
        ...flip,
        revealedAt
      })
    );
    revealedPayload.historyEntry = historyEntry;
    revealedPayload.series = null;
  }

  broadcast("flip-revealed", revealedPayload);
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

function handleEvents(request, response) {
  const client = {
    id: ++viewerCounter,
    name: "",
    response
  };

  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive"
  });

  response.write("\n");
  clients.add(client);

  const snapshot = {
    selfViewerId: client.id,
    activeFlip: activeFlip ? createFlipStartedPayload(activeFlip) : null,
    history: flipHistory,
    series: buildPublicSeriesState(),
    presence: buildPresenceState()
  };

  response.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
  broadcast("presence-updated", {
    presence: buildPresenceState()
  });

  request.on("close", () => {
    clients.delete(client);
    broadcast("presence-updated", {
      presence: buildPresenceState()
    });
  });
}

async function handleUpdatePresence(request, response) {
  let payload = {};

  try {
    payload = await readJsonBody(request);
  } catch (error) {
    sendJson(response, 400, {
      error: error.message
    });
    return;
  }

  const viewerId = Number(payload.viewerId);

  if (!Number.isFinite(viewerId)) {
    sendJson(response, 400, {
      error: "A valid viewer id is required."
    });
    return;
  }

  const client = Array.from(clients).find((entry) => entry.id === viewerId);

  if (!client) {
    sendJson(response, 404, {
      error: "Viewer not found."
    });
    return;
  }

  client.name =
    typeof payload.name === "string"
      ? payload.name.trim().slice(0, 40)
      : "";

  const presence = buildPresenceState();
  broadcast("presence-updated", {
    presence
  });
  sendJson(response, 200, {
    ok: true,
    presence
  });
}

async function handleStartFlip(request, response) {
  if (activeFlip || nextFlipTimeout) {
    sendJson(response, 409, {
      error: "A coin flip or series is already in progress."
    });
    return;
  }

  let payload = {};

  try {
    payload = await readJsonBody(request);
  } catch (error) {
    sendJson(response, 400, {
      error: error.message
    });
    return;
  }

  const headsOption =
    typeof payload.headsOption === "string" ? payload.headsOption.trim() : "";
  const tailsOption =
    typeof payload.tailsOption === "string" ? payload.tailsOption.trim() : "";
  const requestedBestOf = normalizeBestOf(payload.bestOf);

  if (requestedBestOf) {
    currentSeries = createSeriesState({
      bestOf: requestedBestOf,
      headsOption,
      tailsOption
    });
  } else {
    currentSeries = null;
  }

  broadcast("series-updated", buildPublicSeriesState());
  const startedPayload = startNextRound();
  sendJson(response, 200, startedPayload);
}

function handleClearHistory(_request, response) {
  flipHistory = [];
  broadcast("history-updated", {
    history: flipHistory
  });
  sendJson(response, 200, {
    ok: true
  });
}

async function handleDeleteHistoryEntry(request, response) {
  let payload = {};

  try {
    payload = await readJsonBody(request);
  } catch (error) {
    sendJson(response, 400, {
      error: error.message
    });
    return;
  }

  const entryId = Number(payload.id);

  if (!Number.isFinite(entryId)) {
    sendJson(response, 400, {
      error: "A valid history id is required."
    });
    return;
  }

  const nextHistory = flipHistory.filter((entry) => entry.id !== entryId);

  if (nextHistory.length === flipHistory.length) {
    sendJson(response, 404, {
      error: "That history entry no longer exists."
    });
    return;
  }

  flipHistory = nextHistory;
  broadcast("history-updated", {
    history: flipHistory
  });
  sendJson(response, 200, {
    ok: true
  });
}

function handleResetSession(_request, response) {
  if (activeFlip) {
    sendJson(response, 409, {
      error: "Wait for the current flip to finish before resetting the app."
    });
    return;
  }

  clearNextFlipTimeout();
  currentSeries = null;
  broadcast("series-updated", null);
  broadcast("session-reset", {
    history: flipHistory
  });
  sendJson(response, 200, {
    ok: true
  });
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

async function handleRequest(request, response) {
  const requestUrl = new URL(request.url, `http://${request.headers.host}`);

  if (request.method === "GET" && requestUrl.pathname === "/events") {
    handleEvents(request, response);
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/flip") {
    await handleStartFlip(request, response);
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/history/clear") {
    handleClearHistory(request, response);
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/presence") {
    await handleUpdatePresence(request, response);
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/history/delete") {
    await handleDeleteHistoryEntry(request, response);
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/session/reset") {
    handleResetSession(request, response);
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/state") {
    sendJson(response, 200, {
      activeFlip: activeFlip ? createFlipStartedPayload(activeFlip) : null,
      history: flipHistory,
      series: buildPublicSeriesState(),
      presence: buildPresenceState()
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
