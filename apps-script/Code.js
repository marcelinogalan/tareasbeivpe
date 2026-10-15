/**
 * Synchronización de tareas ligada a la spreadsheet.
 * Google Tasks es el maestro. Primera instalación: ejecutar setup() y después
 * migrateLegacyTasks() para importar el catálogo completo desde Google Tasks.
 */
const CFG = Object.freeze({
  TASKS_SHEET: "Tasks",
  STATE_SHEET: "SyncState",
  LOG_SHEET: "SyncLog",
  LINKS_SHEET: "GoogleTaskLinks",
  LINKS_HEADERS: ["task_id", "list_id", "list_title", "google_tasks_id", "google_tasks_etag", "managed_by_tag", "completion_propagated_updated"],
  PULL_MINUTES: 15,
  // Leave a buffer for slow Tasks API calls and spreadsheet writes before
  // Apps Script's hard execution limit terminates the invocation.
  MAX_RUN_MS: 90000,
  MAX_FULL_PAGES_PER_RUN: 1,
  FULL_PAGE_SIZE: 100,
  MAX_API_RETRIES: 4,
  HEADERS: [
    "task_id", "title", "description", "next_steps", "notes", "status",
    "urgency", "due_at", "tags", "assignee", "origin", "country",
    "workstream", "scope", "created_at", "updated_at", "completed",
    "source", "google_tasks_id", "google_tasks_etag", "sync_to_google",
    "sheet_sync_hash", "google_sync_hash", "last_synced_at", "conflict_flag",
    "conflict_note", "deleted", "google_bracket_tags"
  ]
});
var GOOGLE_TASK_LISTS_CACHE_ = null;

function onOpen() {
  SpreadsheetApp.getUi().createMenu("Tareas")
    .addItem("Preparar estructura", "setup")
    .addItem("Reparar filas vacías de Tasks", "compactTasksSheet")
    .addItem("Importar / continuar desde Google Tasks", "migrateLegacyTasks")
    .addItem("Actualizar todo desde Google Tasks", "syncAllFromGoogleTasks")
    .addItem("Actualizar cambios desde la última sincronización", "syncChangesFromGoogleTasks")
    .addItem("Comprobar conexión OAuth de Google Tasks", "checkGoogleTasksConnection")
    .addToUi();
}

/** Crea pestañas, encabezados y disparadores instalables. Es seguro repetirlo. */
function setup() {
  const ss = SpreadsheetApp.getActive();
  ensureSheet_(ss, CFG.TASKS_SHEET, CFG.HEADERS);
  ensureSheet_(ss, CFG.STATE_SHEET, ["key", "value"]);
  ensureSheet_(ss, CFG.LOG_SHEET, ["timestamp", "level", "message", "details"]);
  ensureSheet_(ss, CFG.LINKS_SHEET, CFG.LINKS_HEADERS);
  const tasks = ss.getSheetByName(CFG.TASKS_SHEET);
  tasks.setFrozenRows(1);
  tasks.getRange(1, 1, 1, CFG.HEADERS.length).setFontWeight("bold");
  const dataLastRow = meaningfulLastTaskRow_(tasks);
  if (dataLastRow > 1) setTaskCheckboxValidation_(tasks, 2, dataLastRow - 1);
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (["onTaskEdit", "scheduledSync"].indexOf(trigger.getHandlerFunction()) >= 0) {
      ScriptApp.deleteTrigger(trigger);
    }
  });
  const state = readState_();
  if (truthy_(state.initial_import_done)) ensureSyncTriggers_(ss);
  log_("INFO", "Estructura preparada", truthy_(state.initial_import_done)
    ? "Actualización incremental desde Google Tasks cada " + CFG.PULL_MINUTES + " min"
    : "Ejecuta la importación inicial desde Google Tasks para activar la actualización incremental");
}

/** Sube los registros reales a las primeras filas y quita FALSE vacíos de casillas antiguas. */
function compactTasksSheet() {
  const lock = LockService.getDocumentLock();
  lock.waitLock(30000);
  try {
    const sheet = SpreadsheetApp.getActive().getSheetByName(CFG.TASKS_SHEET);
    if (!sheet) throw new Error("Falta la pestaña Tasks; ejecuta setup().");
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) {
      SpreadsheetApp.getUi().alert("Tasks ya está vacía.");
      return;
    }
    const rawRows = sheet.getRange(2, 1, lastRow - 1, CFG.HEADERS.length).getValues();
    const dataRows = rawRows.filter(isMeaningfulTaskRow_);
    if (dataRows.length) sheet.getRange(2, 1, dataRows.length, CFG.HEADERS.length).setValues(dataRows);
    const firstUnusedRow = dataRows.length + 2;
    if (firstUnusedRow <= lastRow) {
      sheet.getRange(firstUnusedRow, 1, lastRow - firstUnusedRow + 1, CFG.HEADERS.length).clearContent();
    }
    if (dataRows.length) setTaskCheckboxValidation_(sheet, 2, dataRows.length);
    log_("INFO", "Compactación de Tasks", "Registros preservados: " + dataRows.length + "; filas vacías retiradas: " + Math.max(0, lastRow - dataRows.length - 1));
    SpreadsheetApp.getUi().alert("Reparación terminada. Registros conservados: " + dataRows.length + ".");
  } finally {
    lock.releaseLock();
  }
}

function scheduledSync() {
  runSync();
}

/** Trigger de continuación; procesa un tramo por ejecución para respetar el límite de Apps Script. */
function continueFullSync() {
  console.log("Full sync: entrada en continueFullSync");
  const result = reconcileAllGoogleTasks_();
  if (result && result.status !== "PAUSED_RUNTIME") {
    deleteTriggersByHandler_("continueFullSync");
  }
}

function scheduleFullSyncContinuation_() {
  deleteTriggersByHandler_("continueFullSync");
  ScriptApp.newTrigger("continueFullSync").timeBased().after(60 * 1000).create();
}

function deleteTriggersByHandler_(handlerName) {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === handlerName) ScriptApp.deleteTrigger(trigger);
  });
}

function ensureSyncTriggers_(spreadsheet) {
  const existing = ScriptApp.getProjectTriggers().map(function (trigger) { return trigger.getHandlerFunction(); });
  if (existing.indexOf("onTaskEdit") < 0) {
    ScriptApp.newTrigger("onTaskEdit").forSpreadsheet(spreadsheet).onEdit().create();
  }
  if (existing.indexOf("scheduledSync") < 0) {
    ScriptApp.newTrigger("scheduledSync").timeBased().everyMinutes(CFG.PULL_MINUTES).create();
  }
}

/** Carga completa inicial: Google Tasks es el único origen de las tareas. */
function migrateLegacyTasks() {
  const lock = LockService.getDocumentLock();
  lock.waitLock(30000);
  const startedAt = Date.now();
  try {
    let state = readState_();
    ensureSheet_(SpreadsheetApp.getActive(), CFG.TASKS_SHEET, CFG.HEADERS);
    const table = readTasks_();
    const hasImportedGoogleTasks = table.rows.some(function (row) { return Boolean(val_(row, "google_tasks_id")); });
    if (truthy_(state.initial_import_done) && hasImportedGoogleTasks) {
      throw new Error("La importación inicial ya se completó. No la repitas; usa la actualización completa o incremental desde el menú Tareas.");
    }
    // Recupera el caso de la versión anterior que marcó la migración como completa
    // aunque no hubiera escrito ninguna tarea en Tasks.
    if (truthy_(state.initial_import_done) && !hasImportedGoogleTasks) {
      writeState_({
        initial_import_done: "false",
        initial_import_page_token: "",
        initial_import_total: "0",
        initial_import_run_id: "",
        sync_stage: "",
        sync_page_token: "",
        sync_started_at: "",
        sync_updated_min: "",
        sync_task_list: "",
        sync_status: "IDLE",
        last_error: ""
      });
      state = readState_();
      log_("WARN", "Reinicio seguro de importación vacía", "No hay google_tasks_id en Tasks; se vuelve a importar desde Google Tasks.");
    }
    const liveTaskLists = listGoogleTaskLists_();
    let taskListIds = liveTaskLists.map(function (list) { return list.id; });
    let listIndex = Number(state.initial_import_list_index || 0);
    if (state.initial_import_list_ids) {
      try { taskListIds = JSON.parse(state.initial_import_list_ids); }
      catch (error) { throw new Error("La lista de tareas del checkpoint inicial no es válida. Reinicia la importación inicial."); }
    } else if (state.initial_import_task_list) {
      // Resume a checkpoint created by the old single-list importer, then
      // continue through the other lists in the same import.
      taskListIds = [state.initial_import_task_list].concat(taskListIds.filter(function (id) {
        return id !== state.initial_import_task_list;
      }));
      listIndex = 0;
    }
    const runId = state.initial_import_run_id || new Date().toISOString();
    let pageToken = state.initial_import_page_token || "";
    let total = Number(state.initial_import_total || 0);
    let added = 0;
    let updated = 0;
    writeState_({
      initial_import_list_ids: JSON.stringify(taskListIds),
      initial_import_list_index: String(listIndex),
      initial_import_run_id: runId,
      initial_import_status: "RUNNING",
      initial_import_last_error: ""
    });

    const rowsByGoogleId = new Map();
    table.rows.forEach(function (row, i) {
      const id = val_(row, "google_tasks_id");
      if (id) rowsByGoogleId.set(id, i);
    });

    const listById = new Map(liveTaskLists.map(function (list) { return [list.id, list]; }));
    while (listIndex < taskListIds.length) {
      const taskListId = taskListIds[listIndex];
      const activeList = listById.get(taskListId) || { id: taskListId, title: "" };
      if (Date.now() - startedAt > CFG.MAX_RUN_MS) {
        writeState_({ initial_import_list_index: String(listIndex), initial_import_page_token: pageToken, initial_import_total: String(total), initial_import_status: "PAUSED_RUNTIME" });
        log_("WARN", "Importación pausada por tiempo de ejecución", "Progreso guardado después de " + total + " tareas. Vuelve a ejecutar migrateLegacyTasks().");
        return;
      }

      let page;
      try {
        page = listGoogleTasksPage_(taskListId, pageToken, "");
      } catch (error) {
        if (isExpiredPageToken_(error) && pageToken) {
          pageToken = "";
          writeState_({ initial_import_list_index: String(listIndex), initial_import_page_token: "", initial_import_status: "RESTARTING_PAGE", initial_import_last_error: errorMessage_(error) });
          log_("WARN", "Token de página expirado", "Se reinicia la lectura desde el principio; las filas se actualizan por Google task ID sin duplicarse.");
          continue;
        }
        if (isQuotaPause_(error)) {
          writeState_({ initial_import_list_index: String(listIndex), initial_import_page_token: pageToken, initial_import_total: String(total), initial_import_status: "PAUSED_QUOTA", initial_import_last_error: errorMessage_(error) });
          log_("WARN", "Importación pausada por cuota de Google Tasks", "Progreso guardado después de " + total + " tareas. Ejecuta migrateLegacyTasks() más tarde para continuar.");
          return;
        }
        writeState_({ initial_import_list_index: String(listIndex), initial_import_page_token: pageToken, initial_import_total: String(total), initial_import_status: "ERROR", initial_import_last_error: errorMessage_(error) });
        throw error;
      }

      const beforeRows = table.rows.length;
      const result = upsertGoogleTasksPage_(table, rowsByGoogleId, page.items || [], runId, true, beforeRows, activeList.title);
      added += result.added;
      updated += result.updated;
      total += (page.items || []).length;
      pageToken = page.nextPageToken || "";
      if (!pageToken) listIndex++;
      writeState_({
        initial_import_list_index: String(listIndex),
        initial_import_page_token: pageToken,
        initial_import_total: String(total),
        initial_import_status: listIndex < taskListIds.length ? "RUNNING" : "FINALIZING",
        initial_import_last_error: ""
      });
    }

    let notInGoogleTasks = 0;
    table.rows.forEach(function (row) {
      if (val_(row, "last_synced_at") === runId) return;
      row[col_("sync_to_google")] = "FALSE";
      if (val_(row, "title")) {
        row[col_("conflict_flag")] = "NOT_IN_GOOGLE_TASKS";
        row[col_("conflict_note")] = "Se conserva como dato legado, pero no forma parte de la importación desde Google Tasks.";
        notInGoogleTasks++;
      }
    });
    writeAllTasks_(table.rows);
    const completedAt = new Date().toISOString();
    writeState_({
      initial_import_done: "true",
      initial_import_status: "COMPLETED",
      initial_import_page_token: "",
      initial_import_list_index: "",
      initial_import_list_ids: "",
      last_sync_cursor: runId,
      last_full_import: completedAt,
      last_success: completedAt,
      last_error: ""
    });
    ensureSyncTriggers_(SpreadsheetApp.getActive());
    log_("INFO", "Importación inicial desde Google Tasks", "Recibidas: " + total +
      "; nuevas: " + added + "; actualizadas: " + updated + "; filas legadas sin correspondencia: " +
      notInGoogleTasks + "; filas en Tasks: " + table.rows.length);
  } finally {
    lock.releaseLock();
  }
}

/** Escaneo completo desde Google Tasks hacia la hoja, sin enviar cambios a Tasks. */
function syncAllFromGoogleTasks() {
  console.log("Full sync: entrada en syncAllFromGoogleTasks");
  const result = reconcileAllGoogleTasks_();
  if (!result) return;
  let message;
  if (result.status === "COMPLETED") message = "Actualización completa desde Google Tasks. Tareas leídas: " + result.total + "; filas marcadas como borradas: " + result.markedDeleted + ".";
  else if (result.status === "PAUSED_RUNTIME") message = "Actualización completa pausada por tiempo. Progreso guardado tras " + result.total + " tareas; continuará automáticamente en aproximadamente un minuto.";
  else if (result.status === "PAUSED_QUOTA" || result.status === "WAITING_QUOTA") message = "Actualización completa pausada por cuota. Próximo intento permitido: " + result.retryAt + ". El progreso está guardado.";
  else if (result.status === "BUSY") message = "Hay otra sincronización en curso. Vuelve a intentarlo en un momento.";
  if (message) SpreadsheetApp.getActive().toast(message, "Tareas", 10);
  console.log("Full sync: función de menú finalizada; estado=" + result.status);
}

/** Actualiza solo las tareas modificadas desde el último cursor guardado. */
function syncChangesFromGoogleTasks() {
  const outcome = runSync(true);
  if (outcome === "BUSY") {
    SpreadsheetApp.getUi().alert("Hay otra actualización en curso. Vuelve a intentarlo en un momento.");
    return;
  }
  const state = readState_();
  const message = outcome === "COMPLETED"
    ? "Actualización incremental desde Google Tasks terminada."
    : outcome === "PAUSED_RUNTIME"
      ? "Actualización pausada por tiempo. Vuelve a ejecutarla para continuar."
      : outcome === "PAUSED_QUOTA"
        ? "Actualización pausada por cuota. Reintento después de " + state.sync_retry_after + "."
        : state.sync_status === "ERROR"
          ? "Falló la actualización incremental: " + (state.last_error || "error desconocido")
          : state.sync_status === "PAUSED_QUOTA"
            ? "Actualización pausada por cuota. Reintento después de " + state.sync_retry_after + "."
            : state.sync_status === "PAUSED_RUNTIME"
              ? "Actualización pausada por tiempo. Vuelve a ejecutarla para continuar."
              : "Actualización incremental desde Google Tasks terminada.";
  SpreadsheetApp.getUi().alert(message);
}

function reconcileAllGoogleTasks_() {
  console.log("Full sync: inicio de reconciliación");
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(1000)) return { status: "BUSY" };
  const invocationStarted = Date.now();
  try {
    let state = readState_();
    if (!truthy_(state.initial_import_done)) {
      throw new Error("Completa primero la importación inicial desde Google Tasks.");
    }
    if (state.sync_stage) {
      // The full scan supersedes any saved incremental checkpoint. The
      // document lock above guarantees that no incremental run is active.
      writeState_({
        sync_stage: "",
        sync_page_token: "",
        sync_list_index: "",
        sync_task_lists: "",
        sync_started_at: "",
        sync_updated_min: "",
        sync_task_list: "",
        sync_status: "IDLE",
        sync_retry_after: "",
        last_error: ""
      });
      state = readState_();
      log_("INFO", "Checkpoint incremental reemplazado", "La actualización completa leerá todas las listas de Google Tasks.");
    }
    console.log("Full sync: consultando listas en Google Tasks");
    const liveTaskLists = listGoogleTaskLists_();
    console.log("Full sync: listas cargadas en " + (Date.now() - invocationStarted) + " ms; total=" + liveTaskLists.length);
    const resumable = ["RUNNING", "PAUSED_RUNTIME", "PAUSED_QUOTA", "FINALIZING"].indexOf(state.full_reconcile_status) >= 0;
    let taskLists = liveTaskLists;
    if (resumable && state.full_reconcile_list_ids) {
      const liveById = new Map(liveTaskLists.map(function (list) { return [list.id, list]; }));
      try {
        taskLists = JSON.parse(state.full_reconcile_list_ids).map(function (id) {
          return liveById.get(id) || { id: id, title: "" };
        });
      } catch (error) {
        throw new Error("La lista de tareas del checkpoint completo no es válida. Reinicia la actualización completa.");
      }
    }
    if (resumable && state.full_reconcile_status === "PAUSED_QUOTA" &&
        state.full_reconcile_retry_after && Date.parse(state.full_reconcile_retry_after) > Date.now()) {
      return { status: "WAITING_QUOTA", retryAt: state.full_reconcile_retry_after };
    }
    if (!resumable) {
      const startedAt = new Date().toISOString();
      writeState_({
        full_reconcile_status: "RUNNING",
        full_reconcile_list_ids: JSON.stringify(liveTaskLists.map(function (list) { return list.id; })),
        full_reconcile_list_index: "0",
        full_reconcile_started_at: startedAt,
        full_reconcile_page_token: "",
        full_reconcile_page_size: String(CFG.FULL_PAGE_SIZE),
        full_reconcile_total: "0",
        full_reconcile_added: "0",
        full_reconcile_updated: "0",
        full_reconcile_finalize_index: "0",
        full_reconcile_marked_deleted: "0",
        full_reconcile_retry_after: "",
        full_reconcile_last_error: ""
      });
    } else {
      writeState_({ full_reconcile_status: "RUNNING", full_reconcile_retry_after: "", full_reconcile_last_error: "" });
    }

    state = readState_();
    if (state.full_reconcile_page_size !== String(CFG.FULL_PAGE_SIZE)) {
      // Page tokens are tied to the previous page size. Restart only the
      // current list; task IDs make this replay idempotent.
      state.full_reconcile_page_token = "";
      writeState_({ full_reconcile_page_token: "", full_reconcile_page_size: String(CFG.FULL_PAGE_SIZE) });
    }
    ensureSheet_(SpreadsheetApp.getActive(), CFG.TASKS_SHEET, CFG.HEADERS);
    const table = readTasks_();
    console.log("Full sync: Tasks leída en " + (Date.now() - invocationStarted) + " ms; filas=" + table.rows.length);
    const rowsByGoogleId = buildGoogleIdIndex_(table.rows);
    const taggedCopyIndex = buildTaggedCopyIndex_(table.rows);
    console.log("Full sync: índices construidos en " + (Date.now() - invocationStarted) + " ms");
    let pageToken = state.full_reconcile_page_token || "";
    let listIndex = Number(state.full_reconcile_list_index || 0);
    let links = readTaskLinks_();
    console.log("Full sync: vínculos leídos en " + (Date.now() - invocationStarted) + " ms; vínculos=" + links.length);
    const linksByTaskList = new Map();
    links.forEach(function (link, index) {
      linksByTaskList.set(link.task_id + "\u001f" + link.list_id, index);
    });
    let total = Number(state.full_reconcile_total || 0);
    let added = Number(state.full_reconcile_added || 0);
    let updated = Number(state.full_reconcile_updated || 0);
    let pagesThisRun = 0;

    while (listIndex < taskLists.length) {
      const activeList = taskLists[listIndex];
      const activeListId = activeList.id;
      if (Date.now() - invocationStarted > CFG.MAX_RUN_MS) {
        writeState_({ full_reconcile_list_index: String(listIndex), full_reconcile_page_token: pageToken, full_reconcile_total: String(total), full_reconcile_added: String(added), full_reconcile_updated: String(updated), full_reconcile_status: "PAUSED_RUNTIME" });
        scheduleFullSyncContinuation_();
        log_("WARN", "Actualización completa pausada por tiempo", "Checkpoint guardado tras " + total + " tareas.");
        return { status: "PAUSED_RUNTIME", total: total };
      }

      let page;
      try {
        console.log("Full sync: solicitando página de lista " + (activeList.title || activeListId) + " en " + (Date.now() - invocationStarted) + " ms");
        page = listGoogleTasksPage_(activeListId, pageToken, "", CFG.FULL_PAGE_SIZE);
        console.log("Full sync: respuesta de página recibida; tareas=" + ((page.items || []).length) + "; ms=" + (Date.now() - invocationStarted));
      } catch (error) {
        if (isExpiredPageToken_(error) && pageToken) {
          pageToken = "";
          writeState_({ full_reconcile_list_index: String(listIndex), full_reconcile_page_token: "", full_reconcile_status: "RESTARTING_PAGE", full_reconcile_last_error: errorMessage_(error) });
          log_("WARN", "Token de reconciliación expirado", "Se reinicia la lectura; las filas se actualizan por ID sin duplicarse.");
          continue;
        }
        if (isQuotaPause_(error)) {
          const retryAt = new Date(Date.now() + quotaCooldownMs_(error)).toISOString();
          writeState_({ full_reconcile_list_index: String(listIndex), full_reconcile_page_token: pageToken, full_reconcile_total: String(total), full_reconcile_added: String(added), full_reconcile_updated: String(updated), full_reconcile_status: "PAUSED_QUOTA", full_reconcile_retry_after: retryAt, full_reconcile_last_error: errorMessage_(error) });
          log_("WARN", "Actualización completa pausada por cuota", "Checkpoint guardado tras " + total + " tareas; próximo intento después de " + retryAt + ".");
          return { status: "PAUSED_QUOTA", total: total, retryAt: retryAt };
        }
        throw error;
      }

      const beforeRows = table.rows.length;
      const pageResult = upsertGoogleTasksPage_(table, rowsByGoogleId, page.items || [], state.full_reconcile_started_at, false, beforeRows, activeList.title, taggedCopyIndex);
      console.log("Full sync: página aplicada en Tasks; ms=" + (Date.now() - invocationStarted));
      const changedLinkIndexes = [];
      const addedLinks = [];
      (page.items || []).forEach(function (task) {
        if (!task.id) return;
        const rowIndex = rowsByGoogleId.get(task.id);
        if (rowIndex === undefined) return;
        const taskId = val_(table.rows[rowIndex], "task_id");
        const key = taskId + "\u001f" + activeListId;
        const linkIndex = linksByTaskList.get(key);
        const link = linkIndex === undefined ? null : links[linkIndex];
        if (link) {
          const etag = task.etag || "";
          const managedByTag = extractBracketTags_(task.title).some(function (tag) { return normalize_(tag) === normalize_(activeList.title); }) ? "TRUE" : "";
          if (link.google_tasks_id !== task.id || link.google_tasks_etag !== etag ||
              link.list_title !== activeList.title || link.managed_by_tag !== managedByTag) {
            link.google_tasks_id = task.id;
            link.google_tasks_etag = etag;
            link.list_title = activeList.title;
            link.managed_by_tag = managedByTag;
            changedLinkIndexes.push(linkIndex);
          }
        } else {
          const newLink = { task_id: taskId, list_id: activeListId, list_title: activeList.title, google_tasks_id: task.id, google_tasks_etag: task.etag || "", managed_by_tag: extractBracketTags_(task.title).some(function (tag) { return normalize_(tag) === normalize_(activeList.title); }) ? "TRUE" : "" };
          linksByTaskList.set(key, links.length);
          links.push(newLink);
          addedLinks.push(newLink);
        }
        propagateCompletionToLinkedCopies_(task, taskId, activeList, links, linksByTaskList, changedLinkIndexes);
      });
      persistTaskLinkChanges_(changedLinkIndexes, links, addedLinks);
      console.log("Full sync: vínculos de página escritos; ms=" + (Date.now() - invocationStarted));
      added += pageResult.added;
      updated += pageResult.updated;
      total += (page.items || []).length;
      pagesThisRun++;
      pageToken = page.nextPageToken || "";
      if (!pageToken) listIndex++;
      writeState_({
        full_reconcile_list_index: String(listIndex),
        full_reconcile_page_token: pageToken,
        full_reconcile_total: String(total),
        full_reconcile_added: String(added),
        full_reconcile_updated: String(updated),
        full_reconcile_status: listIndex < taskLists.length ? "RUNNING" : "FINALIZING",
        full_reconcile_last_error: ""
      });
      console.log("Full sync: checkpoint de página guardado; total=" + total + "; ms=" + (Date.now() - invocationStarted));
      if (pagesThisRun >= CFG.MAX_FULL_PAGES_PER_RUN || Date.now() - invocationStarted > CFG.MAX_RUN_MS) {
        writeState_({ full_reconcile_status: "PAUSED_RUNTIME" });
        scheduleFullSyncContinuation_();
        log_("INFO", "Continuación automática de actualización completa", "Checkpoint guardado tras " + total + " tareas.");
        return { status: "PAUSED_RUNTIME", total: total };
      }
    }

    // Finalize in chunks too: loading or rewriting a large Tasks sheet in one
    // invocation can exceed Apps Script's hard runtime limit.
    let finalizeIndex = Number(state.full_reconcile_finalize_index || 0);
    let markedDeleted = Number(state.full_reconcile_marked_deleted || 0);
    const chunkSize = 300;
    while (finalizeIndex < table.rows.length) {
      if (Date.now() - invocationStarted > CFG.MAX_RUN_MS) {
        writeState_({
          full_reconcile_finalize_index: String(finalizeIndex),
          full_reconcile_marked_deleted: String(markedDeleted),
          full_reconcile_status: "PAUSED_RUNTIME"
        });
        scheduleFullSyncContinuation_();
        log_("WARN", "Finalización completa pausada por tiempo", "Checkpoint guardado en fila " + (finalizeIndex + 2) + ".");
        return { status: "PAUSED_RUNTIME", total: total };
      }
      const endIndex = Math.min(finalizeIndex + chunkSize, table.rows.length);
      const changed = [];
      for (let i = finalizeIndex; i < endIndex; i++) {
        const row = table.rows[i];
        if (!val_(row, "google_tasks_id") || val_(row, "last_synced_at") === state.full_reconcile_started_at) continue;
        if (truthy_(val_(row, "deleted"))) continue;
        row[col_("deleted")] = "TRUE";
        row[col_("completed")] = "TRUE";
        row[col_("status")] = "End";
        row[col_("conflict_flag")] = "";
        row[col_("conflict_note")] = "";
        changed.push({ index: i, row: row });
        markedDeleted++;
      }
      if (changed.length) {
        table.sheet.getRange(finalizeIndex + 2, 1, endIndex - finalizeIndex, CFG.HEADERS.length)
          .setValues(table.rows.slice(finalizeIndex, endIndex));
      }
      finalizeIndex = endIndex;
      writeState_({
        full_reconcile_finalize_index: String(finalizeIndex),
        full_reconcile_marked_deleted: String(markedDeleted),
        full_reconcile_status: "FINALIZING"
      });
    }

    const completedAt = new Date().toISOString();
    writeState_({
      full_reconcile_status: "COMPLETED",
      full_reconcile_page_token: "",
      full_reconcile_finalize_index: "",
      full_reconcile_added: String(added),
      full_reconcile_updated: String(updated),
      full_reconcile_retry_after: "",
      full_reconcile_last_error: "",
      full_reconcile_completed_at: completedAt,
      full_reconcile_list_ids: "",
      last_sync_cursor: state.full_reconcile_started_at,
      last_success: completedAt
    });
    deleteTriggersByHandler_("continueFullSync");
    log_("INFO", "Actualización completa desde Google Tasks", "Tareas leídas: " + total + "; nuevas: " + added + "; actualizadas: " + updated + "; marcadas como borradas: " + markedDeleted + "; no se enviaron cambios a Google Tasks.");
    return { status: "COMPLETED", total: total, markedDeleted: markedDeleted };
  } catch (error) {
    if (!isQuotaPause_(error)) {
      writeState_({ full_reconcile_status: "ERROR", full_reconcile_last_error: errorMessage_(error) });
      log_("ERROR", "Falló la actualización completa", String(error && error.stack || error));
    }
    throw error;
  } finally {
    lock.releaseLock();
  }
}

/** Actualización incremental y reanudable desde Google Tasks hacia Sheets. */
function runSync(force) {
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(1000)) return "BUSY";
  const invocationStarted = Date.now();
  try {
    let state = readState_();
    if (!truthy_(state.initial_import_done)) {
      throw new Error("Primero ejecuta migrateLegacyTasks() para importar Google Tasks a la hoja.");
    }
    if (["RUNNING", "PAUSED_RUNTIME", "PAUSED_QUOTA"].indexOf(state.full_reconcile_status) >= 0) return "BUSY";
    if (!force && state.sync_retry_after && Date.parse(state.sync_retry_after) > Date.now()) return "WAITING_QUOTA";

    const taskLists = listGoogleTaskLists_();
    let taskListIds = taskLists.map(function (list) { return list.id; });
    if (state.sync_stage && state.sync_task_lists) {
      try { taskListIds = JSON.parse(state.sync_task_lists); }
      catch (error) { throw new Error("La lista de tareas del checkpoint incremental no es válida. Ejecuta la actualización completa."); }
    } else if (state.sync_stage && state.sync_task_list) {
      // Resume a checkpoint created by the earlier single-list version.
      taskListIds = [state.sync_task_list];
    }
    if (!state.sync_stage || state.sync_stage === "PUSH") {
      const syncStarted = new Date().toISOString();
      const priorCursor = state.last_sync_cursor || syncStarted;
      const updatedMin = new Date(Math.max(0, Date.parse(priorCursor) - 10000)).toISOString();
      writeState_({
        sync_stage: "PULL",
        sync_page_token: "",
        sync_list_index: "0",
        sync_task_lists: JSON.stringify(taskListIds),
        sync_started_at: syncStarted,
        sync_updated_min: updatedMin,
        sync_status: "RUNNING"
      });
      state = readState_();
    }

    let table = readTasks_();
    const rowsByGoogleId = buildGoogleIdIndex_(table.rows);
    const links = readTaskLinks_();
    const linksByTaskList = new Map();
    links.forEach(function (link, index) {
      linksByTaskList.set(link.task_id + "\u001f" + link.list_id, index);
    });
    const changedLinkIndexes = [];
    let pageToken = state.sync_page_token || "";
    let listIndex = Number(state.sync_list_index || 0);
    const listById = new Map(taskLists.map(function (list) { return [list.id, list]; }));

    if (state.sync_stage === "PULL") {
      while (listIndex < taskListIds.length) {
        const taskListId = taskListIds[listIndex];
        const activeList = listById.get(taskListId) || { id: taskListId, title: "" };
        if (Date.now() - invocationStarted > CFG.MAX_RUN_MS) {
          writeState_({ sync_list_index: String(listIndex), sync_page_token: pageToken, sync_status: "PAUSED_RUNTIME" });
          log_("WARN", "Actualización incremental pausada por tiempo", "Checkpoint guardado en la lista " + (listIndex + 1) + " de " + taskListIds.length + ".");
          return "PAUSED_RUNTIME";
        }
        let page;
        try {
          page = listGoogleTasksPage_(taskListId, pageToken, state.sync_updated_min);
        } catch (error) {
          if (isExpiredPageToken_(error) && pageToken) {
            pageToken = "";
            writeState_({ sync_list_index: String(listIndex), sync_page_token: "", sync_status: "RESTARTING_PAGE", last_error: errorMessage_(error) });
            continue;
          }
          throw error;
        }
        const beforeRows = table.rows.length;
        upsertGoogleTasksPage_(table, rowsByGoogleId, page.items || [], state.sync_started_at, false, beforeRows, activeList.title);
        (page.items || []).forEach(function (task) {
          const rowIndex = rowsByGoogleId.get(task.id);
          if (rowIndex === undefined) return;
          const taskId = val_(table.rows[rowIndex], "task_id");
          propagateCompletionToLinkedCopies_(task, taskId, activeList, links, linksByTaskList, changedLinkIndexes);
        });
        persistTaskLinkChanges_(changedLinkIndexes, links, []);
        changedLinkIndexes.length = 0;
        pageToken = page.nextPageToken || "";
        if (!pageToken) listIndex++;
        writeState_({
          sync_page_token: pageToken,
          sync_list_index: String(listIndex),
          sync_stage: "PULL",
          sync_status: "RUNNING",
          last_error: ""
        });
      }
    }

    const finalState = readState_();
    writeState_({
      last_sync_cursor: finalState.sync_started_at,
      last_success: new Date().toISOString(),
      last_error: "",
      sync_stage: "",
      sync_page_token: "",
      sync_status: "IDLE",
      sync_retry_after: "",
      sync_updated_min: "",
      sync_started_at: "",
      sync_task_list: "",
      sync_task_lists: "",
      sync_list_index: ""
    });
    log_("INFO", "Actualización incremental correcta", "Cambios desde el cursor anterior aplicados desde todas las listas de Google Tasks.");
    return "COMPLETED";
  } catch (error) {
    if (isQuotaPause_(error)) {
      const retryAt = new Date(Date.now() + quotaCooldownMs_(error)).toISOString();
      writeState_({ sync_status: "PAUSED_QUOTA", sync_retry_after: retryAt, last_error: errorMessage_(error) });
      log_("WARN", "Sincronización pausada por cuota", "Checkpoint conservado. Reintento automático después de " + retryAt + "; también puedes reanudar desde el menú.");
      return "PAUSED_QUOTA";
    }
    writeState_({ sync_status: "ERROR", last_error: errorMessage_(error) });
    log_("ERROR", "Falló la sincronización", String(error && error.stack || error));
    throw error;
  } finally {
    lock.releaseLock();
  }
}

function onTaskEdit(event) {
  if (!event || !event.range) return;
  const sheet = event.range.getSheet();
  if (sheet.getName() !== CFG.TASKS_SHEET || event.range.getRow() < 2) return;
  for (let offset = 0; offset < event.range.getNumRows(); offset++) {
    const rowNumber = event.range.getRow() + offset;
    const row = sheet.getRange(rowNumber, 1, 1, CFG.HEADERS.length).getDisplayValues()[0];
    if (!val_(row, "title")) continue;
    if (!val_(row, "task_id")) {
      row[col_("task_id")] = Utilities.getUuid();
      row[col_("created_at")] = new Date().toISOString();
      row[col_("source")] = "sheet";
      if (!val_(row, "status")) row[col_("status")] = "New";
      row[col_("sync_to_google")] = "FALSE";
    }
    sheet.getRange(rowNumber, 1, 1, CFG.HEADERS.length).setValues([row]);
  }
}

function applyGoogleToSheet_(row, task) {
  row[col_("title")] = task.title || "(sin título)";
  row[col_("notes")] = task.notes || "";
  row[col_("due_at")] = task.due ? new Date(task.due).toISOString() : "";
  const done = task.status === "completed";
  row[col_("status")] = done ? "End" : "WIP";
  row[col_("completed")] = String(done);
  row[col_("deleted")] = String(Boolean(task.deleted));
  row[col_("updated_at")] = task.updated || new Date().toISOString();
  row[col_("google_tasks_id")] = task.id || "";
  row[col_("google_tasks_etag")] = task.etag || "";
  row[col_("source")] = "google_tasks";
  row[col_("conflict_flag")] = "";
  row[col_("conflict_note")] = "";
  syncBracketTags_(row);
}

function parseTagList_(value) {
  return String(value || "").split(",").map(function (tag) { return tag.trim(); }).filter(Boolean);
}

function extractBracketTags_(title) {
  const tags = [];
  const seen = new Set();
  const regex = /\[([^\[\]]+)\]/g;
  let match;
  while ((match = regex.exec(String(title || ""))) !== null) {
    const tag = match[1].trim();
    const key = tag.toLowerCase();
    if (tag && !seen.has(key)) {
      seen.add(key);
      tags.push(tag);
    }
  }
  return tags;
}

/** Mantiene tags manuales y sincroniza de forma reversible las extraídas de [corchetes]. */
function syncBracketTags_(row) {
  const previousBracketTags = parseTagList_(val_(row, "google_bracket_tags"));
  const previousKeys = new Set(previousBracketTags.map(function (tag) { return tag.toLowerCase(); }));
  const currentBracketTags = extractBracketTags_(val_(row, "title"));
  const merged = [];
  const seen = new Set();
  parseTagList_(val_(row, "tags")).forEach(function (tag) {
    const key = tag.toLowerCase();
    if (!previousKeys.has(key) && !seen.has(key)) {
      merged.push(tag);
      seen.add(key);
    }
  });
  currentBracketTags.forEach(function (tag) {
    const key = tag.toLowerCase();
    if (!seen.has(key)) {
      merged.push(tag);
      seen.add(key);
    }
  });
  row[col_("tags")] = merged.join(", ");
  row[col_("google_bracket_tags")] = currentBracketTags.join(", ");
}

function googleTaskRow_(task) {
  const row = emptyRow_();
  row[col_("task_id")] = Utilities.getUuid();
  row[col_("source")] = "google_tasks";
  row[col_("sync_to_google")] = "FALSE";
  applyGoogleToSheet_(row, task);
  setHashes_(row, task);
  row[col_("last_synced_at")] = new Date().toISOString();
  return row;
}

function listGoogleTasksPage_(taskListId, pageToken, updatedMin, maxResults) {
  const options = { maxResults: maxResults || 100, showCompleted: true, showDeleted: true, showHidden: true };
  if (pageToken) options.pageToken = pageToken;
  if (updatedMin) options.updatedMin = updatedMin;
  const query = Object.keys(options).map(function (key) {
    return encodeURIComponent(key) + "=" + encodeURIComponent(String(options[key]));
  }).join("&");
  return callTasksApi_(function () {
    return googleTasksRequest_("GET", taskListPath_(taskListId) + "/tasks?" + query);
  });
}

function buildGoogleIdIndex_(rows) {
  const index = new Map();
  rows.forEach(function (row, rowIndex) {
    const googleId = val_(row, "google_tasks_id");
    if (googleId) index.set(googleId, rowIndex);
  });
  return index;
}

/** Actualiza la memoria y persiste la página antes de que el llamador guarde el token. */
function upsertGoogleTasksPage_(table, rowsByGoogleId, tasks, runId, initial, beforeRows, sourceListTitle, taggedCopyIndex) {
  const changed = [];
  const addedRows = [];
  let added = 0;
  let updated = 0;
  tasks.forEach(function (task) {
    if (!task.id) return;
    let existingIndex = rowsByGoogleId.get(task.id);
    if (existingIndex === undefined && sourceListTitle) {
      existingIndex = taggedCopyIndex
        ? findTaggedCopyFromIndex_(taggedCopyIndex, task, sourceListTitle)
        : findTaggedCopyRow_(table.rows, task, sourceListTitle);
      if (existingIndex !== undefined) rowsByGoogleId.set(task.id, existingIndex);
    }
    if (existingIndex === undefined) {
      const row = googleTaskRow_(task);
      row[col_("last_synced_at")] = runId;
      if (initial) setHashes_(row, task);
      rowsByGoogleId.set(task.id, table.rows.length);
      table.rows.push(row);
      addedRows.push(row);
      added++;
      return;
    }
    const row = table.rows[existingIndex];
    // Google Tasks is authoritative. Keep Sheet-only context columns, while
    // always replacing the fields that are shared with the Google Task.
    applyGoogleToSheet_(row, task);
    setHashes_(row, task);
    row[col_("sync_to_google")] = "FALSE";
    row[col_("last_synced_at")] = runId;
    changed.push({ index: existingIndex, row: row });
    updated++;
  });
  persistChangedTaskRows_(table.sheet, changed, addedRows, beforeRows);
  return { added: added, updated: updated };
}

function findTaggedCopyRow_(rows, task, listTitle) {
  const title = String(task.title || "").trim();
  const notes = String(task.notes || "").trim();
  const matches = [];
  rows.forEach(function (row, index) {
    if (val_(row, "deleted").toLowerCase() === "true") return;
    if (val_(row, "title") !== title || val_(row, "notes") !== notes) return;
    if (!extractBracketTags_(title).some(function (tag) { return normalize_(tag) === normalize_(listTitle); })) return;
    matches.push(index);
  });
  return matches.length === 1 ? matches[0] : undefined;
}

function buildTaggedCopyIndex_(rows) {
  const index = new Map();
  rows.forEach(function (row, rowIndex) {
    if (val_(row, "deleted").toLowerCase() === "true") return;
    const title = val_(row, "title");
    const notes = val_(row, "notes");
    extractBracketTags_(title).forEach(function (tag) {
      const key = JSON.stringify([title, notes, normalize_(tag)]);
      if (index.has(key)) index.set(key, null);
      else index.set(key, rowIndex);
    });
  });
  return index;
}

function findTaggedCopyFromIndex_(index, task, listTitle) {
  const key = JSON.stringify([String(task.title || "").trim(), String(task.notes || "").trim(), normalize_(listTitle)]);
  const rowIndex = index.get(key);
  return rowIndex === null || rowIndex === undefined ? undefined : rowIndex;
}

function persistChangedTaskRows_(sheet, changed, addedRows, beforeRows) {
  changed.sort(function (a, b) { return a.index - b.index; });
  let start = 0;
  while (start < changed.length) {
    let end = start + 1;
    while (end < changed.length && changed[end].index === changed[end - 1].index + 1) end++;
    sheet.getRange(changed[start].index + 2, 1, end - start, CFG.HEADERS.length)
      .setValues(changed.slice(start, end).map(function (item) { return item.row; }));
    start = end;
  }
  if (addedRows.length) {
    const appendAt = beforeRows + 2;
    sheet.getRange(appendAt, 1, addedRows.length, CFG.HEADERS.length).setValues(addedRows);
    setTaskCheckboxValidation_(sheet, appendAt, addedRows.length);
  }
}

function listGoogleTaskLists_() {
  if (GOOGLE_TASK_LISTS_CACHE_) return GOOGLE_TASK_LISTS_CACHE_;
  let token = ""; const lists = [];
  do {
    const query = "?maxResults=1000" + (token ? "&pageToken=" + encodeURIComponent(token) : "");
    const page = callTasksApi_(function () { return googleTasksRequest_("GET", "/users/@me/lists" + query); });
    (page.items || []).forEach(function (item) { lists.push(item); });
    token = page.nextPageToken || "";
  } while (token);
  GOOGLE_TASK_LISTS_CACHE_ = lists;
  return lists;
}
function readTaskLinks_() {
  const sheet = ensureSheet_(SpreadsheetApp.getActive(), CFG.LINKS_SHEET, CFG.LINKS_HEADERS);
  if (!sheet || sheet.getLastRow() < 2) return [];
  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, CFG.LINKS_HEADERS.length).getDisplayValues();
  return values.filter(function (r) { return r[0] && r[1] && r[3]; }).map(function (r) { return { task_id: r[0], list_id: r[1], list_title: r[2], google_tasks_id: r[3], google_tasks_etag: r[4], managed_by_tag: r[5], completion_propagated_updated: r[6] || "" }; });
}
function writeTaskLinks_(links) {
  const sheet = ensureSheet_(SpreadsheetApp.getActive(), CFG.LINKS_SHEET, CFG.LINKS_HEADERS);
  if (sheet.getLastRow() > 1) sheet.getRange(2, 1, sheet.getLastRow() - 1, CFG.LINKS_HEADERS.length).clearContent();
  if (links.length) sheet.getRange(2, 1, links.length, CFG.LINKS_HEADERS.length).setValues(links.map(taskLinkRow_));
}

function persistTaskLinkChanges_(changedIndexes, links, addedLinks) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(CFG.LINKS_SHEET);
  const appendedStart = links.length - addedLinks.length;
  const indexes = Array.from(new Set(changedIndexes)).filter(function (index) { return index < appendedStart; }).sort(function (a, b) { return a - b; });
  let start = 0;
  while (start < indexes.length) {
    let end = start + 1;
    while (end < indexes.length && indexes[end] === indexes[end - 1] + 1) end++;
    const first = indexes[start];
    const last = indexes[end - 1];
    sheet.getRange(first + 2, 1, last - first + 1, CFG.LINKS_HEADERS.length)
      .setValues(links.slice(first, last + 1).map(taskLinkRow_));
    start = end;
  }
  if (addedLinks.length) {
    const appendAt = sheet.getLastRow() + 1;
    sheet.getRange(appendAt, 1, addedLinks.length, CFG.LINKS_HEADERS.length).setValues(addedLinks.map(taskLinkRow_));
  }
}

function taskLinkRow_(link) {
  return [link.task_id, link.list_id, link.list_title || "", link.google_tasks_id, link.google_tasks_etag || "", link.managed_by_tag || "", link.completion_propagated_updated || ""];
}

/** Completar cualquier copia enlazada completa todas las demás copias de esa tarea lógica. */
function propagateCompletionToLinkedCopies_(task, taskId, sourceList, links, linksByTaskList, changedLinkIndexes) {
  if (!task || task.status !== "completed" || task.deleted) return;
  const sourceUpdated = task.updated || task.etag || "completed";
  const sourceLinkIndex = linksByTaskList.get(taskId + "\u001f" + sourceList.id);
  if (sourceLinkIndex !== undefined && links[sourceLinkIndex].completion_propagated_updated === sourceUpdated) return;

  links.forEach(function (link, linkIndex) {
    if (link.task_id !== taskId || link.list_id === sourceList.id) return;
    try {
      const patched = callTasksApi_(function () {
        return googleTasksRequest_("PATCH", taskListPath_(link.list_id) + "/tasks/" + encodeURIComponent(link.google_tasks_id), {
          status: "completed",
          completed: new Date().toISOString()
        });
      });
      link.google_tasks_etag = patched.etag || link.google_tasks_etag;
      // The target task's own update timestamp suppresses feedback when its
      // patched version is read later in this or the next sync run.
      link.completion_propagated_updated = patched.updated || sourceUpdated;
      changedLinkIndexes.push(linkIndex);
      log_("INFO", "Finalización propagada a Google Tasks", "Lista destino: " + link.list_title + "; tarea: " + link.google_tasks_id + ".");
    } catch (error) {
      log_("WARN", "No se pudo completar una copia de Google Tasks", "Lista destino: " + link.list_title + "; verifica que el refresh token tenga el permiso https://www.googleapis.com/auth/tasks. " + errorMessage_(error));
    }
  });
  if (sourceLinkIndex !== undefined) {
    links[sourceLinkIndex].completion_propagated_updated = sourceUpdated;
    changedLinkIndexes.push(sourceLinkIndex);
  }
}
function callTasksApi_(operation) {
  for (let attempt = 0; ; attempt++) {
    try { return operation(); }
    catch (error) {
      const message = errorMessage_(error);
      if (isDailyQuotaError_(message)) throw new Error("PAUSED_QUOTA: " + message);
      if (!isTransientApiError_(message)) throw error;
      if (attempt >= CFG.MAX_API_RETRIES) throw new Error("PAUSED_QUOTA: reintentos agotados; " + message);
      const delay = Math.min(30000, 1000 * Math.pow(2, attempt) + Math.floor(Math.random() * 500));
      Utilities.sleep(delay);
    }
  }
}

function checkGoogleTasksConnection() {
  const items = listGoogleTaskLists_();
  const message = "OAuth válido. Listas de la cuenta autorizada: " + items.length +
    (items.length ? " — " + items.map(function (item) { return item.title; }).join(", ") : "") + ".";
  log_("INFO", "Comprobación OAuth de Google Tasks", message);
  SpreadsheetApp.getUi().alert(message);
}

function taskListPath_(taskListId) {
  return "/lists/" + encodeURIComponent(taskListId);
}

function googleTasksRequest_(method, path, payload) {
  const url = "https://tasks.googleapis.com/tasks/v1" + path;
  const properties = PropertiesService.getScriptProperties();
  const clientId = properties.getProperty("GOOGLE_TASKS_CLIENT_ID") || "";
  const refreshToken = properties.getProperty("GOOGLE_TASKS_REFRESH_TOKEN") || "";
  const cacheKey = "google_tasks_access_token_" + digest_(clientId + "\u001f" + refreshToken).slice(0, 32);
  for (let authAttempt = 0; authAttempt < 2; authAttempt++) {
    const accessToken = googleTasksAccessToken_(cacheKey, authAttempt > 0);
    const response = UrlFetchApp.fetch(url, {
      method: method,
      headers: { Authorization: "Bearer " + accessToken },
      contentType: "application/json",
      payload: payload == null ? undefined : JSON.stringify(payload),
      muteHttpExceptions: true
    });
    const status = response.getResponseCode();
    const text = response.getContentText();
    if (status === 401 && authAttempt === 0) {
      CacheService.getScriptCache().remove(cacheKey);
      continue;
    }
    if (status < 200 || status >= 300) {
      let detail = text;
      try {
        const body = JSON.parse(text);
        detail = body.error && body.error.message ? body.error.message : text;
        if (body.error && body.error.errors && body.error.errors.length) {
          detail += " [" + body.error.errors.map(function (entry) { return entry.reason || ""; }).join(",") + "]";
        }
      } catch (ignored) {}
      throw new Error("Google Tasks API HTTP " + status + ": " + detail);
    }
    return text ? JSON.parse(text) : {};
  }
  throw new Error("OAuth de Google Tasks rechazado (HTTP 401). Comprueba el refresh token guardado en Propiedades del script.");
}

function googleTasksAccessToken_(cacheKey, forceRefresh) {
  const properties = PropertiesService.getScriptProperties();
  const cache = CacheService.getScriptCache();
  if (!forceRefresh) {
    const cached = cache.get(cacheKey);
    if (cached) return cached;
  }
  const clientId = properties.getProperty("GOOGLE_TASKS_CLIENT_ID");
  const clientSecret = properties.getProperty("GOOGLE_TASKS_CLIENT_SECRET");
  const refreshToken = properties.getProperty("GOOGLE_TASKS_REFRESH_TOKEN");
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("Faltan GOOGLE_TASKS_CLIENT_ID, GOOGLE_TASKS_CLIENT_SECRET o GOOGLE_TASKS_REFRESH_TOKEN en Propiedades del script.");
  }
  const form = [
    ["client_id", clientId], ["client_secret", clientSecret],
    ["refresh_token", refreshToken], ["grant_type", "refresh_token"]
  ].map(function (pair) { return encodeURIComponent(pair[0]) + "=" + encodeURIComponent(pair[1]); }).join("&");
  const response = UrlFetchApp.fetch("https://oauth2.googleapis.com/token", {
    method: "post",
    contentType: "application/x-www-form-urlencoded",
    payload: form,
    muteHttpExceptions: true
  });
  const status = response.getResponseCode();
  const text = response.getContentText();
  let body = {};
  try { body = JSON.parse(text); } catch (ignored) {}
  if (status < 200 || status >= 300 || !body.access_token) {
    const reason = body.error_description || body.error || ("HTTP " + status);
    throw new Error("No se pudo renovar el OAuth de Google Tasks: " + reason + ". Revisa las credenciales de Propiedades del script.");
  }
  cache.put(cacheKey, body.access_token, Math.max(60, Math.min(Number(body.expires_in || 3600) - 120, 21600)));
  return body.access_token;
}

function errorMessage_(error) { return String(error && error.message ? error.message : error); }
function isDailyQuotaError_(message) { return /dailyLimitExceeded|quotaExceeded|daily quota|quota.*(exceed|limit)|limit.*quota|limit exceeded.*day|per.?day|too many times.*day/i.test(message); }
function isTransientApiError_(message) { return /rateLimitExceeded|userRateLimitExceeded|RESOURCE_EXHAUSTED|\b429\b|\b5\d\d\b|backendError|service unavailable|temporarily unavailable|too many requests|too many times/i.test(message); }
function isQuotaPause_(error) { return /PAUSED_QUOTA:|rateLimitExceeded|userRateLimitExceeded|quotaExceeded|dailyLimitExceeded|RESOURCE_EXHAUSTED|\b429\b|\b5\d\d\b|too many requests|too many times|quota.*(exceed|limit)/i.test(errorMessage_(error)); }
function isExpiredPageToken_(error) { return /page.?token|invalid argument.*token|invalid.*token|token.*expired/i.test(errorMessage_(error)); }
function quotaCooldownMs_(error) { return isDailyQuotaError_(errorMessage_(error)) ? 6 * 60 * 60 * 1000 : 15 * 60 * 1000; }

function hashGoogle_(task) {
  return digest_([task.title || "", task.notes || "", task.status || "needsAction",
    task.due ? normalizedDate_(task.due) : "", String(Boolean(task.deleted))].join("\u001f"));
}
function hashSheet_(row) {
  const status = ["end", "done", "closed", "cerrado", "completado"].indexOf(val_(row, "status").toLowerCase()) >= 0 ||
    ["true", "yes", "1"].indexOf(val_(row, "completed").toLowerCase()) >= 0 ? "completed" : "needsAction";
  const due = val_(row, "due_at");
  return digest_([val_(row, "title"), val_(row, "notes"), status,
    due ? normalizedDate_(due) : "", String(["true", "yes", "1"].indexOf(val_(row, "deleted").toLowerCase()) >= 0)].join("\u001f"));
}
function setHashes_(row, task) {
  row[col_("sheet_sync_hash")] = hashSheet_(row);
  row[col_("google_sync_hash")] = hashGoogle_(task);
}
function digest_(text) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text)
    .map(function (byte) { return (byte + 256).toString(16).slice(-2); }).join("");
}
function normalizedDate_(value) { const date = new Date(value); return isNaN(date.getTime()) ? String(value) : date.toISOString(); }

function normalize_(value) { return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase(); }
function truthy_(value) { return value === true || ["true", "yes", "si", "sí", "1"].indexOf(String(value || "").trim().toLowerCase()) >= 0; }
function ensureSheet_(ss, name, header) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  if (!sheet.getLastRow()) sheet.getRange(1, 1, 1, header.length).setValues([header]);
  else {
    const existing = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1)).getDisplayValues()[0];
    const comparableColumns = Math.min(existing.length, header.length);
    if (name === CFG.TASKS_SHEET && header.slice(0, comparableColumns).some(function (cell, index) { return existing[index] !== cell; })) {
      throw new Error("La pestaña Tasks ya existe con un esquema distinto. No se ha reordenado ni sobrescrito; renómbrala o migra sus columnas antes de ejecutar setup().");
    }
    const missing = header.filter(function (cell) { return existing.indexOf(cell) < 0; });
    if (missing.length) sheet.getRange(1, existing.length + 1, 1, missing.length).setValues([missing]);
  }
  return sheet;
}
function col_(name) { return CFG.HEADERS.indexOf(name); }
function emptyRow_() { return new Array(CFG.HEADERS.length).fill(""); }
function val_(row, name) { return String(row[col_(name)] || "").trim(); }
function readTasks_() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(CFG.TASKS_SHEET);
  if (!sheet) throw new Error("Falta la pestaña Tasks; ejecuta setup()");
  if (sheet.getLastColumn() < CFG.HEADERS.length) ensureSheet_(SpreadsheetApp.getActive(), CFG.TASKS_SHEET, CFG.HEADERS);
  const lastRow = sheet.getLastRow();
  const values = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, CFG.HEADERS.length).getValues() : [];
  let count = values.length;
  while (count > 0 && !isMeaningfulTaskRow_(values[count - 1])) count--;
  return { sheet: sheet, rows: count ? values.slice(0, count).map(function (row) {
    return row.map(function (value) { return value instanceof Date ? value.toISOString() : String(value == null ? "" : value); });
  }) : [] };
}
function meaningfulLastTaskRow_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 1;
  const values = sheet.getRange(2, 1, lastRow - 1, CFG.HEADERS.length).getValues();
  for (let rowIndex = values.length - 1; rowIndex >= 0; rowIndex--) {
    if (isMeaningfulTaskRow_(values[rowIndex])) return rowIndex + 2;
  }
  return 1;
}
function isMeaningfulTaskRow_(row) {
  for (let column = 0; column < CFG.HEADERS.length; column++) {
    if (column === col_("sync_to_google")) continue;
    const value = row[column];
    // A previous off-by-one wrote unchecked checkbox values into google_tasks_etag.
    if (column === col_("google_tasks_etag") && (value === false || String(value).toLowerCase() === "false")) continue;
    if (value !== "" && value !== null) return true;
  }
  return false;
}
function setTaskCheckboxValidation_(sheet, startRow, rowCount) {
  if (rowCount < 1) return;
  const checkboxRule = SpreadsheetApp.newDataValidation().requireCheckbox().build();
  sheet.getRange(startRow, col_("sync_to_google") + 1, rowCount, 1).setDataValidation(checkboxRule);
}
function writeAllTasks_(rows) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(CFG.TASKS_SHEET);
  if (rows.length) sheet.getRange(2, 1, rows.length, CFG.HEADERS.length).setValues(rows);
}
function readState_() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(CFG.STATE_SHEET);
  const result = {};
  if (!sheet || sheet.getLastRow() < 2) return result;
  sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getDisplayValues().forEach(function (row) {
    result[row[0]] = row[1];
  });
  return result;
}
function writeState_(updates) {
  const sheet = ensureSheet_(SpreadsheetApp.getActive(), CFG.STATE_SHEET, ["key", "value"]);
  const rows = sheet.getLastRow() > 1 ? sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getDisplayValues() : [];
  Object.keys(updates).forEach(function (key) {
    const index = rows.findIndex(function (row) { return row[0] === key; });
    if (index >= 0) { rows[index][1] = updates[key]; sheet.getRange(index + 2, 1, 1, 2).setValues([rows[index]]); }
    else sheet.appendRow([key, updates[key]]);
  });
}
function log_(level, message, details) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(CFG.LOG_SHEET);
  if (sheet) sheet.appendRow([new Date().toISOString(), level, message, details || ""]);
}
