#!/usr/bin/env bash
# Genera en dist/: "Remote Total.app", "Desinstalar Remote Total.app" y "Remote Total.pkg".
# Sin dependencias de npm. Necesita Xcode Command Line Tools (swiftc, pkgbuild, productbuild,
# codesign, osacompile) y un Node oficial para arm64 (por defecto ../node/bin/node; otra ruta: NODE_BIN=...).
# No instala nada en el sistema ni escribe fuera de dist/.
set -euo pipefail

MACOS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$MACOS_DIR/.." && pwd)"
NODE_BIN="${NODE_BIN:-$ROOT/../node/bin/node}"
DIST="$ROOT/dist"
APP="$DIST/Remote Total.app"
UNINSTALL="$DIST/Desinstalar Remote Total.app"
PKG="$DIST/Remote Total.pkg"
WORK="$DIST/.trabajo"

[ -x "$NODE_BIN" ] || { echo "No encuentro node en: $NODE_BIN (pon NODE_BIN=/ruta/a/node)" >&2; exit 1; }
file -b "$NODE_BIN" | grep -q arm64 || { echo "El node de $NODE_BIN no es arm64" >&2; exit 1; }
VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$ROOT/package.json" | head -n 1)"
[ -n "$VERSION" ] || { echo "No pude leer la versión de package.json" >&2; exit 1; }
echo "==> Remote Total $VERSION con $("$NODE_BIN" -v) ($NODE_BIN)"

rm -rf "$DIST"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/node" "$APP/Contents/Resources/app" "$WORK"

echo "==> Compilando el ejecutable Swift (arm64, macOS 12+)"
xcrun swiftc -O -swift-version 5 -target arm64-apple-macos12.0 \
  -o "$APP/Contents/MacOS/RemoteTotal" "$MACOS_DIR/src/main.swift"

echo "==> Copiando el puente (server.js, osc.js, ufx.js, package.json, public/)"
cp "$ROOT/server.js" "$ROOT/osc.js" "$ROOT/ufx.js" "$ROOT/package.json" "$APP/Contents/Resources/app/"
cp -R "$ROOT/public" "$APP/Contents/Resources/app/"

echo "==> Copiando node"
cp "$NODE_BIN" "$APP/Contents/Resources/node/node"
chmod 755 "$APP/Contents/Resources/node/node" "$APP/Contents/MacOS/RemoteTotal"

echo "==> Info.plist"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>es</string>
  <key>CFBundleExecutable</key><string>RemoteTotal</string>
  <key>CFBundleIdentifier</key><string>do.caribbeandream.remotetotal</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>Remote Total</string>
  <key>CFBundleDisplayName</key><string>Remote Total</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSApplicationCategoryType</key><string>public.app-category.music</string>
  <key>NSLocalNetworkUsageDescription</key><string>Remote Total necesita la red local para que los celulares del estudio se conecten a la mezcla de TotalMix.</string>
</dict>
</plist>
PLIST
printf 'APPL????' > "$APP/Contents/PkgInfo"

echo "==> Firma ad-hoc (node, luego la app)"
codesign --force --sign - "$APP/Contents/Resources/node/node"
codesign --force --sign - "$APP"
codesign --verify --deep --strict "$APP"

echo "==> Desinstalador"
osacompile -o "$UNINSTALL" "$MACOS_DIR/installer/desinstalar.applescript"
# osacompile no pone identificador ni versión mínima moderna: sin CFBundleIdentifier pkgbuild no lo toma como app.
/usr/libexec/PlistBuddy -c "Add :CFBundleIdentifier string do.caribbeandream.remotetotal.desinstalar" \
  -c "Add :LSMinimumSystemVersion string 12.0" "$UNINSTALL/Contents/Info.plist"
codesign --force --sign - "$UNINSTALL"

echo "==> Instalador (.pkg)"
RAIZ="$WORK/raiz"
mkdir -p "$RAIZ"
cp -R "$APP" "$RAIZ/"
cp -R "$UNINSTALL" "$RAIZ/"

# Componente: las dos apps van a /Applications; no se "reubican" ni se pisa otra copia encontrada en el disco.
cat > "$WORK/componente.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<array>
  <dict>
    <key>RootRelativeBundlePath</key><string>Remote Total.app</string>
    <key>BundleIsRelocatable</key><false/>
    <key>BundleIsVersionChecked</key><false/>
    <key>BundleHasStrictIdentifier</key><false/>
    <key>BundleOverwriteAction</key><string>upgrade</string>
  </dict>
  <dict>
    <key>RootRelativeBundlePath</key><string>Desinstalar Remote Total.app</string>
    <key>BundleIsRelocatable</key><false/>
    <key>BundleIsVersionChecked</key><false/>
    <key>BundleHasStrictIdentifier</key><false/>
    <key>BundleOverwriteAction</key><string>upgrade</string>
  </dict>
</array>
</plist>
PLIST

pkgbuild --root "$RAIZ" --component-plist "$WORK/componente.plist" \
  --identifier do.caribbeandream.remotetotal --version "$VERSION" \
  --install-location /Applications --ownership recommended \
  "$WORK/RemoteTotal-componente.pkg"

cat > "$WORK/distribution.xml" <<XML
<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
  <title>Remote Total</title>
  <welcome file="bienvenida.html" mime-type="text/html"/>
  <conclusion file="conclusion.html" mime-type="text/html"/>
  <options customize="never" require-scripts="false" hostArchitectures="arm64"/>
  <domains enable_localSystem="true"/>
  <choices-outline>
    <line choice="remotetotal"/>
  </choices-outline>
  <choice id="remotetotal" title="Remote Total" description="Remote Total y su desinstalador en Aplicaciones." start_selected="true">
    <pkg-ref id="do.caribbeandream.remotetotal"/>
  </choice>
  <pkg-ref id="do.caribbeandream.remotetotal" version="$VERSION" auth="Root">RemoteTotal-componente.pkg</pkg-ref>
</installer-gui-script>
XML

productbuild --distribution "$WORK/distribution.xml" --resources "$MACOS_DIR/installer" \
  --package-path "$WORK" "$PKG"

rm -rf "$WORK"
echo "==> Listo en $DIST"
ls -lh "$DIST"
du -sh "$APP" "$UNINSTALL" "$PKG"
