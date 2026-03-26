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
        timer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] _ in
            self?.ensureLauncherRunningIfNeeded()
            self?.rebuildMenu()
        }
        DispatchQueue.global(qos: .utility).async { [weak self] in
            // Clean up stale sessions, ensure deps installed, launch fresh
            self?.runLauncherSync(["stop"])
            self?.runLauncherSync(["install"])
            self?.runLauncher(["launch"])
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        timer?.invalidate()
        // Stop all launcher processes when tray quits
        runLauncherSync(["stop"])
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

    private func launcherExecPath() -> String {
        return Bundle.main.path(forResource: "claude2bot-launcher", ofType: nil)
            ?? launcherState()?.launcherExecPath
            ?? ProcessInfo.processInfo.environment["CLAUDE2BOT_LAUNCHER_EXEC"]
            ?? ""
    }

    private func runLauncher(_ args: [String]) {
        let execPath = launcherExecPath()
        guard !execPath.isEmpty else { return }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/bash")
        process.arguments = [execPath] + args
        process.currentDirectoryURL = URL(fileURLWithPath: NSString(string: "~").expandingTildeInPath)
        try? process.run()
    }

    private func runLauncherSync(_ args: [String]) {
        let execPath = launcherExecPath()
        guard !execPath.isEmpty else { return }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/bash")
        process.arguments = [execPath] + args
        process.currentDirectoryURL = URL(fileURLWithPath: NSString(string: "~").expandingTildeInPath)
        try? process.run()
        process.waitUntilExit()
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
    @objc private func actionRestart() {
        DispatchQueue.global(qos: .utility).async { [weak self] in
            self?.runLauncherSync(["stop"])
            self?.runLauncher(["launch"])
        }
    }
    @objc private func actionDisplayHide() { runLauncher(["display", "hide"]) }
    @objc private func actionDisplayView() { runLauncher(["display", "view"]) }
    @objc private func actionQuit() { NSApp.terminate(nil) }

    @objc private func actionChangeWorkspace() {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.message = "Select workspace folder for Claude Code"
        panel.prompt = "Select"
        if let current = launcherConfig()?.workspacePath {
            panel.directoryURL = URL(fileURLWithPath: current)
        }
        let response = panel.runModal()
        NSApp.setActivationPolicy(.accessory)
        guard response == .OK, let url = panel.url else { return }
        runLauncherSync(["workspace", url.path])
        // Restart with new workspace
        DispatchQueue.global(qos: .utility).async { [weak self] in
            self?.runLauncherSync(["stop"])
            self?.runLauncher(["launch"])
        }
    }

    private func rebuildMenu() {
        menu.removeAllItems()

        let state = launcherState()
        let config = launcherConfig()
        let connected = state?.connected ?? false
        let workspace = state?.workspacePath ?? config?.workspacePath ?? "(not set)"
        let displayMode = state?.displayMode ?? config?.displayMode ?? "view"

        // Status
        let header = NSMenuItem(title: connected ? "🟢 Connected" : "🔴 Disconnected", action: nil, keyEquivalent: "")
        header.isEnabled = false
        menu.addItem(header)
        menu.addItem(.separator())

        // Actions
        let launch = NSMenuItem(title: "Launch", action: #selector(actionLaunch), keyEquivalent: "l")
        launch.target = self
        launch.isEnabled = !connected
        menu.addItem(launch)

        let restart = NSMenuItem(title: "Restart", action: #selector(actionRestart), keyEquivalent: "r")
        restart.target = self
        restart.isEnabled = connected
        menu.addItem(restart)

        menu.addItem(.separator())

        // Display toggle
        let viewMode = NSMenuItem(title: "View Mode", action: #selector(actionDisplayView), keyEquivalent: "")
        viewMode.target = self
        viewMode.state = displayMode == "view" ? .on : .off
        menu.addItem(viewMode)

        let hideMode = NSMenuItem(title: "Hide Mode", action: #selector(actionDisplayHide), keyEquivalent: "")
        hideMode.target = self
        hideMode.state = displayMode == "hide" ? .on : .off
        menu.addItem(hideMode)

        menu.addItem(.separator())

        // Settings
        let workspaceShort = (workspace as NSString).lastPathComponent
        let workspaceItem = NSMenuItem(title: "Workspace: \(workspaceShort)", action: #selector(actionChangeWorkspace), keyEquivalent: "")
        workspaceItem.target = self
        menu.addItem(workspaceItem)

        menu.addItem(.separator())

        let quit = NSMenuItem(title: "Quit", action: #selector(actionQuit), keyEquivalent: "q")
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
