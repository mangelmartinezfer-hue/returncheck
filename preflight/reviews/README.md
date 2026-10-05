# Revisiones de entregas

`npm run review:prepare -- preflight/jobs/nombre.json` crea un borrador
UNRESOLVED, nunca una aprobación. Completar después de revisar realmente fuentes,
afirmaciones y límites. El archivo se corresponde con la misma ruta en jobs.

Cada advertencia/campo dudoso exige VERIFIED o ACCEPTED_LIMITATION y una razón.
Una aprobación queda invalidada si cambia el manifiesto, evidencia o código del
validador/runtime inspeccionado. No editar binding a mano para ocultar cambios:
volver a revisar y preparar una nueva revisión conservando la anterior en Git.

Este recibo no autentica al revisor ni sustituye la revisión de la PR. No concede
autorización de pago, despliegue o fusión. Los perfiles base siguen siendo controles
técnicos históricos, no entregas aprobadas.
