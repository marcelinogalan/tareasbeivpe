import { google, sheets_v4 } from "googleapis";

const DEFAULT_META_SYNC_STATE_SHEET = "meta_sync_state";
const DEFAULT_META_PROCESSED_EVENTS_SHEET = "meta_processed_events";
const DEFAULT_META_TASK_MAPPING_SHEET = "meta_task_mapping";
const READ_RANGE = "A1:Z";

type SheetsClient = sheets_v4.Sheets;

type SyncStateHeaders =
  | "provider"
  | "scope_id"
  | "cursor"
  | "last_success_at"
  | "last_error"
  | "updated_at";

type ProcessedEventHeaders = "provider" | "event_id" | "processed_at" | "ttl_until";

type TaskMappingHeaders = "task_uuid" | "google_tasks_id" | "last_seen_etag" | "updated_at";

const SYNC_STATE_HEADER: SyncStateHeaders[] = [
  "provider",
  "scope_id",
  "cursor",
  "last_success_at",
  "last_error",
  "updated_at"
];

const PROCESSED_EVENTS_HEADER: ProcessedEventHeaders[] = [
  "provider",
  "event_id",
  "processed_at",
  "ttl_until"
];

const TASK_MAPPING_HEADER: TaskMappingHeaders[] = [
  "task_uuid",
  "google_tasks_id",
  "last_seen_etag",
  "updated_at"
];

export type SyncStateRecord = {
  provider: string;
  scopeId: string;
  cursor: string;
  lastSuccessAt: string;
  lastError: string;
  updatedAt: string;
};

export type TaskMappingRecord = {
  taskUuid: string;
  googleTasksId: string;
  lastSeenEtag: string;
  updatedAt: string;
};

type SheetTable = {
  sheetName: string;
  header: string[];
  rows: string[][];
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

function cleanOrNowIso(value: string | undefined): string {
  return clean(value) || new Date().toISOString();
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

function spreadsheetId(): string {
  return getRequiredEnv("GOOGLE_SHEETS_SPREADSHEET_ID");
}

function syncStateSheetName(): string {
  return clean(process.env.GOOGLE_SHEETS_META_SYNC_STATE_SHEET) || DEFAULT_META_SYNC_STATE_SHEET;
}

function processedEventsSheetName(): string {
  return clean(process.env.GOOGLE_SHEETS_META_PROCESSED_EVENTS_SHEET) || DEFAULT_META_PROCESSED_EVENTS_SHEET;
}

function taskMappingSheetName(): string {
  return clean(process.env.GOOGLE_SHEETS_META_TASK_MAPPING_SHEET) || DEFAULT_META_TASK_MAPPING_SHEET;
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

function ensureHeader(table: SheetTable, requiredColumns: string[]) {
  const missing = requiredColumns.filter((column) => !table.header.includes(column));
  if (missing.length > 0) {
    throw new Error(
      `Missing columns in ${table.sheetName}: ${missing.join(", ")}. Please update the sheet header manually.`
    );
  }
}

function findRowByColumns(table: SheetTable, keys: Array<{ column: string; value: string }>): number {
  const indexes = keys.map((key) => ({
    index: table.header.indexOf(key.column),
    value: key.value
  }));

  return table.rows.findIndex((row) =>
    indexes.every((item) => {
      const current = clean(row[item.index]);
      return current === item.value;
    })
  );
}

function buildRow(table: SheetTable, valuesByColumn: Record<string, string>): string[] {
  const row = new Array(table.header.length).fill("");

  for (const [column, value] of Object.entries(valuesByColumn)) {
    const index = table.header.indexOf(column);
    if (index >= 0) {
      row[index] = value;
    }
  }

  return row;
}

async function upsertRow(
  sheets: SheetsClient,
  table: SheetTable,
  lookup: Array<{ column: string; value: string }>,
  valuesByColumn: Record<string, string>
): Promise<void> {
  const row = buildRow(table, valuesByColumn);
  const foundIndex = findRowByColumns(table, lookup);
  const endCol = toA1Column(Math.max(table.header.length, 1));

  if (foundIndex >= 0) {
    const rowNumber = foundIndex + 2;
    await sheets.spreadsheets.values.update({
      spreadsheetId: spreadsheetId(),
      range: `${table.sheetName}!A${rowNumber}:${endCol}${rowNumber}`,
      valueInputOption: "RAW",
      requestBody: {
        values: [row]
      }
    });
    return;
  }

  await sheets.spreadsheets.values.append({
    spreadsheetId: spreadsheetId(),
    range: `${table.sheetName}!A:${endCol}`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: [row]
    }
  });
}

export async function getSyncState(provider: string, scopeId: string): Promise<SyncStateRecord | null> {
  const sheets = await getSheetsClient();

  let table = await readTable(sheets, syncStateSheetName());
  table = await writeHeaderIfEmpty(sheets, table, SYNC_STATE_HEADER);
  ensureHeader(table, SYNC_STATE_HEADER);

  const rowIndex = findRowByColumns(table, [
    { column: "provider", value: clean(provider) },
    { column: "scope_id", value: clean(scopeId) }
  ]);

  if (rowIndex < 0) return null;

  const row = table.rows[rowIndex];
  const at = (column: SyncStateHeaders) => clean(row[table.header.indexOf(column)]);

  return {
    provider: at("provider"),
    scopeId: at("scope_id"),
    cursor: at("cursor"),
    lastSuccessAt: at("last_success_at"),
    lastError: at("last_error"),
    updatedAt: at("updated_at")
  };
}

export async function setSyncState(input: {
  provider: string;
  scopeId: string;
  cursor?: string;
  lastSuccessAt?: string;
  lastError?: string;
}): Promise<SyncStateRecord> {
  const sheets = await getSheetsClient();

  let table = await readTable(sheets, syncStateSheetName());
  table = await writeHeaderIfEmpty(sheets, table, SYNC_STATE_HEADER);
  ensureHeader(table, SYNC_STATE_HEADER);

  const record: SyncStateRecord = {
    provider: clean(input.provider),
    scopeId: clean(input.scopeId),
    cursor: clean(input.cursor),
    lastSuccessAt: clean(input.lastSuccessAt),
    lastError: clean(input.lastError),
    updatedAt: new Date().toISOString()
  };

  await upsertRow(
    sheets,
    table,
    [
      { column: "provider", value: record.provider },
      { column: "scope_id", value: record.scopeId }
    ],
    {
      provider: record.provider,
      scope_id: record.scopeId,
      cursor: record.cursor,
      last_success_at: record.lastSuccessAt,
      last_error: record.lastError,
      updated_at: record.updatedAt
    }
  );

  return record;
}

export async function isProcessedEvent(provider: string, eventId: string): Promise<boolean> {
  const sheets = await getSheetsClient();

  let table = await readTable(sheets, processedEventsSheetName());
  table = await writeHeaderIfEmpty(sheets, table, PROCESSED_EVENTS_HEADER);
  ensureHeader(table, PROCESSED_EVENTS_HEADER);

  const index = findRowByColumns(table, [
    { column: "provider", value: clean(provider) },
    { column: "event_id", value: clean(eventId) }
  ]);

  return index >= 0;
}

export async function markProcessedEvent(input: {
  provider: string;
  eventId: string;
  processedAt?: string;
  ttlUntil?: string;
}): Promise<void> {
  const sheets = await getSheetsClient();

  let table = await readTable(sheets, processedEventsSheetName());
  table = await writeHeaderIfEmpty(sheets, table, PROCESSED_EVENTS_HEADER);
  ensureHeader(table, PROCESSED_EVENTS_HEADER);

  const provider = clean(input.provider);
  const eventId = clean(input.eventId);

  await upsertRow(
    sheets,
    table,
    [
      { column: "provider", value: provider },
      { column: "event_id", value: eventId }
    ],
    {
      provider,
      event_id: eventId,
      processed_at: cleanOrNowIso(input.processedAt),
      ttl_until: clean(input.ttlUntil)
    }
  );
}

export async function getTaskMapping(taskUuid: string): Promise<TaskMappingRecord | null> {
  const sheets = await getSheetsClient();

  let table = await readTable(sheets, taskMappingSheetName());
  table = await writeHeaderIfEmpty(sheets, table, TASK_MAPPING_HEADER);
  ensureHeader(table, TASK_MAPPING_HEADER);

  const index = findRowByColumns(table, [{ column: "task_uuid", value: clean(taskUuid) }]);
  if (index < 0) return null;

  const row = table.rows[index];
  const at = (column: TaskMappingHeaders) => clean(row[table.header.indexOf(column)]);

  return {
    taskUuid: at("task_uuid"),
    googleTasksId: at("google_tasks_id"),
    lastSeenEtag: at("last_seen_etag"),
    updatedAt: at("updated_at")
  };
}

export async function getTaskMappingByGoogleTasksId(
  googleTasksId: string
): Promise<TaskMappingRecord | null> {
  const sheets = await getSheetsClient();

  let table = await readTable(sheets, taskMappingSheetName());
  table = await writeHeaderIfEmpty(sheets, table, TASK_MAPPING_HEADER);
  ensureHeader(table, TASK_MAPPING_HEADER);

  const index = findRowByColumns(table, [{ column: "google_tasks_id", value: clean(googleTasksId) }]);
  if (index < 0) return null;

  const row = table.rows[index];
  const at = (column: TaskMappingHeaders) => clean(row[table.header.indexOf(column)]);

  return {
    taskUuid: at("task_uuid"),
    googleTasksId: at("google_tasks_id"),
    lastSeenEtag: at("last_seen_etag"),
    updatedAt: at("updated_at")
  };
}

export async function upsertTaskMapping(input: {
  taskUuid: string;
  googleTasksId?: string;
  lastSeenEtag?: string;
  updatedAt?: string;
}): Promise<TaskMappingRecord> {
  const sheets = await getSheetsClient();

  let table = await readTable(sheets, taskMappingSheetName());
  table = await writeHeaderIfEmpty(sheets, table, TASK_MAPPING_HEADER);
  ensureHeader(table, TASK_MAPPING_HEADER);

  const record: TaskMappingRecord = {
    taskUuid: clean(input.taskUuid),
    googleTasksId: clean(input.googleTasksId),
    lastSeenEtag: clean(input.lastSeenEtag),
    updatedAt: cleanOrNowIso(input.updatedAt)
  };

  await upsertRow(sheets, table, [{ column: "task_uuid", value: record.taskUuid }], {
    task_uuid: record.taskUuid,
    google_tasks_id: record.googleTasksId,
    last_seen_etag: record.lastSeenEtag,
    updated_at: record.updatedAt
  });

  return record;
}

export async function upsertTaskMappingsBatch(
  inputs: Array<{
    taskUuid: string;
    googleTasksId?: string;
    lastSeenEtag?: string;
    updatedAt?: string;
  }>
): Promise<void> {
  if (inputs.length === 0) return;

  const sheets = await getSheetsClient();

  let table = await readTable(sheets, taskMappingSheetName());
  table = await writeHeaderIfEmpty(sheets, table, TASK_MAPPING_HEADER);
  ensureHeader(table, TASK_MAPPING_HEADER);

  const endCol = toA1Column(Math.max(table.header.length, 1));
  const updates: Array<{ range: string; values: string[][] }> = [];
  const appends: string[][] = [];

  const indexByTaskUuid = new Map<string, number>();
  table.rows.forEach((row, idx) => {
    const col = table.header.indexOf("task_uuid");
    const id = clean(row[col]);
    if (id) indexByTaskUuid.set(id, idx);
  });

  for (const input of inputs) {
    const record = {
      taskUuid: clean(input.taskUuid),
      googleTasksId: clean(input.googleTasksId),
      lastSeenEtag: clean(input.lastSeenEtag),
      updatedAt: cleanOrNowIso(input.updatedAt)
    };

    const row = buildRow(table, {
      task_uuid: record.taskUuid,
      google_tasks_id: record.googleTasksId,
      last_seen_etag: record.lastSeenEtag,
      updated_at: record.updatedAt
    });

    const rowIndex = indexByTaskUuid.get(record.taskUuid);
    if (typeof rowIndex === "number") {
      const rowNumber = rowIndex + 2;
      updates.push({
        range: `${table.sheetName}!A${rowNumber}:${endCol}${rowNumber}`,
        values: [row]
      });
      table.rows[rowIndex] = row;
      continue;
    }

    appends.push(row);
    table.rows.push(row);
    indexByTaskUuid.set(record.taskUuid, table.rows.length - 1);
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
      requestBody: {
        values: appends
      }
    });
  }
}
