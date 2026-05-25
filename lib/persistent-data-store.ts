"use client";

import type { CategoryCommission, ImportSummary, ShippingChannel } from "./types";

export type ImportedDatasetType = "commission" | "shipping";

export interface ImportedDatasetMeta {
  type: ImportedDatasetType;
  importedAt: string;
  fileName?: string;
  itemCount: number;
  rows?: number;
  dataVersion: string;
  summary?: ImportSummary;
}

type ImportedDatasetPayload = CategoryCommission[] | ShippingChannel[];

interface StoredDataset {
  type: ImportedDatasetType;
  data: ImportedDatasetPayload;
  meta: ImportedDatasetMeta;
}

const DB_NAME = "ozon-calculator-data";
const STORE_NAME = "imported-datasets";
const DB_VERSION = 1;

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof window === "undefined" || !window.indexedDB) {
      reject(new Error("当前环境不支持 IndexedDB"));
      return;
    }

    const request = window.indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error || new Error("IndexedDB 打开失败"));
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "type" });
      }
    };
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    const store = tx.objectStore(STORE_NAME);
    const request = run(store);

    request.onerror = () => reject(request.error || new Error("IndexedDB 操作失败"));
    request.onsuccess = () => resolve(request.result);
    tx.oncomplete = () => db.close();
    tx.onerror = () => {
      db.close();
      reject(tx.error || new Error("IndexedDB 事务失败"));
    };
    tx.onabort = () => {
      db.close();
      reject(tx.error || new Error("IndexedDB 事务中断"));
    };
  });
}

export async function saveImportedDataset(
  type: ImportedDatasetType,
  data: ImportedDatasetPayload,
  metadata: Omit<ImportedDatasetMeta, "type">
): Promise<ImportedDatasetMeta> {
  const meta: ImportedDatasetMeta = { ...metadata, type };
  await withStore("readwrite", (store) => store.put({ type, data, meta } satisfies StoredDataset));
  return meta;
}

export async function loadImportedDataset<T extends ImportedDatasetPayload>(
  type: ImportedDatasetType
): Promise<{ data: T; meta: ImportedDatasetMeta } | null> {
  const record = await withStore<StoredDataset | undefined>("readonly", (store) => store.get(type));
  if (!record || !Array.isArray(record.data)) return null;
  return { data: record.data as T, meta: record.meta };
}

export async function clearImportedDataset(type: ImportedDatasetType): Promise<void> {
  await withStore<undefined>("readwrite", (store) => store.delete(type));
}

export async function getImportedDatasetMeta(type: ImportedDatasetType): Promise<ImportedDatasetMeta | null> {
  const record = await withStore<StoredDataset | undefined>("readonly", (store) => store.get(type));
  return record?.meta || null;
}
