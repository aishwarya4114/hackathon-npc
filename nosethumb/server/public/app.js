// Doctor dashboard: log in, then create session codes.

const $ = (id) => document.getElementById(id);

function show(loggedInEmail) {
  const loggedIn = Boolean(loggedInEmail);
  $("login-view").hidden = loggedIn;
  $("dashboard-view").hidden = !loggedIn;
  $("who").hidden = !loggedIn;
  $("logout").hidden = !loggedIn;
  $("who").textContent = loggedInEmail ?? "";
}

// When the page opens: are we already logged in?
async function checkLogin() {
  const res = await fetch("/api/me");
  show(res.ok ? (await res.json()).email : null);
}

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("login-error").hidden = true;
  const res = await fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: $("email").value, password: $("password").value }),
  });
  const body = await res.json();
  if (!res.ok) {
    $("login-error").textContent = body.error ?? "Couldn't log in. Try again.";
    $("login-error").hidden = false;
    return;
  }
  $("password").value = "";
  show(body.email);
});

$("logout").addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" });
  stopListening();
  endCall();
  $("session").hidden = true;
  $("live").hidden = true;
  show(null);
});

// ---- live updates from the patient's phone ----

let events = null;        // the open live-update connection
let lastDataAt = 0;       // when the last data arrived (ms)
let staleTimer = null;

function setStatus(text, kind = "") {
  $("status").textContent = text;
  $("status").className = `status ${kind}`;
}

function setChip(id, on, label) {
  $(id).classList.toggle("on", on);
  if (label) $(id).textContent = label;
}

function stopListening() {
  events?.close();
  events = null;
  clearInterval(staleTimer);
}

// ---- live call: video + voice from the phone, our voice back (WebRTC) ----

let currentCode = null;
let peer = null;          // the WebRTC connection
let micStream = null;     // the doctor's microphone
let latestDots = {};      // latest dot positions from the phone (0...1 of the video frame)

function setCallUI(inCall, status) {
  $("start-call").hidden = inCall;
  $("hang-up").hidden = !inCall;
  $("video-box").hidden = !inCall;
  $("call-status").textContent = status ?? "";
}

$("start-call").addEventListener("click", async () => {
  setCallUI(true, "Calling the patient's phone…");
  try {
    // Ask for the microphone first, so the browser's permission prompt shows now.
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    setCallUI(false, "Microphone blocked. Allow it in the browser and try again.");
    return;
  }
  const res = await fetch(`/api/sessions/${currentCode}/call`, { method: "POST" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    endCall(body.error ?? "Couldn't reach the patient's phone.");
  }
  // Next: the phone sends an offer, handled by answerCall().
});

$("hang-up").addEventListener("click", async () => {
  await fetch(`/api/sessions/${currentCode}/hangup`, { method: "POST" });
  endCall("Call ended");
});

async function answerCall(offer) {
  peer?.close();
  // Same Wi-Fi for now, so no STUN/TURN servers are needed yet.
  peer = new RTCPeerConnection({ iceServers: [] });
  micStream?.getTracks().forEach((track) => peer.addTrack(track, micStream));

  peer.ontrack = (event) => {
    $("video").srcObject = event.streams[0];
  };
  peer.onconnectionstatechange = () => {
    const state = peer?.connectionState;
    if (state === "connected") setCallUI(true, "In call");
    if (state === "failed") endCall("Call failed. Check that both are on the same Wi-Fi.");
    if (state === "disconnected") setCallUI(true, "Connection lost, reconnecting…");
  };

  await peer.setRemoteDescription(offer);
  await peer.setLocalDescription(await peer.createAnswer());
  // Wait until our network addresses are collected, then send the whole answer at once.
  await waitForIceGathering(peer);
  await fetch(`/api/sessions/${currentCode}/signal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "answer", sdp: peer.localDescription.sdp }),
  });
  setCallUI(true, "Connecting…");
}

function waitForIceGathering(pc) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      if (pc.iceGatheringState === "complete") {
        pc.removeEventListener("icegatheringstatechange", done);
        resolve();
      }
    };
    pc.addEventListener("icegatheringstatechange", done);
    setTimeout(resolve, 3000); // don't wait forever
  });
}

function endCall(status) {
  peer?.close();
  peer = null;
  micStream?.getTracks().forEach((track) => track.stop());
  micStream = null;
  $("video").srcObject = null;
  setCallUI(false, status);
}

// Draw the dots on top of the video. The video is scaled to fit its box ("contain"),
// so we apply the same scale and offset to the 0...1 dot positions.
function drawDots() {
  const video = $("video");
  const canvas = $("overlay");
  const box = canvas.getBoundingClientRect();
  canvas.width = box.width * devicePixelRatio;
  canvas.height = box.height * devicePixelRatio;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  ctx.clearRect(0, 0, box.width, box.height);
  if (!video.videoWidth || $("video-box").hidden) return;

  const scale = Math.min(box.width / video.videoWidth, box.height / video.videoHeight);
  const shownWidth = video.videoWidth * scale;
  const shownHeight = video.videoHeight * scale;
  const offsetX = (box.width - shownWidth) / 2;
  const offsetY = (box.height - shownHeight) / 2;
  const toScreen = (p) => [offsetX + p.x * shownWidth, offsetY + p.y * shownHeight];

  const { bridge, thumb } = latestDots;
  if (bridge && thumb) {
    // Line between the two points: the distance being measured.
    ctx.strokeStyle = "#378ADD";
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 5]);
    ctx.beginPath();
    ctx.moveTo(...toScreen(bridge));
    ctx.lineTo(...toScreen(thumb));
    ctx.stroke();
    ctx.setLineDash([]);
  }
  for (const [point, color] of [[bridge, "#3fbf5f"], [thumb, "#e8457a"]]) {
    if (!point) continue;
    const [x, y] = toScreen(point);
    ctx.beginPath();
    ctx.arc(x, y, 8, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#000";
    ctx.stroke();
  }
}
window.addEventListener("resize", drawDots);

function listen(code) {
  stopListening();
  currentCode = code;
  events = new EventSource(`/api/sessions/${code}/events`);

  events.addEventListener("patient-joined", () => {
    setStatus("Patient connected", "good");
    $("live").hidden = false;
  });

  events.addEventListener("patient-left", () => {
    setStatus("Patient left the session", "warn");
    endCall();
  });

  // The phone's answer to "Start call": its offer. We reply with our answer.
  events.addEventListener("offer", (event) => answerCall(JSON.parse(event.data)));

  events.addEventListener("data", (event) => {
    const data = JSON.parse(event.data);
    lastDataAt = Date.now();
    setStatus("Patient connected", "good");
    $("live").hidden = false;
    $("distance").textContent = data.distanceCM == null ? "–" : `${data.distanceCM.toFixed(1)} cm`;
    $("bridge-depth").textContent = data.bridgeDepthCM == null
      ? "Phone to bridge: –"
      : `Phone to bridge: ${data.bridgeDepthCM.toFixed(1)} cm`;
    setChip("chip-face", data.faceVisible);
    setChip("chip-profile", data.isProfile);
    setChip("chip-thumb", data.thumbVisible);
    setChip("chip-camera", true, data.camera === "back" ? "Back camera" : "Front camera");
    $("instruction").textContent = data.instruction || "–";
    latestDots = { bridge: data.bridge, thumb: data.thumb };
    drawDots();
  });

  // If the phone stops sending, say so instead of showing an old number as if it were live.
  staleTimer = setInterval(() => {
    if (lastDataAt && Date.now() - lastDataAt > 3000) {
      setStatus("No data from patient", "warn");
      $("distance").textContent = "–";
    }
  }, 1000);
}

$("new-session").addEventListener("click", async () => {
  const res = await fetch("/api/sessions", { method: "POST" });
  if (res.status === 401) return show(null);
  const { code, expiresInMinutes } = await res.json();
  // Show as "123 456" so it's easy to read out loud.
  $("code").textContent = `${code.slice(0, 3)} ${code.slice(3)}`;
  $("expires").textContent = `Expires in ${expiresInMinutes} minutes if unused`;
  $("session").hidden = false;
  $("live").hidden = true;
  lastDataAt = 0;
  endCall();
  setStatus("Waiting for patient…");
  listen(code);
});

checkLogin();
