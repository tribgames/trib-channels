import Cocoa

struct LauncherState: Decodable {
    let launcherExecPath: String?
    let launcherEntryPath: String?
    let connected: Bool?
    let workspacePath: String?
    let phase: String?
    let displayMode: String?
}

struct LauncherConfig: Decodable {
    let workspacePath: String?
    let displayMode: String?
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let menu = NSMenu()
    private var timer: Timer?
    private var lastLaunchAttempt = Date.distantPast

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem.button?.title = "c2b"
        rebuildMenu()
        timer = Timer.scheduledTimer(withTimeInterval: 5.0, repeats: true) { [weak self] _ in
            self?.ensureLauncherRunningIfNeeded()
            self?.rebuildMenu()
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            self?.ensureLauncherRunningIfNeeded()
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        timer?.invalidate()
    }

    private func launcherState() -> LauncherState? {
        let url = URL(fileURLWithPath: NSString(string: "~/.claude2bot-launcher-state.json").expandingTildeInPath)
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(LauncherState.self, from: data)
    }

    private func launcherConfig() -> LauncherConfig? {
        let url = URL(fileURLWithPath: NSString(string: "~/.claude2bot-launcher.json").expandingTildeInPath)
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(LauncherConfig.self, from: data)
    }

    private func runLauncher(_ args: [String]) {
        let state = launcherState()
        let execPath = Bundle.main.path(forResource: "claude2bot-launcher", ofType: nil)
            ?? state?.launcherExecPath
            ?? ProcessInfo.processInfo.environment["CLAUDE2BOT_LAUNCHER_EXEC"]
            ?? ""
        guard !execPath.isEmpty else { return }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/bash")
        process.arguments = [execPath] + args
        process.currentDirectoryURL = URL(fileURLWithPath: NSString(string: "~").expandingTildeInPath)
        try? process.run()
    }

    private func ensureLauncherRunningIfNeeded() {
        let state = launcherState()
        let connected = state?.connected ?? false
        let phase = state?.phase ?? ""
        if connected || phase == "launching" || phase == "warning_confirm" || phase == "connecting" {
            return
        }

        if Date().timeIntervalSince(lastLaunchAttempt) < 10 {
            return
        }

        lastLaunchAttempt = Date()
        runLauncher(["launch"])
    }

    @objc private func actionLaunch() { runLauncher(["launch"]) }
    @objc private func actionRestart() { runLauncher(["restart"]) }
    @objc private func actionDisplayHide() { runLauncher(["display", "hide"]) }
    @objc private func actionDisplayView() { runLauncher(["display", "view"]) }
    @objc private func actionQuit() { NSApp.terminate(nil) }

    private func rebuildMenu() {
        menu.removeAllItems()

        let state = launcherState()
        let config = launcherConfig()
        let connected = state?.connected ?? false
        let workspace = state?.workspacePath ?? "(not configured)"
        let phase = state?.phase ?? "-"
        let displayMode = state?.displayMode ?? config?.displayMode ?? "view"
        let ready = phase == "ready"

        let header = NSMenuItem(title: connected ? "Launcher connected" : "Launcher not connected", action: nil, keyEquivalent: "")
        header.isEnabled = false
        menu.addItem(header)

        let workspaceItem = NSMenuItem(title: "Workspace: \(workspace)", action: nil, keyEquivalent: "")
        workspaceItem.isEnabled = false
        menu.addItem(workspaceItem)

        let phaseItem = NSMenuItem(title: "Phase: \(phase)", action: nil, keyEquivalent: "")
        phaseItem.isEnabled = false
        menu.addItem(phaseItem)

        let displayItem = NSMenuItem(title: "Display: \(displayMode)", action: nil, keyEquivalent: "")
        displayItem.isEnabled = false
        menu.addItem(displayItem)
        menu.addItem(.separator())

        let launch = NSMenuItem(title: "Launch Claude", action: #selector(actionLaunch), keyEquivalent: "")
        launch.target = self
        menu.addItem(launch)

        let restart = NSMenuItem(title: "Restart Claude", action: #selector(actionRestart), keyEquivalent: "")
        restart.target = self
        restart.isEnabled = connected && ready
        menu.addItem(restart)

        menu.addItem(.separator())

        let viewMode = NSMenuItem(title: "View Mode", action: #selector(actionDisplayView), keyEquivalent: "")
        viewMode.target = self
        viewMode.state = displayMode == "view" ? .on : .off
        menu.addItem(viewMode)

        let hideMode = NSMenuItem(title: "Hide Mode", action: #selector(actionDisplayHide), keyEquivalent: "")
        hideMode.target = self
        hideMode.state = displayMode == "hide" ? .on : .off
        menu.addItem(hideMode)

        menu.addItem(.separator())

        let quit = NSMenuItem(title: "Quit Tray", action: #selector(actionQuit), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)

        statusItem.menu = menu
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
