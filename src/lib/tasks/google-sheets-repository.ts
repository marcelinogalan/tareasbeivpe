import { randomUUID } from "crypto";

import { google, sheets_v4 } from "googleapis";

import { Task } from "@/types/task";

type SheetsClient = sheets_v4.Sheets;
type SheetContext = {
  spreadsheetId: string;
  sheetName: string;
  header: string[];
  rows: string[][];
};

type ParsedTask = {
  task: Task;
  rowNumber: number;
  format: "canonical" | "legacy";
};

type UpdateTaskInput = {
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

type CreateTaskInput = {
  title: string;
  id?: string;
  createdAt?: string;
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

type LegacyColumnKey =
  | "title"
  | "description"
  | "completedNotes"
  | "notes"
  | "tags"
  | "assignee"
  | "status"
  | "urgency"
  | "deadline"
  | "origin"
  | "country"
  | "workstream"
  | "scope"
  | "createdAt";

type LegacyColumns = Record<LegacyColumnKey, number>;

const LEGACY_FALLBACK_COL: LegacyColumns = {
  title: 0,
  description: 1,
  completedNotes: 2,
  notes: 3,
  tags: 4,
  assignee: 5,
  status: 6,
  urgency: 7,
  deadline: 8,
  origin: 9,
  country: 10,
  workstream: 11,
  scope: 12,
  createdAt: 13
};

const LEGACY_HEADER_ALIASES: Record<LegacyColumnKey, string[]> = {
  title: ["Tarea", "Actividad", "id"],
  description: ["Detalle", "title"],
  completedNotes: ['Next Steps/Historial "vivo"', "Next Steps/Historial vivo", "completed"],
  notes: ["Historial", "notes", "createdAt"],
  tags: ["Etiquetas"],
  assignee: ["Asignado a", "Asignado"],
  status: ["Estado", "Status"],
  urgency: ["Urgencia", "Urgencia\n(Urgente/No Urgente)"],
  deadline: ["Fecha Deadline", "Deadline"],
  origin: ["Origen"],
  country: ["País", "Pais"],
  workstream: ["Workstream"],
  scope: ["Ambito", "Ámbito"],
  createdAt: ["Fecha registro", "createdAt"]
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

function normalizeHeaderValue(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .replace(/["']/g, "")
    .trim()
    .toLowerCase();
}

function findHeaderIndex(header: string[], aliases: string[]): number {
  const normalizedHeader = header.map(normalizeHeaderValue);

  const normalizedAliases = aliases.map(normalizeHeaderValue);

  for (const alias of normalizedAliases) {
    const index = normalizedHeader.findIndex((value) => value === alias);
    if (index >= 0) return index;
  }

  for (const alias of normalizedAliases) {
    const index = normalizedHeader.findIndex((value) => value.includes(alias) || alias.includes(value));
    if (index >= 0) return index;
  }
  return -1;
}

function resolveLegacyColumns(header: string[]): LegacyColumns {
  const resolved = { ...LEGACY_FALLBACK_COL };
  const keys = Object.keys(LEGACY_HEADER_ALIASES) as LegacyColumnKey[];
  for (const key of keys) {
    const found = findHeaderIndex(header, LEGACY_HEADER_ALIASES[key]);
    if (found >= 0) {
      resolved[key] = found;
    }
  }
  return resolved;
}

function getLegacyValue(row: string[], columns: LegacyColumns, key: LegacyColumnKey): string {
  return clean(row[columns[key]]);
}

function setLegacyValue(row: string[], columns: LegacyColumns, key: LegacyColumnKey, value: string) {
  const index = columns[key];
  while (row.length <= index) {
    row.push("");
  }
  row[index] = value;
}

function getLastLegacyColumnIndex(columns: LegacyColumns, headerLength: number): number {
  const maxMapped = Math.max(...Object.values(columns));
  return Math.max(maxMapped, headerLength - 1, 13);
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

function parseDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const value = raw.trim();
  if (!value) return null;

  const direct = Date.parse(value);
  if (!Number.isNaN(direct)) {
    return new Date(direct).toISOString();
  }

  const match = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return null;

  const day = Number(match[1]);
  const month = Number(match[2]) - 1;
  const year = Number(match[3]);
  const date = new Date(Date.UTC(year, month, day));
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function inferCompleted(status: string): boolean {
  const normalized = status.toLowerCase();
  return ["end", "done", "cerrado", "closed", "completado"].some((value) => normalized.includes(value));
}

function normalizeStatus(status: string, completed: boolean): string {
  const cleanStatus = status.trim();
  if (cleanStatus) return cleanStatus;
  return completed ? "End" : "WIP";
}

function parseCanonicalRow(row: string[], rowNumber: number): ParsedTask | null {
  const id = clean(row[0]);
  const title = clean(row[1]);
  const completedRaw = clean(row[2]);
  const createdAt = parseDate(row[3]);

  if (!id || !title || (completedRaw !== "true" && completedRaw !== "false") || !createdAt) {
    return null;
  }

  const completed = completedRaw === "true";
  return {
    rowNumber,
    format: "canonical",
    task: {
      id,
      title,
      completed,
      createdAt,
      status: completed ? "End" : "WIP"
    }
  };
}

function parseLegacyRow(row: string[], rowNumber: number, columns: LegacyColumns): ParsedTask | null {
  const title = getLegacyValue(row, columns, "title");
  if (!title || title.toLowerCase() === "id") {
    return null;
  }

  const status = getLegacyValue(row, columns, "status");
  const completed = inferCompleted(status);
  const createdAt =
    parseDate(getLegacyValue(row, columns, "createdAt")) ||
    parseDate(getLegacyValue(row, columns, "deadline")) ||
    new Date(0).toISOString();

  return {
    rowNumber,
    format: "legacy",
    task: {
      id: `legacy-row-${rowNumber}`,
      title,
      completed,
      createdAt,
      description: getLegacyValue(row, columns, "description"),
      nextSteps: getLegacyValue(row, columns, "completedNotes"),
      notes: getLegacyValue(row, columns, "notes"),
      tags: getLegacyValue(row, columns, "tags"),
      assignee: getLegacyValue(row, columns, "assignee"),
      status,
      urgency: getLegacyValue(row, columns, "urgency"),
      deadline: getLegacyValue(row, columns, "deadline"),
      origin: getLegacyValue(row, columns, "origin"),
      country: getLegacyValue(row, columns, "country"),
      workstream: getLegacyValue(row, columns, "workstream"),
      scope: getLegacyValue(row, columns, "scope")
    }
  };
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

async function resolveSheetName(sheets: SheetsClient, spreadsheetId: string): Promise<string> {
  const configuredGid = (process.env.GOOGLE_SHEETS_SHEET_GID || "").trim();
  const configuredName = (process.env.GOOGLE_SHEETS_SHEET_NAME || "").trim();

  const metadata = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets.properties(sheetId,title)"
  });

  const props = (metadata.data.sheets || [])
    .map((sheet) => sheet.properties)
    .filter((item): item is NonNullable<typeof item> => Boolean(item));

  if (configuredGid) {
    const byGid = props.find((item) => String(item.sheetId) === configuredGid);
    if (byGid?.title) {
      return byGid.title;
    }
  }

  if (configuredName) {
    const byName = props.find((item) => item.title === configuredName);
    if (byName?.title) {
      return byName.title;
    }
  }

  const firstTitle = props[0]?.title;
  if (firstTitle) {
    return firstTitle;
  }

  throw new Error("No sheet tabs available in spreadsheet");
}

async function loadContext(): Promise<SheetContext> {
  const sheets = await getSheetsClient();
  const spreadsheetId = getRequiredEnv("GOOGLE_SHEETS_SPREADSHEET_ID");
  const sheetName = await resolveSheetName(sheets, spreadsheetId);

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!A1:Z`
  });

  const values = (response.data.values || []) as string[][];
  const header = values[0] || [];
  const rows = values.slice(1);

  return { spreadsheetId, sheetName, header, rows };
}

async function listParsedTasks() {
  const context = await loadContext();
  const legacyColumns = resolveLegacyColumns(context.header);

  const parsed = context.rows
    .map((row, index) => {
      const rowNumber = index + 2;
      return parseCanonicalRow(row, rowNumber) || parseLegacyRow(row, rowNumber, legacyColumns);
    })
    .filter((item): item is ParsedTask => Boolean(item))
    .sort((a, b) => {
      const aUrgent = (a.task.urgency || "").trim().toLowerCase() === "urgente" ? 1 : 0;
      const bUrgent = (b.task.urgency || "").trim().toLowerCase() === "urgente" ? 1 : 0;
      if (aUrgent !== bUrgent) {
        return bUrgent - aUrgent;
      }
      return b.rowNumber - a.rowNumber;
    });

  return { context, parsed, legacyColumns };
}

export async function listTasks(): Promise<Task[]> {
  const { parsed } = await listParsedTasks();
  return parsed.map((item) => item.task);
}

export async function addTask(input: CreateTaskInput): Promise<Task> {
  const sheets = await getSheetsClient();
  const context = await loadContext();
  const legacyColumns = resolveLegacyColumns(context.header);

  const now = new Date(input.createdAt || Date.now());
  const createdAtIso = input.createdAt || now.toISOString();
  const legacyCreatedAt = `${String(now.getUTCDate()).padStart(2, "0")}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${now.getUTCFullYear()}`;

  const prefersLegacy =
    context.header.includes("Estado") || context.header.includes("Etiquetas") || context.header.includes("Tarea");

  if (prefersLegacy) {
    const status = normalizeStatus(clean(input.status), false);
    const rowLength = getLastLegacyColumnIndex(legacyColumns, context.header.length) + 1;
    const row = new Array<string>(rowLength).fill("");

    setLegacyValue(row, legacyColumns, "title", clean(input.title));
    setLegacyValue(row, legacyColumns, "description", clean(input.description));
    setLegacyValue(row, legacyColumns, "completedNotes", clean(input.nextSteps));
    setLegacyValue(row, legacyColumns, "notes", clean(input.notes));
    setLegacyValue(row, legacyColumns, "tags", clean(input.tags));
    setLegacyValue(row, legacyColumns, "assignee", clean(input.assignee));
    setLegacyValue(row, legacyColumns, "status", status);
    setLegacyValue(row, legacyColumns, "urgency", clean(input.urgency));
    setLegacyValue(row, legacyColumns, "deadline", clean(input.deadline));
    setLegacyValue(row, legacyColumns, "origin", clean(input.origin));
    setLegacyValue(row, legacyColumns, "country", clean(input.country));
    setLegacyValue(row, legacyColumns, "workstream", clean(input.workstream));
    setLegacyValue(row, legacyColumns, "scope", clean(input.scope));
    setLegacyValue(row, legacyColumns, "createdAt", legacyCreatedAt);

    const endCol = toA1Column(row.length);
    await sheets.spreadsheets.values.append({
      spreadsheetId: context.spreadsheetId,
      range: `${context.sheetName}!A:${endCol}`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [row] }
    });

    return {
      id: input.id || `legacy-row-new-${Date.now()}`,
      title: clean(input.title),
      completed: typeof input.completed === "boolean" ? input.completed : inferCompleted(status),
      createdAt: createdAtIso,
      description: clean(input.description),
      nextSteps: clean(input.nextSteps),
      notes: clean(input.notes),
      tags: clean(input.tags),
      assignee: clean(input.assignee),
      status,
      urgency: clean(input.urgency),
      deadline: clean(input.deadline),
      origin: clean(input.origin),
      country: clean(input.country),
      workstream: clean(input.workstream),
      scope: clean(input.scope)
    };
  }

  const completed = typeof input.completed === "boolean" ? input.completed : false;
  const task: Task = {
    id: clean(input.id) || randomUUID(),
    title: clean(input.title),
    completed,
    createdAt: createdAtIso,
    status: normalizeStatus(clean(input.status), completed)
  };

  await sheets.spreadsheets.values.append({
    spreadsheetId: context.spreadsheetId,
    range: `${context.sheetName}!A:D`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: [[task.id, task.title, String(task.completed), task.createdAt]]
    }
  });

  return task;
}

export async function updateTask(id: string, input: UpdateTaskInput): Promise<Task | null> {
  const sheets = await getSheetsClient();
  const { context, parsed, legacyColumns } = await listParsedTasks();

  const match = parsed.find((item) => item.task.id === id);
  if (!match) {
    return null;
  }

  const rowIndex = match.rowNumber - 2;
  const row = [...(context.rows[rowIndex] || [])];

  if (match.format === "legacy") {
    if (typeof input.title === "string") setLegacyValue(row, legacyColumns, "title", input.title);
    if (typeof input.description === "string") setLegacyValue(row, legacyColumns, "description", input.description);
    if (typeof input.nextSteps === "string")
      setLegacyValue(row, legacyColumns, "completedNotes", input.nextSteps);
    if (typeof input.notes === "string") setLegacyValue(row, legacyColumns, "notes", input.notes);
    if (typeof input.tags === "string") setLegacyValue(row, legacyColumns, "tags", input.tags);
    if (typeof input.assignee === "string") setLegacyValue(row, legacyColumns, "assignee", input.assignee);
    if (typeof input.urgency === "string") setLegacyValue(row, legacyColumns, "urgency", input.urgency);
    if (typeof input.deadline === "string") setLegacyValue(row, legacyColumns, "deadline", input.deadline);
    if (typeof input.origin === "string") setLegacyValue(row, legacyColumns, "origin", input.origin);
    if (typeof input.country === "string") setLegacyValue(row, legacyColumns, "country", input.country);
    if (typeof input.workstream === "string") setLegacyValue(row, legacyColumns, "workstream", input.workstream);
    if (typeof input.scope === "string") setLegacyValue(row, legacyColumns, "scope", input.scope);

    const currentStatus = getLegacyValue(row, legacyColumns, "status");
    const statusFromInput = typeof input.status === "string" ? input.status : currentStatus;
    const completedFromInput = typeof input.completed === "boolean" ? input.completed : inferCompleted(statusFromInput);
    setLegacyValue(row, legacyColumns, "status", normalizeStatus(statusFromInput, completedFromInput));

    const endCol = toA1Column(Math.max(row.length, getLastLegacyColumnIndex(legacyColumns, context.header.length) + 1));
    while (row.length < getLastLegacyColumnIndex(legacyColumns, context.header.length) + 1) {
      row.push("");
    }

    await sheets.spreadsheets.values.update({
      spreadsheetId: context.spreadsheetId,
      range: `${context.sheetName}!A${match.rowNumber}:${endCol}${match.rowNumber}`,
      valueInputOption: "RAW",
      requestBody: { values: [row] }
    });

    const parsedUpdated = parseLegacyRow(row, match.rowNumber, legacyColumns);
    return parsedUpdated?.task || null;
  }

  if (typeof input.title === "string") row[1] = input.title;
  if (typeof input.completed === "boolean") row[2] = String(input.completed);

  await sheets.spreadsheets.values.update({
    spreadsheetId: context.spreadsheetId,
    range: `${context.sheetName}!A${match.rowNumber}:D${match.rowNumber}`,
    valueInputOption: "RAW",
    requestBody: { values: [[row[0] || "", row[1] || "", row[2] || "", row[3] || ""]] }
  });

  const parsedUpdated = parseCanonicalRow(row, match.rowNumber);
  return parsedUpdated?.task || null;
}

export async function removeTask(id: string): Promise<boolean> {
  const sheets = await getSheetsClient();
  const { context, parsed, legacyColumns } = await listParsedTasks();

  const match = parsed.find((item) => item.task.id === id);
  if (!match) {
    return false;
  }

  const legacyEndCol = toA1Column(getLastLegacyColumnIndex(legacyColumns, context.header.length) + 1);
  const clearRange =
    match.format === "legacy"
      ? `${context.sheetName}!A${match.rowNumber}:${legacyEndCol}${match.rowNumber}`
      : `${context.sheetName}!A${match.rowNumber}:D${match.rowNumber}`;

  await sheets.spreadsheets.values.clear({
    spreadsheetId: context.spreadsheetId,
    range: clearRange
  });

  return true;
}
