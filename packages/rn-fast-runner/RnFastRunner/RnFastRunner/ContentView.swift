//
//  ContentView.swift
//  RnFastRunner
//

import SwiftUI

struct ContentView: View {
    var body: some View {
        VStack {
            Spacer()
            Text("rn-dev-agent")
                .font(.title2)
                .fontWeight(.semibold)
            Text("fast runner")
                .font(.body)
                .foregroundStyle(.secondary)
                .padding(.top, 4)
            Spacer()
            Text("XCUITest bridge")
                .font(.caption)
                .foregroundStyle(.tertiary)
                .padding(.bottom, 24)
        }
        .padding()
    }
}

#Preview {
    ContentView()
}
