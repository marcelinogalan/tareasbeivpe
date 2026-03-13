import { Task } from "@/types/task";

import { LocalTaskRepository, TaskRepository } from "@/lib/tasks/repository";

export class TasksSyncService {
  private activeSync: Promise<void> | null = null;

  constructor(
    private readonly localRepository: LocalTaskRepository,
    private readonly remoteRepository: TaskRepository | null
  ) {}

  async bootstrapFromRemote(): Promise<void> {
    if (!this.remoteRepository) return;

    const pending = await this.localRepository.listPendingOperations();
    if (pending.length > 0) {
      return;
    }

    const local = await this.localRepository.listTasks();
    if (local.length > 0) {
      return;
    }

    const remote = await this.remoteRepository.listTasks();
    if (remote.length === 0) {
      return;
    }

    await this.localRepository.replaceTasks(remote);
  }

  scheduleSync(): void {
    void this.runSync();
  }

  async runSync(): Promise<void> {
    if (!this.remoteRepository) return;
    if (this.activeSync) return this.activeSync;

    this.activeSync = this.performSync().finally(() => {
      this.activeSync = null;
    });

    return this.activeSync;
  }

  private async performSync(): Promise<void> {
    const remote = this.remoteRepository;
    if (!remote) return;

    await this.localRepository.setSyncState({
      lastAttemptAt: new Date().toISOString(),
      lastError: undefined
    });

    const pending = await this.localRepository.listPendingOperations();

    for (const operation of pending) {
      try {
        if (operation.type === "create") {
          const snapshot = operation.payload as Task | undefined;
          if (!snapshot?.title) {
            await this.localRepository.markPendingOperationDone(operation.id);
            continue;
          }

          const created = await remote.addTask({
            ...snapshot,
            id: operation.taskId,
            completed: snapshot.completed
          });

          if (created.id !== operation.taskId) {
            throw new Error("remote create returned a different id");
          }
        }

        if (operation.type === "update") {
          const patch = operation.payload || {};
          const updated = await remote.updateTask(operation.taskId, patch);
          if (!updated) {
            throw new Error("remote task not found for update");
          }
        }

        if (operation.type === "delete") {
          const removed = await remote.removeTask(operation.taskId);
          if (!removed) {
            throw new Error("remote task not found for delete");
          }
        }

        await this.localRepository.markPendingOperationDone(operation.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown sync error";
        await this.localRepository.markPendingOperationFailed(operation.id, message);
        await this.localRepository.setSyncState({ lastError: message });
        return;
      }
    }

    // Pull latest remote snapshot so edits made directly in Sheets are reflected locally.
    const remoteTasks = await remote.listTasks();
    await this.localRepository.replaceTasks(remoteTasks);

    await this.localRepository.setSyncState({
      lastSuccessAt: new Date().toISOString(),
      lastError: undefined
    });
  }
}
