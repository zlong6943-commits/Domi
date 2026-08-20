import CoreGraphics
import Foundation

func emitClick(x: CGFloat, y: CGFloat, timestamp: TimeInterval = Date().timeIntervalSince1970) {
    let payload: [String: Any] = [
        "type": "leftMouseDown",
        "x": Int(x.rounded()),
        "y": Int(y.rounded()),
        "timestamp": Int((timestamp * 1_000).rounded()),
    ]
    guard let data = try? JSONSerialization.data(withJSONObject: payload),
          let line = String(data: data, encoding: .utf8) else {
        return
    }
    print(line)
    fflush(stdout)
}

if CommandLine.arguments.contains("--self-test") {
    emitClick(x: 120, y: 240)
    exit(EXIT_SUCCESS)
}

var wasPressed = CGEventSource.buttonState(.combinedSessionState, button: .left)

while true {
    let isPressed = CGEventSource.buttonState(.combinedSessionState, button: .left)
    if isPressed && !wasPressed, let event = CGEvent(source: nil) {
        emitClick(x: event.location.x, y: event.location.y)
    }
    wasPressed = isPressed
    usleep(8_000)
}
