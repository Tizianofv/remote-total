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
- `channels[].fader`: posición 1 a 8 dentro del **primer bloque de 8 canales** de esa fila.
- `totalmix.gapMs`: pausa entre órdenes. Si TotalMix se salta movimientos, subir este valor.

## Limitaciones conocidas

- **No está probado con TotalMix real**: las direcciones OSC vienen de foros de RME, no de la tabla oficial.
- Solo llega a los primeros 8 canales de cada fila. Canales más allá requieren cambiar de bloque (pendiente).
- Si "Submix linked to OSC Control" está activo, es probable que la pantalla de TotalMix salte entre mezclas cuando los músicos mueven sus faders.
- El mute de TotalMix es global, por eso aquí solo se controla el volumen.
- Cualquiera conectado a la WiFi del estudio puede abrir la página.
- Los valores que muestra el celular son los últimos enviados desde la página, no los que tiene TotalMix.
