# remote-total

Prototipo para que cada músico controle **su propia mezcla de audífonos** de RME TotalMix FX desde su celular (Android o iPhone), sin instalar nada: abre una página web en la WiFi del estudio.

## Por qué así

TotalMix FX acepta como máximo **4 controladores OSC** a la vez. Este programa ocupa **una sola** de esas ranuras y atiende a todos los celulares (6, 8 o más). Las órdenes se envían de a una, en fila:

1. `/setSubmix` → elige la mezcla (salida) del músico
2. `/1/busInput` o `/1/busPlayback` → elige la fila de canales
3. `/1/volumeN` → mueve el fader

## Requisitos

- Node.js 18 o superior en la computadora del estudio (Windows o Mac). No hay dependencias que instalar.
- TotalMix FX con OSC activado.

## Configurar TotalMix FX 2.1 (Global OSC)

1. **Options → Settings → OSC**: en una ranura marcar *In Use* y elegir **Global OSC**.
   - *Port incoming* = `7001` (igual a `totalmix.port`) y *Port outgoing* = `9001` (igual a `totalmix.listenPort`).
   - *Remote Controller Address / IP* = `127.0.0.1`. No dejarlo vacío: según Bitfocus, en Windows TotalMix no envía datos sin una dirección.
   - Activar el envío de nombres si aparece la opción (*Send Channel Names*).
2. Desactivar **Follow Submix** (lo pide la tabla oficial de RME para Global OSC).

## Uso

```
cp config.example.json config.json   # editar roles, salidas y faders
npm start                            # o: npm run dry  (solo muestra lo que enviaría)
```

En la consola aparece la dirección, por ejemplo `http://192.168.1.20:8080`. Cada músico la abre en su celular y elige su rol.

### config.json (modo global)

- `output`: salida de la mezcla del rol, por nombre: `"AN 1"`, `"AN 9/10"`, `"ADAT 3"`.
- `channels[]`: `{ "label": "Yo", "input": "AN 9" }` para entradas, `{ "label": "Pista", "playback": "AN 1/2" }` para reproducciones del DAW.
- `useTotalMixNames`: si es `true`, el rol muestra el nombre que la salida tiene en TotalMix (por ejemplo "DRUMMER").
- `mode`: `"global"` (TotalMix 2.1+) o `"classic"` (TotalMix 1.x, ver historial del repo).

Las órdenes son `/mix/in/<entrada>/<salida>/faderlin` con valor 0..1, contando desde 0 (AN 1 = 0, AN 9/10 = 8). Fuente: tabla "OSC-Commands TotalMix FX 2.1 beta 2" de RME.

## Ver qué envía TotalMix

En TotalMix (Settings → OSC) poner **Port outgoing** = `9001` (igual a `totalmix.listenPort`) y correr:

```
npm run escuchar
```

La consola muestra cada mensaje que llega de TotalMix (`<- /dirección valor`). Sirve para comprobar si TotalMix envía los nombres de canales y mezclas (por ejemplo `/1/trackname1` o `/1/labelSubmix`, según el foro de RME).

## Limitaciones conocidas

- **No está probado con TotalMix real.** El modo global usa la tabla oficial de RME (versión beta 2); el clásico, direcciones de foros.
- Las posiciones de AES y ADAT (después de AN 12) son una suposición; `npm run escuchar` muestra los nombres reales por número.
- Solo llega al primer bloque de cada fila (hasta 16 canales si *Faders per bank* = 16). No está probado que `/1/volume9`–`/1/volume12` funcionen así.
- Alternativa: TotalMix FX 2.1 trae *Global OSC*, que maneja cada entrada en cada mezcla directo, sin bloques ni cambiar de mezcla. Falta confirmar que esté disponible para la Fireface UFX original.
- Si "Submix linked to OSC Control" está activo, es probable que la pantalla de TotalMix salte entre mezclas cuando los músicos mueven sus faders.
- El mute de TotalMix es global, por eso aquí solo se controla el volumen.
- Cualquiera conectado a la WiFi del estudio puede abrir la página.
- Los valores que muestra el celular son los últimos enviados desde la página, no los que tiene TotalMix.
