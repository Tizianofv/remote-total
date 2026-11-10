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

Al arrancar, el programa envía `/sendall 2` a TotalMix. TotalMix responde con los nombres, los estéreo, la salida principal y las mezclas en uso. Con eso:

**Roles (una pantalla por músico)** = cada salida con nombre en TotalMix, excepto:
- la **salida principal** (`/controlroom/mainout`, por ejemplo los monitores de sala) y su pareja derecha si es estéreo;
- las salidas **ocultas** en TotalMix (color 0);
- la **pareja derecha** de una salida estéreo (por ejemplo `AN 10` cuando la salida es `AN 9/10`).

El rol muestra el nombre que la salida tiene en TotalMix (por ejemplo "DRUMMER") y su etiqueta de hardware (por ejemplo "AN 9/10").

**Faders de un rol** = las entradas y reproducciones que el ingeniero envió a esa salida en TotalMix (su fader está arriba de -65 dB). Reglas:
- Se muestran en el orden de TotalMix: entradas primero, luego reproducciones.
- Un canal que estuvo activo desde que arrancó el programa **sigue en la lista aunque el músico lo baje a cero**; así no desaparece de la pantalla.
- Los canales ocultos y la pareja derecha de un estéreo no se muestran.
- Cada fader muestra el nombre del canal en TotalMix (por ejemplo "MIC 1"); si no tiene nombre, su etiqueta de hardware.

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

`npm run escuchar` muestra cada mensaje que llega de TotalMix (`<- /dirección valor`). Sirve para comprobar nombres, estéreo y canales (por ejemplo, para confirmar la posición de AES y ADAT).

## Limitaciones conocidas

- **No está probado con TotalMix real.** Las órdenes siguen la tabla oficial de RME "OSC-Commands TotalMix FX 2.1 beta 2".
- Las posiciones de AES y ADAT (después de AN 12) son una suposición; `npm run escuchar` muestra los nombres reales por número.
- Los faders solo se mueven por la página; el mute y el resto de TotalMix no se controlan desde aquí.
- Cualquiera conectado a la WiFi del estudio puede abrir la página.
- Los valores que muestra el celular son los de TotalMix al recibirlos y los últimos enviados desde la página.
