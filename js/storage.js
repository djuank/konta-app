// Capa de almacenamiento.
// Responsabilidad única: guardar y recuperar el archivo SQLite (como bytes)
// desde IndexedDB del navegador, y exportarlo/importarlo como backup.
//
// Esto es lo que en el futuro se reemplaza si la app migra a Tauri
// (ahí en vez de IndexedDB se escribiría directo a un archivo .sqlite
// en disco) sin tocar nada de la capa de dominio ni la UI.

const DB_NAME = 'konta-app';
const STORE_NAME = 'sqlite-file';
const KEY = 'main';

function openIndexedDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function loadSavedBytes() {
  try {
    const db = await openIndexedDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    console.error('No se pudo abrir IndexedDB', e);
    return null;
  }
}

export async function saveBytes(uint8array) {
  try {
    const db = await openIndexedDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(uint8array, KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.error('No se pudo guardar en IndexedDB', e);
  }
}

export function downloadDatabaseFile(uint8array, filename) {
  const blob = new Blob([uint8array], { type: 'application/x-sqlite3' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const fecha = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = filename || `konta-backup-${fecha}.sqlite`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function downloadJsonExport(data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const fecha = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `konta-backup-${fecha}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function pickFile(accept) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => resolve(input.files[0] || null);
    input.click();
  });
}

export function readFileAsUint8Array(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}
