import Carbon.HIToolbox
import Cocoa
import WebKit

private let meetNoteURL = URL(string: "http://127.0.0.1:8765/")!
private let captionsURL = URL(string: "http://127.0.0.1:8765/captions.html?overlay=1")!

final class AppDelegate: NSObject, NSApplicationDelegate {
    private let workerQueue = DispatchQueue(label: "com.leon.meetnote.launcher", qos: .userInitiated)
    private var serverProcess: Process?
    private var logHandle: FileHandle?
    private var isQuitting = false
    private let captionOverlay = CaptionOverlay(url: captionsURL)

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        installMainMenu()
        captionOverlay.registerHotKey()
        launchAndOpen()
    }

    // meetnote://captions/<show|hide|toggle|edit|lock>, sent by the recording page.
    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls where url.scheme == "meetnote" && url.host == "captions" {
            let action = url.pathComponents.dropFirst().first ?? "show"
            ensureServer { [weak self] in self?.captionOverlay.perform(action) }
        }
    }

    // Right-click on the Dock icon: caption controls while slides are full screen.
    func applicationDockMenu(_ sender: NSApplication) -> NSMenu? {
        let menu = NSMenu()
        addCaptionItems(to: menu)
        return menu
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        launchAndOpen()
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        isQuitting = true
        if let process = serverProcess, process.isRunning {
            process.terminate()
            let deadline = Date().addingTimeInterval(2)
            while process.isRunning && Date() < deadline {
                Thread.sleep(forTimeInterval: 0.05)
            }
            if process.isRunning { process.interrupt() }
        }
        try? logHandle?.close()
    }

    private func installMainMenu() {
        let mainMenu = NSMenu()
        let appMenuItem = NSMenuItem()
        mainMenu.addItem(appMenuItem)

        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Mở MeetNote", action: #selector(openFromMenu), keyEquivalent: "o")
        appMenu.addItem(NSMenuItem.separator())
        let captionsMenu = NSMenu(title: "Phụ đề")
        captionsMenu.delegate = self
        let captionsItem = NSMenuItem(title: "Phụ đề trên màn chiếu", action: nil, keyEquivalent: "")
        captionsItem.submenu = captionsMenu
        appMenu.addItem(captionsItem)
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "Thoát MeetNote", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appMenuItem.submenu = appMenu
        NSApp.mainMenu = mainMenu
    }

    @objc private func openFromMenu() {
        launchAndOpen()
    }

    private func addCaptionItems(to menu: NSMenu) {
        let visible = captionOverlay.isVisible
        let toggle = NSMenuItem(title: visible ? "Ẩn phụ đề (⌃⌥C)" : "Hiện phụ đề (⌃⌥C)", action: #selector(toggleCaptions), keyEquivalent: "")
        toggle.target = self
        menu.addItem(toggle)
        let edit = NSMenuItem(
            title: captionOverlay.isEditing ? "Khoá vị trí phụ đề" : "Chỉnh vị trí phụ đề",
            action: #selector(toggleCaptionEditing),
            keyEquivalent: ""
        )
        edit.target = self
        menu.addItem(edit)
    }

    @objc private func toggleCaptions() {
        ensureServer { [weak self] in self?.captionOverlay.perform("toggle") }
    }

    @objc private func toggleCaptionEditing() {
        ensureServer { [weak self] in
            guard let self else { return }
            self.captionOverlay.perform(self.captionOverlay.isEditing ? "lock" : "edit")
        }
    }

    private func launchAndOpen() {
        ensureServer {
            NSWorkspace.shared.open(meetNoteURL)
        }
    }

    /// Start the local server if needed, then run `ready` on the main thread.
    private func ensureServer(_ ready: @escaping () -> Void) {
        workerQueue.async { [weak self] in
            guard let self else { return }

            if !self.serverIsReady() {
                if self.serverProcess?.isRunning != true && !self.startServer() {
                    self.showLaunchError()
                    return
                }

                for _ in 0..<60 {
                    if self.serverIsReady() { break }
                    Thread.sleep(forTimeInterval: 0.25)
                }
            }

            guard self.serverIsReady() else {
                self.showLaunchError()
                return
            }

            DispatchQueue.main.async(execute: ready)
        }
    }

    private func serverIsReady() -> Bool {
        let check = Process()
        check.executableURL = URL(fileURLWithPath: "/usr/bin/curl")
        check.arguments = ["--fail", "--silent", "--max-time", "1", meetNoteURL.absoluteString]
        check.standardOutput = FileHandle.nullDevice
        check.standardError = FileHandle.nullDevice
        do {
            try check.run()
            check.waitUntilExit()
            return check.terminationStatus == 0
        } catch {
            return false
        }
    }

    private func startServer() -> Bool {
        guard
            let resourcesURL = Bundle.main.resourceURL,
            let applicationSupportURL = FileManager.default.urls(
                for: .applicationSupportDirectory,
                in: .userDomainMask
            ).first,
            let logsURL = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask).first
        else { return false }

        let appResourcesURL = resourcesURL.appendingPathComponent("app", isDirectory: true)
        let nodeURL = resourcesURL.appendingPathComponent("runtime/node")
        let storageURL = applicationSupportURL.appendingPathComponent("MeetNote", isDirectory: true)
        let logDirectoryURL = logsURL.appendingPathComponent("Logs/MeetNote", isDirectory: true)
        let logURL = logDirectoryURL.appendingPathComponent("server.log")

        do {
            try FileManager.default.createDirectory(at: storageURL, withIntermediateDirectories: true)
            try FileManager.default.createDirectory(at: logDirectoryURL, withIntermediateDirectories: true)
            if !FileManager.default.fileExists(atPath: logURL.path) {
                FileManager.default.createFile(atPath: logURL.path, contents: nil)
            }

            let handle = try FileHandle(forWritingTo: logURL)
            try handle.seekToEnd()

            let process = Process()
            process.executableURL = nodeURL
            process.arguments = ["server.js"]
            process.currentDirectoryURL = appResourcesURL
            process.standardOutput = handle
            process.standardError = handle

            var environment = ProcessInfo.processInfo.environment
            environment["MEETNOTE_STORAGE_DIR"] = storageURL.path
            let homeURL = FileManager.default.homeDirectoryForCurrentUser
            let userLocalBin = homeURL.appendingPathComponent(".local/bin").path
            let userNpmBin = homeURL.appendingPathComponent(".npm-global/bin").path
            environment["PATH"] = [
                userLocalBin,
                userNpmBin,
                "/opt/homebrew/bin",
                "/usr/local/bin",
                "/usr/bin",
                "/bin",
                "/usr/sbin",
                "/sbin"
            ].joined(separator: ":")
            process.environment = environment
            process.terminationHandler = { [weak self] _ in
                guard let self, !self.isQuitting else { return }
                DispatchQueue.main.async {
                    NSApp.requestUserAttention(.criticalRequest)
                }
            }

            try process.run()
            serverProcess = process
            logHandle = handle
            return true
        } catch {
            return false
        }
    }

    private func showLaunchError() {
        DispatchQueue.main.async {
            let alert = NSAlert()
            alert.alertStyle = .critical
            alert.messageText = "MeetNote không thể khởi động"
            alert.informativeText = "Xem log tại ~/Library/Logs/MeetNote/server.log."
            alert.runModal()
        }
    }
}

extension AppDelegate: NSMenuDelegate {
    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        addCaptionItems(to: menu)
    }
}

// MARK: - Caption overlay

/// Live captions in a borderless, transparent window that floats over every
/// app, full-screen slide shows included. Clicks pass through it to the
/// slides; while editing, it can be dragged and resized instead.
final class CaptionOverlay: NSObject, WKNavigationDelegate {
    // Saved only when the user locks a position they set (v2: earlier test saves do not count).
    private static let frameKey = "MeetNoteCaptionOverlayFrameV2"
    private static let edgeWidth: CGFloat = 14

    private let url: URL
    private var panel: NSPanel?
    private var webView: WKWebView?
    private var handle: OverlayHandleView?
    private var hotKeyRef: EventHotKeyRef?
    private(set) var isEditing = false

    init(url: URL) {
        self.url = url
    }

    var isVisible: Bool { panel?.isVisible ?? false }

    func perform(_ action: String) {
        switch action {
        case "hide": hide()
        case "toggle": isVisible ? hide() : show()
        case "edit": setEditing(true)
        case "lock": setEditing(false)
        default: show()
        }
    }

    func show() {
        let firstShow = panel == nil && UserDefaults.standard.string(forKey: Self.frameKey) == nil
        let panel = self.panel ?? makePanel()
        panel.orderFrontRegardless()
        // The first time, let the user place it before it turns click-through.
        if firstShow { setEditing(true) }
    }

    func hide() {
        setEditing(false)
        panel?.orderOut(nil)
    }

    func setEditing(_ editing: Bool) {
        let wasEditing = isEditing
        isEditing = editing
        if editing && !isVisible { show() }
        guard let panel else { return }
        panel.ignoresMouseEvents = !editing
        handle?.isHidden = !editing
        applyEditingToPage()
        // Remember the spot only when the user finishes placing it, not on a plain hide.
        if wasEditing && !editing { UserDefaults.standard.set(NSStringFromRect(panel.frame), forKey: Self.frameKey) }
    }

    private func applyEditingToPage() {
        webView?.evaluateJavaScript("typeof Captions !== 'undefined' && Captions.setEditing(\(isEditing))", completionHandler: nil)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        applyEditingToPage()
    }

    // The page failed to load (server restarting): try again shortly.
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { reloadSoon() }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { reloadSoon() }

    private func reloadSoon() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            guard let self, let webView = self.webView else { return }
            webView.load(URLRequest(url: self.url))
        }
    }

    private func savedOrDefaultFrame() -> NSRect {
        if let saved = UserDefaults.standard.string(forKey: Self.frameKey) {
            let frame = NSRectFromString(saved)
            // Keep a saved spot only while its screen is still connected.
            if frame.width > 0, NSScreen.screens.contains(where: { $0.frame.intersects(frame) }) { return frame }
        }
        // Default: the bottom of the last screen, usually the projector.
        let screen = NSScreen.screens.last ?? NSScreen.main
        let visible = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1280, height: 800)
        let width = (visible.width * 0.8).rounded()
        return NSRect(x: visible.midX - width / 2, y: visible.minY + 40, width: width, height: 220)
    }

    private func makePanel() -> NSPanel {
        let frame = savedOrDefaultFrame()
        let panel = NSPanel(
            contentRect: frame,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.level = .screenSaver
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.ignoresMouseEvents = true

        let content = NSView(frame: NSRect(origin: .zero, size: frame.size))
        content.autoresizingMask = [.width, .height]

        let webView = WKWebView(frame: content.bounds, configuration: WKWebViewConfiguration())
        webView.autoresizingMask = [.width, .height]
        webView.setValue(false, forKey: "drawsBackground")
        webView.navigationDelegate = self
        content.addSubview(webView)

        let handle = OverlayHandleView(frame: content.bounds, edgeWidth: Self.edgeWidth)
        handle.autoresizingMask = [.width, .height]
        handle.onDoubleClick = { [weak self] in self?.setEditing(false) }
        handle.isHidden = true
        content.addSubview(handle)

        panel.contentView = content
        webView.load(URLRequest(url: url))
        self.panel = panel
        self.webView = webView
        self.handle = handle
        return panel
    }

    /// Control+Option+C shows or hides the captions from any app, with no
    /// Accessibility permission needed.
    func registerHotKey() {
        var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let context = Unmanaged.passUnretained(self).toOpaque()
        InstallEventHandler(GetApplicationEventTarget(), { _, _, userData in
            guard let userData else { return noErr }
            let overlay = Unmanaged<CaptionOverlay>.fromOpaque(userData).takeUnretainedValue()
            DispatchQueue.main.async { overlay.perform("toggle") }
            return noErr
        }, 1, &eventType, context, nil)
        let hotKeyID = EventHotKeyID(signature: OSType(0x4D4E4350), id: 1) // "MNCP"
        RegisterEventHotKey(UInt32(kVK_ANSI_C), UInt32(controlKey | optionKey), hotKeyID, GetApplicationEventTarget(), 0, &hotKeyRef)
    }
}

/// Covers the overlay while editing: dragging inside moves the window,
/// dragging near an edge or corner resizes it.
final class OverlayHandleView: NSView {
    private let edgeWidth: CGFloat
    private var startMouse = NSPoint.zero
    private var startFrame = NSRect.zero
    private var edges: (left: Bool, right: Bool, bottom: Bool, top: Bool) = (false, false, false, false)
    private let minimumSize = NSSize(width: 320, height: 80)
    var onDoubleClick: (() -> Void)?

    init(frame: NSRect, edgeWidth: CGFloat) {
        self.edgeWidth = edgeWidth
        super.init(frame: frame)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func resetCursorRects() {
        let e = edgeWidth
        addCursorRect(NSRect(x: 0, y: 0, width: e, height: bounds.height), cursor: .resizeLeftRight)
        addCursorRect(NSRect(x: bounds.width - e, y: 0, width: e, height: bounds.height), cursor: .resizeLeftRight)
        addCursorRect(NSRect(x: 0, y: 0, width: bounds.width, height: e), cursor: .resizeUpDown)
        addCursorRect(NSRect(x: 0, y: bounds.height - e, width: bounds.width, height: e), cursor: .resizeUpDown)
        addCursorRect(bounds.insetBy(dx: e, dy: e), cursor: .openHand)
    }

    override func mouseDown(with event: NSEvent) {
        guard let window else { return }
        // Double-click anywhere: done placing the captions.
        if event.clickCount == 2 {
            onDoubleClick?()
            return
        }
        let point = convert(event.locationInWindow, from: nil)
        edges = (point.x < edgeWidth, point.x > bounds.width - edgeWidth, point.y < edgeWidth, point.y > bounds.height - edgeWidth)
        startMouse = NSEvent.mouseLocation
        startFrame = window.frame
        if !(edges.left || edges.right || edges.bottom || edges.top) {
            window.performDrag(with: event)
        }
    }

    override func mouseDragged(with event: NSEvent) {
        guard let window, edges.left || edges.right || edges.bottom || edges.top else { return }
        let mouse = NSEvent.mouseLocation
        let dx = mouse.x - startMouse.x
        let dy = mouse.y - startMouse.y
        var frame = startFrame
        if edges.right { frame.size.width = max(minimumSize.width, startFrame.width + dx) }
        if edges.left {
            frame.size.width = max(minimumSize.width, startFrame.width - dx)
            frame.origin.x = startFrame.maxX - frame.width
        }
        if edges.top { frame.size.height = max(minimumSize.height, startFrame.height + dy) }
        if edges.bottom {
            frame.size.height = max(minimumSize.height, startFrame.height - dy)
            frame.origin.y = startFrame.maxY - frame.height
        }
        window.setFrame(frame, display: true)
    }
}

let application = NSApplication.shared
let delegate = AppDelegate()
application.delegate = delegate
application.run()
