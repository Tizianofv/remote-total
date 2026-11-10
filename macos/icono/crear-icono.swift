// Dibuja los PNG del iconset de Remote Total con CoreGraphics (vectorial, cada tamaño se dibuja de nuevo).
// Uso: crear-icono <carpeta.iconset> <app|desinstalar>
// Motivo: audífonos (diadema y dos copas) con tres faders de consola. Sin logo ni nombres de marcas ajenas.
// Colores: fondo azul noche #05080d con degradado; acento rojo #eb2028 (medido en public/logo-cds.webp).
import Foundation
import CoreGraphics
import ImageIO

let outDir = CommandLine.arguments[1]
let variante = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : "app"

func gris(_ v: CGFloat) -> CGColor { CGColor(red: v / 255, green: v / 255, blue: v / 255, alpha: 1) }
func color(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat, _ a: CGFloat = 1) -> CGColor {
    CGColor(red: r / 255, green: g / 255, blue: b / 255, alpha: a)
}
let rojo = color(0xeb, 0x20, 0x28)

// Dibuja sobre un lienzo de 1024 unidades con el eje Y hacia abajo (como el diseño).
func dibujar(_ ctx: CGContext, px: Int) {
    let detalle = px >= 128
    let conFaders = px >= 64
    // Forma de macOS: cuadro de 824 con esquinas de 22.5 % (margen de 100 a cada lado).
    let caja = CGRect(x: 100, y: 100, width: 824, height: 824)
    let forma = CGPath(roundedRect: caja, cornerWidth: 824 * 0.225, cornerHeight: 824 * 0.225, transform: nil)
    ctx.saveGState()
    ctx.addPath(forma)
    ctx.clip()
    let cs = CGColorSpaceCreateDeviceRGB()
    let degradado = CGGradient(colorsSpace: cs,
                               colors: [color(20, 28, 40), color(5, 8, 13)] as CFArray,
                               locations: [0, 1])!
    ctx.drawLinearGradient(degradado, start: CGPoint(x: 512, y: 100), end: CGPoint(x: 512, y: 924), options: [])

    // Diadema: arco superior, grosor 44, color #cacaca.
    let centro = CGPoint(x: 512, y: 470)
    ctx.setStrokeColor(gris(0xca))
    ctx.setLineWidth(44)
    ctx.setLineCap(.round)
    ctx.addArc(center: centro, radius: 300, startAngle: .pi, endAngle: 2 * .pi, clockwise: false)
    ctx.strokePath()

    // Copas: rectángulos redondeados rojos con almohadilla oscura.
    for x in [147.0, 765.0] as [CGFloat] {
        let copa = CGRect(x: x, y: 465, width: 130, height: 190)
        ctx.setFillColor(rojo)
        ctx.addPath(CGPath(roundedRect: copa, cornerWidth: 46, cornerHeight: 46, transform: nil))
        ctx.fillPath()
        let almohadilla = copa.insetBy(dx: 24, dy: 26)
        ctx.setFillColor(color(12, 16, 24))
        ctx.addPath(CGPath(roundedRect: almohadilla, cornerWidth: 30, cornerHeight: 30, transform: nil))
        ctx.fillPath()
    }


    // Ondas del estudio: 8 barras rojas redondeadas, medidas en public/logo-cds.webp.
    // Centro x (px del logo), alto (px del logo); ancho 16 px; el centro vertical es común.
    let barrasLogo: [(CGFloat, CGFloat)] = [(7.4, 16), (53.4, 31), (99.4, 62), (145.4, 110),
                                            (191.0, 78), (236.5, 110), (282.5, 70), (328.5, 42)]
    let escalaOndas: CGFloat = 1.3          // 1 px del logo = 1.3 unidades del icono
    let centroOndasX: CGFloat = 512, centroOndasY: CGFloat = 420
    let anchoLogoCentro: CGFloat = 169.2     // centro medio de las barras en el logo
    // En tamaños chicos la barra se engrosa para que siga viéndose (la separación se mantiene).
    let engrosar: CGFloat = px <= 32 ? 2.2 : 1.0
    ctx.setFillColor(rojo)
    for (cx, alto) in barrasLogo {
        let ancho = 16 * escalaOndas * engrosar
        let x = centroOndasX + (cx - anchoLogoCentro) * escalaOndas - ancho / 2
        let h = alto * escalaOndas
        let barra = CGRect(x: x, y: centroOndasY - h / 2, width: ancho, height: h)
        ctx.addPath(CGPath(roundedRect: barra, cornerWidth: ancho / 2, cornerHeight: ancho / 2, transform: nil))
        ctx.fillPath()
    }

    // Tres faders de consola: rieles oscuros y capuchones gris claro con estrías (no en 16 y 32 px).
    if conFaders {
    let xs: [CGFloat] = [430, 512, 594]
    let alturas: [CGFloat] = [650, 610, 690]
    for (x, y) in zip(xs, alturas) {
        let riel = CGRect(x: x - 5, y: 580, width: 10, height: 230)
        ctx.setFillColor(color(28, 37, 48))
        ctx.addPath(CGPath(roundedRect: riel, cornerWidth: 5, cornerHeight: 5, transform: nil))
        ctx.fillPath()

        let capuchon = CGRect(x: x - 40, y: y - 30, width: 80, height: 60)
        let trazo = CGPath(roundedRect: capuchon, cornerWidth: 10, cornerHeight: 10, transform: nil)
        ctx.saveGState()
        ctx.addPath(trazo)
        ctx.clip()
        let capDeg = CGGradient(colorsSpace: cs, colors: [gris(0xca), gris(0xa4)] as CFArray, locations: [0, 1])!
        ctx.drawLinearGradient(capDeg, start: CGPoint(x: x, y: y - 30), end: CGPoint(x: x, y: y + 30), options: [])
        if detalle {
            ctx.setFillColor(gris(0x44))
            for dy in [-18.0, 0.0, 18.0] as [CGFloat] {
                ctx.fill(CGRect(x: x - 40, y: y + dy - 2, width: 80, height: 4))
            }
        }
        ctx.restoreGState()
    }
    }
    ctx.restoreGState()

    // Marca de quitar (solo desinstalador): círculo rojo con un signo menos blanco.
    if variante == "desinstalar" {
        let c = CGPoint(x: 770, y: 790)
        ctx.setFillColor(color(12, 16, 24))
        ctx.fillEllipse(in: CGRect(x: c.x - 112, y: c.y - 112, width: 224, height: 224))
        ctx.setFillColor(rojo)
        ctx.fillEllipse(in: CGRect(x: c.x - 100, y: c.y - 100, width: 200, height: 200))
        ctx.setFillColor(gris(255))
        ctx.addPath(CGPath(roundedRect: CGRect(x: c.x - 55, y: c.y - 14, width: 110, height: 28),
                           cornerWidth: 8, cornerHeight: 8, transform: nil))
        ctx.fillPath()
    }
}

// Tamaños del iconset: nombre y píxeles.
let tamanos: [(String, Int)] = [
    ("icon_16x16.png", 16), ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32), ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128), ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256), ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512), ("icon_512x512@2x.png", 1024),
]

try? FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)
for (nombre, px) in tamanos {
    let ctx = CGContext(data: nil, width: px, height: px, bitsPerComponent: 8, bytesPerRow: 0,
                        space: CGColorSpaceCreateDeviceRGB(),
                        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.clear(CGRect(x: 0, y: 0, width: px, height: px))
    let k = CGFloat(px) / 1024
    ctx.translateBy(x: 0, y: CGFloat(px))
    ctx.scaleBy(x: k, y: -k)
    dibujar(ctx, px: px)
    let url = URL(fileURLWithPath: outDir + "/" + nombre) as CFURL
    let destino = CGImageDestinationCreateWithURL(url, "public.png" as CFString, 1, nil)!
    CGImageDestinationAddImage(destino, ctx.makeImage()!, nil)
    guard CGImageDestinationFinalize(destino) else {
        print("No pude escribir \(nombre)")
        exit(1)
    }
}
print("iconset \(variante): \(tamanos.count) PNG en \(outDir)")
