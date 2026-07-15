/**
 * Add/remove random rows on the dedicated CronAppwrite collection (not routine).
 *
 * Env:
 *   ROUTINE_CRON_ACTION = add | remove
 *   APPWRITE_CRON_PERIOD = 上午 | 下午 | 晚上 | manual (optional label)
 *   APPWRITE_CRON_COLLECTION_NAME = CronAppwrite (default)
 *   APPWRITE_CRON_AUTO_ENSURE = 1 (default) create collection/attrs if missing
 */

import { randomBytes, randomInt } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pageSize = Number.parseInt(process.env.APPWRITE_PAGE_SIZE || "100", 10);
const collectionName = process.env.APPWRITE_CRON_COLLECTION_NAME || "CronAppwrite";
const collectionIdEnv = process.env.APPWRITE_CRON_COLLECTION_ID || "";
const action = (process.env.ROUTINE_CRON_ACTION || "").toLowerCase();
const noteMaxLength = Number.parseInt(process.env.APPWRITE_CRON_NOTE_MAX || "255", 10);
const autoEnsure = (process.env.APPWRITE_CRON_AUTO_ENSURE || "1") !== "0";
const sourceLabel = process.env.APPWRITE_CRON_SOURCE || "CronForfengbroaiappwrite";

if (!["add", "remove"].includes(action)) {
  throw new Error("ROUTINE_CRON_ACTION must be add or remove.");
}

/** Resolve period label in this file (UTF-8) to avoid YAML/env encoding issues. */
function resolvePeriodLabel() {
  const raw = (process.env.APPWRITE_CRON_PERIOD || "").trim();
  const schedule = (process.env.APPWRITE_CRON_SCHEDULE || "").trim();

  const aliases = {
    morning: "上午",
    afternoon: "下午",
    evening: "晚上",
    上午: "上午",
    下午: "下午",
    晚上: "晚上",
    manual: "manual",
  };

  if (raw && aliases[raw]) {
    return aliases[raw];
  }
  if (raw) {
    return raw.slice(0, 32);
  }

  if (schedule === "33 1 * * *") {
    return "上午";
  }
  if (schedule === "33 7 * * *") {
    return "下午";
  }
  if (schedule === "33 13 * * *") {
    return "晚上";
  }

  return "manual";
}

const periodLabel = resolvePeriodLabel();

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

function buildRandomPayload() {
  const now = new Date();
  const token = randomBytes(4).toString("hex");
  const roll = randomInt(1000, 10000);
  const note = `${periodLabel}隨機#${token} r${roll} ${now.toISOString()}`.slice(0, noteMaxLength);
  return { period: periodLabel.slice(0, 32), note, token, source: sourceLabel.slice(0, 64) };
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
    throw new Error(`Could not find Appwrite collection named ${collectionName}. Run npm run cronappwrite:ensure first.`);
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

function runEnsure() {
  const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "ensure-cronappwrite-collection.mjs");
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

async function addDocument(collectionId) {
  const payload = buildRandomPayload();
  const document = await appwriteRequest(
    `/databases/${config.databaseId}/collections/${collectionId}/documents`,
    {
      method: "POST",
      body: JSON.stringify({
        documentId: "unique()",
        data: payload,
      }),
    },
  );

  console.log(`Added CronAppwrite document: ${document.$id}`);
  console.log(JSON.stringify(payload));
}

async function removeRandomDocument(collectionId) {
  const documents = await listAllDocuments(collectionId);

  if (!documents.length) {
    console.log("CronAppwrite table is empty; nothing to remove.");
    return;
  }

  const target = documents[randomInt(0, documents.length)];
  await appwriteRequest(
    `/databases/${config.databaseId}/collections/${collectionId}/documents/${target.$id}`,
    { method: "DELETE" },
  );

  console.log(`Removed random CronAppwrite document: ${target.$id}`);
  console.log(
    JSON.stringify({
      period: target.period ?? null,
      note: target.note ?? null,
      token: target.token ?? null,
      source: target.source ?? null,
    }),
  );
}

if (autoEnsure) {
  await runEnsure();
}

const collectionId = await resolveCollectionId();
console.log(`Using CronAppwrite collection id=${collectionId}`);

if (action === "add") {
  await addDocument(collectionId);
} else {
  await removeRandomDocument(collectionId);
}
