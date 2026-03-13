import { createHash, randomUUID } from "crypto";

import { google, sheets_v4 } from "googleapis";

const DEFAULT_MASTER_SHEET_NAME = "TasksMaster";
const READ_RANGE = "A1:Z";

type SheetsClient = sheets_v4.Sheets;

type MasterHeaders =
  | "task_uuid"
  | "title"
  | "notes"
  | "status"
  | "due_at"
  | "priority"
  | "tags"
  | "assignee"
  | "deleted"
  | "version"
  | "updated_at"
  | "source"
  | "sync_hash"
  | "google_tasks_id"
  | "google_tasks_etag"
  | "last_sync_at"
  | "conflict_flag"
  | "conflict_note";

const MASTER_HEADER: MasterHeaders[] = [
  "task_uuid",
  "title",
  "notes",
  "status",
  "due_at",
  "priority",
  "tags",
  "assignee",
  "deleted",
  "version",
  "updated_at",
  "source",
  "sync_hash",
  "google_tasks_id",
  "google_tasks_etag",
  "last_sync_at",
  "conflict_flag",
  "conflict_note"
];

type SheetTable = {
  sheetName: string;
  header: string[];
  rows: string[][];
};

export type MasterTaskRecord = {
  taskUuid: string;
  title: string;
  notes: string;
  status: string;
  dueAt: string;
  priority: string;
  tags: string;
  assignee: string;
  deleted: string;
  version: number;
  updatedAt: string;
  source: string;
  syncHash: string;
  googleTasksId: string;
  googleTasksEtag: string;
  lastSyncAt: string;
  conflictFlag: string;
  conflictNote: string;
};

export type GoogleTasksUpsertInput = {
  taskUuid?: string;
  googleTasksId: string;
  googleTasksEtag?: string;
  title: string;
  notes?: string;
  status: string;
  dueAt?: string;
  deleted?: boolean;
  updatedAt?: string;
};

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing env var: ${name}`);
  }
  return value;
}

function normalizePrivateKey(raw: string): string {
  return raw.replace(/\\n/g, "\n");
}

function clean(value: string | undefined): string {
  return (value || "").trim();
}

function nowIso(): string {
  return new Date().toISOString();
}

function spreadsheetId(): string {
  return getRequiredEnv("GOOGLE_SHEETS_SPREADSHEET_ID");
}

function masterSheetName(): string {
  return clean(process.env.GOOGLE_SHEETS_MASTER_SHEET_NAME || process.env.GOOGLE_SHEETS_SHEET_NAME) || DEFAULT_MASTER_SHEET_NAME;
}

function toA1Column(columnNumber: number): string {
  let col = columnNumber;
  let result = "";
  while (col > 0) {
    const remainder = (col - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    col = Math.floor((col - 1) / 26);
  }
  return result;
}

async function getSheetsClient(): Promise<SheetsClient> {
  const clientEmail = getRequiredEnv("GOOGLE_SERVICE_ACCOUNT_EMAIL");
  const privateKey = normalizePrivateKey(getRequiredEnv("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY"));

  const auth = new google.auth.JWT({
    email: clientEmail,
    key: privateKey,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"]
  });

  return google.sheets({ version: "v4", auth });
}

async function readTable(sheets: SheetsClient, sheetName: string): Promise<SheetTable> {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: spreadsheetId(),
    range: `${sheetName}!${READ_RANGE}`
  });

  const values = (response.data.values || []) as string[][];
  return {
    sheetName,
    header: values[0] || [],
    rows: values.slice(1)
  };
}

async function writeHeaderIfEmpty(
  sheets: SheetsClient,
  table: SheetTable,
  expectedHeader: string[]
): Promise<SheetTable> {
  if (table.header.length > 0) {
    return table;
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId: spreadsheetId(),
    range: `${table.sheetName}!A1:${toA1Column(expectedHeader.length)}1`,
    valueInputOption: "RAW",
    requestBody: {
      values: [expectedHeader]
    }
  });

  return {
    ...table,
    header: expectedHeader,
    rows: []
  };
}

async function ensureHeader(
  sheets: SheetsClient,
  table: SheetTable,
  requiredColumns: string[]
): Promise<SheetTable> {
  const missing = requiredColumns.filter((column) => !table.header.includes(column));
  if (missing.length === 0) return table;

  const nextHeader = [...table.header, ...missing];
  await sheets.spreadsheets.values.update({
    spreadsheetId: spreadsheetId(),
    range: `${table.sheetName}!A1:${toA1Column(nextHeader.length)}1`,
    valueInputOption: "RAW",
    requestBody: {
      values: [nextHeader]
    }
  });

  return {
    ...table,
    header: nextHeader
  };
}

function findRowByColumnValue(table: SheetTable, column: string, value: string): number {
  const index = table.header.indexOf(column);
  if (index < 0) return -1;
  return table.rows.findIndex((row) => clean(row[index]) === value);
}

function rowAt(table: SheetTable, rowIndex: number, column: MasterHeaders): string {
  const col = table.header.indexOf(column);
  if (col < 0) return "";
  return clean(table.rows[rowIndex]?.[col]);
}

function buildRow(table: SheetTable, record: MasterTaskRecord): string[] {
  const row = new Array(table.header.length).fill("");
  const set = (column: MasterHeaders, value: string) => {
    const idx = table.header.indexOf(column);
    if (idx >= 0) row[idx] = value;
  };

  set("task_uuid", record.taskUuid);
  set("title", record.title);
  set("notes", record.notes);
  set("status", record.status);
  set("due_at", record.dueAt);
  set("priority", record.priority);
  set("tags", record.tags);
  set("assignee", record.assignee);
  set("deleted", record.deleted);
  set("version", String(record.version));
  set("updated_at", record.updatedAt);
  set("source", record.source);
  set("sync_hash", record.syncHash);
  set("google_tasks_id", record.googleTasksId);
  set("google_tasks_etag", record.googleTasksEtag);
  set("last_sync_at", record.lastSyncAt);
  set("conflict_flag", record.conflictFlag);
  set("conflict_note", record.conflictNote);

  return row;
}

function parseRecord(table: SheetTable, rowIndex: number): MasterTaskRecord {
  const versionRaw = rowAt(table, rowIndex, "version");
  const version = Number(versionRaw);

  return {
    taskUuid: rowAt(table, rowIndex, "task_uuid"),
    title: rowAt(table, rowIndex, "title"),
    notes: rowAt(table, rowIndex, "notes"),
    status: rowAt(table, rowIndex, "status"),
    dueAt: rowAt(table, rowIndex, "due_at"),
    priority: rowAt(table, rowIndex, "priority"),
    tags: rowAt(table, rowIndex, "tags"),
    assignee: rowAt(table, rowIndex, "assignee"),
    deleted: rowAt(table, rowIndex, "deleted"),
    version: Number.isFinite(version) ? version : 0,
    updatedAt: rowAt(table, rowIndex, "updated_at"),
    source: rowAt(table, rowIndex, "source"),
    syncHash: rowAt(table, rowIndex, "sync_hash"),
    googleTasksId: rowAt(table, rowIndex, "google_tasks_id"),
    googleTasksEtag: rowAt(table, rowIndex, "google_tasks_etag"),
    lastSyncAt: rowAt(table, rowIndex, "last_sync_at"),
    conflictFlag: rowAt(table, rowIndex, "conflict_flag"),
    conflictNote: rowAt(table, rowIndex, "conflict_note")
  };
}

function computeSyncHash(record: {
  title: string;
  notes: string;
  status: string;
  dueAt: string;
  priority: string;
  tags: string;
  assignee: string;
  deleted: string;
}): string {
  const payload = JSON.stringify(record);
  return createHash("sha256").update(payload).digest("hex");
}

export async function findMasterTaskByUuid(taskUuid: string): Promise<MasterTaskRecord | null> {
  const sheets = await getSheetsClient();
  let table = await readTable(sheets, masterSheetName());
  table = await writeHeaderIfEmpty(sheets, table, MASTER_HEADER);
  table = await ensureHeader(sheets, table, MASTER_HEADER);

  const rowIndex = findRowByColumnValue(table, "task_uuid", clean(taskUuid));
  if (rowIndex < 0) return null;

  return parseRecord(table, rowIndex);
}

export async function findMasterTaskByGoogleTasksId(
  googleTasksId: string
): Promise<MasterTaskRecord | null> {
  const sheets = await getSheetsClient();
  let table = await readTable(sheets, masterSheetName());
  table = await writeHeaderIfEmpty(sheets, table, MASTER_HEADER);
  table = await ensureHeader(sheets, table, MASTER_HEADER);

  const rowIndex = findRowByColumnValue(table, "google_tasks_id", clean(googleTasksId));
  if (rowIndex < 0) return null;

  return parseRecord(table, rowIndex);
}

export async function upsertMasterTaskFromGoogleTasks(input: {
  taskUuid?: string;
  googleTasksId: string;
  googleTasksEtag?: string;
  title: string;
  notes?: string;
  status: string;
  dueAt?: string;
  deleted?: boolean;
  updatedAt?: string;
}): Promise<{ taskUuid: string; version: number }> {
  const sheets = await getSheetsClient();
  let table = await readTable(sheets, masterSheetName());
  table = await writeHeaderIfEmpty(sheets, table, MASTER_HEADER);
  table = await ensureHeader(sheets, table, MASTER_HEADER);

  const googleTasksId = clean(input.googleTasksId);
  const resolvedUuid = clean(input.taskUuid) || randomUUID();

  const byUuid = findRowByColumnValue(table, "task_uuid", resolvedUuid);
  const byGoogleId = findRowByColumnValue(table, "google_tasks_id", googleTasksId);
  const rowIndex = byUuid >= 0 ? byUuid : byGoogleId;

  const previous = rowIndex >= 0 ? parseRecord(table, rowIndex) : null;

  const nextVersion = previous ? previous.version + 1 : 1;
  const title = clean(input.title);
  const notes = clean(input.notes);
  const status = clean(input.status) || "wip";
  const dueAt = clean(input.dueAt);
  const deleted = input.deleted ? "true" : "false";
  const updatedAt = clean(input.updatedAt) || nowIso();
  const priority = previous?.priority || "normal";
  const tags = previous?.tags || "";
  const assignee = previous?.assignee || "";

  const syncHash = computeSyncHash({
    title,
    notes,
    status,
    dueAt,
    priority,
    tags,
    assignee,
    deleted
  });

  const nextRecord: MasterTaskRecord = {
    taskUuid: previous?.taskUuid || resolvedUuid,
    title,
    notes,
    status,
    dueAt,
    priority,
    tags,
    assignee,
    deleted,
    version: nextVersion,
    updatedAt,
    source: "gtasks",
    syncHash,
    googleTasksId,
    googleTasksEtag: clean(input.googleTasksEtag),
    lastSyncAt: nowIso(),
    conflictFlag: "none",
    conflictNote: ""
  };

  const row = buildRow(table, nextRecord);
  const endCol = toA1Column(Math.max(table.header.length, 1));

  if (rowIndex >= 0) {
    const rowNumber = rowIndex + 2;
    await sheets.spreadsheets.values.update({
      spreadsheetId: spreadsheetId(),
      range: `${table.sheetName}!A${rowNumber}:${endCol}${rowNumber}`,
      valueInputOption: "RAW",
      requestBody: { values: [row] }
    });
  } else {
    await sheets.spreadsheets.values.append({
      spreadsheetId: spreadsheetId(),
      range: `${table.sheetName}!A:${endCol}`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [row] }
    });
  }

  return {
    taskUuid: nextRecord.taskUuid,
    version: nextRecord.version
  };
}

export async function upsertMasterTasksFromGoogleTasksBatch(
  inputs: GoogleTasksUpsertInput[]
): Promise<Array<{ taskUuid: string; googleTasksId: string; version: number }>> {
  if (inputs.length === 0) return [];

  const sheets = await getSheetsClient();
  let table = await readTable(sheets, masterSheetName());
  table = await writeHeaderIfEmpty(sheets, table, MASTER_HEADER);
  table = await ensureHeader(sheets, table, MASTER_HEADER);

  const updates: Array<{ range: string; values: string[][] }> = [];
  const appends: string[][] = [];
  const results: Array<{ taskUuid: string; googleTasksId: string; version: number }> = [];
  const endCol = toA1Column(Math.max(table.header.length, 1));

  const indexByUuid = new Map<string, number>();
  const indexByGoogleId = new Map<string, number>();
  table.rows.forEach((row, idx) => {
    const uuidCol = table.header.indexOf("task_uuid");
    const googleCol = table.header.indexOf("google_tasks_id");
    const uuid = clean(row[uuidCol]);
    const gid = clean(row[googleCol]);
    if (uuid) indexByUuid.set(uuid, idx);
    if (gid) indexByGoogleId.set(gid, idx);
  });

  for (const input of inputs) {
    const googleTasksId = clean(input.googleTasksId);
    const resolvedUuid = clean(input.taskUuid) || randomUUID();

    const byUuid = indexByUuid.get(resolvedUuid);
    const byGoogleId = indexByGoogleId.get(googleTasksId);
    const rowIndex = typeof byUuid === "number" ? byUuid : byGoogleId;
    const previous = typeof rowIndex === "number" ? parseRecord(table, rowIndex) : null;

    const nextVersion = previous ? previous.version + 1 : 1;
    const title = clean(input.title);
    const notes = clean(input.notes);
    const status = clean(input.status) || "wip";
    const dueAt = clean(input.dueAt);
    const deleted = input.deleted ? "true" : "false";
    const updatedAt = clean(input.updatedAt) || nowIso();
    const priority = previous?.priority || "normal";
    const tags = previous?.tags || "";
    const assignee = previous?.assignee || "";

    const syncHash = computeSyncHash({
      title,
      notes,
      status,
      dueAt,
      priority,
      tags,
      assignee,
      deleted
    });

    const nextRecord: MasterTaskRecord = {
      taskUuid: previous?.taskUuid || resolvedUuid,
      title,
      notes,
      status,
      dueAt,
      priority,
      tags,
      assignee,
      deleted,
      version: nextVersion,
      updatedAt,
      source: "gtasks",
      syncHash,
      googleTasksId,
      googleTasksEtag: clean(input.googleTasksEtag),
      lastSyncAt: nowIso(),
      conflictFlag: "none",
      conflictNote: ""
    };

    const row = buildRow(table, nextRecord);

    if (typeof rowIndex === "number") {
      const rowNumber = rowIndex + 2;
      updates.push({
        range: `${table.sheetName}!A${rowNumber}:${endCol}${rowNumber}`,
        values: [row]
      });
      table.rows[rowIndex] = row;
    } else {
      appends.push(row);
      table.rows.push(row);
      const newIndex = table.rows.length - 1;
      indexByUuid.set(nextRecord.taskUuid, newIndex);
      indexByGoogleId.set(nextRecord.googleTasksId, newIndex);
    }

    results.push({
      taskUuid: nextRecord.taskUuid,
      googleTasksId: nextRecord.googleTasksId,
      version: nextRecord.version
    });
  }

  if (updates.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: spreadsheetId(),
      requestBody: {
        valueInputOption: "RAW",
        data: updates
      }
    });
  }

  if (appends.length > 0) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: spreadsheetId(),
      range: `${table.sheetName}!A:${endCol}`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: appends }
    });
  }

  return results;
}
