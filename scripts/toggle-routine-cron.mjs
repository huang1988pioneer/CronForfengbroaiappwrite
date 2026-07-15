import { randomBytes, randomInt } from "node:crypto";

const pageSize = Number.parseInt(process.env.APPWRITE_PAGE_SIZE || "100", 10);
const routineName = process.env.APPWRITE_ROUTINE_NAME || "鋒兄例行";
const routineCollectionName = process.env.APPWRITE_ROUTINE_COLLECTION_NAME || "routine";
const routineCollectionId = process.env.APPWRITE_ROUTINE_COLLECTION_ID || "";
const action = (process.env.ROUTINE_CRON_ACTION || "").toLowerCase();
const noteMaxLength = Number.parseInt(process.env.APPWRITE_ROUTINE_NOTE_MAX || "100", 10);

if (!["add", "remove"].includes(action)) {
  throw new Error("ROUTINE_CRON_ACTION must be add or remove.");
}

function requireEnv(primary, fallback) {
  const value = process.env[primary] || (fallback ? process.env[fallback] : undefined);
  if (!value) {
    const suffix = fallback ? ` or ${fallback}` : "";
    throw new Error(`Missing required environment variable: ${primary}${suffix}`);
  }
  return value;
}

const config = {
  endpoint: requireEnv("APPWRITE_ENDPOINT", "NEXT_PUBLIC_APPWRITE_ENDPOINT").replace(/\/+$/, ""),
  projectId: requireEnv("APPWRITE_PROJECT_ID", "NEXT_PUBLIC_APPWRITE_PROJECT_ID"),
  databaseId: requireEnv("APPWRITE_DATABASE_ID", "NEXT_PUBLIC_APPWRITE_DATABASE_ID"),
  apiKey: requireEnv("APPWRITE_API_KEY", "NEXT_PUBLIC_APPWRITE_API_KEY"),
};

function headers(extra = {}) {
  return {
    "Content-Type": "application/json",
    "X-Appwrite-Project": config.projectId,
    "X-Appwrite-Key": config.apiKey,
    ...extra,
  };
}

function queryParam(value) {
  return `queries[]=${encodeURIComponent(JSON.stringify(value))}`;
}

function buildRandomNote() {
  const now = new Date();
  const token = randomBytes(3).toString("hex");
  const roll = randomInt(1000, 10000);
  const periods = ["上午", "下午", "晚上", "例行"];
  const period = periods[randomInt(0, periods.length)];
  const note = `${period}隨機#${token} r${roll} ${now.toISOString()}`;
  return note.slice(0, noteMaxLength);
}

async function appwriteRequest(route, options = {}) {
  const response = await fetch(`${config.endpoint}${route}`, {
    ...options,
    headers: headers(options.headers),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Appwrite ${options.method || "GET"} ${route} failed: ${response.status} ${response.statusText}\n${body}`);
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

async function appwriteGet(route, queries = []) {
  const queryString = queries.length ? `?${queries.map(queryParam).join("&")}` : "";
  return appwriteRequest(`${route}${queryString}`);
}

async function resolveRoutineCollectionId() {
  if (routineCollectionId) {
    return routineCollectionId;
  }

  const collections = [];
  let cursorAfter = null;

  while (true) {
    const queries = [{ method: "limit", values: [pageSize] }];
    if (cursorAfter) {
      queries.push({ method: "cursorAfter", values: [cursorAfter] });
    }

    const page = await appwriteGet(`/databases/${config.databaseId}/collections`, queries);
    collections.push(...(page.collections || []));

    if (!page.collections?.length || page.collections.length < pageSize) {
      break;
    }

    cursorAfter = page.collections[page.collections.length - 1].$id;
  }

  const collection = collections.find((item) => item.name === routineCollectionName);
  if (!collection) {
    throw new Error(`Could not find Appwrite collection named ${routineCollectionName}.`);
  }

  return collection.$id;
}

async function listAllDocuments(collectionId) {
  const documents = [];
  let cursorAfter = null;

  while (true) {
    const queries = [{ method: "limit", values: [pageSize] }];
    if (cursorAfter) {
      queries.push({ method: "cursorAfter", values: [cursorAfter] });
    }

    const page = await appwriteGet(
      `/databases/${config.databaseId}/collections/${collectionId}/documents`,
      queries,
    );

    documents.push(...(page.documents || []));

    if (!page.documents?.length || page.documents.length < pageSize) {
      return documents;
    }

    cursorAfter = page.documents[page.documents.length - 1].$id;
  }
}

async function addRoutine(collectionId) {
  const now = new Date();
  const note = buildRandomNote();
  const document = await appwriteRequest(
    `/databases/${config.databaseId}/collections/${collectionId}/documents`,
    {
      method: "POST",
      body: JSON.stringify({
        documentId: "unique()",
        data: {
          name: routineName,
          note,
          lastdate1: now.toISOString(),
        },
      }),
    },
  );

  console.log(`Added ${routineName} routine document: ${document.$id}`);
  console.log(`note=${note}`);
}

async function removeRoutine(collectionId) {
  const documents = await listAllDocuments(collectionId);
  const matches = documents.filter((document) => document.name === routineName);

  if (!matches.length) {
    console.log(`No ${routineName} routine document found; nothing to remove.`);
    return;
  }

  const target = matches[randomInt(0, matches.length)];
  await appwriteRequest(
    `/databases/${config.databaseId}/collections/${collectionId}/documents/${target.$id}`,
    { method: "DELETE" },
  );

  console.log(`Removed random ${routineName} routine document: ${target.$id}`);
  if (target.note) {
    console.log(`note=${target.note}`);
  }
}

const collectionId = await resolveRoutineCollectionId();

if (action === "add") {
  await addRoutine(collectionId);
} else {
  await removeRoutine(collectionId);
}
