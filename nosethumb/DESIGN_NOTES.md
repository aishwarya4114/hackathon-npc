# Project: live telemedicine movement measurement (iOS)

## What we're building
A native iPhone app that tracks a patient live with the camera and MediaPipe. It draws body points and big measurement numbers on screen. First test: nose-to-thumb distance (Near Point Convergence, threshold ≤5cm = normal). Later: a simplified balance check (hands-off-hips, hip angle) based on the Modified BESS test.

## Tech
- Native iOS app, Swift + SwiftUI, runs on a real iPhone
- MediaPipe Tasks Vision via CocoaPods (pod 'MediaPipeTasksVision')
- Pose Landmarker + Hand Landmarker in live stream mode
- Camera through AVFoundation
- IMPORTANT: this project uses CocoaPods. Always open/build via NoseThumb.xcworkspace, never NoseThumb.xcodeproj. Do not edit the Podfile.lock or Pods folder directly.

## How to work with me (IMPORTANT)
- I'm new to MediaPipe and Swift and want to learn. Go one small step at a time.
- Before writing code, explain in plain words what the step does and why.
- After writing code, explain each important line, then tell me exactly what I should see or do in Xcode/on the iPhone to confirm it works.
- Do not build ahead. Stop after each step and wait for me.
- Never claim something works unless we ran it. If unsure of an API detail, check the official MediaPipe docs instead of guessing.
- If a new file (like a .task model file) needs to be added to the Xcode project, tell me exactly how to add it in Xcode (drag and drop, "copy items if needed", target membership) instead of editing project files by hand.
- Distances are normalized by shoulder width. Show "not visible" instead of a wrong number when a landmark's visibility is low.
- Numbers on screen must be very large, since they'll be read over Zoom screen share.

## NPC test
- Patient brings thumb toward nose until double vision, then taps or says "now". Output: break-point distance (cm) per trial.

## Decisions (2026-10-03)
- NPC method: SIDE VIEW. One iPhone propped beside the patient at nose height, front TrueDepth camera facing the patient's profile, ~40–60 cm away.
- Why not front-facing depth: tried it. Depth is aligned with the video (depth map 480x640, rotated 90° + mirrored like the video) and gives plausible readings, but when the thumb is on the midline in front of the nose it blocks the nose from the camera, so "nose depth" becomes thumb depth and the gap reads ~0. That's exactly the critical part of the test.
- Reference point (per teammate): measure from the bridge of the nose (between the eyes/eyebrows), not the nose tip. Midpoint of pose inner eye corners (landmarks 1 and 4) lands ~1–2 cm inside the face in profile, so we scan the depth map along that row toward the nose-tip side until depth jumps to background; that edge is the bridge front, and its depth sets the scale. Nose tip only gives the "forward" direction. Thumb-tip depth not used (fingertip often reads the wall).
- Camera: front TrueDepth (default) or back LiDAR (`.builtInLiDARDepthCamera`, Pro iPhones only; test phone is a Pro), switchable on screen. Back camera is not mirrored; its video format is picked from `device.formats` (smallest ≥640 wide with depth).
- Side-view scaling: shoulder width isn't usable from the side. Plan: use TrueDepth distance to the face + camera intrinsics to convert pixels to cm.
- Findings on the test iPhone (A15): TrueDepth reports "absolute" depth; no valid depth closer than ~16 cm from the phone; occasional frames with no depth; ~24 FPS with pose + hand + depth at 640x480.

## Product plan (decided 2026-10-03)
- Patient uses our iPhone app (depth stays on the phone → accurate cm). Patient screen shows ONLY instructions: no numbers, no dots.
- Doctor uses our own web dashboard (login): live video with dots, bridge–thumb distance, trial list, "Mark now" / "Next trial" buttons.
- Our own streaming, no Zoom/third-party video service: WebRTC (open source) for two-way audio + patient video + data; our own signaling server, our own TURN relay (e.g. coturn), rented hosting.
- Patient says "now" out loud; doctor clicks "Mark now". Doctor's voice plays on the iPhone loudspeaker.
- Build order: (1) patient mode in the app, (2) own server + simple doctor page with live numbers, (3) login + session codes, (4) live video/audio over WebRTC with dots drawn on the doctor side, (5) TURN relay + hosting.
- Before real patients: HIPAA-ready hosting (BAA), advisor/IRB approval. Team-only testing until then.
- Server lives in `server/` (Node.js, built-in modules only, no npm dependencies so far): `npm start` serves the doctor dashboard on http://localhost:3000; `npm run add-doctor -- email "password"` creates accounts in `server/doctors.json` (scrypt-hashed, gitignored). Logins and session codes (6 digits, 15 min) are in memory.
- Phone → server: app joins with the code (`/api/patient/join` → token), then POSTs numbers ~10×/s to `/api/patient/data`; doctor page receives them via Server-Sent Events (`/api/sessions/<code>/events`). The app uses `http://<Mac LocalHostName>.local:3000` because iOS 17+ ATS blocks plain-http raw IP addresses but allows `.local` names; only the Local Network usage description is needed.
- Live call (WebRTC): iOS uses the `stasel/WebRTC` Swift package (community build of Google's WebRTC, pinned 154.0.0, added via Xcode). Doctor clicks Start call → server pushes `call-request` to the phone (phone listens on `/api/patient/events`) → phone sends offer (`/api/patient/signal`) → doctor page answers (`/api/sessions/<code>/signal`). Non-trickle ICE (full SDP after gathering), no STUN/TURN yet (same Wi-Fi only). Phone sends its own camera frames (same ones MediaPipe sees) via `WebRTCClient.push`; doctor page draws bridge/thumb dots from the data stream over the video.

## Docs
-
