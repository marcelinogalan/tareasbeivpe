"use client";

import { useEffect, useMemo, useState } from "react";

import { TaskCreateDraft, TaskForm } from "@/components/TaskForm";
import { isDirectSheetsConfigured, listTasksDirectFromSheets } from "@/lib/direct-sheets-client";
import { TASKS_STORAGE_KEY, parseStoredTasks } from "@/lib/task-logic";
import { TaskList } from "@/components/TaskList";
import { BASE_TAG_OPTIONS } from "@/lib/tag-options";
import { Task } from "@/types/task";

const EMPTY_DRAFT: TaskCreateDraft = {
  title: "",
  description: "",
  tags: "",
  assignee: "",
  status: "New",
  urgency: "",
  deadline: ""
};

type StatusFilter = "non_end" | "all" | "end" | "wip" | "blocked";
type SyncStatus = {
  remoteEnabled: boolean;
  pendingOperations: number;
  sync: {
    lastAttemptAt?: string;
    lastSuccessAt?: string;
    lastError?: string;
  };
};

export function TaskApp() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [draft, setDraft] = useState<TaskCreateDraft>(EMPTY_DRAFT);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [tagFilter, setTagFilter] = useState("all");
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [online, setOnline] = useState(true);
  const [localOnlyMode, setLocalOnlyMode] = useState(false);

  function readLocalTasks(): Task[] {
    if (typeof window === "undefined") return [];
    return parseStoredTasks(window.localStorage.getItem(TASKS_STORAGE_KEY));
  }

  function writeLocalTasks(nextTasks: Task[]) {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(TASKS_STORAGE_KEY, JSON.stringify(nextTasks));
  }

  function buildLocalTaskFromDraft(currentDraft: TaskCreateDraft): Task {
    const cleanTitle = currentDraft.title.trim();
    const randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);

    return {
      id: randomUUID ? randomUUID() : `local-${Date.now()}-${Math.random()}`,
      title: cleanTitle,
      completed: false,
      createdAt: new Date().toISOString(),
      description: currentDraft.description.trim(),
      nextSteps: "",
      notes: "",
      tags: currentDraft.tags.trim(),
      assignee: currentDraft.assignee.trim(),
      status: currentDraft.status.trim() || "New",
      urgency: currentDraft.urgency.trim(),
      deadline: currentDraft.deadline.trim()
    };
  }

  function updateLocalTaskState(taskId: string, updates: Partial<Task>) {
    setTasks((previous) => {
      const next = previous.map((item) => (item.id === taskId ? { ...item, ...updates } : item));
      writeLocalTasks(next);
      return next;
    });
  }

  useEffect(() => {
    let active = true;

    async function fetchTasks() {
      try {
        const response = await fetch("/api/tasks");
        if (!response.ok) {
          throw new Error("No se pudo cargar la actividad");
        }

        const payload = (await response.json()) as { tasks: Task[] };
        if (active) {
          setTasks(payload.tasks);
          writeLocalTasks(payload.tasks);
          setLocalOnlyMode(false);
          setError(null);
        }
      } catch {
        if (!active) return;

        if (isDirectSheetsConfigured()) {
          try {
            const directTasks = await listTasksDirectFromSheets();
            if (!active) return;
            setTasks(directTasks);
            writeLocalTasks(directTasks);
            setLocalOnlyMode(false);
            setSyncStatus({
              remoteEnabled: true,
              pendingOperations: 0,
              sync: {
                lastSuccessAt: new Date().toISOString()
              }
            });
            setError("Conectado directo a Google Sheets (inseguro)");
            return;
          } catch {
            // Fallback to local mode.
          }
        }

        const localTasks = readLocalTasks();
        setTasks(localTasks);
        setLocalOnlyMode(true);
        setSyncStatus({
          remoteEnabled: false,
          pendingOperations: 0,
          sync: {}
        });
        setError("Modo local PWA activo");
      }
    }

    async function fetchSyncStatus() {
      try {
        const response = await fetch("/api/tasks/sync");
        if (!response.ok) return;
        const payload = (await response.json()) as SyncStatus;
        if (active) {
          setSyncStatus(payload);
        }
      } catch {
        // Keep UI usable even if sync status endpoint is unavailable.
        if (active && localOnlyMode) {
          setSyncStatus({
            remoteEnabled: false,
            pendingOperations: 0,
            sync: {}
          });
        }
      }
    }

    fetchTasks();
    fetchSyncStatus();
    setOnline(typeof navigator === "undefined" ? true : navigator.onLine);

    const handleOnline = () => {
      setOnline(true);
      void syncNow(true);
    };
    const handleOffline = () => setOnline(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      active = false;
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  useEffect(() => {
    if (!online || localOnlyMode) return;

    const interval = window.setInterval(() => {
      const hasPending = (syncStatus?.pendingOperations || 0) > 0;
      if (hasPending) {
        void syncNow(true);
        return;
      }

      if (syncStatus?.remoteEnabled) {
        void syncNow(true);
        return;
      }

      void refreshSyncStatus();
    }, 20_000);

    return () => window.clearInterval(interval);
  }, [online, localOnlyMode, syncStatus?.pendingOperations, syncStatus?.remoteEnabled]);

  useEffect(() => {
    if (!online || !localOnlyMode) return;

    const interval = window.setInterval(() => {
      void recoverFromApi(true);
    }, 10_000);

    return () => window.clearInterval(interval);
  }, [online, localOnlyMode]);

  async function refreshSyncStatus() {
    try {
      const response = await fetch("/api/tasks/sync");
      if (!response.ok) return;
      const payload = (await response.json()) as SyncStatus;
      setSyncStatus(payload);
    } catch {
      // No-op: sync status is informational only.
    }
  }

  async function recoverFromApi(silent = false): Promise<boolean> {
    try {
      const response = await fetch("/api/tasks");
      if (!response.ok) {
        throw new Error("No se pudo cargar la actividad");
      }

      const payload = (await response.json()) as { tasks: Task[] };
      setTasks(payload.tasks);
      writeLocalTasks(payload.tasks);
      setLocalOnlyMode(false);
      if (!silent) {
        setError(null);
      }
      await refreshSyncStatus();
      return true;
    } catch {
      if (isDirectSheetsConfigured()) {
        try {
          const directTasks = await listTasksDirectFromSheets();
          setTasks(directTasks);
          writeLocalTasks(directTasks);
          setLocalOnlyMode(false);
          setSyncStatus({
            remoteEnabled: true,
            pendingOperations: 0,
            sync: {
              lastSuccessAt: new Date().toISOString()
            }
          });
          if (!silent) {
            setError("Conectado directo a Google Sheets (inseguro)");
          }
          return true;
        } catch {
          // continue with normal fallback below
        }
      }

      if (!silent) {
        setError("No se pudo reconectar con el backend");
      }
      return false;
    }
  }

  async function createTask() {
    const cleanTitle = draft.title.trim();
    if (!cleanTitle) return;
    const deadline =
      /^\d{4}-\d{2}-\d{2}$/.test(draft.deadline)
        ? `${draft.deadline.slice(8, 10)}/${draft.deadline.slice(5, 7)}/${draft.deadline.slice(0, 4)}`
        : draft.deadline;

    setLoading(true);
    try {
      const response = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...draft, title: cleanTitle, deadline })
      });
      if (!response.ok) {
        throw new Error("No se pudo registrar la actividad");
      }

      const payload = (await response.json()) as { task: Task };
      setTasks((previous) => {
        const next = [payload.task, ...previous];
        writeLocalTasks(next);
        return next;
      });
      setDraft(EMPTY_DRAFT);
      setError(null);
      setLocalOnlyMode(false);
      await refreshSyncStatus();
    } catch {
      const localTask = buildLocalTaskFromDraft(draft);
      setTasks((previous) => {
        const next = [localTask, ...previous];
        writeLocalTasks(next);
        return next;
      });
      setDraft(EMPTY_DRAFT);
      setLocalOnlyMode(true);
      setSyncStatus({
        remoteEnabled: false,
        pendingOperations: 0,
        sync: {}
      });
      setError("Guardado en modo local PWA");
    } finally {
      setLoading(false);
    }
  }

  async function updateTask(task: Task, updates: Partial<Task>) {
    try {
      const response = await fetch(`/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates)
      });

      if (!response.ok) {
        throw new Error("No se pudo actualizar la actividad");
      }

      const payload = (await response.json()) as { task: Task };
      setTasks((previous) => {
        const next = previous.map((item) => (item.id === task.id ? payload.task : item));
        writeLocalTasks(next);
        return next;
      });
      setError(null);
      setLocalOnlyMode(false);
      await refreshSyncStatus();
    } catch {
      updateLocalTaskState(task.id, updates);
      setLocalOnlyMode(true);
      setSyncStatus({
        remoteEnabled: false,
        pendingOperations: 0,
        sync: {}
      });
      setError("Actualizado en modo local PWA");
    }
  }

  async function syncNow(silent = false) {
    if (localOnlyMode) {
      const recovered = await recoverFromApi(silent);
      if (!recovered && !silent) {
        setError("Modo local activo: no hay backend disponible para sincronizar");
      }
      return;
    }

    try {
      const response = await fetch("/api/tasks/sync", { method: "POST" });
      if (!response.ok) {
        if (!silent) {
          setError("No se pudo sincronizar");
        }
        return;
      }
      const payload = (await response.json()) as SyncStatus;
      setSyncStatus(payload);
      if (!silent) {
        setError(null);
      }

      if (payload.remoteEnabled || payload.pendingOperations === 0) {
        const tasksResponse = await fetch("/api/tasks");
        if (tasksResponse.ok) {
          const tasksPayload = (await tasksResponse.json()) as { tasks: Task[] };
          setTasks(tasksPayload.tasks);
          writeLocalTasks(tasksPayload.tasks);
        }
      }
    } catch {
      if (!silent) {
        setError("No se pudo sincronizar");
      }
    }
  }

  const completedCount = tasks.filter((task) => task.completed).length;
  const pendingCount = tasks.length - completedCount;
  const completionRate = tasks.length ? Math.round((completedCount / tasks.length) * 100) : 0;
  const availableTags = useMemo(() => {
    const unique = new Map<string, string>();
    for (const baseTag of BASE_TAG_OPTIONS) {
      unique.set(baseTag.toLowerCase(), baseTag);
    }
    for (const task of tasks) {
      const raw = task.tags || "";
      const tokens = raw
        .split(",")
        .map((token) => token.trim())
        .filter(Boolean);
      for (const token of tokens) {
        const key = token.toLowerCase();
        if (!unique.has(key)) unique.set(key, token);
      }
    }
    return Array.from(unique.values()).sort((a, b) => a.localeCompare(b));
  }, [tasks]);

  const filteredTasks = useMemo(() => {
    return tasks.filter((task) => {
      const normalizedStatus = (task.status || (task.completed ? "End" : "WIP")).trim().toLowerCase();
      const normalizedTags = (task.tags || "")
        .split(",")
        .map((token) => token.trim().toLowerCase())
        .filter(Boolean);

      const statusPass =
        statusFilter === "all"
          ? true
          : statusFilter === "non_end"
            ? normalizedStatus !== "end"
            : statusFilter === "end"
              ? normalizedStatus === "end"
              : statusFilter === "wip"
                ? normalizedStatus === "wip"
                : normalizedStatus === "blocked";

      const tagPass = tagFilter === "all" ? true : normalizedTags.includes(tagFilter.toLowerCase());
      return statusPass && tagPass;
    });
  }, [tasks, statusFilter, tagFilter]);

  return (
    <section className="hb-shell">
      <div className="hb-stack">
        <article className="hb-card">
          <p className="hb-card-label">Nueva actividad</p>
          <TaskForm value={draft} onChange={setDraft} onSubmit={createTask} loading={loading} />
        </article>

        <section className="hb-card hb-right">
          <div className="hb-right-head">
            <p className="hb-card-label">Tabla de actividades</p>
            <div className="hb-sync-group">
              <span className={`hb-tag ${online ? "" : "is-offline"}`}>{online ? "Online" : "Offline"}</span>
              <span className={`hb-tag ${syncStatus?.remoteEnabled ? "" : "is-local"}`}>
                {syncStatus?.remoteEnabled ? "Sync remoto" : "Solo local"}
              </span>
              <button className="hb-sync-button" type="button" onClick={() => void syncNow()}>
                Sincronizar
              </button>
            </div>
          </div>
          {syncStatus ? (
            <p className="hb-sync-note">
              Pendientes: {syncStatus.pendingOperations}
              {syncStatus.sync.lastSuccessAt
                ? ` · Ultima sync: ${new Date(syncStatus.sync.lastSuccessAt).toLocaleString()}`
                : ""}
              {syncStatus.sync.lastError ? ` · Error: ${syncStatus.sync.lastError}` : ""}
            </p>
          ) : null}

          <div className="hb-summary-row">
            <article className="hb-summary-card">
              <p className="hb-card-label">Total</p>
              <p className="hb-metric-value">{tasks.length}</p>
            </article>
            <article className="hb-summary-card">
              <p className="hb-card-label">Pendientes</p>
              <p className="hb-metric-value">{pendingCount}</p>
            </article>
            <article className="hb-summary-card">
              <p className="hb-card-label">Completadas</p>
              <p className="hb-metric-value">{completedCount}</p>
            </article>
            <article className="hb-summary-card">
              <p className="hb-card-label">Avance</p>
              <p className="hb-metric-value">{completionRate}%</p>
            </article>
          </div>

          {error ? <p className="hb-error">{error}</p> : null}
          <div className="task-filters">
            <div className="task-filter-item">
              <label className="hb-card-label" htmlFor="status-filter">
                Filtro por estado
              </label>
              <select
                id="status-filter"
                className="task-input task-filter-select"
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
              >
                <option value="non_end">No finalizado</option>
                <option value="all">Todos</option>
                <option value="end">End</option>
                <option value="wip">WIP</option>
                <option value="blocked">Blocked</option>
              </select>
            </div>

            <div className="task-filter-item">
              <label className="hb-card-label" htmlFor="tag-filter">
                Filtro por etiqueta
              </label>
              <select
                id="tag-filter"
                className="task-input task-filter-select"
                value={tagFilter}
                onChange={(event) => setTagFilter(event.target.value)}
              >
                <option value="all">Todas</option>
                {availableTags.map((tag) => (
                  <option key={tag} value={tag}>
                    {tag}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <TaskList tasks={filteredTasks} onUpdate={updateTask} tagOptions={availableTags} />
        </section>
      </div>
    </section>
  );
}
