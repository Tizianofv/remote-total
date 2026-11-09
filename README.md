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

## Configurar TotalMix FX (sin probar todavía)

1. **Options → Settings → OSC**: en una ranura marcar *In Use* y *Enable OSC Control*. Anotar el **Port incoming** (normalmente 7001). La IP del controlador remoto es `127.0.0.1` si el programa corre en la misma computadora.
2. **Options**: activar **"Submix linked to OSC Control"**. Según el foro de RME, sin esto `/setSubmix` no funciona.

## Uso

```
cp config.example.json config.json   # editar músicos, mezclas y canales
npm start                            # o: npm run dry  (solo muestra lo que enviaría)
```

En la consola aparece la dirección, por ejemplo `http://192.168.1.20:8080`. Cada músico la abre en su celular y elige su nombre (o va directo con `?m=voz`).

### config.json

- `totalmix.port`: el *Port incoming* de TotalMix.
- `musicians[].submix`: número de la salida de la mezcla, **contando desde 0 y en mono** (según el foro de RME). Ejemplo: la salida estéreo 3/4 sería `2`.
- `channels[].bus`: `input` (entradas de la interfaz) o `playback` (salidas del DAW).
- `channels[].fader`: posición del canal dentro del primer bloque de esa fila (1 a 16). Para llegar a AN 1–12 sin cambiar de bloque, en TotalMix (Settings → OSC) poner **Faders per bank** en 16 (sin probar; ver abajo).
- `totalmix.gapMs`: pausa entre órdenes. Si TotalMix se salta movimientos, subir este valor.

## Ver qué envía TotalMix

En TotalMix (Settings → OSC) poner **Port outgoing** = `9001` (igual a `totalmix.listenPort`) y correr:

```
npm run escuchar
```

La consola muestra cada mensaje que llega de TotalMix (`<- /dirección valor`). Sirve para comprobar si TotalMix envía los nombres de canales y mezclas (por ejemplo `/1/trackname1` o `/1/labelSubmix`, según el foro de RME).

## Limitaciones conocidas

- **No está probado con TotalMix real**: las direcciones OSC vienen de foros de RME, no de la tabla oficial.
- Solo llega al primer bloque de cada fila (hasta 16 canales si *Faders per bank* = 16). No está probado que `/1/volume9`–`/1/volume12` funcionen así.
- Alternativa: TotalMix FX 2.1 trae *Global OSC*, que maneja cada entrada en cada mezcla directo, sin bloques ni cambiar de mezcla. Falta confirmar que esté disponible para la Fireface UFX original.
- Si "Submix linked to OSC Control" está activo, es probable que la pantalla de TotalMix salte entre mezclas cuando los músicos mueven sus faders.
- El mute de TotalMix es global, por eso aquí solo se controla el volumen.
- Cualquiera conectado a la WiFi del estudio puede abrir la página.
- Los valores que muestra el celular son los últimos enviados desde la página, no los que tiene TotalMix.
