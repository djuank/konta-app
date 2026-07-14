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

// --- Configuración de seguridad (PIN / Face ID) ---
// Se guarda en la misma base de IndexedDB, con su propia llave.
// Todo lo que se guarda aquí (envolturas de llave, id de credencial) es
// inútil sin el PIN o la frase de recuperación reales, así que es seguro
// tenerlo en el mismo almacenamiento.

const SECURITY_KEY = 'security-config';

export async function loadSecurityConfig() {
  try {
    const db = await openIndexedDb();
    const config = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(SECURITY_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    // Migración: las credenciales biométricas viejas guardaban la llave en
    // texto plano (deviceKeyRaw) y usaban un rpId incompatible. Ya no sirven
    // con el nuevo sistema seguro. Las invalidamos para que la app muestre
    // "activar Face ID" limpio en vez de un botón que falla en silencio.
    if (config && config.biometria && config.biometria.deviceKeyRaw) {
      config.biometria = null;
      const tx2 = db.transaction(STORE_NAME, 'readwrite');
      tx2.objectStore(STORE_NAME).put(config, SECURITY_KEY);
    }
    return config;
  } catch (e) {
    console.error('No se pudo leer la configuración de seguridad', e);
    return null;
  }
}

export async function saveSecurityConfig(config) {
  try {
    const db = await openIndexedDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(config, SECURITY_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.error('No se pudo guardar la configuración de seguridad', e);
  }
}

export async function clearSecurityConfig() {
  try {
    const db = await openIndexedDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(SECURITY_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.error('No se pudo borrar la configuración de seguridad', e);
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
