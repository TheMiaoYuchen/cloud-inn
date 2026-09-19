import type { DesignProject } from "./types";

const DATABASE = "cloud-inn-web-mvp";
const STORE = "projects";
const VERSION = 1;

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("无法打开浏览器存储"));
  });
}

export async function loadProject(): Promise<DesignProject | undefined> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE, "readonly");
    const request = transaction.objectStore(STORE).get("current");
    request.onsuccess = () => resolve(request.result as DesignProject | undefined);
    request.onerror = () => reject(request.error ?? new Error("无法读取浏览器存储"));
    transaction.oncomplete = () => database.close();
  });
}

export async function saveProject(project: DesignProject): Promise<void> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE, "readwrite");
    transaction.objectStore(STORE).put(project);
    transaction.oncomplete = () => { database.close(); resolve(); };
    transaction.onerror = () => reject(transaction.error ?? new Error("无法保存到浏览器"));
    transaction.onabort = () => reject(transaction.error ?? new Error("无法保存到浏览器"));
  });
}
