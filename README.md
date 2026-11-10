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
- la **pareja derecha** de una salida estéreo (por ejemplo `AN 10` cuando la salida es `AN 9/10`).

El rol muestra el nombre que la salida tiene en TotalMix (por ejemplo "DRUMMER") y su etiqueta de hardware (por ejemplo "AN 9/10").

**Nombre de fábrica** = el nombre que TotalMix pone solo, con forma de etiqueta de hardware: `AN`, `PH`, `AES` o `ADAT`, seguido opcionalmente de un número, de `número/número` o de `L/R` (por ejemplo `AN 4`, `AN 7/8`, `PH 9/10`, `AES`, `ADAT 3/4`). No distingue mayúsculas y tolera espacios. `Analog Synth`, `PHIL`, `ADATA` y `Voz 2` **no** son de fábrica.
Una salida, entrada o reproducción con nombre de fábrica o sin nombre **no aparece en el celular**, y `/api/set` la rechaza. Para que aparezca, cambiarle el nombre en TotalMix.

**Faders de un rol** = las entradas y reproducciones que el ingeniero envió a esa salida en TotalMix (su fader está arriba de -65 dB). Reglas:
- Se muestran en el orden de TotalMix: entradas primero, luego reproducciones.
- Un canal que estuvo activo desde que arrancó el programa **sigue en la lista aunque el músico lo baje a cero**; así no desaparece de la pantalla.
- Los canales ocultos, los que no tienen nombre propio (sin nombre o de fábrica) y la pareja derecha de un estéreo no se muestran.
- Cada fader muestra el nombre del canal en TotalMix (por ejemplo "MIC 1").

Para cambiar qué escucha un músico, se cambia la mezcla en TotalMix. La página se actualiza sola.

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
