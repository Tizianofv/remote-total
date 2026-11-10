#!/usr/bin/env bash
# Regenera RemoteTotal.icns (app) y Desinstalar.icns (desinstalador) desde crear-icono.swift.
# Sin dependencias externas: swiftc + iconutil. Deja los .icns en esta carpeta; build.sh los copia.
set -euo pipefail

ICONO="$(cd "$(dirname "$0")" && pwd)"
TRABAJO="$ICONO/.trabajo"
rm -rf "$TRABAJO"
mkdir -p "$TRABAJO"

xcrun swiftc -O -swift-version 5 -o "$TRABAJO/crear-icono" "$ICONO/crear-icono.swift"

for variante in app desinstalar; do
  if [ "$variante" = app ]; then base=RemoteTotal; else base=Desinstalar; fi
  "$TRABAJO/crear-icono" "$TRABAJO/$base.iconset" "$variante"
  iconutil -c icns "$TRABAJO/$base.iconset" -o "$ICONO/$base.icns"
done

rm -rf "$TRABAJO"
ls -l "$ICONO"/*.icns
