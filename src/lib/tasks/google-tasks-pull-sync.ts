import { google, tasks_v1 } from "googleapis";

import {
  GoogleTasksUpsertInput,
  upsertMasterTasksFromGoogleTasksBatch
} from "@/lib/tasks/sheets-master-store";
import {
  getSyncState,
  setSyncState,
  upsertTaskMappingsBatch
} from "@/lib/tasks/sheets-meta-store";

type SyncStats = {
  pulled: number;
  upserted: number;
  skippedProcessed: number;
  cursorUsed: string;
  cursorSaved: string;
  resetHappened: boolean;
};

function env(name: string): string {
  return (process.env[name] || "").trim();
}

function required(name: string): string {
  const value = env(name);
  if (!value) {
    throw new Error(`Missing env var: ${name}`);
  }
  return value;
}

function scopeId(): string {
  return env("GOOGLE_TASKS_SCOPE_ID") || "default";
}

function providerName(): string {
  return "google_tasks";
}

function taskListId(): string {
  return env("GOOGLE_TASKS_TASKLIST_ID") || "@default";
}

function initialUpdatedMin(): string {
  return env("GOOGLE_TASKS_INITIAL_UPDATED_MIN") || "1970-01-01T00:00:00.000Z";
}

function nowIso(): string {
  return new Date().toISOString();
}

function mapStatus(task: tasks_v1.Schema$Task): string {
  return task.status === "completed" ? "done" : "wip";
}

function normalizeDueAt(task: tasks_v1.Schema$Task): string {
  return (task.due || "").trim();
}

function normalizeUpdatedAt(task: tasks_v1.Schema$Task): string {
  return (task.updated || task.completed || task.due || new Date().toISOString()).trim();
}

function buildOAuthClient() {
  const clientId = required("GOOGLE_TASKS_CLIENT_ID");
  const clientSecret = required("GOOGLE_TASKS_CLIENT_SECRET");
  const refreshToken = required("GOOGLE_TASKS_REFRESH_TOKEN");
  const redirectUri = env("GOOGLE_TASKS_REDIRECT_URI") || "http://localhost";

  const oauth = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  oauth.setCredentials({ refresh_token: refreshToken });
  return oauth;
}

async function pullPage(
  tasksApi: tasks_v1.Tasks,
  params: tasks_v1.Params$Resource$Tasks$List
): Promise<tasks_v1.Schema$Tasks> {
  const response = await tasksApi.tasks.list(params);
  return response.data;
}

export async function runGoogleTasksPullSync(): Promise<SyncStats> {
  const oauth = buildOAuthClient();
  const tasksApi = google.tasks({ version: "v1", auth: oauth });

  const scope = scopeId();
  const syncState = await getSyncState(providerName(), scope);

  let cursorUsed = (syncState?.cursor || "").trim();
  let resetHappened = false;

  const stats: SyncStats = {
    pulled: 0,
    upserted: 0,
    skippedProcessed: 0,
    cursorUsed,
    cursorSaved: cursorUsed,
    resetHappened
  };

  let pageToken = "";
  let maxUpdatedAt = cursorUsed || "";

  const executePull = async (useCursor: string) => {
    pageToken = "";
    maxUpdatedAt = useCursor || maxUpdatedAt;

    do {
      const params: tasks_v1.Params$Resource$Tasks$List = {
        tasklist: taskListId(),
        maxResults: 100,
        showCompleted: true,
        showDeleted: true,
        showHidden: true,
        pageToken: pageToken || undefined
      };

      params.updatedMin = useCursor || initialUpdatedMin();

      const page = await pullPage(tasksApi, params);
      const items = page.items || [];
      const batchInputs: GoogleTasksUpsertInput[] = [];

      for (const task of items) {
        if (!task.id) continue;

        stats.pulled += 1;
        batchInputs.push({
          googleTasksId: task.id,
          googleTasksEtag: task.etag || "",
          title: task.title || "(untitled)",
          notes: task.notes || "",
          status: mapStatus(task),
          dueAt: normalizeDueAt(task),
          deleted: Boolean(task.deleted),
          updatedAt: normalizeUpdatedAt(task)
        });

        const taskUpdatedAt = normalizeUpdatedAt(task);
        if (!maxUpdatedAt || taskUpdatedAt > maxUpdatedAt) {
          maxUpdatedAt = taskUpdatedAt;
        }
      }

      const upsertedRows = await upsertMasterTasksFromGoogleTasksBatch(batchInputs);
      stats.upserted += upsertedRows.length;

      await upsertTaskMappingsBatch(
        upsertedRows.map((row) => ({
          taskUuid: row.taskUuid,
          googleTasksId: row.googleTasksId,
          updatedAt: new Date().toISOString()
        }))
      );

      pageToken = (page.nextPageToken || "").trim();
    } while (pageToken);
  };

  try {
    await executePull(cursorUsed);
  } catch (error) {
    await setSyncState({
      provider: providerName(),
      scopeId: scope,
      cursor: cursorUsed,
      lastError: error instanceof Error ? error.message : "unknown error",
      lastSuccessAt: syncState?.lastSuccessAt || ""
    });
    throw error;
  }

  const cursorToSave = maxUpdatedAt || nowIso();

  await setSyncState({
    provider: providerName(),
    scopeId: scope,
    cursor: cursorToSave,
    lastSuccessAt: new Date().toISOString(),
    lastError: ""
  });

  stats.cursorUsed = syncState?.cursor || "";
  stats.cursorSaved = cursorToSave;
  stats.resetHappened = resetHappened;

  return stats;
}
