//
//  SessionClient.swift
//  NoseThumb
//

import Foundation
import AVFoundation
import Observation

// Talks to our server: joins a session with the doctor's code, sends live numbers,
// and handles the doctor's call (video + voice) through WebRTCClient.
@Observable
final class SessionClient {
    enum State: Equatable {
        case notJoined
        case joining
        case joined
        case failed(String)   // message to show the patient
    }

    private(set) var state: State = .notJoined
    private(set) var inCall = false     // a call with the doctor is connected

    // Set by ContentView: the camera's WebRTC client, which sends our video and voice.
    @ObservationIgnored var webRTC: WebRTCClient?
    @ObservationIgnored private var eventsTask: Task<Void, Never>?

    private var serverURL: URL?
    private var token: String?      // secret from the server, sent with every message
    private var isSending = false

    // Joins with the 6-digit code. On success, state becomes .joined.
    func join(server: String, code: String) async {
        state = .joining
        guard let url = URL(string: server.trimmingCharacters(in: .whitespaces)),
              url.scheme == "http" || url.scheme == "https" else {
            state = .failed("Check the server address. It should start with http://")
            return
        }
        do {
            let (data, response) = try await post(url.appending(path: "api/patient/join"), body: ["code": code])
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            if (response as? HTTPURLResponse)?.statusCode == 200, let token = json?["token"] as? String {
                self.serverURL = url
                self.token = token
                state = .joined
                listenForCallMessages()
            } else {
                state = .failed(json?["error"] as? String ?? "Couldn't join. Try again.")
            }
        } catch {
            state = .failed("Can't reach the server. Check that it's running and you're on the same Wi-Fi.")
        }
    }

    // Sends the latest numbers. If the previous send hasn't finished, this one is skipped,
    // so requests never pile up. A lost update is fine: the next one follows shortly.
    func send(_ payload: [String: Any]) async {
        guard state == .joined, !isSending, let serverURL, let token else { return }
        isSending = true
        defer { isSending = false }
        do {
            let (_, response) = try await post(serverURL.appending(path: "api/patient/data"),
                                               body: ["token": token, "data": payload])
            if (response as? HTTPURLResponse)?.statusCode == 401 {
                self.token = nil
                eventsTask?.cancel()
                webRTC?.close()
                inCall = false
                state = .failed("Session ended. Ask your doctor for a new code.")
            }
        } catch {
            // Network hiccup: skip this update.
        }
    }

    // Keeps a connection to the server open to receive call messages from the doctor:
    // "call-request" (doctor clicked Start call), "answer" (their reply), "hangup".
    private func listenForCallMessages() {
        eventsTask?.cancel()
        guard let serverURL, let token else { return }
        var components = URLComponents(url: serverURL.appending(path: "api/patient/events"), resolvingAgainstBaseURL: false)
        components?.queryItems = [URLQueryItem(name: "token", value: token)]
        guard let url = components?.url else { return }

        eventsTask = Task {
            do {
                var request = URLRequest(url: url)
                request.timeoutInterval = 60 * 60   // a long-lived connection
                let (bytes, _) = try await URLSession.shared.bytes(for: request)
                // Server-Sent Events: "event: name" then "data: {...}" then an empty line.
                var eventName = ""
                for try await line in bytes.lines {
                    if line.hasPrefix("event: ") {
                        eventName = String(line.dropFirst(7))
                    } else if line.hasPrefix("data: ") {
                        await handleCallMessage(eventName, data: Data(line.dropFirst(6).utf8))
                    }
                }
            } catch {
                // Connection closed (left the session, or network lost).
            }
        }
    }

    private func handleCallMessage(_ event: String, data: Data) async {
        guard let webRTC else { return }
        switch event {
        case "call-request":
            // The first time, iOS asks the patient to allow the microphone.
            guard await AVAudioApplication.requestRecordPermission() else {
                print("Microphone permission denied")
                return
            }
            webRTC.onStateChange = { [weak self] state in
                Task { @MainActor [weak self] in self?.inCall = state == "connected" }
            }
            do {
                let offer = try await webRTC.makeOffer()
                if let serverURL, let token {
                    _ = try await post(serverURL.appending(path: "api/patient/signal"),
                                       body: ["token": token, "type": "offer", "sdp": offer])
                }
            } catch {
                print("Could not start the call: \(error)")
                webRTC.close()
            }
        case "answer":
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            if let sdp = json?["sdp"] as? String {
                do {
                    try await webRTC.setAnswer(sdp)
                } catch {
                    print("Could not use the doctor's answer: \(error)")
                }
            }
        case "hangup":
            webRTC.close()
            inCall = false
        default:
            break
        }
    }

    // Tells the server the patient left, then resets.
    func leave() async {
        eventsTask?.cancel()
        eventsTask = nil
        webRTC?.close()
        inCall = false
        if let serverURL, let token {
            _ = try? await post(serverURL.appending(path: "api/patient/leave"), body: ["token": token])
        }
        token = nil
        serverURL = nil
        state = .notJoined
    }

    private func post(_ url: URL, body: [String: Any]) async throws -> (Data, URLResponse) {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        request.timeoutInterval = 5
        return try await URLSession.shared.data(for: request)
    }
}
