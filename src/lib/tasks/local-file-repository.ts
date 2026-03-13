import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, resolve } from "path";
import { randomUUID } from "crypto";

import { Task } from "@/types/task";

import { LocalTaskRepository } from "@/lib/tasks/repository";
import { CreateTaskInput, PendingOperation, SyncState, TasksDatabase, UpdateTaskInput } from "@/lib/tasks/types";

const DEFAULT_DB_PATH = ".data/tasks-db.json";

const EMPTY_DB: TasksDatabase = {
  tasks: [],
  pendingOps: [],
  sync: {}
};

function clean(value: string | undefined): string {
  return (value || "").trim();
}

function normalizeStatus(status: string | undefined, completed: boolean): string {
  const next = clean(status);
  if (next) return next;
  return completed ? "End" : "WIP";
}

function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    const aUrgent = (a.urgency || "").trim().toLowerCase() === "urgente" ? 1 : 0;
    const bUrgent = (b.urgency || "").trim().toLowerCase() === "urgente" ? 1 : 0;
    if (aUrgent !== bUrgent) {
      return bUrgent - aUrgent;
    }

    return Date.parse(b.createdAt) - Date.parse(a.createdAt);
  });
}

export class LocalFileTaskRepository implements LocalTaskRepository {
  private readonly dbPath: string;

  private writeQueue: Promise<void> = Promise.resolve();

  constructor() {
    this.dbPath = resolve(process.cwd(), process.env.TASKS_LOCAL_DB_PATH || DEFAULT_DB_PATH);
  }

  async listTasks(): Promise<Task[]> {
    const db = await this.readDb();
    return sortTasks(db.tasks);
  }

  async addTask(input: CreateTaskInput): Promise<Task> {
    const title = clean(input.title);
    const now = new Date().toISOString();
    const task: Task = {
      id: input.id || randomUUID(),
      title,
      completed: input.completed ?? false,
      createdAt: input.createdAt || now,
      description: clean(input.description),
      nextSteps: clean(input.nextSteps),
      notes: clean(input.notes),
      tags: clean(input.tags),
      assignee: clean(input.assignee),
      status: normalizeStatus(input.status, input.completed ?? false),
      urgency: clean(input.urgency),
      deadline: clean(input.deadline),
      origin: clean(input.origin),
      country: clean(input.country),
      workstream: clean(input.workstream),
      scope: clean(input.scope)
    };

    await this.withWriteLock(async (db) => {
      db.tasks = sortTasks([task, ...db.tasks]);
      db.pendingOps.push(this.buildPendingOperation("create", task.id, task));
    });

    return task;
  }

  async updateTask(id: string, input: UpdateTaskInput): Promise<Task | null> {
    let updated: Task | null = null;

    await this.withWriteLock(async (db) => {
      const index = db.tasks.findIndex((task) => task.id === id);
      if (index < 0) return;

      const current = db.tasks[index];
      const completed = typeof input.completed === "boolean" ? input.completed : current.completed;

      updated = {
        ...current,
        ...input,
        title: typeof input.title === "string" ? clean(input.title) : current.title,
        description: typeof input.description === "string" ? clean(input.description) : current.description,
        nextSteps: typeof input.nextSteps === "string" ? clean(input.nextSteps) : current.nextSteps,
        notes: typeof input.notes === "string" ? clean(input.notes) : current.notes,
        tags: typeof input.tags === "string" ? clean(input.tags) : current.tags,
        assignee: typeof input.assignee === "string" ? clean(input.assignee) : current.assignee,
        urgency: typeof input.urgency === "string" ? clean(input.urgency) : current.urgency,
        deadline: typeof input.deadline === "string" ? clean(input.deadline) : current.deadline,
        origin: typeof input.origin === "string" ? clean(input.origin) : current.origin,
        country: typeof input.country === "string" ? clean(input.country) : current.country,
        workstream: typeof input.workstream === "string" ? clean(input.workstream) : current.workstream,
        scope: typeof input.scope === "string" ? clean(input.scope) : current.scope,
        status: normalizeStatus(
          typeof input.status === "string" ? input.status : current.status,
          completed
        ),
        completed
      };

      db.tasks[index] = updated;
      db.tasks = sortTasks(db.tasks);
      db.pendingOps.push(this.buildPendingOperation("update", id, input));
    });

    return updated;
  }

  async removeTask(id: string): Promise<boolean> {
    let deleted = false;

    await this.withWriteLock(async (db) => {
      const before = db.tasks.length;
      db.tasks = db.tasks.filter((task) => task.id !== id);
      deleted = db.tasks.length !== before;
      if (deleted) {
        db.pendingOps.push(this.buildPendingOperation("delete", id));
      }
    });

    return deleted;
  }

  async listPendingOperations(): Promise<PendingOperation[]> {
    const db = await this.readDb();
    return [...db.pendingOps].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  }

  async markPendingOperationDone(operationId: string): Promise<void> {
    await this.withWriteLock(async (db) => {
      db.pendingOps = db.pendingOps.filter((op) => op.id !== operationId);
    });
  }

  async markPendingOperationFailed(operationId: string, errorMessage: string): Promise<void> {
    await this.withWriteLock(async (db) => {
      db.pendingOps = db.pendingOps.map((op) => {
        if (op.id !== operationId) return op;
        return {
          ...op,
          attempts: op.attempts + 1,
          lastError: errorMessage
        };
      });
    });
  }

  async getSyncState(): Promise<SyncState> {
    const db = await this.readDb();
    return db.sync;
  }

  async setSyncState(next: SyncState): Promise<void> {
    await this.withWriteLock(async (db) => {
      db.sync = {
        ...db.sync,
        ...next
      };
    });
  }

  async replaceTasks(tasks: Task[]): Promise<void> {
    await this.withWriteLock(async (db) => {
      if (db.pendingOps.length > 0) {
        return;
      }
      db.tasks = sortTasks(tasks);
    });
  }

  private buildPendingOperation(
    type: PendingOperation["type"],
    taskId: string,
    payload?: PendingOperation["payload"]
  ): PendingOperation {
    return {
      id: randomUUID(),
      type,
      taskId,
      payload,
      createdAt: new Date().toISOString(),
      attempts: 0
    };
  }

  private async withWriteLock(mutator: (db: TasksDatabase) => Promise<void> | void): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      const db = await this.readDb();
      await mutator(db);
      await this.writeDb(db);
    });

    await this.writeQueue;
  }

  private async readDb(): Promise<TasksDatabase> {
    try {
      const raw = await readFile(this.dbPath, "utf-8");
      const parsed = JSON.parse(raw) as TasksDatabase;

      return {
        tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
        pendingOps: Array.isArray(parsed.pendingOps) ? parsed.pendingOps : [],
        sync: parsed.sync || {}
      };
    } catch {
      await this.writeDb({ ...EMPTY_DB });
      return { ...EMPTY_DB };
    }
  }

  private async writeDb(db: TasksDatabase): Promise<void> {
    await mkdir(dirname(this.dbPath), { recursive: true });
    await writeFile(this.dbPath, JSON.stringify(db, null, 2), "utf-8");
  }
}
