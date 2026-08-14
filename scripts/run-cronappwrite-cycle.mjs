/**
 * Add three documents with a delay between each addition. If the resulting
 * total exceeds the limit, delete three batches of three random documents,
 * with the same delay between batches.
 */

import { randomBytes, randomInt } from "node:crypto";

const pageSize = Number.parseInt(process.env.APPWRITE_PAGE_SIZE || "100", 10);
const collectionName = process.env.APPWRITE_CRON_COLLECTION_NAME || "CronAppwrite";
const collectionIdEnv = process.env.APPWRITE_CRON_COLLECTION_ID || "";
const sourceLabel = process.env.APPWRITE_CRON_SOURCE || "CronForfengbroaiappwrite";
const noteMaxLength = Number.parseInt(process.env.APPWRITE_CRON_NOTE_MAX || "255", 10);
const intervalMs = Number.parseInt(process.env.APPWRITE_CRON_INTERVAL_MS || "180000", 10);
const addCount = Number.parseInt(process.env.APPWRITE_CRON_ADD_COUNT || "3", 10);
const maximumDocuments = Number.parseInt(process.env.APPWRITE_CRON_MAX_DOCUMENTS || "33", 10);
const deleteBatchSize = Number.parseInt(process.env.APPWRITE_CRON_DELETE_BATCH_SIZE || "3", 10);
const deleteBatchCount = Number.parseInt(process.env.APPWRITE_CRON_DELETE_BATCH_COUNT || "3", 10);

function requireEnv(primary, fallback) {
  const value = process.env[primary] || (fallback ? process.env[fallback] : undefined);
  if (!value) {
    throw new Error(`Missing required environment variable: ${primary}${fallback ? ` or ${fallback}` : ""}`);
  }
  return value;
}

const config = {
  endpoint: requireEnv("APPWRITE_ENDPOINT", "NEXT_PUBLIC_APPWRITE_ENDPOINT").replace(/\/+$/, ""),
  projectId: requireEnv("APPWRITE_PROJECT_ID", "NEXT_PUBLIC_APPWRITE_PROJECT_ID"),
  databaseId: requireEnv("APPWRITE_DATABASE_ID", "NEXT_PUBLIC_APPWRITE_DATABASE_ID"),
  apiKey: requireEnv("APPWRITE_API_KEY", "NEXT_PUBLIC_APPWRITE_API_KEY"),
};

function headers() {
  return {
    "Content-Type": "application/json",
    "X-Appwrite-Project": config.projectId,
    "X-Appwrite-Key": config.apiKey,
  };
}

function queryParam(value) {
  return `queries[]=${encodeURIComponent(JSON.stringify(value))}`;
}

function sleep(ms) {
  if (ms <= 0) return Promise.resolve();
  console.log(`Waiting ${Math.round(ms / 1000)} second(s)...`);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function appwriteRequest(route, options = {}) {
  const response = await fetch(`${config.endpoint}${route}`, {
    ...options,
    headers: { ...headers(), ...options.headers },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Appwrite ${options.method || "GET"} ${route} failed: ${response.status} ${response.statusText}\n${body}`);
  }
  return response.status === 204 ? null : response.json();
}

async function appwriteGet(route, queries = []) {
  const queryString = queries.length ? `?${queries.map(queryParam).join("&")}` : "";
  return appwriteRequest(`${route}${queryString}`);
}

async function resolveCollectionId() {
  if (collectionIdEnv) return collectionIdEnv;

  const collections = [];
  let cursorAfter = null;
  while (true) {
    const queries = [{ method: "limit", values: [pageSize] }];
    if (cursorAfter) queries.push({ method: "cursorAfter", values: [cursorAfter] });
    const page = await appwriteGet(`/databases/${config.databaseId}/collections`, queries);
    const batch = page.collections || [];
    collections.push(...batch);
    if (!batch.length || batch.length < pageSize) break;
    cursorAfter = batch[batch.length - 1].$id;
  }

  const collection = collections.find((item) => item.name === collectionName);
  if (!collection) {
    throw new Error(`Could not find Appwrite collection named "${collectionName}". Run npm run cronappwrite:ensure first.`);
  }
  return collection.$id;
}

async function listAllDocuments(collectionId) {
  const documents = [];
  let cursorAfter = null;
  while (true) {
    const queries = [{ method: "limit", values: [pageSize] }];
    if (cursorAfter) queries.push({ method: "cursorAfter", values: [cursorAfter] });
    const page = await appwriteGet(
      `/databases/${config.databaseId}/collections/${collectionId}/documents`,
      queries,
    );
    const batch = page.documents || [];
    documents.push(...batch);
    if (!batch.length || batch.length < pageSize) return documents;
    cursorAfter = batch[batch.length - 1].$id;
  }
}

function buildPayload(sequence) {
  const token = randomBytes(4).toString("hex");
  const note = `daily cycle #${sequence} token=${token} ${new Date().toISOString()}`.slice(0, noteMaxLength);
  return { period: "daily", note, token, source: sourceLabel.slice(0, 64) };
}

async function addDocument(collectionId, sequence) {
  const document = await appwriteRequest(
    `/databases/${config.databaseId}/collections/${collectionId}/documents`,
    {
      method: "POST",
      body: JSON.stringify({ documentId: "unique()", data: buildPayload(sequence) }),
    },
  );
  console.log(`Added document ${sequence}/${addCount}: ${document.$id}`);
}

async function deleteRandomBatch(collectionId, batchNumber) {
  const candidates = await listAllDocuments(collectionId);
  const targets = [];
  while (targets.length < deleteBatchSize && candidates.length) {
    targets.push(candidates.splice(randomInt(0, candidates.length), 1)[0]);
  }

  for (const target of targets) {
    await appwriteRequest(
      `/databases/${config.databaseId}/collections/${collectionId}/documents/${target.$id}`,
      { method: "DELETE" },
    );
    console.log(`Deleted batch ${batchNumber}/${deleteBatchCount}: ${target.$id}`);
  }
  return targets.length;
}

async function main() {
  const collectionId = await resolveCollectionId();
  console.log(`Using CronAppwrite collection id=${collectionId}`);

  for (let sequence = 1; sequence <= addCount; sequence += 1) {
    await addDocument(collectionId, sequence);
    if (sequence < addCount) await sleep(intervalMs);
  }

  const count = (await listAllDocuments(collectionId)).length;
  console.log(`Document count after additions: ${count}`);
  if (count <= maximumDocuments) {
    console.log(`Count is not over ${maximumDocuments}; deletion batches are skipped.`);
    return;
  }

  for (let batch = 1; batch <= deleteBatchCount; batch += 1) {
    const deleted = await deleteRandomBatch(collectionId, batch);
    console.log(`Deletion batch ${batch} complete: ${deleted} document(s) deleted.`);
    if (batch < deleteBatchCount && deleted > 0) await sleep(intervalMs);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
