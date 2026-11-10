# remote-total

Prototipo para que cada músico controle **su propia mezcla de audífonos** de RME TotalMix FX desde su celular (Android o iPhone), sin instalar nada: abre una página web en la WiFi del estudio.

Sin configuración de músicos: el programa pregunta a TotalMix qué salidas, entradas y reproducciones existen y cuáles están en uso, y arma los roles y los faders solo.

## Requisitos

- Node.js 18 o superior en la computadora del estudio (Windows o Mac). No hay dependencias que instalar.
- RME TotalMix FX 2.1 con Global OSC activado.

## Configurar TotalMix FX 2.1 (Global OSC)

1. **Options → Settings → OSC**: en una ranura marcar *In Use* y elegir **Global OSC**.
   - *Port incoming* = `7001` y *Port outgoing* = `9001` (los valores por defecto del programa).
   - *Remote Controller Address / IP* = `127.0.0.1`. No dejarlo vacío: según Bitfocus, en Windows TotalMix no envía datos sin una dirección.
   - Activar el envío de nombres si aparece la opción (*Send Channel Names*).
2. Desactivar **Follow Submix** (lo pide la tabla oficial de RME para Global OSC).

## Uso

```
npm start        # conecta con TotalMix y sirve la página
npm run dry      # datos de ejemplo, sin TotalMix (para probar la página)
npm run escuchar # igual que npm start, pero muestra cada mensaje que llega de TotalMix
npm test
```

Al arrancar aparece la dirección, por ejemplo `http://192.168.1.20:8080`. Cada músico la abre en su celular y elige su rol.

## Cómo se eligen los roles y los faders

Al arrancar, el programa envía `/sendall 2` a TotalMix. TotalMix responde con los nombres, los estéreo, la salida principal y las mezclas en uso. Esos mensajes llegan en paquetes OSC con bundles (también anidados), y el programa lee todos los mensajes de cada paquete. Con eso:

**Roles (una pantalla por músico)** = cada salida con nombre propio en TotalMix (ver "Nombre de fábrica" más abajo), excepto:
- la **salida principal** (`/controlroom/mainout`, por ejemplo los monitores de sala) y su pareja derecha si es estéreo;
- las salidas **ocultas** en TotalMix (color 0);
- las salidas **sin nombre** o con **nombre de fábrica**;
- la **pareja derecha** de una salida estéreo (por ejemplo `PH 10` cuando la salida es `PH 9/10`).

El rol muestra el nombre que la salida tiene en TotalMix (por ejemplo "DRUMMER") y su etiqueta de hardware (por ejemplo "PH 9/10"). Las salidas y reproducciones 9–12 se llaman PH; las entradas 9–12 siguen AN.

**Nombre de fábrica** = el nombre que TotalMix pone solo, con forma de etiqueta de hardware: `AN`, `PH`, `AES` o `ADAT`, seguido opcionalmente de un número, de `número/número` o de `L/R` (por ejemplo `AN 4`, `AN 7/8`, `PH 9/10`, `AES`, `ADAT 3/4`). No distingue mayúsculas y tolera espacios. `Analog Synth`, `PHIL`, `ADATA` y `Voz 2` **no** son de fábrica.
Una salida, entrada o reproducción con nombre de fábrica o sin nombre **no aparece en el celular**, y `/api/set` la rechaza. Para que aparezca, cambiarle el nombre en TotalMix.

**Faders de un rol** = **todas** las entradas y reproducciones con nombre propio, estén o no enviadas a esa salida en TotalMix. Reglas:
- Se muestran en el orden de TotalMix: entradas primero, luego reproducciones, por número.
- Cada fader muestra el valor que TotalMix tiene para ese canal en esa salida. Si TotalMix todavía no lo ha enviado, sale vacío; un canal enviado a -∞ sale con el fader en cero.
- Los canales ocultos, los que no tienen nombre propio (sin nombre o de fábrica) y la pareja derecha de un estéreo no se muestran.
- Cada fader muestra el nombre del canal en TotalMix (por ejemplo "MIC 1").
- Cada rol tiene además el **fader de su salida** (campo `master`, por ejemplo "DRUMMER" en "PH 9/10"), con su medidor. Es el fader de la salida misma, no de un canal. Además, el retorno de efectos de esa salida va en `master.fx` (en dB, de -65 a 0; `k: "fx"` en `/api/set`).

Para cambiar qué escucha un músico, se cambia la mezcla en TotalMix. La página se actualiza sola.

Las imágenes sueltas de `public/` (`.jpg`, `.jpeg`, `.png`, `.webp`, `.svg`) se sirven por su nombre, por ejemplo `/logo-cds.webp`. Solo archivos sueltos: sin subcarpetas ni rutas con `..`.

## Opcional: config.json

No hace falta. Solo sirve para cambiar el puerto de la página o las direcciones de TotalMix. Copiar `config.example.json` a `config.json` y editar:

```json
{
  "port": 8080,
  "totalmix": { "host": "127.0.0.1", "port": 7001, "listenPort": 9001 }
}
```

- `port`: puerto de la página para los celulares.
- `totalmix.port`: puerto donde TotalMix recibe (el *Port incoming* de TotalMix).
- `totalmix.listenPort`: puerto donde este programa recibe (el *Port outgoing* de TotalMix).

Los canales cuentan desde 0 como en la tabla de RME (AN 1 = 0, AN 9/10 = 8).

## Ver qué envía TotalMix

`npm run escuchar` muestra cada mensaje que llega de TotalMix (`<- /dirección valor`). Sirve para comprobar nombres, estéreo y canales.

## Limitaciones conocidas

- **Lo que envía TotalMix sí está medido; las órdenes no están probadas con TotalMix real.** La captura de 299 líneas de TotalMix real (10-nov-2026) está en `test/fixtures/captura-real.txt`, y 279 de 279 paquetes llegaron como bundle. Las órdenes que manda el programa siguen la tabla oficial de RME "OSC-Commands TotalMix FX 2.1 beta 2".
- Posiciones medidas en esa captura: AN 1–12 = 0–11, AES = 12, ADAT 1/2 = 14 … ADAT 15/16 = 28.
- Los faders solo se mueven por la página; el mute y el resto de TotalMix no se controlan desde aquí.
- Cualquiera conectado a la WiFi del estudio puede abrir la página.
- Los valores que muestra el celular son los de TotalMix al recibirlos y los últimos enviados desde la página.

## App para Mac

Para quien no quiera usar la terminal: **Remote Total.app** vive en la barra de menú y arranca el puente sola. Solo Mac con Apple Silicon (arm64), macOS 12 o superior. Trae su propio Node: no hace falta instalar Node.

### Generar el instalador

```
bash macos/build.sh
```

Genera en `dist/`: `Remote Total.app`, `Desinstalar Remote Total.app` y `Remote Total.pkg` (el instalador). Hacen falta las Command Line Tools de Xcode (`swiftc`, `pkgbuild`, `productbuild`, `codesign`, `osacompile`) y un Node oficial arm64. Por defecto usa `../node/bin/node`; para otra ruta: `NODE_BIN=/ruta/a/node bash macos/build.sh`.

Los iconos de las apps (`macos/icono/RemoteTotal.icns` y `Desinstalar.icns`) los dibuja `macos/icono/build-icono.sh` con CoreGraphics; `build.sh` lo llama y los copia a cada app.

El instalador **no está firmado** (no hay certificado de desarrollador). Las apps van con firma ad-hoc.

### Instalar

1. Doble clic en `dist/Remote Total.pkg` y seguir los pasos. Pide la contraseña de administrador porque instala en Aplicaciones.
2. La primera vez, macOS avisa que el desarrollador no está identificado. Clic derecho sobre el `.pkg` (o sobre la app) → **Abrir**, y confirmar.
3. Abrir **Remote Total** desde Aplicaciones. No aparece en el Dock: su icono está en la barra de menú (los deslizadores).
4. Si macOS pregunta si Remote Total puede aceptar conexiones de red, permitirlo: los celulares necesitan entrar.

### Usar

- **Icono de la barra**: clic en la dirección principal (por ejemplo `http://192.168.1.20:8080`) la copia al portapapeles. Debajo está el estado: *TotalMix conectado*, *Esperando a TotalMix…* o *Puente detenido*. El icono se pone rojo si TotalMix no responde o si el puente está caído.
- **Mostrar ventana**: abre la ventana con la dirección en grande, un código QR para escanear desde el celular, el estado y un recordatorio de la configuración OSC de TotalMix.
- **Ajustes… (⌘,)**: cambia el puerto de la página, la IP de TotalMix y sus puertos de entrada y salida. Si los valores no son válidos, no guarda y marca el campo. Si son válidos, guarda `config.json` y reinicia el puente. «Valores por defecto» rellena los campos de fábrica sin guardar.
- **Cerrar la ventana no cierra la app**: el puente sigue y la ventana se vuelve a abrir desde el menú.
- **Salir (⌘Q)** cierra la app y **apaga el puente**.
- Si el puerto de la página ya está ocupado (por ejemplo, porque hay otro Remote Total abierto), la ventana y el menú lo dicen. Si el puente se cae, aparece **Reiniciar puente**.

Archivos de la app:
- Configuración: `~/Library/Application Support/Remote Total/config.json` (la escribe Ajustes; si no existe, valores por defecto).
- Registro del puente: `~/Library/Logs/Remote Total/puente.log` (rota al pasar de 512 KB).

### Desinstalar

Doble clic en **Desinstalar Remote Total.app** (en Aplicaciones). Pide confirmación y contraseña de administrador. Cierra la app y el puente, borra la app y su desinstalador de Aplicaciones, borra la configuración y los registros, y olvida el recibo del instalador.

### Notas

- Si la variable de entorno `CONFIG` está definida, el puente usa ese archivo y Ajustes no tiene efecto sobre el arranque.
- Las pruebas de la app se hicieron sin pantalla: el arranque, la página, el registro, SIGTERM, el cambio de puerto por config y el caso de puerto ocupado están comprobados. Los botones y la ventana de Ajustes no se pudieron pulsar: no están comprobados en pantalla.
