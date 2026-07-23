/**
 * Delete ALL documents from the CronAppwrite collection.
 *
 * Env:
 *   APPWRITE_CRON_COLLECTION_NAME = CronAppwrite (default)
 *   APPWRITE_CRON_COLLECTION_ID   = <id>  (skip lookup if provided)
 *   APPWRITE_CRON_AUTO_ENSURE     = 1     (default) create collection/attrs if missing
 *   CLEAR_DRY_RUN                 = 1     list what would be deleted, do NOT delete
 *   APPWRITE_PAGE_SIZE            = 100   (default)
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pageSize = Number.parseInt(process.env.APPWRITE_PAGE_SIZE || "100", 10);
const collectionName = process.env.APPWRITE_CRON_COLLECTION_NAME || "CronAppwrite";
const collectionIdEnv = process.env.APPWRITE_CRON_COLLECTION_ID || "";
const autoEnsure = (process.env.APPWRITE_CRON_AUTO_ENSURE || "1") !== "0";
const dryRun = (process.env.CLEAR_DRY_RUN || "0") === "1";

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

async function appwriteRequest(route, options = {}) {
  const response = await fetch(`${config.endpoint}${route}`, {
    ...options,
    headers: headers(options.headers),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Appwrite ${options.method || "GET"} ${route} failed: ${response.status} ${response.statusText}\n${body}`,
    );
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

async function resolveCollectionId() {
  if (collectionIdEnv) {
    return collectionIdEnv;
  }

  const collections = await listAllCollections();
  const collection = collections.find((item) => item.name === collectionName);
  if (!collection) {
    throw new Error(
      `Could not find Appwrite collection named "${collectionName}". Run npm run cronappwrite:ensure first.`,
    );
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

async function deleteDocument(collectionId, documentId) {
  await appwriteRequest(
    `/databases/${config.databaseId}/collections/${collectionId}/documents/${documentId}`,
    { method: "DELETE" },
  );
}

function runEnsure() {
  const scriptPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "ensure-cronappwrite-collection.mjs",
  );
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      stdio: "inherit",
      env: process.env,
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ensure-cronappwrite-collection.mjs exited with code ${code}`));
      }
    });
  });
}

async function main() {
  if (dryRun) {
    console.log("[DRY RUN] No documents will actually be deleted.");
  }

  if (autoEnsure) {
    await runEnsure();
  }

  const collectionId = await resolveCollectionId();
  console.log(`Using CronAppwrite collection id=${collectionId}`);

  const documents = await listAllDocuments(collectionId);

  if (!documents.length) {
    console.log("CronAppwrite collection is already empty. Nothing to clear.");
    return;
  }

  console.log(`Found ${documents.length} document(s) to delete.`);

  let deleted = 0;
  let failed = 0;

  for (const doc of documents) {
    const label = JSON.stringify({
      id: doc.$id,
      period: doc.period ?? null,
      note: doc.note ?? null,
    });

    if (dryRun) {
      console.log(`[DRY RUN] Would delete: ${label}`);
      continue;
    }

    try {
      await deleteDocument(collectionId, doc.$id);
      console.log(`Deleted: ${label}`);
      deleted++;
    } catch (error) {
      console.error(`Failed to delete ${doc.$id}: ${error.message}`);
      failed++;
    }
  }

  if (dryRun) {
    console.log(`[DRY RUN] Would have deleted ${documents.length} document(s).`);
  } else {
    console.log(`Clear complete: ${deleted} deleted, ${failed} failed.`);
    if (failed > 0) {
      process.exitCode = 1;
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
