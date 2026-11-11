import CoreGraphics
import Foundation
let pid = Int(CommandLine.arguments[1])!
let windows = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]] ?? []
for window in windows {
    if window[kCGWindowOwnerPID as String] as? Int == pid,
       window[kCGWindowLayer as String] as? Int == 0,
       let id = window[kCGWindowNumber as String] as? Int {
        print(id)
        exit(0)
    }
}
fputs("No visible smoke window (graphical macOS session required)\n", stderr)
exit(1)
