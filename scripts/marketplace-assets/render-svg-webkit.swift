import AppKit
import Foundation
import WebKit

guard CommandLine.arguments.count == 4 else {
    fputs("usage: render-svg-webkit input.svg output.png size\n", stderr)
    exit(2)
}

let input = CommandLine.arguments[1]
let output = CommandLine.arguments[2]
guard let size = Int(CommandLine.arguments[3]), size > 0 else {
    fputs("invalid size\n", stderr)
    exit(2)
}
guard let svg = try? String(contentsOfFile: input, encoding: .utf8) else {
    fputs("could not read SVG\n", stderr)
    exit(1)
}

final class Renderer: NSObject, WKNavigationDelegate {
    let webView: WKWebView
    let output: String

    init(webView: WKWebView, output: String) {
        self.webView = webView
        self.output = output
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            let bounds = webView.bounds
            guard let bitmap = webView.bitmapImageRepForCachingDisplay(in: bounds) else {
                fputs("could not create bitmap\n", stderr)
                exit(1)
            }
            webView.cacheDisplay(in: bounds, to: bitmap)
            guard let data = bitmap.representation(using: .png, properties: [:]) else {
                fputs("could not encode PNG\n", stderr)
                exit(1)
            }
            do {
                try data.write(to: URL(fileURLWithPath: self.output))
            } catch {
                fputs("could not write PNG\n", stderr)
                exit(1)
            }
            exit(0)
        }
    }
}

let application = NSApplication.shared
application.setActivationPolicy(.prohibited)
let configuration = WKWebViewConfiguration()
configuration.suppressesIncrementalRendering = true
let webView = WKWebView(
    frame: NSRect(x: 0, y: 0, width: size, height: size),
    configuration: configuration
)
webView.wantsLayer = true
let renderer = Renderer(webView: webView, output: output)
webView.navigationDelegate = renderer
let window = NSWindow(
    contentRect: NSRect(x: 0, y: 0, width: size, height: size),
    styleMask: [],
    backing: .buffered,
    defer: false
)
window.isOpaque = false
window.backgroundColor = .clear
window.contentView = webView
window.orderOut(nil)

let encodedSvg = svg.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? svg
let html = "<html><head><style>html,body{margin:0;padding:0;background:transparent;width:\(size)px;height:\(size)px;overflow:hidden}img{display:block;width:\(size)px;height:\(size)px}</style></head><body><img src=\"data:image/svg+xml,\(encodedSvg)\"></body></html>"
webView.loadHTMLString(html, baseURL: nil)
application.run()
