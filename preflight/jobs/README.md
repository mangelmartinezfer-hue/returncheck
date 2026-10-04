# Trabajos registrados

Todos los JSON de esta carpeta (incluidas subcarpetas) se validan automáticamente
con `npm test`, `npm run validate`, `npm run check` y GitHub Actions.

Crear: `npm run work:new -- ucp nombre-del-trabajo` (o payment, corpus, artifact).
Completar después el manifiesto según `../README.md`. Una plantilla vacía falla;
crear el archivo no equivale a aprobar el trabajo. No sobrescribe trabajos.

Registrar aquí únicamente entregas públicas/versionables. Archivos privados y
firmas permanecen en `_local/` y se validan explícitamente, sin subirlos a GitHub.
No colocar datos sueltos aquí: cada JSON debe ser un manifiesto con `profile`.
No se admiten enlaces simbólicos ni extensiones distintas de .json (salvo este
README.md). Para lotes relacionados de corpus, usar un manifiesto conjunto.
