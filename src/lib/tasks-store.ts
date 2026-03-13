import { Task } from "@/types/task";

import { LocalFileTaskRepository } from "@/lib/tasks/local-file-repository";
import { TaskRepository } from "@/lib/tasks/repository";
import { TasksSyncService } from "@/lib/tasks/sync-service";
import { addTask as addTaskRemote, listTasks as listTasksRemote, removeTask as removeTaskRemote, updateTask as updateTaskRemote } from "@/lib/tasks/google-sheets-repository";
import { CreateTaskInput, UpdateTaskInput } from "@/lib/tasks/types";

class GoogleTaskRepositoryAdapter implements TaskRepository {
  async listTasks(): Promise<Task[]> {
    return listTasksRemote();
  }

  async addTask(input: CreateTaskInput): Promise<Task> {
    return addTaskRemote(input);
  }

  async updateTask(id: string, input: UpdateTaskInput): Promise<Task | null> {
    return updateTaskRemote(id, input);
  }

  async removeTask(id: string): Promise<boolean> {
    return removeTaskRemote(id);
  }
}

const localRepository = new LocalFileTaskRepository();

function shouldEnableRemoteSync(): boolean {
  const mode = (process.env.TASKS_SYNC_REMOTE || "").trim().toLowerCase();

  const hasGoogleEnv =
    Boolean(process.env.GOOGLE_SHEETS_SPREADSHEET_ID) &&
    Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL) &&
    Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY);

  if (!hasGoogleEnv) return false;

  if (mode === "local" || mode === "off" || mode === "none") {
    return false;
  }

  if (mode === "google") {
    return true;
  }

  // Default: if Google credentials are present, enable remote sync automatically.
  return true;
}

const remoteRepository: TaskRepository | null = shouldEnableRemoteSync()
  ? new GoogleTaskRepositoryAdapter()
  : null;

const syncService = new TasksSyncService(localRepository, remoteRepository);

let bootstrapDone = false;
let lastBackgroundSyncAt = 0;
const BACKGROUND_SYNC_COOLDOWN_MS = 15_000;

async function ensureBootstrap(): Promise<void> {
  if (bootstrapDone) return;
  bootstrapDone = true;

  try {
    await syncService.bootstrapFromRemote();
  } catch (error) {
    console.warn("tasks bootstrap skipped", error);
  }
}

export async function listTasks(): Promise<Task[]> {
  await ensureBootstrap();

  const tasks = await localRepository.listTasks();
  const pending = await localRepository.listPendingOperations();
  const shouldRetryPending =
    pending.length > 0 && Date.now() - lastBackgroundSyncAt >= BACKGROUND_SYNC_COOLDOWN_MS;

  if (tasks.length === 0 || shouldRetryPending) {
    lastBackgroundSyncAt = Date.now();
    syncService.scheduleSync();
  }

  return tasks;
}

export async function addTask(input: CreateTaskInput): Promise<Task> {
  await ensureBootstrap();
  const task = await localRepository.addTask(input);
  syncService.scheduleSync();
  return task;
}

export async function updateTask(id: string, input: UpdateTaskInput): Promise<Task | null> {
  await ensureBootstrap();
  const task = await localRepository.updateTask(id, input);
  if (task) {
    syncService.scheduleSync();
  }
  return task;
}

export async function removeTask(id: string): Promise<boolean> {
  await ensureBootstrap();
  const removed = await localRepository.removeTask(id);
  if (removed) {
    syncService.scheduleSync();
  }
  return removed;
}

export async function getSyncStatus() {
  await ensureBootstrap();
  const [pending, sync] = await Promise.all([
    localRepository.listPendingOperations(),
    localRepository.getSyncState()
  ]);

  return {
    remoteEnabled: Boolean(remoteRepository),
    pendingOperations: pending.length,
    sync
  };
}

export async function runSyncNow() {
  await ensureBootstrap();
  await syncService.runSync();
  return getSyncStatus();
}
