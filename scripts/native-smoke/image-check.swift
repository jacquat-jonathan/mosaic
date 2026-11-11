import CoreGraphics
import ImageIO
import Foundation
let url = URL(fileURLWithPath: CommandLine.arguments[1]) as CFURL
guard let source = CGImageSourceCreateWithURL(url, nil), let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { exit(1) }
var pixels = [UInt8](repeating: 0, count: 16 * 16 * 4)
let nonblank = pixels.withUnsafeMutableBytes { bytes -> Bool in
    guard let context = CGContext(data: bytes.baseAddress, width: 16, height: 16, bitsPerComponent: 8, bytesPerRow: 64, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
    context.draw(image, in: CGRect(x: 0, y: 0, width: 16, height: 16))
    return stride(from: 0, to: bytes.count, by: 4).contains { index in
        bytes[index] > 30 || bytes[index + 1] > 30 || bytes[index + 2] > 30
    }
}
if !nonblank { fputs("Window capture is blank; display/recording permission unavailable\n", stderr); exit(1) }
