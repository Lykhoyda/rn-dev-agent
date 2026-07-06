import SwiftUI

@main
struct FixtureApp: App {
  var body: some Scene {
    WindowGroup { ContentView() }
  }
}

struct ContentView: View {
  @State private var count = 0
  @State private var text = ""
  @State private var bottomText = ""
  @State private var bottomTaps = 0

  var body: some View {
    VStack(spacing: 8) {
      Button("Increment") { count += 1 }
        .accessibilityIdentifier("fixture_button")
      Text("count: \(count)")
        .accessibilityIdentifier("fixture_count")
      TextField("type here", text: $text)
        .textFieldStyle(.roundedBorder)
        .accessibilityIdentifier("fixture_input")
        .padding(.horizontal)
      List(1...100, id: \.self) { n in
        Text("row \(n)")
          .accessibilityIdentifier("fixture_row_\(n)")
      }
      .accessibilityIdentifier("fixture_list")
      HStack {
        TextField("bottom", text: $bottomText)
          .textFieldStyle(.roundedBorder)
          .accessibilityIdentifier("fixture_bottom_input")
        Button("Tap") { bottomTaps += 1 }
          .accessibilityIdentifier("fixture_bottom_button")
      }
      .padding(.horizontal)
      Text("bottom taps: \(bottomTaps)")
        .accessibilityIdentifier("fixture_bottom_count")
    }
    .padding(.vertical)
    // Keyboard-guard contract fixture: keep the bottom bar UNDER the keyboard.
    .ignoresSafeArea(.keyboard)
  }
}
