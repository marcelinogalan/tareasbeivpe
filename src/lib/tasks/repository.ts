import { Task } from "@/types/task";

import { CreateTaskInput, PendingOperation, SyncState, UpdateTaskInput } from "@/lib/tasks/types";

export interface TaskRepository {
  listTasks(): Promise<Task[]>;
  addTask(input: CreateTaskInput): Promise<Task>;
  updateTask(id: string, input: UpdateTaskInput): Promise<Task | null>;
  removeTask(id: string): Promise<boolean>;
}

export interface LocalTaskRepository extends TaskRepository {
  listPendingOperations(): Promise<PendingOperation[]>;
  markPendingOperationDone(operationId: string): Promise<void>;
  markPendingOperationFailed(operationId: string, errorMessage: string): Promise<void>;
  getSyncState(): Promise<SyncState>;
  setSyncState(next: SyncState): Promise<void>;
  replaceTasks(tasks: Task[]): Promise<void>;
}
