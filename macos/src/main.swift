// Remote Total para Mac: icono en la barra de menú que arranca el puente (node + server.js),
// muestra la dirección para los celulares con su código QR y apaga el puente al salir.
import AppKit
import CoreImage
import Darwin

// MARK: - Rutas
let homeDir = ProcessInfo.processInfo.environment["HOME"] ?? NSHomeDirectory()
let supportDir = homeDir + "/Library/Application Support/Remote Total"
let userConfigPath = supportDir + "/config.json"
let logDir = homeDir + "/Library/Logs/Remote Total"
let logPath = logDir + "/puente.log"
let resourcesDir = Bundle.main.resourcePath ?? ""
let nodePath = resourcesDir + "/node/node"
let appDir = resourcesDir + "/app"
let serverPath = appDir + "/server.js"

// MARK: - Configuración: solo el puerto de la página (para sondear /api/estado)
func configFile() -> String? {
    if let c = ProcessInfo.processInfo.environment["CONFIG"], !c.isEmpty { return c }
    return FileManager.default.fileExists(atPath: userConfigPath) ? userConfigPath : nil
}

func configuredPort() -> Int {
    guard let file = configFile(),
          let data = FileManager.default.contents(atPath: file),
          let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          let port = obj["port"] as? Int else { return 8080 }
    return port
}

// MARK: - Registro del puente: ~/Library/Logs/Remote Total/puente.log, rota al pasar de 512 KB
final class Log {
    private let queue = DispatchQueue(label: "remotetotal.log")
    private var handle: FileHandle?
    private var size: UInt64 = 0
    private let maxSize: UInt64 = 512 * 1024

    init() {
        try? FileManager.default.createDirectory(atPath: logDir, withIntermediateDirectories: true)
        queue.sync { self.open() }
    }

    private func open() {
        let fm = FileManager.default
        if !fm.fileExists(atPath: logPath) { fm.createFile(atPath: logPath, contents: nil) }
        handle = FileHandle(forWritingAtPath: logPath)
        _ = try? handle?.seekToEnd()
        let attrs = try? fm.attributesOfItem(atPath: logPath)
        size = (attrs?[.size] as? NSNumber)?.uint64Value ?? 0
    }

    private func rotate() {
        try? handle?.close()
        let viejo = logPath + ".1"
        try? FileManager.default.removeItem(atPath: viejo)
        try? FileManager.default.moveItem(atPath: logPath, toPath: viejo)
        open()
    }

    func write(_ text: String) {
        queue.async {
            guard let data = text.data(using: .utf8) else { return }
            if self.size + UInt64(data.count) > self.maxSize { self.rotate() }
            self.handle?.write(data)
            self.size += UInt64(data.count)
        }
    }

    // Espera a que se escriba lo pendiente (antes de salir).
    func flush() { queue.sync {} }
}


// MARK: - Ajustes (lo que escribe la ventana Ajustes en config.json)
struct Ajustes: Equatable {
    var port: Int
    var host: String
    var tmPort: Int
    var listenPort: Int
    static let defaults = Ajustes(port: 8080, host: "127.0.0.1", tmPort: 7001, listenPort: 9001)
}

// Lee lo que el puente usará (CONFIG o config.json); lo que falte, por defecto.
func leerAjustes() -> Ajustes {
    var a = Ajustes.defaults
    guard let file = configFile(), let data = FileManager.default.contents(atPath: file),
          let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return a }
    if let p = obj["port"] as? Int { a.port = p }
    if let tm = obj["totalmix"] as? [String: Any] {
        if let h = tm["host"] as? String { a.host = h }
        if let p = tm["port"] as? Int { a.tmPort = p }
        if let p = tm["listenPort"] as? Int { a.listenPort = p }
    }
    return a
}

func esIPv4(_ s: String) -> Bool {
    var addr = in_addr()
    return inet_pton(AF_INET, s, &addr) == 1
}

// Errores por campo ("port", "host", "tmPort", "listenPort"). Vacío = válido.
func validarAjustes(_ a: Ajustes) -> [String: String] {
    var e: [String: String] = [:]
    let rango = "Debe estar entre 1024 y 65535"
    if !(1024...65535).contains(a.port) { e["port"] = rango }
    if !(1024...65535).contains(a.tmPort) { e["tmPort"] = rango }
    if !(1024...65535).contains(a.listenPort) { e["listenPort"] = rango }
    if !esIPv4(a.host) { e["host"] = "Debe ser una IPv4, por ejemplo 127.0.0.1" }
    let pares = [("port", a.port), ("tmPort", a.tmPort), ("listenPort", a.listenPort)]
    for (i, x) in pares.enumerated() {
        for y in pares[(i + 1)...] where x.1 == y.1 {
            if e[y.0] == nil { e[y.0] = "Repite un puerto que ya usa otro campo" }
        }
    }
    return e
}

// Texto de la ventana -> Ajustes (o errores por campo).
func validarCampos(_ c: [String: String]) -> (Ajustes?, [String: String]) {
    var errores: [String: String] = [:]
    func entero(_ k: String) -> Int? {
        if let v = Int((c[k] ?? "").trimmingCharacters(in: .whitespaces)) { return v }
        errores[k] = "Debe ser un número entero"
        return nil
    }
    let p = entero("port"), t = entero("tmPort"), l = entero("listenPort")
    let host = (c["host"] ?? "").trimmingCharacters(in: .whitespaces)
    guard let pp = p, let tt = t, let ll = l else { return (nil, errores) }
    let a = Ajustes(port: pp, host: host, tmPort: tt, listenPort: ll)
    errores = validarAjustes(a)
    return (errores.isEmpty ? a : nil, errores)
}

// Escribe config.json con el formato que lee server.js.
func guardarAjustes(_ a: Ajustes) throws {
    let obj: [String: Any] = ["port": a.port,
                              "totalmix": ["host": a.host, "port": a.tmPort, "listenPort": a.listenPort]]
    let data = try JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys, .prettyPrinted])
    try FileManager.default.createDirectory(atPath: supportDir, withIntermediateDirectories: true)
    try data.write(to: URL(fileURLWithPath: userConfigPath), options: .atomic)
}

// Modo de prueba: remote-total --probar-config (sin ventana; usa el HOME de la prueba).
func probarConfig() -> Int32 {
    var fallos = 0
    func check(_ nombre: String, _ ok: Bool) {
        print((ok ? "OK    " : "FALLA ") + nombre)
        if !ok { fallos += 1 }
    }
    let base = Ajustes.defaults
    check("valores por defecto son válidos", validarAjustes(base).isEmpty)
    check("puerto 80 se rechaza", validarAjustes(Ajustes(port: 80, host: base.host, tmPort: 7001, listenPort: 9001))["port"] != nil)
    check("puerto 70000 se rechaza", validarAjustes(Ajustes(port: 70000, host: base.host, tmPort: 7001, listenPort: 9001))["port"] != nil)
    check("puerto 1024 se acepta", validarAjustes(Ajustes(port: 1024, host: base.host, tmPort: 7001, listenPort: 9001)).isEmpty)
    check("puerto 65535 se acepta", validarAjustes(Ajustes(port: 65535, host: base.host, tmPort: 7001, listenPort: 9001)).isEmpty)
    check("entrada igual a la página se rechaza (campo tmPort)",
          validarAjustes(Ajustes(port: 8080, host: base.host, tmPort: 8080, listenPort: 9001))["tmPort"] != nil)
    check("salida igual a la entrada se rechaza (campo listenPort)",
          validarAjustes(Ajustes(port: 8080, host: base.host, tmPort: 7001, listenPort: 7001))["listenPort"] != nil)
    check("host 300.1.1.1 se rechaza", validarAjustes(Ajustes(port: 8080, host: "300.1.1.1", tmPort: 7001, listenPort: 9001))["host"] != nil)
    check("host localhost se rechaza", validarAjustes(Ajustes(port: 8080, host: "localhost", tmPort: 7001, listenPort: 9001))["host"] != nil)
    check("host vacío se rechaza", validarAjustes(Ajustes(port: 8080, host: "", tmPort: 7001, listenPort: 9001))["host"] != nil)
    check("texto no numérico se rechaza", validarCampos(["port": "abc", "host": "127.0.0.1", "tmPort": "7001", "listenPort": "9001"]).0 == nil)
    check("decimal 8080.5 se rechaza", validarCampos(["port": "8080.5", "host": "127.0.0.1", "tmPort": "7001", "listenPort": "9001"]).0 == nil)
    let ok = validarCampos(["port": " 8089 ", "host": "192.168.1.20", "tmPort": "7101", "listenPort": "9101"]).0
    check("texto válido se acepta y recorta espacios", ok == Ajustes(port: 8089, host: "192.168.1.20", tmPort: 7101, listenPort: 9101))
    let prueba = Ajustes(port: 8089, host: "192.168.1.20", tmPort: 7101, listenPort: 9101)
    do {
        try guardarAjustes(prueba)
        check("guardar crea config.json en la carpeta de la prueba", FileManager.default.fileExists(atPath: userConfigPath))
        let raw = (try? JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: userConfigPath)))) as? [String: Any]
        let tm = raw?["totalmix"] as? [String: Any]
        check("formato de server.js: port y totalmix{host,port,listenPort}",
              (raw?["port"] as? Int) == 8089 && (tm?["host"] as? String) == "192.168.1.20"
              && (tm?["port"] as? Int) == 7101 && (tm?["listenPort"] as? Int) == 9101)
    } catch {
        check("guardar config.json: \(error)", false)
    }
    check("leer devuelve lo guardado", leerAjustes() == prueba)
    try? "no es json".write(toFile: userConfigPath, atomically: true, encoding: .utf8)
    check("JSON roto cae a valores por defecto", leerAjustes() == Ajustes.defaults)
    print(fallos == 0 ? "RESULTADO: todo OK" : "RESULTADO: \(fallos) fallo(s)")
    return fallos == 0 ? 0 : 1
}

// MARK: - SIGTERM / SIGINT llegan como un byte por una tubería, para salir limpio desde el hilo principal.
// El manejador no se ignora (SIG_IGN) porque el hijo heredaría la ignorancia; un manejador propio se
// restaura a SIG_DFL al hacer exec, así node sí responde a SIGTERM.
var termFD: Int32 = -1

final class AppDelegate: NSObject, NSApplicationDelegate {
    private let log = Log()
    private var port = configuredPort()
    private var ajustesWindow: NSWindow?
    private var campos: [String: NSTextField] = [:]
    private var errLabels: [String: NSTextField] = [:]
    private var ajustesMsg: NSTextField?
    private var statusItem: NSStatusItem!
    private var window: NSWindow!
    private var contentStack: NSStackView!
    private var addressLabel: NSTextField!
    private var statusLabel: NSTextField!
    private var problemLabel: NSTextField!
    private var restartButton: NSButton!
    private var qrView: NSImageView!
    private var lastQR: String?
    private var timer: Timer?
    private var signalSource: DispatchSourceRead?
    private let session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = 1
        return URLSession(configuration: c)
    }()

    private var child: Process?
    private var running = false    // hay un node vivo que arrancamos nosotros
    private var stopping = false   // lo paramos nosotros (Salir)
    private var portBusy = false   // node salió con código 2: puerto ocupado
    private var polling = false
    private var totalmix: Bool?    // nil: no hay dato de /api/estado todavía
    private var estadoURLs: [String] = []

    // MARK: Arranque
    func applicationDidFinishLaunching(_ notification: Notification) {
        let principal = NSMenu()
        let itemApp = NSMenuItem()
        principal.addItem(itemApp)
        let menuApp = NSMenu()
        menuApp.addItem(NSMenuItem(title: "Salir de Remote Total",
                                   action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        itemApp.submenu = menuApp
        NSApp.mainMenu = principal

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.image = NSImage(systemSymbolName: "slider.vertical.3", accessibilityDescription: "Remote Total")
        statusItem.button?.image?.isTemplate = true

        buildWindow()
        installSignals()
        startBridge()
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.poll() }
        showWindow()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationWillTerminate(_ notification: Notification) {
        stopBridge()
        log.write("--- Remote Total sale ---\n")
        log.flush()
    }

    private func installSignals() {
        var fd: [Int32] = [0, 0]
        guard pipe(&fd) == 0 else { return }
        termFD = fd[1]
        let rd = fd[0]
        let source = DispatchSource.makeReadSource(fileDescriptor: rd, queue: .main)
        source.setEventHandler {
            var b: UInt8 = 0
            _ = read(rd, &b, 1)
            NSApp.terminate(nil)
        }
        source.resume()
        signalSource = source
        _ = signal(SIGTERM) { _ in var b: UInt8 = 0; _ = write(termFD, &b, 1) }
        _ = signal(SIGINT) { _ in var b: UInt8 = 0; _ = write(termFD, &b, 1) }
    }

    // MARK: Puente (node)
    private func startBridge() {
        if running { return }
        port = configuredPort()
        portBusy = false
        let fm = FileManager.default
        guard fm.fileExists(atPath: nodePath), fm.fileExists(atPath: serverPath) else {
            log.write("Falta dentro de la app: \(nodePath) o \(serverPath)\n")
            refreshUI()
            return
        }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: nodePath)
        p.arguments = [serverPath]
        p.currentDirectoryURL = URL(fileURLWithPath: appDir)
        var env = ProcessInfo.processInfo.environment
        if env["CONFIG"] == nil, fm.fileExists(atPath: userConfigPath) { env["CONFIG"] = userConfigPath }
        p.environment = env

        let pipe = Pipe()
        pipe.fileHandleForReading.readabilityHandler = { [weak self] h in
            let d = h.availableData
            if d.isEmpty { h.readabilityHandler = nil; return }
            if let s = String(data: d, encoding: .utf8) { self?.log.write(s) }
        }
        p.standardOutput = pipe
        p.standardError = pipe
        p.terminationHandler = { [weak self] pr in
            let status = pr.terminationStatus
            let porSalida = pr.terminationReason == .exit
            DispatchQueue.main.async { self?.childEnded(pr, status: status, byExit: porSalida) }
        }
        do {
            try p.run()
        } catch {
            log.write("No pude arrancar node: \(error.localizedDescription)\n")
            refreshUI()
            return
        }
        child = p
        running = true
        stopping = false
        totalmix = nil
        estadoURLs = []
        log.write("\n--- arranque \(Date()) · puerto \(port) ---\n")
        refreshUI()
    }

    private func childEnded(_ p: Process, status: Int32, byExit: Bool) {
        guard child === p else { return }
        child = nil
        running = false
        totalmix = nil
        estadoURLs = []
        if stopping { stopping = false; return }
        if byExit && status == 2 {
            portBusy = true
            log.write("node salió con código 2: el puerto \(port) está ocupado\n")
        } else {
            log.write("node se detuvo (código \(status))\n")
        }
        refreshUI()
    }

    // Salir: SIGTERM, hasta 3 s esperando, y SIGKILL si sigue vivo.
    private func stopBridge() {
        guard running, let p = child else { return }
        stopping = true
        if p.isRunning { p.terminate() }
        let limite = Date().addingTimeInterval(3)
        while p.isRunning && Date() < limite { usleep(50_000) }
        if p.isRunning {
            kill(p.processIdentifier, SIGKILL)
            log.write("node no salió con SIGTERM en 3 s: SIGKILL\n")
        }
        child = nil
        running = false
    }

    @objc private func restartBridge() { startBridge() }

    // MARK: Sondeo de /api/estado cada 1 s
    private func poll() {
        guard running, !polling, let url = URL(string: "http://127.0.0.1:\(port)/api/estado") else { return }
        polling = true
        session.dataTask(with: url) { [weak self] data, response, _ in
            var ok: Bool? = nil
            var urls: [String] = []
            if let http = response as? HTTPURLResponse, http.statusCode == 200, let data = data,
               let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
                ok = obj["totalmix"] as? Bool
                urls = obj["urls"] as? [String] ?? []
            }
            DispatchQueue.main.async {
                self?.polling = false
                self?.apply(totalmix: ok, urls: urls)
            }
        }.resume()
    }

    private func apply(totalmix nuevo: Bool?, urls: [String]) {
        guard running else { return }
        if nuevo != totalmix || urls != estadoURLs {
            totalmix = nuevo
            estadoURLs = urls
            refreshUI()
        }
    }

    // MARK: Estado y direcciones
    private var statusLine: String {
        if !running { return portBusy ? "Puente detenido: puerto ocupado" : "Puente detenido" }
        return totalmix == true ? "TotalMix conectado" : "Esperando a TotalMix…"
    }

    private var problem: String? {
        if portBusy { return "El puerto \(port) ya está en uso. ¿Ya hay otro Remote Total abierto?" }
        if !running { return "El puente se detuvo. Usa «Reiniciar puente»." }
        return nil
    }

    private func primaryURL() -> String? {
        guard running else { return nil }
        return estadoURLs.first ?? localURLs().first
    }

    // Direcciones IPv4 de la red local, por si /api/estado todavía no las trae.
    private func localURLs() -> [String] {
        var result: [String] = []
        var list: UnsafeMutablePointer<ifaddrs>? = nil
        guard getifaddrs(&list) == 0, let first = list else { return result }
        defer { freeifaddrs(list) }
        var cur: UnsafeMutablePointer<ifaddrs>? = first
        while let c = cur {
            let flags = c.pointee.ifa_flags
            if let sa = c.pointee.ifa_addr, Int32(sa.pointee.sa_family) == AF_INET,
               flags & UInt32(IFF_UP) != 0, flags & UInt32(IFF_LOOPBACK) == 0 {
                var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
                if getnameinfo(sa, socklen_t(sa.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 {
                    result.append("http://\(String(cString: host)):\(port)")
                }
            }
            cur = c.pointee.ifa_next
        }
        return result
    }

    // MARK: Interfaz
    private func refreshUI() {
        let ok = running && totalmix == true
        statusItem.button?.contentTintColor = ok ? nil : NSColor.systemRed
        statusItem.button?.toolTip = "Remote Total · " + statusLine
        statusItem.menu = buildMenu()

        let addr = primaryURL()
        addressLabel.stringValue = addr ?? "Sin dirección de red"
        if addr != lastQR {
            lastQR = addr
            qrView.image = addr.flatMap { qrImage(for: $0) }
        }
        statusLabel.stringValue = statusLine
        statusLabel.textColor = ok ? NSColor.systemGreen : (running ? NSColor.secondaryLabelColor : NSColor.systemRed)
        problemLabel.stringValue = problem ?? ""
        problemLabel.isHidden = problem == nil
        restartButton.isHidden = running
        contentStack.layoutSubtreeIfNeeded()
        window.setContentSize(NSSize(width: 360, height: contentStack.fittingSize.height))
    }

    private func buildMenu() -> NSMenu {
        let menu = NSMenu()
        let addr = primaryURL()
        let copia = NSMenuItem(title: addr ?? "Sin dirección de red",
                               action: addr == nil ? nil : #selector(copyAddress), keyEquivalent: "")
        copia.target = self
        menu.addItem(copia)

        let mostrar = NSMenuItem(title: "Mostrar ventana", action: #selector(showWindow), keyEquivalent: "")
        mostrar.target = self
        menu.addItem(mostrar)
        menu.addItem(.separator())

        let estado = NSMenuItem(title: statusLine, action: nil, keyEquivalent: "")
        estado.isEnabled = false
        menu.addItem(estado)
        if portBusy {
            let aviso = NSMenuItem(title: "¿Ya hay otro Remote Total abierto?", action: nil, keyEquivalent: "")
            aviso.isEnabled = false
            menu.addItem(aviso)
        }
        if !running {
            let reiniciar = NSMenuItem(title: "Reiniciar puente", action: #selector(restartBridge), keyEquivalent: "")
            reiniciar.target = self
            menu.addItem(reiniciar)
        }
        let ajustes = NSMenuItem(title: "Ajustes…", action: #selector(openAjustes), keyEquivalent: ",")
        ajustes.target = self
        menu.addItem(ajustes)
        menu.addItem(.separator())

        let salir = NSMenuItem(title: "Salir", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        salir.target = NSApp
        menu.addItem(salir)
        return menu
    }

    @objc private func copyAddress() {
        guard let addr = primaryURL() else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(addr, forType: .string)
    }

    @objc private func showWindow() {
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func qrImage(for text: String) -> NSImage? {
        guard let filter = CIFilter(name: "CIQRCodeGenerator") else { return nil }
        filter.setValue(Data(text.utf8), forKey: "inputMessage")
        filter.setValue("M", forKey: "inputCorrectionLevel")
        guard let out = filter.outputImage else { return nil }
        let grande = out.transformed(by: CGAffineTransform(scaleX: 10, y: 10))
        // Margen blanco alrededor del código (zona silenciosa para la cámara).
        let fondo = CIImage(color: CIColor.white).cropped(to: grande.extent.insetBy(dx: -40, dy: -40))
        let conMargen = grande.composited(over: fondo)
        let rep = NSCIImageRep(ciImage: conMargen)
        let img = NSImage(size: rep.size)
        img.addRepresentation(rep)
        return img
    }

    private func texto(_ s: String, _ size: CGFloat, _ peso: NSFont.Weight = .regular,
                       color: NSColor = .labelColor) -> NSTextField {
        let t = NSTextField(wrappingLabelWithString: s)
        t.font = .systemFont(ofSize: size, weight: peso)
        t.textColor = color
        t.alignment = .center
        t.preferredMaxLayoutWidth = 300
        return t
    }


    // MARK: - Ventana Ajustes
    @objc func openAjustes() {
        if ajustesWindow == nil { buildAjustes() }
        fillAjustes(leerAjustes())
        ajustesWindow?.center()
        ajustesWindow?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func fillAjustes(_ a: Ajustes) {
        campos["port"]?.stringValue = String(a.port)
        campos["host"]?.stringValue = a.host
        campos["tmPort"]?.stringValue = String(a.tmPort)
        campos["listenPort"]?.stringValue = String(a.listenPort)
        for l in errLabels.values { l.stringValue = "" }
        ajustesMsg?.stringValue = ""
    }

    private func buildAjustes() {
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 380, height: 380),
                         styleMask: [.titled, .closable], backing: .buffered, defer: false)
        w.title = "Ajustes de Remote Total"
        w.isReleasedWhenClosed = false
        ajustesWindow = w

        let filas: [(String, String)] = [
            ("port", "Puerto de la página"),
            ("host", "IP de TotalMix"),
            ("tmPort", "Puerto de entrada de TotalMix (Port incoming)"),
            ("listenPort", "Puerto de salida de TotalMix (Port outgoing)"),
        ]
        var vistas: [NSView] = []
        for (k, titulo) in filas {
            let l = NSTextField(labelWithString: titulo)
            l.font = .systemFont(ofSize: 12, weight: .semibold)
            let f = NSTextField()
            f.translatesAutoresizingMaskIntoConstraints = false
            f.widthAnchor.constraint(equalToConstant: 330).isActive = true
            let e = NSTextField(labelWithString: "")
            e.font = .systemFont(ofSize: 11)
            e.textColor = .systemRed
            campos[k] = f
            errLabels[k] = e
            vistas += [l, f, e]
        }
        let msg = NSTextField(labelWithString: "")
        msg.font = .systemFont(ofSize: 11)
        msg.textColor = .systemRed
        ajustesMsg = msg
        vistas.append(msg)

        let guardar = NSButton(title: "Guardar", target: self, action: #selector(guardarAjustesTapped))
        guardar.keyEquivalent = "\r"
        guardar.bezelStyle = .rounded
        let defecto = NSButton(title: "Valores por defecto", target: self, action: #selector(defaultsTapped))
        defecto.bezelStyle = .rounded
        let botones = NSStackView(views: [defecto, guardar])
        botones.orientation = .horizontal
        botones.spacing = 10
        vistas.append(botones)

        let stack = NSStackView(views: vistas)
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 4
        stack.edgeInsets = NSEdgeInsets(top: 20, left: 25, bottom: 20, right: 25)
        stack.translatesAutoresizingMaskIntoConstraints = false
        stack.setCustomSpacing(12, after: campos["listenPort"]!)
        w.contentView!.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: w.contentView!.topAnchor),
            stack.leadingAnchor.constraint(equalTo: w.contentView!.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: w.contentView!.trailingAnchor),
        ])
        w.setContentSize(NSSize(width: 380, height: stack.fittingSize.height))
    }

    @objc private func defaultsTapped() { fillAjustes(.defaults) }

    @objc private func guardarAjustesTapped() {
        var c: [String: String] = [:]
        for (k, f) in campos { c[k] = f.stringValue }
        let (ajustes, errores) = validarCampos(c)
        for (k, l) in errLabels { l.stringValue = errores[k] ?? "" }
        guard let a = ajustes else {
            ajustesMsg?.stringValue = "No guardado: corrige los campos marcados."
            return
        }
        do {
            try guardarAjustes(a)
        } catch {
            ajustesMsg?.stringValue = "No pude escribir config.json: \(error.localizedDescription)"
            return
        }
        ajustesWindow?.orderOut(nil)
        log.write("--- Ajustes guardados: página \(a.port), TotalMix \(a.host):\(a.tmPort)/\(a.listenPort). Reinicio del puente ---\n")
        stopBridge()
        startBridge()
    }

    private func buildWindow() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 360, height: 600),
                          styleMask: [.titled, .closable, .miniaturizable],
                          backing: .buffered, defer: false)
        window.title = "Remote Total"
        window.isReleasedWhenClosed = false
        window.center()

        let titulo = texto("Remote Total", 18, .bold)
        addressLabel = texto("", 19, .semibold)
        addressLabel.font = .monospacedSystemFont(ofSize: 19, weight: .semibold)
        addressLabel.isSelectable = true
        let hint = texto("Abre esta dirección en el celular (misma WiFi) o escanea el código.", 12,
                         color: .secondaryLabelColor)

        qrView = NSImageView()
        qrView.imageScaling = .scaleProportionallyUpOrDown
        qrView.wantsLayer = true
        qrView.layer?.magnificationFilter = .nearest
        qrView.translatesAutoresizingMaskIntoConstraints = false
        qrView.widthAnchor.constraint(equalToConstant: 220).isActive = true
        qrView.heightAnchor.constraint(equalToConstant: 220).isActive = true

        statusLabel = texto("", 15, .semibold)
        problemLabel = texto("", 12, color: .systemRed)
        restartButton = NSButton(title: "Reiniciar puente", target: self, action: #selector(restartBridge))
        restartButton.bezelStyle = .rounded

        let sep = NSBox()
        sep.boxType = .separator
        sep.translatesAutoresizingMaskIntoConstraints = false
        sep.widthAnchor.constraint(equalToConstant: 300).isActive = true

        let oscTitulo = texto("TotalMix FX (Global OSC)", 13, .semibold)
        let osc = texto("Options → Settings → OSC: Global OSC activado (In Use), puertos 7001 y 9001, "
                        + "IP 127.0.0.1 y Peak Hold desmarcado.", 12, color: .secondaryLabelColor)
        let pie = texto("Cerrar esta ventana no apaga el puente. Para apagarlo: ⌘Q o «Salir» en el icono de la barra.",
                        11, color: .tertiaryLabelColor)

        contentStack = NSStackView(views: [titulo, addressLabel, hint, qrView, statusLabel, problemLabel,
                                           restartButton, sep, oscTitulo, osc, pie])
        contentStack.orientation = .vertical
        contentStack.alignment = .centerX
        contentStack.spacing = 10
        contentStack.edgeInsets = NSEdgeInsets(top: 24, left: 30, bottom: 24, right: 30)
        contentStack.translatesAutoresizingMaskIntoConstraints = false
        let content = window.contentView!
        content.addSubview(contentStack)
        NSLayoutConstraint.activate([
            contentStack.topAnchor.constraint(equalTo: content.topAnchor),
            contentStack.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            contentStack.trailingAnchor.constraint(equalTo: content.trailingAnchor),
        ])
        refreshUI()
    }
}

// MARK: - Arranque
if CommandLine.arguments.contains("--probar-config") { exit(probarConfig()) }
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
