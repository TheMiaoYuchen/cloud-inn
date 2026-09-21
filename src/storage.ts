import type { Blueprint, DesignProject } from "./types";

const DATABASE = "cloud-inn-web-mvp";
const PROJECT_STORE = "projects";
const BLUEPRINT_STORE = "blueprints";
const VERSION = 2;

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(PROJECT_STORE)) request.result.createObjectStore(PROJECT_STORE, { keyPath: "id" });
      if (!request.result.objectStoreNames.contains(BLUEPRINT_STORE)) request.result.createObjectStore(BLUEPRINT_STORE, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("无法打开浏览器存储"));
  });
}

export async function loadProject(): Promise<DesignProject | undefined> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(PROJECT_STORE, "readonly");
    const request = transaction.objectStore(PROJECT_STORE).get("current");
    request.onsuccess = () => resolve(request.result as DesignProject | undefined);
    request.onerror = () => reject(request.error ?? new Error("无法读取浏览器存储"));
    transaction.oncomplete = () => database.close();
  });
}

export async function saveProject(project: DesignProject): Promise<void> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(PROJECT_STORE, "readwrite");
    transaction.objectStore(PROJECT_STORE).put(project);
    transaction.oncomplete = () => { database.close(); resolve(); };
    transaction.onerror = () => reject(transaction.error ?? new Error("无法保存到浏览器"));
    transaction.onabort = () => reject(transaction.error ?? new Error("无法保存到浏览器"));
  });
}

export async function listBlueprints(): Promise<Blueprint[]> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(BLUEPRINT_STORE, "readonly");
    const request = transaction.objectStore(BLUEPRINT_STORE).getAll();
    request.onsuccess = () => resolve((request.result as Blueprint[]).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)));
    request.onerror = () => reject(request.error ?? new Error("无法读取蓝图库"));
    transaction.oncomplete = () => database.close();
  });
}

export async function saveBlueprint(blueprint: Blueprint): Promise<void> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(BLUEPRINT_STORE, "readwrite");
    transaction.objectStore(BLUEPRINT_STORE).put(blueprint);
    transaction.oncomplete = () => { database.close(); resolve(); };
    transaction.onerror = () => reject(transaction.error ?? new Error("无法保存蓝图"));
    transaction.onabort = () => reject(transaction.error ?? new Error("无法保存蓝图"));
  });
}
