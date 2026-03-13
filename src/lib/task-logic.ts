import { Task } from "@/types/task";

export const TASKS_STORAGE_KEY = "todo.tasks.v1";

function isTask(value: unknown): value is Task {
  if (!value || typeof value !== "object") return false;
  const item = value as Task;
  return (
    typeof item.id === "string" &&
    typeof item.title === "string" &&
    typeof item.completed === "boolean" &&
    typeof item.createdAt === "string"
  );
}

export function parseStoredTasks(raw: string | null): Task[] {
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];

    return parsed.filter(isTask).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch {
    return [];
  }
}

export function createTask(title: string, now: Date = new Date()): Task {
  const cleanTitle = title.trim();
  const randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
  return {
    id: randomUUID ? randomUUID() : `${Date.now()}-${Math.random()}`,
    title: cleanTitle,
    completed: false,
    createdAt: now.toISOString()
  };
}

export function toggleTaskCompletion(tasks: Task[], id: string, completed: boolean): Task[] {
  return tasks.map((task) => (task.id === id ? { ...task, completed } : task));
}

export function editTaskTitle(tasks: Task[], id: string, title: string): Task[] {
  const cleanTitle = title.trim();
  if (!cleanTitle) return tasks;
  return tasks.map((task) => (task.id === id ? { ...task, title: cleanTitle } : task));
}

export function removeTask(tasks: Task[], id: string): Task[] {
  return tasks.filter((task) => task.id !== id);
}
