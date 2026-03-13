import {
  getSyncState,
  getTaskMapping,
  isProcessedEvent,
  markProcessedEvent,
  setSyncState,
  upsertTaskMapping
} from "@/lib/tasks/sheets-meta-store";

async function demo() {
  await setSyncState({
    provider: "google_tasks",
    scopeId: "default",
    cursor: "sync-token-123",
    lastSuccessAt: new Date().toISOString(),
    lastError: ""
  });

  const sync = await getSyncState("google_tasks", "default");
  console.log("sync state", sync);

  await markProcessedEvent({
    provider: "google_tasks",
    eventId: "google_tasks:evt:123"
  });

  const alreadyProcessed = await isProcessedEvent("google_tasks", "google_tasks:evt:123");
  console.log("already processed", alreadyProcessed);

  await upsertTaskMapping({
    taskUuid: "task-uuid-001",
    googleTasksId: "gtasks-abc",
    lastSeenEtag: "etag-1"
  });

  const mapping = await getTaskMapping("task-uuid-001");
  console.log("mapping", mapping);
}

void demo();
