import Cocoa

// MARK: - Data Models

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
    let sleepEnabled: Bool?
    let sleepTime: String?
}

struct BotConfig: Decodable {
    var autotalk: AutotalkConfig?
    var quiet: QuietConfig?
}

struct AutotalkConfig: Decodable {
    var enabled: Bool?
    var freq: Int?
}

struct QuietConfig: Decodable {
    var schedule: String?
    var autotalk: String?
    var holidays: String?
    var timezone: String?
}


// MARK: - Settings Window

final class SettingsWindowController: NSObject {
    private var window: NSWindow?
    private let delegate: AppDelegate

    init(delegate: AppDelegate) {
        self.delegate = delegate
    }

    func show() {
        if let w = window, w.isVisible { w.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true); return }

        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 360, height: 350),
                         styleMask: [.titled, .closable], backing: .buffered, defer: false)
        w.title = "Claude2Bot Settings"
        w.center()
        w.isReleasedWhenClosed = false

        let content = NSView(frame: w.contentView!.bounds)
        content.autoresizingMask = [.width, .height]
        w.contentView = content

        let p: CGFloat = 16 // same padding left and right
        let ww: CGFloat = 360
        let rEdge: CGFloat = ww - p // right edge = all controls end here
        let cw: CGFloat = 80 // standard control/button width
        let row: CGFloat = 28 // row height
        var y: CGFloat = 310

        // ── Workspace ──
        addLabel(to: content, text: "Workspace", x: p, y: y, bold: true)
        addSmallButton(to: content, title: "Change...", x: rEdge - cw, y: y, width: cw, target: self, action: #selector(changeWorkspace))
        y -= 20
        let wsPath = delegate.launcherConfig()?.workspacePath ?? delegate.launcherState()?.workspacePath ?? "(not set)"
        let wsLabel = addLabel(to: content, text: wsPath, x: p, y: y)
        wsLabel.textColor = .secondaryLabelColor
        wsLabel.font = .systemFont(ofSize: 11)
        wsLabel.lineBreakMode = .byTruncatingMiddle
        wsLabel.frame.size.width = rEdge - p
        y -= row

        // ── Autotalk ──
        let botConfig = readBotConfig()
        let autotalkOn = botConfig?.autotalk?.enabled ?? false
        let autotalkFreq = max(1, min(5, botConfig?.autotalk?.freq ?? 3))

        addLabelWithHelp(to: content, text: "Autotalk", x: p, y: y,
            help: "Proactive conversation frequency. Claude initiates topics based on context and schedule.")
        let freqLabels = ["OFF", "Very Low", "Low", "Medium", "High", "Very High"]
        let freqPopup = NSPopUpButton(frame: NSRect(x: rEdge - cw, y: y - 2, width: cw, height: 24), pullsDown: false)
        freqPopup.font = .systemFont(ofSize: 12)
        for label in freqLabels { freqPopup.addItem(withTitle: label) }
        freqPopup.selectItem(at: autotalkOn ? autotalkFreq : 0)
        freqPopup.target = self
        freqPopup.action = #selector(autotalkChanged(_:))
        content.addSubview(freqPopup)
        y -= row

        // ── Quiet Hours ──
        let quietSchedule = botConfig?.quiet?.schedule ?? ""
        let quietOn = !quietSchedule.isEmpty
        let quietParts = quietSchedule.split(separator: "-").map(String.init)
        let quietFrom = quietParts.count >= 1 ? quietParts[0] : "22:00"
        let quietTo = quietParts.count >= 2 ? quietParts[1] : "08:00"

        addLabelWithHelp(to: content, text: "Quiet Hours", x: p, y: y,
            help: "No scheduled messages or autotalk during these hours.")
        let qToggle = NSPopUpButton(frame: NSRect(x: rEdge - cw, y: y - 2, width: cw, height: 24), pullsDown: false)
        qToggle.font = .systemFont(ofSize: 12)
        qToggle.addItem(withTitle: "OFF")
        qToggle.addItem(withTitle: "ON")
        qToggle.selectItem(at: quietOn ? 1 : 0)
        qToggle.tag = 200
        qToggle.target = self
        qToggle.action = #selector(quietToggleChanged(_:))
        content.addSubview(qToggle)
        y -= row

        // Time fields — each field same width as button, right-aligned
        addLabel(to: content, text: "Quiet From", x: p, y: y)
        let fromField = NSTextField(string: quietFrom)
        fromField.frame = NSRect(x: rEdge - cw, y: y - 1, width: cw, height: 22)
        fromField.alignment = .center
        fromField.font = .monospacedDigitSystemFont(ofSize: 12, weight: .regular)
        fromField.tag = 201
        fromField.isEnabled = quietOn
        fromField.target = self
        fromField.action = #selector(quietTimeChanged)
        content.addSubview(fromField)
        y -= row

        addLabel(to: content, text: "Quiet To", x: p, y: y)
        let toField = NSTextField(string: quietTo)
        toField.frame = NSRect(x: rEdge - cw, y: y - 1, width: cw, height: 22)
        toField.alignment = .center
        toField.font = .monospacedDigitSystemFont(ofSize: 12, weight: .regular)
        toField.tag = 202
        toField.isEnabled = quietOn
        toField.target = self
        toField.action = #selector(quietTimeChanged)
        content.addSubview(toField)
        y -= row

        // ── Sleeping Mode ──
        let config = delegate.launcherConfig()
        let sleepOn = config?.sleepEnabled ?? true // default ON
        let sleepTime = config?.sleepTime ?? "03:00"

        addLabelWithHelp(to: content, text: "Sleeping Mode", x: p, y: y,
            help: "Summarizes today's conversation, updates your profile, and restarts the session at the scheduled time.")
        let sleepToggle = NSPopUpButton(frame: NSRect(x: rEdge - cw, y: y - 2, width: cw, height: 24), pullsDown: false)
        sleepToggle.font = .systemFont(ofSize: 12)
        sleepToggle.addItem(withTitle: "OFF")
        sleepToggle.addItem(withTitle: "ON")
        sleepToggle.selectItem(at: sleepOn ? 1 : 0)
        sleepToggle.tag = 300
        sleepToggle.target = self
        sleepToggle.action = #selector(sleepToggleChanged(_:))
        content.addSubview(sleepToggle)
        y -= row

        addLabel(to: content, text: "Sleep Time", x: p, y: y)
        let sleepField = NSTextField(string: sleepTime)
        sleepField.frame = NSRect(x: rEdge - cw, y: y - 1, width: cw, height: 22)
        sleepField.alignment = .center
        sleepField.font = .monospacedDigitSystemFont(ofSize: 12, weight: .regular)
        sleepField.tag = 301
        sleepField.isEnabled = sleepOn
        sleepField.target = self
        sleepField.action = #selector(sleepTimeChanged(_:))
        content.addSubview(sleepField)
        y -= row

        // ── Auto-start on Login ──
        let autostart = isLoginItemEnabled()
        addLabelWithHelp(to: content, text: "Auto-start", x: p, y: y,
            help: "Automatically launch Claude2Bot when you log in to your Mac.")
        let asCheck = NSButton(checkboxWithTitle: "", target: self, action: #selector(autostartToggled(_:)))
        asCheck.frame = NSRect(x: rEdge - 18, y: y, width: 20, height: 20)
        asCheck.state = autostart ? .on : .off
        content.addSubview(asCheck)
        y -= row

        // ── Voice (only show if not installed) ──
        if !hasWhisper() {
            addLabelWithHelp(to: content, text: "Voice", x: p, y: y,
                help: "Install whisper.cpp for voice message transcription.")
            addSmallButton(to: content, title: "Install", x: rEdge - cw, y: y, width: cw, target: self, action: #selector(installVoice))
            y -= row
        }

        // ── Plugin Update ──
        addLabel(to: content, text: "Plugin", x: p, y: y)
        addSmallButton(to: content, title: "Update", x: rEdge - cw, y: y, width: cw, target: self, action: #selector(updatePlugin))

        self.window = w
        NSApp.setActivationPolicy(.regular)
        w.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    // MARK: - Helpers

    @discardableResult
    private func addLabel(to view: NSView, text: String, x: CGFloat, y: CGFloat, bold: Bool = false) -> NSTextField {
        let label = NSTextField(labelWithString: text)
        label.frame = NSRect(x: x, y: y, width: 300, height: 20)
        label.font = bold ? .boldSystemFont(ofSize: 13) : .systemFont(ofSize: 13)
        view.addSubview(label)
        return label
    }

    @discardableResult
    private func addLabelWithHelp(to view: NSView, text: String, x: CGFloat, y: CGFloat, help: String, bold: Bool = false) -> NSTextField {
        let label = addLabel(to: view, text: text, x: x, y: y, bold: bold)
        let font = bold ? NSFont.boldSystemFont(ofSize: 13) : NSFont.systemFont(ofSize: 13)
        let textWidth = (text as NSString).size(withAttributes: [.font: font]).width
        let helpBtn = NSButton(title: "?", target: self, action: #selector(showHelp(_:)))
        helpBtn.frame = NSRect(x: x + textWidth + 4, y: y, width: 18, height: 18)
        helpBtn.bezelStyle = .circular
        helpBtn.controlSize = .mini
        helpBtn.font = .systemFont(ofSize: 10)
        helpBtn.toolTip = help
        view.addSubview(helpBtn)
        return label
    }

    @objc private func showHelp(_ sender: NSButton) {
        if let tip = sender.toolTip {
            let alert = NSAlert()
            alert.messageText = "Help"
            alert.informativeText = tip
            alert.alertStyle = .informational
            alert.addButton(withTitle: "OK")
            alert.runModal()
        }
    }

    private func addSeparator(to view: NSView, y: CGFloat) {
        let sep = NSBox()
        sep.boxType = .separator
        sep.frame = NSRect(x: 16, y: y, width: 368, height: 1)
        view.addSubview(sep)
    }

    @discardableResult
    private func addSmallButton(to view: NSView, title: String, x: CGFloat, y: CGFloat, width: CGFloat, target: AnyObject, action: Selector) -> NSButton {
        let btn = NSButton(title: title, target: target, action: action)
        btn.frame = NSRect(x: x, y: y - 2, width: width, height: 24)
        btn.bezelStyle = .rounded
        btn.font = .systemFont(ofSize: 12)
        view.addSubview(btn)
        return btn
    }

    private let pluginDataDir = NSString(string: "~/.claude/plugins/data/claude2bot-claude2bot").expandingTildeInPath

    private func readBotConfig() -> BotConfig? {
        let path = (pluginDataDir as NSString).appendingPathComponent("bot.json")
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)) else { return nil }
        return try? JSONDecoder().decode(BotConfig.self, from: data)
    }


    private func hasWhisper() -> Bool {
        let paths = ["/opt/homebrew/bin/whisper-cpp", "/usr/local/bin/whisper-cpp",
                     "/opt/homebrew/bin/whisper", "/usr/local/bin/whisper"]
        return paths.contains { FileManager.default.fileExists(atPath: $0) }
    }

    private func isLoginItemEnabled() -> Bool {
        let plistPath = NSString(string: "~/Library/LaunchAgents/com.tribgames.claude2bot.launcher.plist").expandingTildeInPath
        return FileManager.default.fileExists(atPath: plistPath)
    }

    // MARK: - Actions

    @objc private func changeWorkspace() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.message = "Select workspace folder for Claude Code"
        panel.prompt = "Select"
        if let current = delegate.launcherConfig()?.workspacePath {
            panel.directoryURL = URL(fileURLWithPath: current)
        }
        guard panel.runModal() == .OK, let url = panel.url else { return }
        delegate.runLauncherSync(["workspace", url.path])
        DispatchQueue.global(qos: .utility).async { [weak self] in
            self?.delegate.runLauncherSync(["stop"])
            self?.delegate.runLauncher(["launch"])
        }
        closeSettings()
    }

    @objc private func sleepToggleChanged(_ sender: NSPopUpButton) {
        let on = sender.indexOfSelectedItem == 1
        if let contentView = sender.window?.contentView {
            if let f = contentView.viewWithTag(301) as? NSTextField { f.isEnabled = on }
        }
        var config = readLauncherConfigRaw()
        config["sleepEnabled"] = on
        writeLauncherConfig(config)
    }

    @objc private func sleepTimeChanged(_ sender: NSTextField) {
        var config = readLauncherConfigRaw()
        config["sleepTime"] = sender.stringValue
        writeLauncherConfig(config)
    }

    private func readLauncherConfigRaw() -> [String: Any] {
        let path = NSString(string: "~/.claude2bot-launcher.json").expandingTildeInPath
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
        return json
    }

    private func writeLauncherConfig(_ config: [String: Any]) {
        let path = NSString(string: "~/.claude2bot-launcher.json").expandingTildeInPath
        if let data = try? JSONSerialization.data(withJSONObject: config, options: [.prettyPrinted, .sortedKeys]) {
            try? data.write(to: URL(fileURLWithPath: path))
        }
    }

    @objc private func autotalkChanged(_ sender: NSPopUpButton) {
        // Index 0 = OFF, 1-5 = freq levels
        let idx = sender.indexOfSelectedItem
        var bot = readBotConfigRaw()
        var at = bot["autotalk"] as? [String: Any] ?? [:]
        if idx == 0 {
            at["enabled"] = false
        } else {
            at["enabled"] = true
            at["freq"] = idx
        }
        bot["autotalk"] = at
        writeBotConfig(bot)
    }

    @objc private func quietToggleChanged(_ sender: NSPopUpButton) {
        let on = sender.indexOfSelectedItem == 1
        if let contentView = sender.window?.contentView {
            if let f = contentView.viewWithTag(201) as? NSTextField { f.isEnabled = on }
            if let t = contentView.viewWithTag(202) as? NSTextField { t.isEnabled = on }
        }
        var bot = readBotConfigRaw()
        var q = bot["quiet"] as? [String: Any] ?? [:]
        if on {
            let from = (sender.window?.contentView?.viewWithTag(201) as? NSTextField)?.stringValue ?? "22:00"
            let to = (sender.window?.contentView?.viewWithTag(202) as? NSTextField)?.stringValue ?? "08:00"
            q["schedule"] = "\(from)-\(to)"
        } else {
            q["schedule"] = ""
            q["autotalk"] = ""
        }
        bot["quiet"] = q
        writeBotConfig(bot)
    }

    @objc private func quietTimeChanged() {
        guard let contentView = window?.contentView,
              let qCheck = contentView.viewWithTag(200) as? NSButton, qCheck.state == .on,
              let fromField = contentView.viewWithTag(201) as? NSTextField,
              let toField = contentView.viewWithTag(202) as? NSTextField else { return }
        let schedule = "\(fromField.stringValue)-\(toField.stringValue)"
        var bot = readBotConfigRaw()
        var q = bot["quiet"] as? [String: Any] ?? [:]
        q["schedule"] = schedule
        bot["quiet"] = q
        writeBotConfig(bot)
    }

    @objc private func autostartToggled(_ sender: NSButton) {
        let enable = sender.state == .on
        let plistPath = NSString(string: "~/Library/LaunchAgents/com.tribgames.claude2bot.launcher.plist").expandingTildeInPath

        if enable {
            let appPath = Bundle.main.bundlePath
            let plist: [String: Any] = [
                "Label": "com.tribgames.claude2bot.launcher",
                "ProgramArguments": ["open", "-a", appPath],
                "RunAtLoad": true,
                "KeepAlive": false,
            ]
            let dir = (plistPath as NSString).deletingLastPathComponent
            try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
            (plist as NSDictionary).write(toFile: plistPath, atomically: true)
        } else {
            try? FileManager.default.removeItem(atPath: plistPath)
        }
    }

    @objc private func installVoice() {
        delegate.runLauncher(["install-voice"])
        closeSettings()
    }

    @objc private func updatePlugin() {
        delegate.runLauncher(["update"])
        closeSettings()
    }

    @objc private func closeSettings() {
        window?.close()
        NSApp.setActivationPolicy(.accessory)
    }

    private func writeBotConfig(_ bot: [String: Any]) {
        let path = (pluginDataDir as NSString).appendingPathComponent("bot.json")
        if let data = try? JSONSerialization.data(withJSONObject: bot, options: [.prettyPrinted, .sortedKeys]) {
            try? data.write(to: URL(fileURLWithPath: path))
        }
    }

    private func readBotConfigRaw() -> [String: Any] {
        let path = (pluginDataDir as NSString).appendingPathComponent("bot.json")
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
        return json
    }

}

// MARK: - App Delegate

final class AppDelegate: NSObject, NSApplicationDelegate {
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let menu = NSMenu()
    private var timer: Timer?
    private var lastLaunchAttempt = Date.distantPast
    private var lastSleepDate = ""
    private lazy var settingsController = SettingsWindowController(delegate: self)

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem.button?.title = "c2b"
        rebuildMenu()
        timer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] _ in
            self?.ensureLauncherRunningIfNeeded()
            self?.checkSleepSchedule()
            self?.rebuildMenu()
        }
        DispatchQueue.global(qos: .utility).async { [weak self] in
            self?.runLauncherSync(["stop"])
            self?.runLauncherSync(["install"])
            self?.runLauncher(["launch"])
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        timer?.invalidate()
        runLauncherSync(["stop"])
    }

    func launcherState() -> LauncherState? {
        let url = URL(fileURLWithPath: NSString(string: "~/.claude2bot-launcher-state.json").expandingTildeInPath)
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(LauncherState.self, from: data)
    }

    func launcherConfig() -> LauncherConfig? {
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

    func runLauncher(_ args: [String]) {
        let execPath = launcherExecPath()
        guard !execPath.isEmpty else { return }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/bash")
        process.arguments = [execPath] + args
        process.currentDirectoryURL = URL(fileURLWithPath: NSString(string: "~").expandingTildeInPath)
        try? process.run()
    }

    func runLauncherSync(_ args: [String]) {
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
        if Date().timeIntervalSince(lastLaunchAttempt) < 10 { return }
        lastLaunchAttempt = Date()
        runLauncher(["launch"])
    }

    private func checkSleepSchedule() {
        let config = launcherConfig()
        guard config?.sleepEnabled ?? true else { return }
        let sleepTime = config?.sleepTime ?? "03:00"

        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm"
        let now = formatter.string(from: Date())
        let today = DateFormatter.localizedString(from: Date(), dateStyle: .short, timeStyle: .none)

        // Only trigger once per day, within 2-minute window of sleep time
        guard now >= sleepTime, now < addMinutes(sleepTime, 2), lastSleepDate != today else { return }
        lastSleepDate = today

        DispatchQueue.global(qos: .utility).async { [weak self] in
            self?.runLauncherSync(["sleep-cycle"])
        }
    }

    private func addMinutes(_ time: String, _ mins: Int) -> String {
        let parts = time.split(separator: ":").compactMap { Int($0) }
        guard parts.count == 2 else { return time }
        let total = parts[0] * 60 + parts[1] + mins
        return String(format: "%02d:%02d", (total / 60) % 24, total % 60)
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
    @objc private func actionSettings() { settingsController.show() }
    @objc private func actionQuit() { NSApp.terminate(nil) }

    private func rebuildMenu() {
        menu.removeAllItems()

        let state = launcherState()
        let config = launcherConfig()
        let connected = state?.connected ?? false
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
        let settings = NSMenuItem(title: "Settings...", action: #selector(actionSettings), keyEquivalent: ",")
        settings.target = self
        menu.addItem(settings)

        menu.addItem(.separator())

        let quit = NSMenuItem(title: "Quit", action: #selector(actionQuit), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)

        statusItem.menu = menu
    }
}

// MARK: - Main

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
