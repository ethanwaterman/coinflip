const statusTitle = document.getElementById("status-title");
const statusDetail = document.getElementById("status-detail");
const flipButton = document.getElementById("flip-button");
const coin = document.getElementById("coin");
const resultText = document.getElementById("result-text");
const verificationText = document.getElementById("verification-text");
const commitmentText = document.getElementById("commitment-text");
const secretText = document.getElementById("secret-text");
const shareLinks = document.getElementById("share-links");

let activeFlipId = null;

async function digestSha256(value) {
  const bytes = new TextEncoder().encode(value);
  const hashBuffer = await crypto.subtle.digest("SHA-256", bytes);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function setIdleState() {
  statusTitle.textContent = "Waiting for the next flip";
  statusDetail.textContent =
    "Open this page on every computer that should witness the flip.";
  flipButton.disabled = false;
}

function showCountdown(revealAt) {
  const updateCountdown = () => {
    const remainingMs = Math.max(0, revealAt - Date.now());
    const remainingSeconds = (remainingMs / 1000).toFixed(1);

    statusTitle.textContent = "Flip in progress";
    statusDetail.textContent = `Outcome already committed. Reveal in ${remainingSeconds}s.`;
  };

  updateCountdown();
  const intervalId = window.setInterval(() => {
    updateCountdown();

    if (Date.now() >= revealAt) {
      window.clearInterval(intervalId);
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
  resultText.textContent = "Flipping...";
  verificationText.textContent = "Commitment received by every viewer";
  commitmentText.textContent = payload.commitment;
  secretText.textContent = "Hidden until the reveal";
  startFlipAnimation();
  showCountdown(payload.revealAt);
}

async function showFlipRevealed(payload) {
  if (activeFlipId !== payload.id) {
    activeFlipId = null;
  }

  coin.classList.remove("spinning");
  coin.classList.add(payload.result === "heads" ? "show-heads" : "show-tails");
  resultText.textContent = payload.result.toUpperCase();
  commitmentText.textContent = payload.commitment;
  secretText.textContent = payload.secret;

  const calculated = await digestSha256(
    `${payload.id}:${payload.result}:${payload.secret}`
  );
  const verified = calculated === payload.commitment;

  verificationText.textContent = verified
    ? "Verified: reveal matches original commitment"
    : "Verification failed: reveal did not match commitment";

  statusTitle.textContent = verified ? "Reveal verified" : "Verification failed";
  statusDetail.textContent = verified
    ? "Every browser can recompute the hash and confirm the result was fixed before reveal."
    : "Do not trust this flip. The revealed value did not match the committed hash.";

  activeFlipId = null;
  flipButton.disabled = false;
}

async function fetchInitialState() {
  const response = await fetch("/api/state", { cache: "no-store" });
  const payload = await response.json();

  if (payload.activeFlip) {
    showFlipStarted(payload.activeFlip);
    return;
  }

  if (payload.lastCompletedFlip) {
    await showFlipRevealed(payload.lastCompletedFlip);
    return;
  }

  setIdleState();
}

function renderShareLinks(urls) {
  shareLinks.replaceChildren();

  for (const url of urls) {
    const paragraph = document.createElement("p");
    const link = document.createElement("a");
    link.href = url;
    link.textContent = url;
    link.target = "_blank";
    link.rel = "noreferrer";
    paragraph.append(link);
    shareLinks.append(paragraph);
  }
}

async function fetchShareLinks() {
  const response = await fetch("/api/hosts", { cache: "no-store" });
  const payload = await response.json();
  renderShareLinks(payload.urls);
}

async function triggerFlip() {
  try {
    flipButton.disabled = true;
    const response = await fetch("/api/flip", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      }
    });

    if (!response.ok) {
      const payload = await response.json();
      throw new Error(payload.error || "Unable to start flip");
    }
  } catch (error) {
    setIdleState();
    statusTitle.textContent = "Flip could not start";
    statusDetail.textContent = error.message;
  }
}

function connectEvents() {
  const eventSource = new EventSource("/events");

  eventSource.addEventListener("snapshot", async (event) => {
    const payload = JSON.parse(event.data);

    if (payload.activeFlip) {
      showFlipStarted(payload.activeFlip);
      return;
    }

    if (payload.lastCompletedFlip) {
      await showFlipRevealed(payload.lastCompletedFlip);
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

  eventSource.onerror = () => {
    statusDetail.textContent =
      "Live connection lost. The page will keep trying to reconnect.";
  };
}

flipButton.addEventListener("click", triggerFlip);

connectEvents();
fetchInitialState().catch((error) => {
  statusTitle.textContent = "Unable to load state";
  statusDetail.textContent = error.message;
  flipButton.disabled = true;
});
fetchShareLinks().catch(() => {
  shareLinks.innerHTML = "<p>Unable to detect local share URLs.</p>";
});
