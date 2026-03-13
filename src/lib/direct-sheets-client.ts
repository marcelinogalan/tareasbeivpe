import { Task } from "@/types/task";

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

type ParsedTask = {
  task: Task;
  rowNumber: number;
};

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

function env(name: string): string {
  return (process.env[name] || "").trim();
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

function toBase64Url(input: string): string {
  const base64 = btoa(input);
  return base64.replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function normalizePrivateKey(raw: string): string {
  return raw.replace(/\\n/g, "\n");
}

async function importPrivateKey(privateKeyPem: string): Promise<CryptoKey> {
  const key = privateKeyPem
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s+/g, "");

  const binary = Uint8Array.from(atob(key), (char) => char.charCodeAt(0));

  return crypto.subtle.importKey(
    "pkcs8",
    binary.buffer,
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256"
    },
    false,
    ["sign"]
  );
}

async function signJwt(unsignedJwt: string, privateKeyPem: string): Promise<string> {
  const key = await importPrivateKey(privateKeyPem);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsignedJwt)
  );

  const signatureBase64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  return `${unsignedJwt}.${signatureBase64}`;
}

async function getAccessToken(): Promise<string> {
  const clientEmail = env("NEXT_PUBLIC_GOOGLE_SERVICE_ACCOUNT_EMAIL");
  const privateKey = normalizePrivateKey(env("NEXT_PUBLIC_GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY"));

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: clientEmail,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://www.googleapis.com/oauth2/v4/token",
    exp: now + 3600,
    iat: now
  };

  const header = { alg: "RS256", typ: "JWT" };
  const unsignedJwt = `${toBase64Url(JSON.stringify(header))}.${toBase64Url(JSON.stringify(payload))}`;
  const assertion = await signJwt(unsignedJwt, privateKey);

  const response = await fetch("https://www.googleapis.com/oauth2/v4/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    })
  });

  if (!response.ok) {
    throw new Error(`direct sheets token failed (${response.status})`);
  }

  const payloadJson = (await response.json()) as { access_token: string };
  return payloadJson.access_token;
}

async function resolveSheetName(accessToken: string, spreadsheetId: string): Promise<string> {
  const configuredGid = env("NEXT_PUBLIC_GOOGLE_SHEETS_SHEET_GID");
  const configuredName = env("NEXT_PUBLIC_GOOGLE_SHEETS_SHEET_NAME");

  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      spreadsheetId
    )}?fields=sheets.properties(sheetId,title)`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    }
  );

  if (!response.ok) {
    throw new Error(`direct sheets metadata failed (${response.status})`);
  }

  const data = (await response.json()) as {
    sheets?: Array<{ properties?: { sheetId?: number; title?: string } }>;
  };

  const props = (data.sheets || [])
    .map((sheet) => sheet.properties)
    .filter((item): item is NonNullable<typeof item> => Boolean(item));

  if (configuredGid) {
    const byGid = props.find((item) => String(item.sheetId) === configuredGid);
    if (byGid?.title) return byGid.title;
  }

  if (configuredName) {
    const byName = props.find((item) => item.title === configuredName);
    if (byName?.title) return byName.title;
  }

  const firstTitle = props[0]?.title;
  if (!firstTitle) {
    throw new Error("direct sheets: no sheet tabs available");
  }

  return firstTitle;
}

export function isDirectSheetsConfigured(): boolean {
  return (
    env("NEXT_PUBLIC_DIRECT_SHEETS_ENABLED").toLowerCase() === "true" &&
    Boolean(env("NEXT_PUBLIC_GOOGLE_SHEETS_SPREADSHEET_ID")) &&
    Boolean(env("NEXT_PUBLIC_GOOGLE_SERVICE_ACCOUNT_EMAIL")) &&
    Boolean(env("NEXT_PUBLIC_GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY"))
  );
}

export async function listTasksDirectFromSheets(): Promise<Task[]> {
  const spreadsheetId = env("NEXT_PUBLIC_GOOGLE_SHEETS_SPREADSHEET_ID");
  const accessToken = await getAccessToken();
  const sheetName = await resolveSheetName(accessToken, spreadsheetId);

  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      spreadsheetId
    )}/values/${encodeURIComponent(sheetName + "!A1:Z")}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    }
  );

  if (!response.ok) {
    throw new Error(`direct sheets values failed (${response.status})`);
  }

  const data = (await response.json()) as { values?: string[][] };
  const values = data.values || [];
  const header = values[0] || [];
  const rows = values.slice(1);
  const legacyColumns = resolveLegacyColumns(header);

  const parsed = rows
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

  return parsed.map((item) => item.task);
}
