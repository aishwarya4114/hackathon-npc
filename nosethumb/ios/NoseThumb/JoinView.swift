//
//  JoinView.swift
//  NoseThumb
//

import SwiftUI

// First screen: the patient enters the code their doctor gives them.
struct JoinView: View {
    let session: SessionClient
    let onPractice: () -> Void

    // Remembered between launches. ".local" names work on the same Wi-Fi without
    // extra security settings (plain IP addresses are blocked by iOS 17+).
    @AppStorage("serverAddress") private var serverAddress = "http://Aishwaryas-MacBook-Pro.local:3000"
    @State private var code = ""

    var body: some View {
        VStack(spacing: 20) {
            Text("NoseThumb")
                .font(.system(size: 34, weight: .bold, design: .rounded))
            Text("Enter the code your doctor gives you")
                .font(.system(size: 18, weight: .medium, design: .rounded))
                .foregroundStyle(.secondary)

            TextField("123456", text: $code)
                .keyboardType(.numberPad)
                .font(.system(size: 40, weight: .bold, design: .monospaced))
                .multilineTextAlignment(.center)
                .padding(12)
                .background(.quaternary, in: RoundedRectangle(cornerRadius: 12))
                .onChange(of: code) {
                    // Digits only, at most 6.
                    code = String(code.filter(\.isNumber).prefix(6))
                }

            if case .failed(let message) = session.state {
                Text(message)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
            }

            Button {
                Task { await session.join(server: serverAddress, code: code) }
            } label: {
                Text(session.state == .joining ? "Joining…" : "Join")
                    .font(.system(size: 20, weight: .semibold, design: .rounded))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 6)
            }
            .buttonStyle(.borderedProminent)
            .disabled(code.count != 6 || session.state == .joining)

            Button("Practice without a doctor", action: onPractice)

            Spacer()

            // For development: the address of our server (the Mac running `npm start`).
            VStack(alignment: .leading, spacing: 4) {
                Text("Server address")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                TextField("http://your-mac.local:3000", text: $serverAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                    .font(.system(size: 14, design: .monospaced))
            }
        }
        .padding(24)
    }
}
