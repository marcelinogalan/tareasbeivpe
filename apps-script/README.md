# Apps Script vinculado para tareas

Este proyecto vincula una Google Spreadsheet con Google Tasks. Google Tasks es siempre el origen maestro. La hoja recibe los datos; además, al completar una copia enlazada, el script completa todas las demás copias de esa tarea lógica en Google Tasks.

## Instalación

1. Abre la spreadsheet y ve a **Extensiones → Apps Script**.
2. Sustituye el archivo de código por `Code.js` y activa **Mostrar archivo de manifiesto `appsscript.json`** en la configuración del proyecto. Copia también ese manifiesto.
3. En **Configuración del proyecto → Propiedades de secuencia de comandos**, añade las mismas credenciales OAuth de la instalación anterior: `GOOGLE_TASKS_CLIENT_ID`, `GOOGLE_TASKS_CLIENT_SECRET` y `GOOGLE_TASKS_REFRESH_TOKEN`. Copia sus valores directamente desde el entorno seguro donde se configuraba el servidor; no los pegues en una celda, el código o el chat. El refresh token debe tener el permiso `https://www.googleapis.com/auth/tasks` para que el script pueda propagar finalizaciones a las copias. Si devuelve HTTP 403 al completar copias, genera un refresh token nuevo con ese permiso y actualiza la propiedad.
4. Guarda y ejecuta `setup()`. Acepta los permisos de la spreadsheet y de solicitudes externas. No hace falta autorizar la API de Tasks con la cuenta que ejecuta el Apps Script: las llamadas a Tasks llevan el access token obtenido del refresh token configurado.
5. Ejecuta **Tareas → Comprobar conexión OAuth de Google Tasks** y confirma que aparecen todas las listas esperadas. Esto verifica el token sin escribir tareas.
6. Si la importación inicial todavía no se completó, ejecuta **Tareas → Importar / continuar desde Google Tasks**. Importa todas las tareas de todas las listas, incluidas completadas y eliminadas. Al terminar, activa los disparadores. Si se pausa por tiempo o cuota, vuelve a ejecutar la misma opción: continúa desde la lista y página guardadas. No borres la pestaña `SyncState` durante una importación pausada.
7. Si la importación inicial ya se completó con una versión que solo leía una lista, ejecuta **Tareas → Actualizar todo desde Google Tasks** para incorporar las demás listas.
8. Revisa `Tasks` y `SyncLog`. Usa **Tareas → Actualizar todo desde Google Tasks** para reconstruir la hoja desde el maestro, o **Tareas → Actualizar cambios desde la última sincronización** para traer solo cambios recientes.

## Métodos de actualización

- **Actualizar todo desde Google Tasks** (`syncAllFromGoogleTasks`) pagina todas las listas, actualiza los campos compartidos en `Tasks`, conserva el contexto exclusivo de Sheets y marca como borradas las filas vinculadas que ya no existen en Google Tasks. Reduce las búsquedas repetidas y las escrituras de vínculos, divide la finalización en bloques, guarda el progreso y programa una continuación automática al acercarse al límite de ejecución. Si se alcanza una cuota de Google Tasks, espera al periodo indicado y vuelve a ejecutarse desde el menú.
- **Actualizar cambios desde la última sincronización** (`syncChangesFromGoogleTasks`) consulta todas las listas con `updatedMin` calculado desde el cursor guardado. Usa un margen de diez segundos para cubrir cambios cercanos al cursor. El cursor solo avanza al terminar correctamente.
- Al completar desde Google Tasks una tarea en cualquiera de sus listas, el estado completado se propaga a todas las demás copias enlazadas. La fila lógica de `Tasks` queda en `End`. No se propagan cambios de contenido ni se crean/eliminan tareas.
- El disparador programado ejecuta el método incremental. El método completo queda para ejecución manual y reparación/reconstrucción.
- La importación inicial (`migrateLegacyTasks`) sigue siendo el paso de instalación y debe completarse una vez antes de activar los disparadores.

## Flujo de datos

- La primera ejecución de `migrateLegacyTasks()` usa Google Tasks como único origen de tareas. No crea tareas en Google Tasks ni importa filas de `Actidades` o `TasksMaster`.
- La importación enlaza por `google_tasks_id`. Si ya existe una fila en `Tasks` con ese ID, actualiza sus campos compartidos y conserva sus campos de contexto. No empareja por título para evitar asociar contexto a la tarea equivocada.
- Las filas existentes en `Tasks` sin correspondencia en ninguna lista de Google Tasks se conservan y se marcan `NOT_IN_GOOGLE_TASKS`. Los datos de pestañas antiguas no se copian como contexto durante esta importación.
- Los campos compartidos (`title`, `notes`, `status`, `due_at`, `completed`) siempre se reemplazan con los valores de Google Tasks durante la actualización. Los campos de contexto exclusivos de Sheets se conservan.
- Los cambios de contenido hechos en Sheets no se envían a Google Tasks. Crea y edita las tareas en Google Tasks y luego ejecuta una actualización incremental. Al completar una copia en Google Tasks, el estado completado sí se propaga a las demás copias enlazadas.
- Cada texto entre corchetes en el título de Google Tasks se añade como etiqueta en `tags` (por ejemplo, `[VPE] [Marce] Revisar informe` produce las etiquetas `VPE` y `Marce`). Los corchetes se conservan en el título. Se aceptan varias etiquetas, se deduplican sin distinguir mayúsculas y se preservan las etiquetas manuales de Sheets. La columna auxiliar `google_bracket_tags` permite retirar de `tags` una etiqueta automática cuando se elimina el corchete correspondiente, sin retirar las manuales.
- Una tarea lógica conserva una sola fila en `Tasks`; las copias encontradas en Google Tasks se registran por separado en `GoogleTaskLinks` (task_id, ID/nombre de lista e ID de tarea). Si una etiqueta entre corchetes coincide con el nombre de una lista existente, la hoja conserva el vínculo de cada copia. El script solo propaga el estado completado del origen a las copias etiquetadas; no crea ni elimina tareas ni sincroniza desde Sheets hacia Google Tasks.
- Si una tarea se elimina en Google Tasks, la fila correspondiente se conserva con `deleted=TRUE`.
- `description`, `next_steps`, `tags`, `assignee`, `origin`, `country`, `workstream` y `scope` no tienen equivalentes estructurados en Google Tasks y permanecen como contexto adicional de Sheets. La API de Google Tasks no proporciona fecha de creación; `created_at` queda vacío para nuevas filas si no había un valor previo.
- El ciclo programado consulta incrementalmente todas las listas de Google Tasks. Guarda checkpoint por lista y página; si pausa por tiempo o cuota, puede reanudarse. El consumo de API depende de las páginas que contienen cambios desde el cursor.
- Usa **Tareas → Actualizar todo desde Google Tasks** para volver a leer todas las páginas y reconstruir el estado de la hoja. El proceso registra los vínculos en `GoogleTaskLinks`.
- Una versión previa insertó casillas hasta el final de la hoja y, por un índice de columna incorrecto, pudo dejar `FALSE` en `google_tasks_etag`. Usa **Tareas → Reparar filas vacías de Tasks** para retirar esos valores aislados sin eliminar filas con datos.
- La actualización completa deja margen frente al límite de Apps Script, guarda la lista y página procesadas y también finaliza las filas en bloques. Si queda trabajo pendiente por tiempo, un disparador temporal la reanuda automáticamente. Ante límites temporales de tasa, aplica reintentos con espera exponencial y guarda el checkpoint; una cuota diaria pausa el proceso durante seis horas.

## Límites

El código fuente está preparado, pero no puede adjuntarse ni configurarse en una cuenta de Google desde este entorno. La instalación requiere abrir la spreadsheet y guardar allí las credenciales OAuth existentes. El access token se almacena temporalmente en la caché del script; client secret y refresh token permanecen en Propiedades del script. Limita quién puede editar el proyecto porque sus editores podrían modificar código que lea esas propiedades. Las cuotas de Google Tasks pueden cambiar; consulta los límites vigentes en https://developers.google.com/workspace/tasks/limits.
