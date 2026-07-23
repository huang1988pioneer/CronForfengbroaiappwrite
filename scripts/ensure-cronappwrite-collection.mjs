/**
 * Ensure a dedicated Appwrite collection "CronAppwrite" exists (not the routine table).
 * Creates collection + attributes if missing, then waits until attributes are available.
 */

const pageSize = Number.parseInt(process.env.APPWRITE_PAGE_SIZE || "100", 10);
const collectionName = process.env.APPWRITE_CRON_COLLECTION_NAME || "CronAppwrite";
const collectionIdEnv = process.env.APPWRITE_CRON_COLLECTION_ID || "";
const waitMs = Number.parseInt(process.env.APPWRITE_ATTRIBUTE_WAIT_MS || "1500", 10);
const waitAttempts = Number.parseInt(process.env.APPWRITE_ATTRIBUTE_WAIT_ATTEMPTS || "40", 10);

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

/** @type {{ key: string, type: "string" | "datetime", size?: number, required?: boolean }[]} */
const desiredAttributes = [
  { key: "period", type: "string", size: 32, required: true },
  { key: "note", type: "string", size: 255, required: false },
  { key: "token", type: "string", size: 64, required: false },
  { key: "source", type: "string", size: 64, required: false },
];

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function appwriteRequest(route, options = {}) {
  const response = await fetch(`${config.endpoint}${route}`, {
    ...options,
    headers: headers(options.headers),
  });

  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!response.ok) {
    const message =
      typeof body === "object" && body?.message
        ? body.message
        : typeof body === "string"
          ? body
          : response.statusText;
    const error = new Error(`Appwrite ${options.method || "GET"} ${route} failed: ${response.status} ${message}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }

  if (response.status === 204) {
    return null;
  }

  return body;
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

async function findCollection() {
  if (collectionIdEnv) {
    try {
      return await appwriteGet(`/databases/${config.databaseId}/collections/${collectionIdEnv}`);
    } catch (error) {
      if (error.status !== 404) {
        throw error;
      }
    }
  }

  const collections = await listAllCollections();
  return collections.find((item) => item.name === collectionName) || null;
}

async function createCollection() {
  const collectionId = collectionIdEnv || "cronappwrite";
  console.log(`Creating collection ${collectionName} (id=${collectionId})...`);

  try {
    return await appwriteRequest(`/databases/${config.databaseId}/collections`, {
      method: "POST",
      body: JSON.stringify({
        collectionId,
        name: collectionName,
        permissions: [],
        documentSecurity: false,
        enabled: true,
      }),
    });
  } catch (error) {
    // Race / reuse: if id exists with another name, fall back to unique id.
    if (error.status === 409) {
      console.log(`Collection id ${collectionId} already exists; creating with unique id...`);
      return appwriteRequest(`/databases/${config.databaseId}/collections`, {
        method: "POST",
        body: JSON.stringify({
          collectionId: "unique()",
          name: collectionName,
          permissions: [],
          documentSecurity: false,
          enabled: true,
        }),
      });
    }
    throw error;
  }
}

async function listAttributes(collectionId) {
  const attributes = [];
  let cursorAfter = null;

  while (true) {
    const queries = [{ method: "limit", values: [pageSize] }];
    if (cursorAfter) {
      queries.push({ method: "cursorAfter", values: [cursorAfter] });
    }

    const page = await appwriteGet(
      `/databases/${config.databaseId}/collections/${collectionId}/attributes`,
      queries,
    );

    const batch = page.attributes || [];
    attributes.push(...batch);

    if (!batch.length || batch.length < pageSize) {
      break;
    }

    cursorAfter = batch[batch.length - 1].key;
  }

  return attributes;
}

async function createAttribute(collectionId, attribute) {
  if (attribute.type === "datetime") {
    console.log(`Creating datetime attribute: ${attribute.key}`);
    return appwriteRequest(
      `/databases/${config.databaseId}/collections/${collectionId}/attributes/datetime`,
      {
        method: "POST",
        body: JSON.stringify({
          key: attribute.key,
          required: Boolean(attribute.required),
        }),
      },
    );
  }

  console.log(`Creating string attribute: ${attribute.key} (size=${attribute.size})`);
  return appwriteRequest(
    `/databases/${config.databaseId}/collections/${collectionId}/attributes/string`,
    {
      method: "POST",
      body: JSON.stringify({
        key: attribute.key,
        size: attribute.size || 255,
        required: Boolean(attribute.required),
      }),
    },
  );
}

async function waitForAttributes(collectionId, keys) {
  for (let attempt = 1; attempt <= waitAttempts; attempt += 1) {
    const attributes = await listAttributes(collectionId);
    const byKey = new Map(attributes.map((item) => [item.key, item]));
    const pending = keys.filter((key) => {
      const attr = byKey.get(key);
      return !attr || attr.status !== "available";
    });

    if (!pending.length) {
      console.log(`All attributes available: ${keys.join(", ")}`);
      return;
    }

    const statuses = pending.map((key) => {
      const attr = byKey.get(key);
      return `${key}=${attr?.status || "missing"}`;
    });
    console.log(`Waiting for attributes (${attempt}/${waitAttempts}): ${statuses.join(", ")}`);
    await sleep(waitMs);
  }

  throw new Error(`Timed out waiting for CronAppwrite attributes to become available.`);
}

async function main() {
  let collection = await findCollection();

  if (!collection) {
    collection = await createCollection();
    console.log(`Created collection ${collection.name} (${collection.$id})`);
  } else {
    console.log(`Found collection ${collection.name} (${collection.$id})`);
  }

  const existing = await listAttributes(collection.$id);
  const existingKeys = new Set(existing.map((item) => item.key));

  for (const attribute of desiredAttributes) {
    if (existingKeys.has(attribute.key)) {
      console.log(`Attribute already exists: ${attribute.key}`);
      continue;
    }
    await createAttribute(collection.$id, attribute);
  }

  await waitForAttributes(
    collection.$id,
    desiredAttributes.map((item) => item.key),
  );

  console.log(
    JSON.stringify(
      {
        collectionId: collection.$id,
        collectionName: collection.name,
        attributes: desiredAttributes.map((item) => item.key),
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
