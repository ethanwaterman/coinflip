
const statusText = document.getElementById("status-text");
const flipButton = document.getElementById("flip-button");
const coin = document.getElementById("coin");
const resultText = document.getElementById("result-text");
const bestOfInput = document.getElementById("best-of-input");
const bestOfSummary = document.getElementById("best-of-summary");
const sessionPanel = document.getElementById("session-panel");
const sessionScore = document.getElementById("session-score");
const sessionStatus = document.getElementById("session-status");
const sessionResults = document.getElementById("session-results");
const detailsButton = document.getElementById("details-button");
const resetAppButton = document.getElementById("reset-app-button");
const clearHistoryButton = document.getElementById("clear-history-button");
const presenceCount = document.getElementById("presence-count");
const presenceList = document.getElementById("presence-list");
const presenceNameInput = document.getElementById("presence-name-input");
const verificationText = document.getElementById("verification-text");
const commitmentText = document.getElementById("commitment-text");
const secretText = document.getElementById("secret-text");
const detailsPanel = document.getElementById("details-panel");
const headsOutcome = document.getElementById("heads-outcome");
const tailsOutcome = document.getElementById("tails-outcome");
const headsInput = document.getElementById("heads-input");
const tailsInput = document.getElementById("tails-input");
const historyList = document.getElementById("history-list");

let activeFlipId = null;
let currentResult = null;
let countdownIntervalId = null;
let historyEntries = [];
let currentSeries = null;
let selfViewerId = null;
let presenceUpdateTimeoutId = null;

const savedPresenceName = (() => {
  try {
    return window.localStorage.getItem("coinflip-presence-name") || "";
  } catch {
    return "";
  }
})();

async function digestSha256(value) {
  const bytes = new TextEncoder().encode(value);
  const hashBuffer = await crypto.subtle.digest("SHA-256", bytes);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeBestOfValue(value) {
  const digitsOnly = String(value).replace(/\D/g, "");
  const numeric = Number(digitsOnly);

  if (!Number.isFinite(numeric)) {
    return null;
  }

  let normalized = Math.max(1, Math.floor(numeric));

  if (normalized > 1 && normalized % 2 === 0) {
    normalized += 1;
  }

  return normalized > 1 ? normalized : null;
}

function getCurrentBestOfValue() {
  return normalizeBestOfValue(bestOfInput.value);
}

function toggleDetails() {
  const nextHidden = !detailsPanel.classList.contains("is-hidden");
  detailsPanel.classList.toggle("is-hidden", nextHidden);
  detailsButton.textContent = nextHidden ? "Details" : "Hide Details";
}

function renderPresence(presence) {
  presenceList.replaceChildren();

  if (!presence.length) {
    presenceCount.textContent = "No one here";
    return;
  }

  presenceCount.textContent =
    presence.length === 1 ? "1 person here" : `${presence.length} people here`;

  for (const viewer of presence) {
    const pill = document.createElement("span");
    pill.className = "presence-pill";

    if (viewer.id === selfViewerId) {
      pill.classList.add("is-self");
    }

    pill.textContent = viewer.label;
    presenceList.append(pill);
  }
}

function schedulePresenceUpdate() {
  try {
    window.localStorage.setItem("coinflip-presence-name", presenceNameInput.value);
  } catch {
    // Best-effort persistence only.
  }

  if (selfViewerId === null) {
    return;
  }

  if (presenceUpdateTimeoutId !== null) {
    window.clearTimeout(presenceUpdateTimeoutId);
  }

  presenceUpdateTimeoutId = window.setTimeout(async () => {
    presenceUpdateTimeoutId = null;

    try {
      await fetch("/api/presence", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          viewerId: selfViewerId,
          name: presenceNameInput.value
        })
      });
    } catch {
      // Presence updates are best-effort.
    }
  }, 250);
}

function setOptionInputs(payload) {
  headsInput.value = payload.headsOption || "";
  tailsInput.value = payload.tailsOption || "";
}

function clearOptionInputs() {
  headsInput.value = "";
  tailsInput.value = "";
}

function syncInputLocks() {
  const locked = Boolean(currentSeries && !currentSeries.winner);
  headsInput.disabled = locked;
  tailsInput.disabled = locked;
  bestOfInput.disabled = locked;
}

function syncBestOfUi() {
  const rawValue = bestOfInput.value.replace(/\D/g, "");
  const rawNumeric = Number(rawValue);
  const bestOf = getCurrentBestOfValue();

  if (bestOfInput.value !== rawValue) {
    bestOfInput.value = rawValue;
  }

  if (currentSeries) {
    bestOfInput.value = String(currentSeries.bestOf);
  }

  if (!bestOf) {
    bestOfSummary.textContent = "";
    return;
  }

  const winsNeeded = Math.floor(bestOf / 2) + 1;

  if (currentSeries) {
    bestOfSummary.textContent =
      `${currentSeries.headsWins}-${currentSeries.tailsWins} | first to ${currentSeries.targetWins}`;
    return;
  }

  if (Number.isFinite(rawNumeric) && rawNumeric > 1 && rawNumeric % 2 === 0) {
    bestOfSummary.textContent = `Using ${bestOf}. First to ${winsNeeded}`;
    return;
  }

  bestOfSummary.textContent = `First to ${winsNeeded}`;
}

function renderSessionPanel() {
  if (!currentSeries) {
    sessionPanel.classList.add("is-hidden");
    sessionScore.textContent = "";
    sessionStatus.textContent = "";
    sessionResults.replaceChildren();
    return;
  }

  sessionPanel.classList.remove("is-hidden");
  sessionScore.textContent = `${currentSeries.headsWins}-${currentSeries.tailsWins}`;
  sessionStatus.textContent = currentSeries.winner
    ? `${currentSeries.winner === "heads" ? "Heads" : "Tails"} won the best of ${currentSeries.bestOf}.`
    : `Best of ${currentSeries.bestOf}. First to ${currentSeries.targetWins} wins.`;

  sessionResults.replaceChildren();

  if (!currentSeries.rounds.length) {
    const waiting = document.createElement("p");
    waiting.className = "session-result-label";
    waiting.textContent = "The result is: waiting for the first flip.";
    sessionResults.append(waiting);
    return;
  }

  for (const [index, round] of currentSeries.rounds.entries()) {
    const row = document.createElement("div");
    row.className = "session-result-row";

    const label = document.createElement("p");
    label.className = "session-result-label";
    label.textContent = `The result is: flip ${index + 1}`;

    const value = document.createElement("p");
    value.className = "session-result-value";
    value.textContent = round.result === "heads" ? "HEADS" : "TAILS";

    row.append(label, value);
    sessionResults.append(row);
  }
}

function setSeriesState(series) {
  currentSeries = series;
  syncInputLocks();
  syncBestOfUi();
  renderSessionPanel();
}

function updateOutcomeIndicators(result) {
  currentResult = result;
  headsOutcome.classList.toggle("is-winner", result === "heads");
  tailsOutcome.classList.toggle("is-winner", result === "tails");
}

function clearOutcomeIndicators() {
  currentResult = null;
  headsOutcome.classList.remove("is-winner");
  tailsOutcome.classList.remove("is-winner");
}

function clearCountdown() {
  if (countdownIntervalId !== null) {
    window.clearInterval(countdownIntervalId);
    countdownIntervalId = null;
  }
}

function formatOptionText(value, fallback) {
  return value || fallback;
}

function formatTimestamp(value) {
  return new Date(value).toLocaleString();
}

function setHistoryEntries(history) {
  historyEntries = history;
  renderHistory();
}

function prependHistoryEntry(entry) {
  historyEntries = [entry, ...historyEntries.filter((item) => item.id !== entry.id)];
  renderHistory();
}

function renderHistory() {
  historyList.replaceChildren();

  if (!historyEntries.length) {
    const empty = document.createElement("p");
    empty.className = "history-empty";
    empty.textContent = "No flips yet.";
    historyList.append(empty);
    return;
  }

  for (const entry of historyEntries) {
    const item = document.createElement("article");
    item.className = "history-item";

    const header = document.createElement("div");
    header.className = "history-item-header";

    const meta = document.createElement("p");
    meta.className = "history-meta";
    meta.textContent =
      entry.bestOf > 1
        ? `Best of ${entry.bestOf}: ${entry.winner === "heads" ? "Heads" : "Tails"} won on ${formatTimestamp(entry.revealedAt)}`
        : `${entry.winner === "heads" ? "Heads" : "Tails"} won on ${formatTimestamp(entry.revealedAt)}`;

    const deleteButton = document.createElement("button");
    deleteButton.className = "mini-button mini-button-secondary";
    deleteButton.type = "button";
    deleteButton.textContent = "Delete";
    deleteButton.addEventListener("click", () => {
      void deleteHistoryEntry(entry.id);
    });

    const heads = document.createElement("p");
    heads.className = "history-option";
    heads.textContent = `Heads: ${formatOptionText(entry.headsOption, "No description provided")}`;

    const tails = document.createElement("p");
    tails.className = "history-option";
    tails.textContent = `Tails: ${formatOptionText(entry.tailsOption, "No description provided")}`;

    header.append(meta, deleteButton);
    item.append(header, heads, tails);

    if (entry.rounds && entry.rounds.length) {
      const rounds = document.createElement("div");
      rounds.className = "history-rounds";

      for (const round of entry.rounds) {
        const chip = document.createElement("p");
        chip.className = "history-round";
        chip.textContent = `#${round.id} ${round.result === "heads" ? "Heads" : "Tails"}`;
        rounds.append(chip);
      }

      item.append(rounds);
    }

    historyList.append(item);
  }
}

function setIdleState() {
  clearCountdown();
  activeFlipId = null;
  statusText.textContent = "Click the coin to flip";
  flipButton.disabled = false;
  resultText.textContent = "";
  verificationText.textContent = "Waiting for reveal";
  commitmentText.textContent = "Not started";
  secretText.textContent = "Hidden until the flip completes";
  coin.classList.remove("spinning", "show-heads", "show-tails");
  coin.classList.add("resting");
  clearOutcomeIndicators();
  syncBestOfUi();
  renderSessionPanel();
}

function showCountdown(revealAt) {
  clearCountdown();

  const updateCountdown = () => {
    const remainingMs = Math.max(0, revealAt - Date.now());
    const remainingSeconds = (remainingMs / 1000).toFixed(1);
    statusText.textContent = `Flipping... reveal in ${remainingSeconds}s`;
  };

  updateCountdown();
  countdownIntervalId = window.setInterval(() => {
    updateCountdown();

    if (Date.now() >= revealAt) {
      clearCountdown();
    }
  }, 100);
}

function startFlipAnimation() {
  coin.classList.remove("show-heads", "show-tails", "resting");
  void coin.offsetWidth;
  coin.classList.add("spinning");
}

function showFlipStarted(payload) {
  activeFlipId = payload.id;
  flipButton.disabled = true;
  resultText.textContent = "Coin is in the air";
  commitmentText.textContent = payload.commitment;
  secretText.textContent = "Hidden until the reveal";
  verificationText.textContent = "Commitment received by every viewer";

  if (payload.series) {
    setSeriesState(payload.series);
  }

  if (payload.roundNumber && payload.bestOf > 1) {
    statusText.textContent = `Round ${payload.roundNumber} of ${payload.bestOf}`;
  }

  setOptionInputs(payload);
  clearOutcomeIndicators();
  startFlipAnimation();
  showCountdown(payload.revealAt);
}

async function showFlipRevealed(payload) {
  if (activeFlipId !== null && activeFlipId !== payload.id) {
    return;
  }

  clearCountdown();
  activeFlipId = payload.id;
  coin.classList.remove("spinning", "show-heads", "show-tails", "resting");
  coin.classList.add(payload.result === "heads" ? "show-heads" : "show-tails");
  setOptionInputs(payload);
  resultText.textContent = payload.result === "heads" ? "HEADS" : "TAILS";
  commitmentText.textContent = payload.commitment;
  secretText.textContent = payload.secret;

  const calculated = await digestSha256(
    `${payload.id}:${payload.result}:${payload.secret}`
  );
  const verified = calculated === payload.commitment;

  verificationText.textContent = verified
    ? "Verified: reveal matches original commitment"
    : "Verification failed: reveal did not match commitment";

  if (payload.series) {
    setSeriesState(payload.series);

    if (payload.series.winner) {
      statusText.textContent =
        `${payload.series.winner === "heads" ? "Heads" : "Tails"} wins the best of ${payload.series.bestOf}`;
    } else {
      statusText.textContent =
        `${payload.result === "heads" ? "Heads" : "Tails"} wins this flip. Next round starting soon...`;
    }
  } else {
    statusText.textContent = verified
      ? `${payload.result === "heads" ? "Heads" : "Tails"} wins`
      : "Verification failed";
  }

  updateOutcomeIndicators(payload.result);

  if (payload.historyEntry) {
    prependHistoryEntry(payload.historyEntry);
  }

  activeFlipId = null;

  if (!payload.series || payload.series.winner) {
    flipButton.disabled = false;
  }
}

async function fetchInitialState() {
  const response = await fetch("/api/state", { cache: "no-store" });
  const payload = await response.json();

  setHistoryEntries(payload.history || []);
  setSeriesState(payload.series || null);
  renderPresence(payload.presence || []);

  if (payload.activeFlip) {
    showFlipStarted(payload.activeFlip);
    return;
  }

  setIdleState();
}

async function triggerFlip() {
  try {
    flipButton.disabled = true;
    const response = await fetch("/api/flip", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        bestOf: getCurrentBestOfValue(),
        headsOption: headsInput.value,
        tailsOption: tailsInput.value
      })
    });

    if (!response.ok) {
      const payload = await response.json();
      throw new Error(payload.error || "Unable to start flip");
    }
  } catch (error) {
    flipButton.disabled = false;
    statusText.textContent = "Flip could not start";
    resultText.textContent = error.message;
  }
}

async function clearHistory() {
  const confirmed = window.confirm(
    "Clear all flip history for everyone viewing this session? This cannot be undone."
  );

  if (!confirmed) {
    return;
  }

  try {
    clearHistoryButton.disabled = true;
    const response = await fetch("/api/history/clear", {
      method: "POST"
    });

    if (!response.ok) {
      const payload = await response.json();
      throw new Error(payload.error || "Unable to clear history");
    }

    setHistoryEntries([]);
  } catch (error) {
    statusText.textContent = "Could not clear history";
    resultText.textContent = error.message;
  } finally {
    clearHistoryButton.disabled = false;
  }
}

async function deleteHistoryEntry(id) {
  const confirmed = window.confirm(
    "Delete this history entry? This cannot be undone."
  );

  if (!confirmed) {
    return;
  }

  try {
    const response = await fetch("/api/history/delete", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ id })
    });

    if (!response.ok) {
      const payload = await response.json();
      throw new Error(payload.error || "Unable to delete history entry");
    }

    setHistoryEntries(historyEntries.filter((entry) => entry.id !== id));
  } catch (error) {
    statusText.textContent = "Could not delete history entry";
    resultText.textContent = error.message;
  }
}

async function resetApp() {
  try {
    resetAppButton.disabled = true;
    const response = await fetch("/api/session/reset", {
      method: "POST"
    });

    if (!response.ok) {
      const payload = await response.json();
      throw new Error(payload.error || "Unable to reset the app");
    }

    clearOptionInputs();
    bestOfInput.value = "";
    setSeriesState(null);
    setIdleState();
  } catch (error) {
    statusText.textContent = "Could not reset app";
    resultText.textContent = error.message;
  } finally {
    resetAppButton.disabled = false;
  }
}

function connectEvents() {
  const eventSource = new EventSource("/events");

  eventSource.addEventListener("snapshot", async (event) => {
    const payload = JSON.parse(event.data);
    const hadNoViewerId = selfViewerId === null;
    selfViewerId = payload.selfViewerId ?? selfViewerId;
    setHistoryEntries(payload.history || []);
    setSeriesState(payload.series || null);
    renderPresence(payload.presence || []);

    if (hadNoViewerId && presenceNameInput.value.trim()) {
      schedulePresenceUpdate();
    }

    if (payload.activeFlip) {
      showFlipStarted(payload.activeFlip);
      return;
    }

    setIdleState();
  });

  eventSource.addEventListener("flip-started", (event) => {
    const payload = JSON.parse(event.data);
    showFlipStarted(payload);
  });

  eventSource.addEventListener("flip-revealed", async (event) => {
    const payload = JSON.parse(event.data);
    await showFlipRevealed(payload);
  });

  eventSource.addEventListener("series-updated", (event) => {
    const payload = JSON.parse(event.data);
    setSeriesState(payload);
  });

  eventSource.addEventListener("history-updated", (event) => {
    const payload = JSON.parse(event.data);
    setHistoryEntries(payload.history || []);
  });

  eventSource.addEventListener("presence-updated", (event) => {
    const payload = JSON.parse(event.data);
    renderPresence(payload.presence || []);
  });

  eventSource.addEventListener("session-reset", (event) => {
    const payload = JSON.parse(event.data);
    clearOptionInputs();
    bestOfInput.value = "";
    setHistoryEntries(payload.history || []);
    setSeriesState(null);
    setIdleState();
  });

  eventSource.onerror = () => {
    statusText.textContent = "Live connection lost. Reconnecting...";
  };
}

flipButton.addEventListener("click", triggerFlip);
detailsButton.addEventListener("click", toggleDetails);
resetAppButton.addEventListener("click", resetApp);
clearHistoryButton.addEventListener("click", clearHistory);
bestOfInput.addEventListener("input", syncBestOfUi);
presenceNameInput.addEventListener("input", schedulePresenceUpdate);

connectEvents();
detailsPanel.classList.add("is-hidden");
presenceNameInput.value = savedPresenceName;
fetchInitialState().catch((error) => {
  statusText.textContent = "Unable to load state";
  resultText.textContent = error.message;
  flipButton.disabled = true;
});
