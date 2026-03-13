import {
  createTask,
  editTaskTitle,
  parseStoredTasks,
  removeTask,
  toggleTaskCompletion
} from "@/lib/task-logic";
import { Task } from "@/types/task";

function task(overrides: Partial<Task>): Task {
  return {
    id: "t1",
    title: "Task",
    completed: false,
    createdAt: "2026-03-11T10:00:00.000Z",
    ...overrides
  };
}

describe("task-logic", () => {
  it("parseStoredTasks returns only valid tasks sorted by newest first", () => {
    const raw = JSON.stringify([
      task({ id: "old", createdAt: "2026-03-10T10:00:00.000Z" }),
      { invalid: true },
      task({ id: "new", createdAt: "2026-03-12T10:00:00.000Z" })
    ]);

    const result = parseStoredTasks(raw);
    expect(result.map((item) => item.id)).toEqual(["new", "old"]);
  });

  it("parseStoredTasks returns empty array for bad json", () => {
    expect(parseStoredTasks("not-json")).toEqual([]);
  });

  it("createTask trims title and marks as not completed", () => {
    const now = new Date("2026-03-11T09:15:00.000Z");
    const result = createTask("  Comprar pan  ", now);

    expect(result.title).toBe("Comprar pan");
    expect(result.completed).toBe(false);
    expect(result.createdAt).toBe("2026-03-11T09:15:00.000Z");
    expect(result.id.length).toBeGreaterThan(0);
  });

  it("toggleTaskCompletion updates only selected task", () => {
    const tasks = [task({ id: "a" }), task({ id: "b" })];
    const result = toggleTaskCompletion(tasks, "b", true);

    expect(result.find((item) => item.id === "a")?.completed).toBe(false);
    expect(result.find((item) => item.id === "b")?.completed).toBe(true);
  });

  it("editTaskTitle trims and updates title", () => {
    const tasks = [task({ id: "a", title: "Viejo" })];
    const result = editTaskTitle(tasks, "a", "  Nuevo  ");

    expect(result[0].title).toBe("Nuevo");
  });

  it("editTaskTitle ignores empty titles", () => {
    const tasks = [task({ id: "a", title: "Original" })];
    const result = editTaskTitle(tasks, "a", "   ");

    expect(result[0].title).toBe("Original");
  });

  it("removeTask deletes selected task", () => {
    const tasks = [task({ id: "a" }), task({ id: "b" })];
    const result = removeTask(tasks, "a");

    expect(result.map((item) => item.id)).toEqual(["b"]);
  });
});
