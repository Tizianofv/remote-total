# Reglas de la sala

## Forma de trabajo
- El agente principal **solo organiza y orquesta**: divide el trabajo, escribe las instrucciones, revisa resultados e integra. No hace el trabajo él mismo.
- Todo el trabajo (investigar, programar, probar, maquetar) se **delega a agentes**.
- Los agentes **siempre usan el modelo Haiku** (`model: "haiku"` en la herramienta Agent).
- Lanzar en paralelo los trabajos que no dependen entre sí.
- Cada encargo a un agente dice: objetivo, archivos involucrados, qué ya se descartó y cómo se ve "terminado".
- Antes de dar algo por bueno, el orquestador verifica lo que devuelve el agente (pruebas, captura o lectura del cambio).

## Proyecto
- Puente celular → RME TotalMix FX 2.1 (Fireface UFX original) por **Global OSC**: `server.js`, `osc.js`, `ufx.js`, `public/`.
- Pruebas: `npm test`. Prueba sin TotalMix: `npm run dry`. Ver lo que envía TotalMix: `npm run escuchar`.
- Fuente de las órdenes OSC: tabla oficial de RME "OSC-Commands TotalMix FX 2.1 beta 2". Canales cuentan desde 0 (AN 1 = 0, AN 9/10 = 8).
- Estudio: in-ears mono en AN 1–6 y ADAT; audífonos estéreo en PH 9/10 y PH 11/12; monitores de sala en AN 7/8.
- Respuestas al usuario en español, cortas, distinguiendo hecho / inferencia / especulación.
