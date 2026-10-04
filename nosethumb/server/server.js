// NoseThumb server: serves the doctor dashboard, handles doctor login,
// and creates session codes for patients.
// Run with: npm start   (then open http://localhost:3000)

import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { randomBytes, randomInt } from "node:crypto";
import { extname, join } from "node:path";
import { checkPassword } from "./passwords.js";

const PORT = Number(process.env.PORT ?? 3000);
const DOCTORS_FILE = process.env.DOCTORS_FILE ?? new URL("./doctors.json", import.meta.url);
const PUBLIC_DIR = new URL("./public/", import.meta.url).pathname;
const SESSION_CODE_MINUTES = 15;   // an unused code expires after this
const SESSION_IDLE_MINUTES = 30;   // a joined session expires after this long without data

// In memory for now: restarting the server clears them.
const logins = new Map();        // login token -> doctor email
const sessions = new Map();      // 6-digit code -> session (see newSession)
const patientTokens = new Map(); // patient token -> 6-digit code

function newSession(doctor) {
  return {
    doctor,
    createdAt: Date.now(),
    patientToken: null,   // set when the patient joins
    lastSeen: null,       // last time the patient sent anything
    lastData: null,       // latest numbers from the phone
    doctorStreams: new Set(),  // open live-update connections from the doctor's page
    patientStreams: new Set(), // open live-update connection from the patient's phone
  };
}

function loadDoctors() {
  return existsSync(DOCTORS_FILE) ? JSON.parse(readFileSync(DOCTORS_FILE, "utf8")) : {};
}

// ---- small helpers ----

function sendJSON(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

async function readJSON(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 200_000) throw new Error("Body too large"); // call setup messages can be ~10 KB
  }
  return raw ? JSON.parse(raw) : {};
}

// The login token lives in a cookie the browser sends back automatically.
// HttpOnly: page scripts can't read it. SameSite=Strict: other sites can't send it.
function loginCookie(token, maxAgeSeconds) {
  return `nt_login=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}`;
}

function loggedInDoctor(req) {
  const match = /(?:^|;\s*)nt_login=([a-f0-9]+)/.exec(req.headers.cookie ?? "");
  return match ? logins.get(match[1]) : undefined;
}

// A 6-digit code that isn't already in use.
function newSessionCode() {
  let code;
  do {
    code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  } while (sessions.has(code));
  return code;
}

function removeExpiredSessions() {
  const now = Date.now();
  for (const [code, session] of sessions) {
    const unusedAndOld = !session.patientToken && now - session.createdAt > SESSION_CODE_MINUTES * 60_000;
    const joinedAndIdle = session.patientToken && now - session.lastSeen > SESSION_IDLE_MINUTES * 60_000;
    if (unusedAndOld || joinedAndIdle) {
      if (session.patientToken) patientTokens.delete(session.patientToken);
      session.doctorStreams.forEach((stream) => stream.end());
      session.patientStreams.forEach((stream) => stream.end());
      sessions.delete(code);
    }
  }
}

// Push an event to every open doctor page for this session (Server-Sent Events format).
function pushToPatient(session, event, data) {
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  session.patientStreams.forEach((stream) => stream.write(message));
}

// Opens a Server-Sent Events stream on `res`, registers it in `streams`, and cleans up on close.
function openStream(req, res, streams) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  streams.add(res);
  // A comment line every 15 s keeps the connection from being closed as idle.
  const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
  req.on("close", () => {
    clearInterval(keepAlive);
    streams.delete(res);
  });
}

// A WebRTC session description (offer or answer) from a client: a type and SDP text.
function cleanDescription(body) {
  const type = body.type === "offer" || body.type === "answer" ? body.type : null;
  const sdp = typeof body.sdp === "string" && body.sdp.length < 100_000 ? body.sdp : null;
  return type && sdp ? { type, sdp } : null;
}

function pushToDoctor(session, event, data) {
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  session.doctorStreams.forEach((stream) => stream.write(message));
}

// Keep only the fields we expect from the phone, with the right types.
// Anything else is dropped, so the doctor's page never receives unexpected data.
function cleanPatientData(data) {
  const number = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
  const fraction = (value) => (typeof value === "number" && value >= 0 && value <= 1 ? value : null);
  const point = (value) => {
    const x = fraction(value?.x);
    const y = fraction(value?.y);
    return x !== null && y !== null ? { x, y } : null;
  };
  const bool = (value) => value === true;
  return {
    distanceCM: number(data.distanceCM),
    bridgeDepthCM: number(data.bridgeDepthCM),
    faceVisible: bool(data.faceVisible),
    isProfile: bool(data.isProfile),
    thumbVisible: bool(data.thumbVisible),
    camera: data.camera === "back" ? "back" : "front",
    instruction: typeof data.instruction === "string" ? data.instruction.slice(0, 200) : "",
    // Dot positions for the doctor's video overlay, as 0...1 fractions of the video frame.
    bridge: point(data.bridge),
    thumb: point(data.thumb),
  };
}

// The patient's session, from the token the phone sends with every message.
function sessionForPatient(token) {
  const code = typeof token === "string" ? patientTokens.get(token) : undefined;
  return code ? sessions.get(code) : undefined;
}

const CONTENT_TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

function serveStatic(req, res) {
  const path = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  // Only plain file names inside public/, so a URL can't reach other files.
  if (!/^\/[a-zA-Z0-9_.-]+$/.test(path) || path.includes("..")) {
    return sendJSON(res, 404, { error: "Not found" });
  }
  const file = join(PUBLIC_DIR, path);
  if (!existsSync(file)) return sendJSON(res, 404, { error: "Not found" });
  res.writeHead(200, { "Content-Type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
}

// ---- routes ----

const server = createServer(async (req, res) => {
  try {
    // Doctor logs in with email + password.
    if (req.method === "POST" && req.url === "/api/login") {
      const { email = "", password = "" } = await readJSON(req);
      const doctor = loadDoctors()[String(email).toLowerCase()];
      if (!doctor || !checkPassword(String(password), doctor.passwordHash)) {
        return sendJSON(res, 401, { error: "Email or password is incorrect." });
      }
      const token = randomBytes(32).toString("hex");
      logins.set(token, String(email).toLowerCase());
      return sendJSON(res, 200, { email: String(email).toLowerCase() },
                      { "Set-Cookie": loginCookie(token, 8 * 60 * 60) });
    }

    if (req.method === "POST" && req.url === "/api/logout") {
      const match = /(?:^|;\s*)nt_login=([a-f0-9]+)/.exec(req.headers.cookie ?? "");
      if (match) logins.delete(match[1]);
      return sendJSON(res, 200, {}, { "Set-Cookie": loginCookie("", 0) });
    }

    // Who is logged in (the page calls this when it opens).
    if (req.method === "GET" && req.url === "/api/me") {
      const doctor = loggedInDoctor(req);
      return doctor ? sendJSON(res, 200, { email: doctor }) : sendJSON(res, 401, { error: "Not logged in" });
    }

    // Doctor starts a new session and gets a code to give the patient.
    if (req.method === "POST" && req.url === "/api/sessions") {
      const doctor = loggedInDoctor(req);
      if (!doctor) return sendJSON(res, 401, { error: "Not logged in" });
      removeExpiredSessions();
      const code = newSessionCode();
      sessions.set(code, newSession(doctor));
      return sendJSON(res, 200, { code, expiresInMinutes: SESSION_CODE_MINUTES });
    }

    // Doctor's page opens this and keeps it open; the server pushes live updates down it.
    const eventsMatch = /^\/api\/sessions\/(\d{6})\/events$/.exec(req.url);
    if (req.method === "GET" && eventsMatch) {
      const doctor = loggedInDoctor(req);
      const session = sessions.get(eventsMatch[1]);
      // Only the doctor who created this code may watch it.
      if (!doctor || !session || session.doctor !== doctor) {
        return sendJSON(res, 404, { error: "Session not found" });
      }
      openStream(req, res, session.doctorStreams);
      // Send the current state right away (useful if the doctor's page reconnects).
      if (session.patientToken) res.write(`event: patient-joined\ndata: {}\n\n`);
      if (session.lastData) res.write(`event: data\ndata: ${JSON.stringify(session.lastData)}\n\n`);
      return;
    }

    // ---- call setup (WebRTC signaling) ----
    // 1. Doctor clicks "Start call"      -> server tells the phone "call-request"
    // 2. Phone creates an offer          -> server forwards it to the doctor's page
    // 3. Doctor's page creates an answer -> server forwards it to the phone
    // After that, audio and video flow directly between phone and browser.

    const doctorCallMatch = /^\/api\/sessions\/(\d{6})\/(call|signal|hangup)$/.exec(req.url);
    if (req.method === "POST" && doctorCallMatch) {
      const doctor = loggedInDoctor(req);
      const session = sessions.get(doctorCallMatch[1]);
      if (!doctor || !session || session.doctor !== doctor) {
        return sendJSON(res, 404, { error: "Session not found" });
      }
      const action = doctorCallMatch[2];
      if (action === "call") {
        if (session.patientStreams.size === 0) return sendJSON(res, 409, { error: "The patient's app isn't connected." });
        pushToPatient(session, "call-request", {});
      } else if (action === "signal") {
        const description = cleanDescription(await readJSON(req));
        if (!description || description.type !== "answer") return sendJSON(res, 400, { error: "Expected an answer" });
        pushToPatient(session, "answer", description);
      } else {
        pushToPatient(session, "hangup", {});
      }
      return sendJSON(res, 200, {});
    }

    // Patient's phone opens this and keeps it open to receive call messages.
    if (req.method === "GET" && req.url.startsWith("/api/patient/events?")) {
      const token = new URL(req.url, "http://localhost").searchParams.get("token");
      const session = sessionForPatient(token);
      if (!session) return sendJSON(res, 401, { error: "Session ended. Join again with a new code." });
      openStream(req, res, session.patientStreams);
      return;
    }

    // Phone sends its offer (or hangs up).
    if (req.method === "POST" && req.url === "/api/patient/signal") {
      const body = await readJSON(req);
      const session = sessionForPatient(body.token);
      if (!session) return sendJSON(res, 401, { error: "Session ended. Join again with a new code." });
      const description = cleanDescription(body);
      if (!description || description.type !== "offer") return sendJSON(res, 400, { error: "Expected an offer" });
      pushToDoctor(session, "offer", description);
      return sendJSON(res, 200, {});
    }

    // Patient's phone joins with the code and gets a secret token for this session.
    if (req.method === "POST" && req.url === "/api/patient/join") {
      removeExpiredSessions();
      const { code = "" } = await readJSON(req);
      const session = sessions.get(String(code).replace(/\s/g, ""));
      if (!session) return sendJSON(res, 404, { error: "That code isn't valid or has expired." });
      // Joining again (e.g. the app restarted) replaces the old token.
      if (session.patientToken) patientTokens.delete(session.patientToken);
      const token = randomBytes(32).toString("hex");
      session.patientToken = token;
      session.lastSeen = Date.now();
      patientTokens.set(token, String(code).replace(/\s/g, ""));
      pushToDoctor(session, "patient-joined", {});
      return sendJSON(res, 200, { token });
    }

    // Patient's phone sends its latest numbers (about 10 times per second).
    if (req.method === "POST" && req.url === "/api/patient/data") {
      const { token, data = {} } = await readJSON(req);
      const session = sessionForPatient(token);
      if (!session) return sendJSON(res, 401, { error: "Session ended. Join again with a new code." });
      session.lastSeen = Date.now();
      session.lastData = { ...cleanPatientData(data), receivedAt: session.lastSeen };
      pushToDoctor(session, "data", session.lastData);
      return sendJSON(res, 200, {});
    }

    // Patient leaves the session.
    if (req.method === "POST" && req.url === "/api/patient/leave") {
      const { token } = await readJSON(req);
      const session = sessionForPatient(token);
      if (session) {
        patientTokens.delete(token);
        session.patientToken = null;
        pushToDoctor(session, "patient-left", {});
      }
      return sendJSON(res, 200, {});
    }

    if (req.method === "GET") return serveStatic(req, res);

    sendJSON(res, 404, { error: "Not found" });
  } catch (error) {
    console.error(error);
    sendJSON(res, 400, { error: "Bad request" });
  }
});

server.listen(PORT, () => {
  console.log(`NoseThumb server running at http://localhost:${PORT}`);
  if (Object.keys(loadDoctors()).length === 0) {
    console.log('No doctor accounts yet. Create one with: npm run add-doctor -- you@example.com "your password"');
  }
});
