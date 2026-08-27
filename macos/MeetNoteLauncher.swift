import Cocoa

private let meetNoteURL = URL(string: "http://127.0.0.1:8765/")!

final class AppDelegate: NSObject, NSApplicationDelegate {
    private let workerQueue = DispatchQueue(label: "com.leon.meetnote.launcher", qos: .userInitiated)
    private var serverProcess: Process?
    private var logHandle: FileHandle?
    private var isQuitting = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        installMainMenu()
        launchAndOpen()
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
        appMenu.addItem(withTitle: "Thoát MeetNote", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appMenuItem.submenu = appMenu
        NSApp.mainMenu = mainMenu
    }

    @objc private func openFromMenu() {
        launchAndOpen()
    }

    private func launchAndOpen() {
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

            DispatchQueue.main.async {
                NSWorkspace.shared.open(meetNoteURL)
            }
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

let application = NSApplication.shared
let delegate = AppDelegate()
application.delegate = delegate
application.run()
