import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const pageSize = Number.parseInt(process.env.APPWRITE_PAGE_SIZE || "100", 10);
const historyMode = (process.env.APPWRITE_SNAPSHOT_HISTORY || "full").toLowerCase();

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

function appwriteHeaders() {
  return {
    "X-Appwrite-Project": config.projectId,
    "X-Appwrite-Key": config.apiKey,
  };
}

function safeName(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "collection";
}

function isSensitiveKey(key) {
  return /(^|[_-])(api[_-]?key|authorization|client[_-]?secret|password|private[_-]?key|refresh[_-]?token|secret|token)($|[_-])/i.test(
    String(key),
  );
}

function redactString(value) {
  return value
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, "[REDACTED_OPENAI_KEY]")
    .replace(/xapp-[A-Za-z0-9_-]{20,}/g, "[REDACTED_APPWRITE_KEY]")
    .replace(/Bearer\s+[A-Za-z0-9._-]{20,}/gi, "Bearer [REDACTED_TOKEN]");
}

function redactSecrets(value, key = "") {
  if (isSensitiveKey(key)) {
    return "[REDACTED]";
  }

  if (typeof value === "string") {
    return redactString(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [entryKey, redactSecrets(entryValue, entryKey)]),
    );
  }

  return value;
}

function queryParam(value) {
  return `queries[]=${encodeURIComponent(JSON.stringify(value))}`;
}

async function appwriteGet(route, queries = []) {
  const queryString = queries.length ? `?${queries.map(queryParam).join("&")}` : "";
  const response = await fetch(`${config.endpoint}${route}${queryString}`, {
    headers: appwriteHeaders(),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Appwrite GET ${route} failed: ${response.status} ${response.statusText}\n${body}`);
  }

  return response.json();
}

async function listAllCollections() {
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

  return collections;
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
      return { total: page.total ?? documents.length, documents };
    }

    cursorAfter = page.documents[page.documents.length - 1].$id;
  }
}

async function writeJson(filePath, data) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(`${filePath}.tmp`, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await rm(filePath, { force: true });
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await rm(`${filePath}.tmp`, { force: true });
}

async function main() {
  const startedAt = new Date();
  const runId = startedAt.toISOString().replace(/[:.]/g, "-");
  const historyDir = path.join("data", "history", runId.slice(0, 10), runId);
  const latestDir = path.join("data", "latest");

  await rm(latestDir, { recursive: true, force: true });
  await mkdir(path.join(latestDir, "collections"), { recursive: true });

  const collections = await listAllCollections();
  const summary = {
    generatedAt: startedAt.toISOString(),
    endpoint: config.endpoint,
    projectId: config.projectId,
    databaseId: config.databaseId,
    totalCollections: collections.length,
    totalDocuments: 0,
    historyMode,
    collections: [],
  };

  for (const collection of collections) {
    const { total, documents } = await listAllDocuments(collection.$id);
    const collectionSummary = {
      id: collection.$id,
      name: collection.name,
      documentCount: total,
      fetchedCount: documents.length,
      attributeCount: collection.attributes?.length || 0,
      createdAt: collection.$createdAt,
      updatedAt: collection.$updatedAt,
    };

    const snapshot = redactSecrets({
      ...collectionSummary,
      attributes: collection.attributes || [],
      documents,
    });

    const fileBase = `${safeName(collection.name)}-${collection.$id}`;
    await writeJson(path.join(latestDir, "collections", `${fileBase}.json`), snapshot);

    if (historyMode === "full") {
      await writeJson(path.join(historyDir, "collections", `${fileBase}.json`), snapshot);
    }

    summary.totalDocuments += total;
    summary.collections.push(collectionSummary);
    console.log(`${collection.name} (${collection.$id}): ${total} documents`);
  }

  summary.collections.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

  await writeJson(path.join(latestDir, "summary.json"), summary);
  await writeJson(path.join(historyDir, "summary.json"), summary);

  console.log(`Snapshot complete: ${summary.totalCollections} collections, ${summary.totalDocuments} documents`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
