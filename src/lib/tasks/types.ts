import { Task } from "@/types/task";

export type UpdateTaskInput = {
  title?: string;
  completed?: boolean;
  description?: string;
  nextSteps?: string;
  notes?: string;
  tags?: string;
  assignee?: string;
  status?: string;
  urgency?: string;
  deadline?: string;
  origin?: string;
  country?: string;
  workstream?: string;
  scope?: string;
};

export type CreateTaskInput = Omit<Task, "id" | "createdAt" | "completed"> & {
  title: string;
  id?: string;
  createdAt?: string;
  completed?: boolean;
};

export type PendingOperationType = "create" | "update" | "delete";

export type PendingOperation = {
  id: string;
  type: PendingOperationType;
  taskId: string;
  payload?: Partial<Task>;
  createdAt: string;
  attempts: number;
  lastError?: string;
};

export type SyncState = {
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
};

export type TasksDatabase = {
  tasks: Task[];
  pendingOps: PendingOperation[];
  sync: SyncState;
};
