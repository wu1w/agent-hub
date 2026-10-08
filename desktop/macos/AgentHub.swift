import AppKit
import WebKit
import Darwin

private func localized(_ key: String) -> String {
    Bundle.main.localizedString(forKey: key, value: nil, table: nil)
}

@MainActor
final class AgentHubApp: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var statusView: NSStackView!
    private var statusTitle: NSTextField!
    private var statusDetail: NSTextField!
    private var retryButton: NSButton!
    private var logsButton: NSButton!
    private var spinner: NSProgressIndicator!
    private var runtime: Process?
    private var inputPipe: Pipe?
    private var outputPipe: Pipe?
    private var errorPipe: Pipe?
    private var outputBuffer = Data()
    private var logHandle: FileHandle?
    private var logURL = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Logs/Agent Hub/app.log")
    private var dataRoot = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".agent-hub")
    private var origin: URL?
    private var generation = 0
    private var startupTimeout: DispatchWorkItem?
    private var stopTimeout: DispatchWorkItem?
    private var stopping = false
    private var quitting = false
    private var retryAfterStop = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        let bundleID = Bundle.main.bundleIdentifier ?? "com.wu1w.agent-hub"
        if let existing = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID)
            .first(where: { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }) {
            existing.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])
            NSApp.terminate(nil)
            return
        }
        prepareLog()
        buildMenu()
        buildWindow()
        startRuntime()
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
        window?.makeKeyAndOrderFront(nil)
        return true
    }

    func windowWillClose(_ notification: Notification) { savePreferences() }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard runtime?.isRunning == true else { return .terminateNow }
        if quitting { return .terminateLater }
        quitting = true
        savePreferences()
        stopRuntime()
        return .terminateLater
    }

    private func savePreferences() {
        // Only two non-secret UI preferences cross launches with a random localhost port.
        if let webView, isLocal(webView.url) {
            webView.evaluateJavaScript("JSON.stringify({language:localStorage.getItem('hub-lang'),installed:localStorage.getItem('hub-agent-installed')})") { result, _ in
                if let text = result as? String, let data = text.data(using: .utf8),
                   let values = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    if let language = values["language"] as? String, ["en", "zh"].contains(language) {
                        UserDefaults.standard.set(language, forKey: "HubLanguage")
                    }
                    if let installed = values["installed"] as? String, ["0", "1"].contains(installed) {
                        UserDefaults.standard.set(installed, forKey: "HubInstalledOnly")
                    }
                }
            }
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        try? inputPipe?.fileHandleForWriting.close()
        try? logHandle?.close()
    }

    private func prepareLog() {
        let files = FileManager.default
        do {
            try files.createDirectory(at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true,
                                      attributes: [.posixPermissions: 0o700])
            if let attrs = try? files.attributesOfItem(atPath: logURL.path),
               let size = attrs[.size] as? NSNumber, size.intValue > 5_000_000 {
                let previous = logURL.appendingPathExtension("previous")
                try? files.removeItem(at: previous)
                try files.moveItem(at: logURL, to: previous)
            }
            if !files.fileExists(atPath: logURL.path) {
                files.createFile(atPath: logURL.path, contents: nil, attributes: [.posixPermissions: 0o600])
            }
            try files.setAttributes([.posixPermissions: 0o600], ofItemAtPath: logURL.path)
            logHandle = try FileHandle(forWritingTo: logURL)
            try logHandle?.seekToEnd()
        } catch { logHandle = nil }
    }

    private func buildMenu() {
        let main = NSMenu()
        let application = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(item("menu.about", #selector(showAbout), ""))
        appMenu.addItem(.separator())
        appMenu.addItem(item("menu.data", #selector(openDataDirectory), ""))
        appMenu.addItem(item("menu.logs", #selector(showLogs), ""))
        appMenu.addItem(.separator())
        appMenu.addItem(item("menu.hide", #selector(NSApplication.hide(_:)), "h", target: NSApp))
        let hideOthers = item("menu.hideOthers", #selector(NSApplication.hideOtherApplications(_:)), "h", target: NSApp)
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(hideOthers)
        appMenu.addItem(item("menu.showAll", #selector(NSApplication.unhideAllApplications(_:)), "", target: NSApp))
        appMenu.addItem(.separator())
        appMenu.addItem(item("menu.quit", #selector(NSApplication.terminate(_:)), "q", target: NSApp))
        application.submenu = appMenu
        main.addItem(application)

        let edit = NSMenuItem(title: localized("menu.edit"), action: nil, keyEquivalent: "")
        let editMenu = NSMenu(title: localized("menu.edit"))
        for (key, action, shortcut) in [
            ("menu.undo", "undo:", "z"), ("menu.redo", "redo:", "Z"),
            ("menu.cut", "cut:", "x"), ("menu.copy", "copy:", "c"),
            ("menu.paste", "paste:", "v"), ("menu.selectAll", "selectAll:", "a")
        ] {
            let entry = NSMenuItem(title: localized(key), action: NSSelectorFromString(action), keyEquivalent: shortcut)
            editMenu.addItem(entry)
        }
        edit.submenu = editMenu
        main.addItem(edit)

        let view = NSMenuItem(title: localized("menu.view"), action: nil, keyEquivalent: "")
        let viewMenu = NSMenu(title: localized("menu.view"))
        viewMenu.addItem(item("menu.reload", #selector(reload), "r"))
        view.submenu = viewMenu
        main.addItem(view)

        let windows = NSMenuItem(title: localized("menu.window"), action: nil, keyEquivalent: "")
        let windowMenu = NSMenu(title: localized("menu.window"))
        windowMenu.addItem(NSMenuItem(title: localized("menu.close"), action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w"))
        windowMenu.addItem(NSMenuItem(title: localized("menu.minimize"), action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m"))
        windowMenu.addItem(NSMenuItem(title: localized("menu.zoom"), action: #selector(NSWindow.performZoom(_:)), keyEquivalent: ""))
        windows.submenu = windowMenu
        main.addItem(windows)
        NSApp.mainMenu = main
        NSApp.windowsMenu = windowMenu
    }

    private func item(_ key: String, _ action: Selector, _ shortcut: String, target: AnyObject? = nil) -> NSMenuItem {
        let entry = NSMenuItem(title: localized(key), action: action, keyEquivalent: shortcut)
        entry.target = target ?? self
        return entry
    }

    private func buildWindow() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1260, height: 860),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = localized("app.name")
        window.minSize = NSSize(width: 850, height: 600)
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.setFrameAutosaveName("AgentHubMainWindow")
        window.center()

        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        let language = UserDefaults.standard.string(forKey: "HubLanguage")
        let installed = UserDefaults.standard.string(forKey: "HubInstalledOnly")
        var preferences: [String: String] = [:]
        if let language, ["zh", "en"].contains(language) { preferences["hub-lang"] = language }
        if let installed, ["0", "1"].contains(installed) { preferences["hub-agent-installed"] = installed }
        if let bytes = try? JSONSerialization.data(withJSONObject: preferences), let json = String(data: bytes, encoding: .utf8) {
            let script = "try { const prefs = \(json); for (const [k,v] of Object.entries(prefs)) { if (localStorage.getItem(k) === null) localStorage.setItem(k,v); } } catch (_) {}"
            configuration.userContentController.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        webView.translatesAutoresizingMaskIntoConstraints = false
        let container = NSView()
        window.contentView = container
        container.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            webView.topAnchor.constraint(equalTo: container.topAnchor),
            webView.bottomAnchor.constraint(equalTo: container.bottomAnchor)
        ])
        spinner = NSProgressIndicator()
        spinner.style = .spinning
        spinner.controlSize = .regular
        statusTitle = NSTextField(labelWithString: "")
        statusTitle.font = .systemFont(ofSize: 24, weight: .semibold)
        statusTitle.alignment = .center
        statusDetail = NSTextField(wrappingLabelWithString: "")
        statusDetail.font = .systemFont(ofSize: 13)
        statusDetail.textColor = .secondaryLabelColor
        statusDetail.alignment = .center
        statusDetail.isSelectable = true
        retryButton = NSButton(title: localized("button.retry"), target: self, action: #selector(retry))
        retryButton.bezelStyle = .rounded
        logsButton = NSButton(title: localized("button.logs"), target: self, action: #selector(showLogs))
        logsButton.bezelStyle = .rounded
        let buttons = NSStackView(views: [retryButton, logsButton])
        buttons.orientation = .horizontal
        buttons.spacing = 12
        statusView = NSStackView(views: [spinner, statusTitle, statusDetail, buttons])
        statusView.orientation = .vertical
        statusView.alignment = .centerX
        statusView.spacing = 18
        statusView.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(statusView)
        NSLayoutConstraint.activate([
            statusView.centerXAnchor.constraint(equalTo: container.centerXAnchor),
            statusView.centerYAnchor.constraint(equalTo: container.centerYAnchor),
            statusView.widthAnchor.constraint(lessThanOrEqualTo: container.widthAnchor, constant: -100),
            statusDetail.widthAnchor.constraint(lessThanOrEqualToConstant: 620)
        ])
        window.makeKeyAndOrderFront(nil)
    }

    private func showStatus(title: String, detail: String, loading: Bool) {
        statusTitle.stringValue = title
        statusDetail.stringValue = detail
        statusView.isHidden = false
        webView.isHidden = true
        retryButton.isHidden = loading
        logsButton.isHidden = loading
        if loading { spinner.startAnimation(nil) } else { spinner.stopAnimation(nil) }
        spinner.isHidden = !loading
    }

    private func showFailure(_ key: String) {
        startupTimeout?.cancel()
        let location = String(format: localized("error.logLocation"), logURL.path)
        showStatus(title: localized("status.failed"), detail: localized(key) + "\n\n" + location, loading: false)
    }

    private func startRuntime() {
        guard !quitting, runtime == nil else { return }
        generation += 1
        let current = generation
        stopping = false
        origin = nil
        outputBuffer.removeAll(keepingCapacity: true)
        showStatus(title: localized("status.starting"), detail: localized("status.startingDetail"), loading: true)
        guard let resources = Bundle.main.resourceURL else { showFailure("error.resources"); return }
        let node = resources.appendingPathComponent("runtime/node")
        let server = resources.appendingPathComponent("runtime/server.mjs")
        guard FileManager.default.isExecutableFile(atPath: node.path), FileManager.default.fileExists(atPath: server.path) else {
            showFailure("error.resources")
            return
        }
        let process = Process()
        process.executableURL = node
        process.arguments = [server.path]
        process.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser
        var environment = ProcessInfo.processInfo.environment
        // User shell preload hooks must not change the packaged Node runtime.
        environment.removeValue(forKey: "NODE_OPTIONS")
        environment.removeValue(forKey: "NODE_PATH")
        environment.removeValue(forKey: "AGENT_HUB_SERVICE")
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        environment["HOME"] = home
        // Leave an unset Hub root unset: config.toml may point at a relocated data directory.
        let runtimePath = resources.appendingPathComponent("runtime").path
        let userPaths = (environment["PATH"] ?? "").split(separator: ":").map(String.init).filter { $0 != runtimePath }
        let paths = ["\(home)/.local/bin", "\(home)/.bun/bin", "\(home)/.grok/bin", "\(home)/.kimi-code/bin", "\(home)/.cargo/bin", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
        environment["PATH"] = (userPaths + paths + [runtimePath]).reduce(into: [String]()) { values, value in
            if !value.isEmpty && !values.contains(value) { values.append(value) }
        }.joined(separator: ":")
        environment["AGENT_HUB_DESKTOP"] = "1"
        environment["HUB_LANG"] = UserDefaults.standard.string(forKey: "HubLanguage")
            ?? (Locale.preferredLanguages.first?.hasPrefix("zh") == true ? "zh" : "en")
        process.environment = environment
        let stdinPipe = Pipe(), stdoutPipe = Pipe(), stderrPipe = Pipe()
        process.standardInput = stdinPipe
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe
        inputPipe = stdinPipe
        outputPipe = stdoutPipe
        errorPipe = stderrPipe
        stdoutPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil; return }
            DispatchQueue.main.async { self?.consumeOutput(data, generation: current) }
        }
        stderrPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil; return }
            DispatchQueue.main.async {
                guard let self, self.generation == current else { return }
                try? self.logHandle?.write(contentsOf: data)
            }
        }
        process.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async { self?.runtimeEnded(generation: current) }
        }
        runtime = process
        do { try process.run() }
        catch {
            releasePipes()
            runtime = nil
            showFailure("error.launch")
            return
        }
        let timeout = DispatchWorkItem { [weak self] in
            guard let self, self.generation == current, self.origin == nil, !self.quitting else { return }
            self.showFailure("error.timeout")
            self.stopRuntime()
        }
        startupTimeout = timeout
        DispatchQueue.main.asyncAfter(deadline: .now() + 30, execute: timeout)
    }

    private func consumeOutput(_ data: Data, generation current: Int) {
        guard generation == current, !quitting, !stopping else { return }
        outputBuffer.append(data)
        guard outputBuffer.count <= 1_048_576 else {
            showFailure("error.protocol")
            stopRuntime()
            return
        }
        while let end = outputBuffer.firstIndex(of: 10) {
            let line = outputBuffer[..<end]
            outputBuffer.removeSubrange(...end)
            guard origin == nil,
                  let object = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
                  object["type"] as? String == "ready" else { continue }
            guard let port = object["port"] as? Int, (1...65535).contains(port),
                  let token = object["token"] as? String,
                  token.range(of: "^[A-Za-z0-9._~-]{32,512}$", options: .regularExpression) != nil,
                  let url = URL(string: "http://127.0.0.1:\(port)/") else {
                showFailure("error.protocol")
                stopRuntime()
                return
            }
            if let root = object["root"] as? String, root.hasPrefix("/") {
                dataRoot = URL(fileURLWithPath: root, isDirectory: true)
            }
            if let backendLog = object["logPath"] as? String, backendLog.hasPrefix("/") {
                // The stderr stream still uses the fixed app log; the menu reveals the backend log.
                logURL = URL(fileURLWithPath: backendLog)
            }
            guard let cookie = HTTPCookie.cookies(withResponseHeaderFields: [
                "Set-Cookie": "hub_session=\(token); HttpOnly; SameSite=Strict; Path=/"
            ], for: url).first, cookie.isHTTPOnly else {
                showFailure("error.protocol")
                stopRuntime()
                return
            }
            origin = url
            startupTimeout?.cancel()
            webView.configuration.websiteDataStore.httpCookieStore.setCookie(cookie) { [weak self] in
                DispatchQueue.main.async {
                    guard let self, self.generation == current, !self.stopping, !self.quitting else { return }
                    self.webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))
                }
            }
        }
    }

    private func stopRuntime() {
        startupTimeout?.cancel()
        guard let process = runtime, process.isRunning else {
            runtimeEnded(generation: generation)
            return
        }
        if stopping { return }
        stopping = true
        try? inputPipe?.fileHandleForWriting.close()
        process.terminate()
        let current = generation
        let timeout = DispatchWorkItem { [weak self, weak process] in
            guard let self, self.generation == current, let process, process.isRunning else { return }
            Darwin.kill(process.processIdentifier, SIGKILL)
        }
        stopTimeout = timeout
        DispatchQueue.main.asyncAfter(deadline: .now() + 20, execute: timeout)
    }

    private func runtimeEnded(generation current: Int) {
        guard generation == current else { return }
        let wasStopping = stopping
        startupTimeout?.cancel()
        stopTimeout?.cancel()
        releasePipes()
        runtime = nil
        origin = nil
        stopping = false
        if quitting { NSApp.reply(toApplicationShouldTerminate: true); return }
        if retryAfterStop { retryAfterStop = false; startRuntime(); return }
        if !wasStopping { showFailure("error.exited") }
    }

    private func releasePipes() {
        outputPipe?.fileHandleForReading.readabilityHandler = nil
        errorPipe?.fileHandleForReading.readabilityHandler = nil
        try? inputPipe?.fileHandleForWriting.close()
        try? outputPipe?.fileHandleForReading.close()
        try? errorPipe?.fileHandleForReading.close()
        inputPipe = nil
        outputPipe = nil
        errorPipe = nil
    }

    private func isLocal(_ url: URL?) -> Bool {
        guard let url, let origin else { return false }
        return url.scheme == origin.scheme && url.host == origin.host && url.port == origin.port
            && url.user == nil && url.password == nil
    }

    private func openExternalLink(_ action: WKNavigationAction) {
        guard action.navigationType == .linkActivated, let url = action.request.url,
              ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
              let host = url.host?.lowercased(), host != "localhost", host != "127.0.0.1", host != "::1" else { return }
        NSWorkspace.shared.open(url)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if isLocal(navigationAction.request.url) {
            decisionHandler(.allow)
        } else {
            openExternalLink(navigationAction)
            decisionHandler(.cancel)
        }
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if isLocal(navigationAction.request.url) { webView.load(navigationAction.request) }
        else { openExternalLink(navigationAction) }
        return nil
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard isLocal(webView.url) else { return }
        statusView.isHidden = true
        spinner.stopAnimation(nil)
        webView.isHidden = false
        window.makeFirstResponder(webView)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code != NSURLErrorCancelled && !quitting { showFailure("error.page") }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code != NSURLErrorCancelled && !quitting { showFailure("error.page") }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        if !quitting { showFailure("error.page") }
    }

    private func dialog(_ message: String) -> NSAlert {
        let alert = NSAlert()
        alert.messageText = localized("app.name")
        alert.informativeText = message
        alert.addButton(withTitle: localized("button.ok"))
        return alert
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        guard isLocal(frame.request.url) else { completionHandler(); return }
        dialog(message).beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        guard isLocal(frame.request.url) else { completionHandler(false); return }
        let alert = dialog(message)
        alert.addButton(withTitle: localized("button.cancel"))
        alert.beginSheetModal(for: window) { result in completionHandler(result == .alertFirstButtonReturn) }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        guard isLocal(frame.request.url) else { completionHandler(nil); return }
        let alert = dialog(prompt)
        alert.addButton(withTitle: localized("button.cancel"))
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 360, height: 24))
        field.stringValue = defaultText ?? ""
        alert.accessoryView = field
        alert.window.initialFirstResponder = field
        alert.beginSheetModal(for: window) { result in
            completionHandler(result == .alertFirstButtonReturn ? field.stringValue : nil)
        }
    }

    @objc private func retry() {
        if runtime?.isRunning == true { retryAfterStop = true; stopRuntime() }
        else { runtime = nil; startRuntime() }
    }

    @objc private func reload() {
        if origin != nil { webView.reload() } else { retry() }
    }

    @objc private func openDataDirectory() { NSWorkspace.shared.open(dataRoot) }

    @objc private func showLogs() {
        if FileManager.default.fileExists(atPath: logURL.path) { NSWorkspace.shared.activateFileViewerSelecting([logURL]) }
        else { NSWorkspace.shared.open(logURL.deletingLastPathComponent()) }
    }

    @objc private func showAbout() {
        NSApp.orderFrontStandardAboutPanel(options: [
            .applicationName: localized("app.name"),
            .applicationVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.2.0",
            .credits: NSAttributedString(string: localized("about.description"))
        ])
    }
}

MainActor.assumeIsolated {
    let app = NSApplication.shared
    let delegate = AgentHubApp()
    app.setActivationPolicy(.regular)
    app.delegate = delegate
    withExtendedLifetime(delegate) { app.run() }
}
