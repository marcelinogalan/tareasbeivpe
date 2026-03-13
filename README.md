# Todo App Skeleton

Esqueleto inicial de una app de tareas simple con Next.js + TypeScript.

## Scripts

- `npm install`
- `npm run dev`
- `npm run typecheck`
- `npm run desktop:dev` (abre Electron y levanta el servidor automaticamente)
- `npm run desktop:build` (genera `.app/.dmg` para macOS)

## Arquitectura de datos (offline-first)

La API ahora usa almacenamiento local persistente en archivo JSON (`.data/tasks-db.json`) para funcionar sin red.

Variables opcionales:

- `TASKS_LOCAL_DB_PATH`: ruta alternativa para la base local
- `TASKS_SYNC_REMOTE=google`: activa sincronizacion remota con Google Sheets

Con `TASKS_SYNC_REMOTE` desactivado, la app funciona 100% offline.

### Meta-store tecnico en Google Sheets (tabs auxiliares)

Soportado por el modulo:

- `src/lib/tasks/sheets-meta-store.ts`

Tabs por defecto:

- `meta_sync_state`
- `meta_processed_events`
- `meta_task_mapping`

Puedes cambiarlos con:

- `GOOGLE_SHEETS_META_SYNC_STATE_SHEET`
- `GOOGLE_SHEETS_META_PROCESSED_EVENTS_SHEET`
- `GOOGLE_SHEETS_META_TASK_MAPPING_SHEET`

### Sync incremental Google Tasks -> Sheet

Endpoint manual:

- `POST /api/sync/google-tasks/pull`

Requisitos de entorno:

- `GOOGLE_TASKS_CLIENT_ID`
- `GOOGLE_TASKS_CLIENT_SECRET`
- `GOOGLE_TASKS_REFRESH_TOKEN`
- `GOOGLE_TASKS_TASKLIST_ID` (opcional, por defecto `@default`)
- `GOOGLE_TASKS_SCOPE_ID` (opcional, por defecto `default`)

Persistencia de cursor/idempotencia:

- `meta_sync_state` (cursor incremental)
- `meta_processed_events` (eventos ya procesados)
- `meta_task_mapping` (enlace `task_uuid` <-> `google_tasks_id`)

### Endpoints de sync

- `GET /api/tasks/sync`: estado de sincronizacion y cola pendiente
- `POST /api/tasks/sync`: fuerza un intento de sincronizacion

## Google Sheets (sincronizacion opcional)

Si activas `TASKS_SYNC_REMOTE=google`, la app intentara sincronizar con Google Sheets.

1. Crea un Service Account en Google Cloud con acceso a Sheets API.
2. Comparte la hoja con el email del Service Account (permiso Editor).
3. Copia `.env.example` a `.env.local` y completa las credenciales.

Variables requeridas:

- `GOOGLE_SHEETS_SPREADSHEET_ID`
- `GOOGLE_SHEETS_SHEET_NAME` (en tu caso: `Actidades`)
- `GOOGLE_SERVICE_ACCOUNT_EMAIL`
- `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` (con `\\n` escapados)

## Estructura

- `src/pages/index.tsx`: pantalla principal
- `src/components/*`: componentes pequenos de UI
- `src/pages/api/tasks/*`: rutas API (`GET`, `POST`, `PATCH`, `DELETE`)
- `public/manifest.webmanifest` y `public/sw.js`: base PWA para instalacion en Android
- `src/lib/tasks-store.ts`: servicio de tareas local-first + sincronizacion
- `src/lib/tasks/local-file-repository.ts`: persistencia local y cola de operaciones pendientes
- `src/lib/tasks/google-sheets-repository.ts`: adaptador remoto Google Sheets
- `src/pages/api/tasks/sync.ts`: estado/sync manual (`GET`/`POST`)
- `electron/main.cjs`: proceso principal de Electron (arranca servidor + ventana)
- `scripts/prepare-electron.cjs`: prepara el bundle standalone de Next para empaquetado

## Desktop (macOS)

Flujo recomendado:

1. `npm install`
2. `npm run desktop:build`

Salida de build:

- `dist-desktop/*.dmg`
- `dist-desktop/mac/*.app`

Al abrir la app, Electron inicia el servidor interno de Next y carga la UI automaticamente.

## PWA (Android)

La app incluye `manifest` + `service worker` y modo local en cliente para uso cuando la API no esta disponible.

Prueba recomendada:

1. Arranca en produccion: `npm run build && npm run start`
2. Abre desde Android en Chrome (misma URL accesible)
3. Menu de Chrome > `Instalar aplicacion` / `Añadir a pantalla de inicio`

Comportamiento:

- Con backend disponible: usa API y sincronizacion normal.
- Sin backend: entra en `modo local PWA` y guarda/edita tareas en almacenamiento local del navegador.

### Modo directo a Google Sheets desde cliente (inseguro)

Solo para pruebas, puedes activar conexion directa desde el navegador/PWA:

- `NEXT_PUBLIC_DIRECT_SHEETS_ENABLED=true`
- `NEXT_PUBLIC_GOOGLE_SHEETS_SPREADSHEET_ID=...`
- `NEXT_PUBLIC_GOOGLE_SERVICE_ACCOUNT_EMAIL=...`
- `NEXT_PUBLIC_GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY=\"...\"`

Esto expone credenciales en frontend y no es recomendable para produccion.
