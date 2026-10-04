# Remote Near Point Convergence (NPC) on iPhone

Built at HackHeal 2026 (winning project). A clinician runs a **Near Point Convergence** test over a live video call: the patient's iPhone measures the distance from the **bridge of the nose to the thumb tip** in centimetres, using MediaPipe and the phone's depth camera, and the doctor sees the live video, the tracked points and the measurement on a web dashboard. The same call also runs a **Modified BESS** balance test.

## What's in this repo

| Folder | What it is |
|---|---|
| [`television/TeleVision`](television/TeleVision) | **Final integrated patient app** (Swift/SwiftUI). Back LiDAR camera, live call to the doctor (WebRTC), NPC measurement on the phone, BESS streaming. |
| [`television/posecam`](television/posecam) | **Doctor dashboard and analysis servers** (Python). `doctor_call_server.py`: call signaling + dashboard with Balance / Near Point tabs; `server.py`: pose / BESS analysis. |
| [`nosethumb/ios`](nosethumb/ios) | **NoseThumb**, the standalone prototype where the NPC method was developed: front TrueDepth + back LiDAR, patient / clinician views, join-with-code + live call. |
| [`nosethumb/server`](nosethumb/server) | NoseThumb's own Node.js server: doctor login, 6-digit session codes, live numbers, WebRTC call setup. |
| [`nosethumb/DESIGN_NOTES.md`](nosethumb/DESIGN_NOTES.md) | Design decisions and test findings (why side view, why the bridge-plane method, depth limits). |

## How the NPC measurement works

1. The patient sits **side-on** to the phone; the thumb moves along the midline toward the nose.
2. **MediaPipe Pose** (full) finds the eyes and nose; **MediaPipe Hand** finds the thumb tip (landmark 4).
3. **Bridge of the nose:** midpoint of the inner eye corners, then a scan along that row of the depth map toward the nose tip until depth jumps to background; that edge is the front of the bridge.
4. **Distance (bridge-plane method):** `pixel distance (bridge -> thumb) x bridge depth / focal length`. The thumb's own depth is not used: a thin, moving fingertip often reads the wall behind it.
5. **Safeguards:** no number unless the face is visible (visibility >= 0.5), the view is side-on, the thumb is found and the bridge has depth; a short hold covers dropped depth frames.

Lessons learned while integrating (details in commit history / design notes):
- MediaPipe on iOS returns positions in the camera's **raw (unrotated)** frame; they're converted to the upright picture before any geometry.
- The camera hands out frames from a small buffer pool; depth maps are **copied** instead of held, or the camera and call freeze.

## Running it

**Doctor side (Mac):**

```bash
cd television/posecam
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python doctor_call_server.py    # terminal 1: call + dashboard, http://localhost:8088/doctor
python server.py                # terminal 2: balance (BESS) analysis
```

**Patient side (iPhone Pro with LiDAR):** open `television/TeleVision/TeleVision.xcodeproj` in Xcode (Swift packages: MediaPipe, WebRTC resolve automatically), set your signing team, run on the phone. In the app, enter the Mac's IP and the room, start the call. On the dashboard: Join Call, then a Balance stance or the **Near Point (NPC)** tab -> Start NPC.

**NoseThumb prototype:** `cd nosethumb/ios && pod install`, open `NoseThumb.xcworkspace`. Server: `cd nosethumb/server && npm run add-doctor -- you@example.com "password" && npm start`.

## Status

Hackathon prototype. Distances have not been clinically validated; not for diagnosis. Testing was on team members only.

## Credits

TeleVision and posecam were built with the HackHeal 2026 team (see the original repo `stefan-arni/hackheal2026`). NPC measurement, NoseThumb and the NPC dashboard panel by Aishwarya Patil.
