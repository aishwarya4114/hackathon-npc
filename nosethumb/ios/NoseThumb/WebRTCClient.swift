//
//  WebRTCClient.swift
//  NoseThumb
//

import Foundation
import AVFoundation
import WebRTC

// The live call with the doctor's browser: sends our microphone and our camera frames
// (the same frames MediaPipe sees), and plays the doctor's voice on the loudspeaker.
// Call setup messages (offer/answer) travel through our server; see SessionClient.
nonisolated final class WebRTCClient: NSObject, RTCPeerConnectionDelegate, @unchecked Sendable {
    // One factory for the whole app, as WebRTC recommends.
    private static let factory: RTCPeerConnectionFactory = {
        RTCInitializeSSL()
        return RTCPeerConnectionFactory(encoderFactory: RTCDefaultVideoEncoderFactory(),
                                        decoderFactory: RTCDefaultVideoDecoderFactory())
    }()

    // Touched from the main thread (setup) and the camera thread (frames), so guarded by a lock.
    private let lock = NSLock()
    private var peerConnection: RTCPeerConnection?
    private var videoSource: RTCVideoSource?
    private var capturer: RTCVideoCapturer?

    // Called (on any thread) when the connection state changes, e.g. "connected".
    var onStateChange: (@Sendable (String) -> Void)?

    // Starts a call: creates the connection with our mic + camera, and returns the offer
    // (including our network addresses) to send to the doctor.
    func makeOffer() async throws -> String {
        close()
        configureAudioSession()

        let config = RTCConfiguration()
        config.sdpSemantics = .unifiedPlan
        config.iceServers = []   // same Wi-Fi for now, so no STUN/TURN servers yet
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)

        guard let peerConnection = Self.factory.peerConnection(with: config, constraints: constraints, delegate: self) else {
            throw CallError.couldNotCreateConnection
        }

        // Our microphone.
        let audioTrack = Self.factory.audioTrack(with: Self.factory.audioSource(with: constraints), trackId: "audio0")
        peerConnection.add(audioTrack, streamIds: ["patient"])

        // Our camera frames, pushed in by `push(pixelBuffer:time:)`.
        let videoSource = Self.factory.videoSource()
        let videoTrack = Self.factory.videoTrack(with: videoSource, trackId: "video0")
        peerConnection.add(videoTrack, streamIds: ["patient"])

        lock.withLock {
            self.peerConnection = peerConnection
            self.videoSource = videoSource
            self.capturer = RTCVideoCapturer(delegate: videoSource)
        }

        let offer = try await peerConnection.offer(for: constraints)
        try await peerConnection.setLocalDescription(offer)

        // Wait (up to 3 s) until our network addresses are collected, then send everything at once.
        for _ in 0..<30 where peerConnection.iceGatheringState != .complete {
            try await Task.sleep(for: .milliseconds(100))
        }
        return peerConnection.localDescription?.sdp ?? offer.sdp
    }

    // The doctor's reply to our offer. After this, audio and video start flowing.
    func setAnswer(_ sdp: String) async throws {
        guard let peerConnection = lock.withLock({ self.peerConnection }) else { return }
        try await peerConnection.setRemoteDescription(RTCSessionDescription(type: .answer, sdp: sdp))
    }

    // Called by the camera for every frame. Does nothing when there's no call.
    func push(pixelBuffer: CVPixelBuffer, time: CMTime) {
        guard let (source, capturer) = lock.withLock({ () -> (RTCVideoSource, RTCVideoCapturer)? in
            guard let videoSource, let capturer else { return nil }
            return (videoSource, capturer)
        }) else { return }
        // Frames are already rotated upright by the camera, so rotation is 0.
        let frame = RTCVideoFrame(buffer: RTCCVPixelBuffer(pixelBuffer: pixelBuffer),
                                  rotation: ._0,
                                  timeStampNs: Int64(CMTimeGetSeconds(time) * 1_000_000_000))
        source.capturer(capturer, didCapture: frame)
    }

    func close() {
        let peerConnection = lock.withLock { () -> RTCPeerConnection? in
            let current = self.peerConnection
            self.peerConnection = nil
            self.videoSource = nil
            self.capturer = nil
            return current
        }
        peerConnection?.close()
    }

    // The patient is side-on to the phone, so the doctor's voice goes to the loudspeaker.
    private func configureAudioSession() {
        let session = RTCAudioSession.sharedInstance()
        session.lockForConfiguration()
        defer { session.unlockForConfiguration() }
        do {
            try session.setCategory(.playAndRecord, with: [.defaultToSpeaker, .allowBluetoothHFP])
            try session.setMode(.videoChat)
        } catch {
            print("Could not configure audio: \(error)")
        }
    }

    enum CallError: Error {
        case couldNotCreateConnection
    }

    // MARK: - RTCPeerConnectionDelegate

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCPeerConnectionState) {
        let text: String
        switch newState {
        case .connecting: text = "connecting"
        case .connected: text = "connected"
        case .disconnected: text = "disconnected"
        case .failed: text = "failed"
        case .closed: text = "closed"
        default: text = "new"
        }
        onStateChange?(text)
    }

    // The rest aren't needed: we send all addresses at once in the offer.
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}
}
