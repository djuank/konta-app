// Capa de acceso a datos.
// Inicializa sql.js (SQLite compilado a WebAssembly), crea el esquema
// si es la primera vez, y expone helpers simples de consulta.
// Ningún cálculo de negocio vive aquí — eso está en domain.js.

import { SCHEMA_SQL, CONFIG_DEFAULT, CATEGORIAS_SEED, CUENTAS_SEED, PAGOS_FIJOS_SEED, INGRESOS_FIJOS_SEED } from './schema.js';
import { loadSavedBytes, saveBytes } from './storage.js';

let SQL = null;
let db = null;
let saveTimeout = null;

export async function initDatabase() {
  SQL = await initSqlJs({ locateFile: (file) => `vendor/${file}` });

  const savedBytes = await loadSavedBytes();
  if (savedBytes) {
    db = new SQL.Database(savedBytes);
  } else {
    db = new SQL.Database();
    db.run(SCHEMA_SQL);
    seedInitialData();
    persist();
  }
  // Por si el archivo cargado viene de una versión anterior sin alguna tabla nueva.
  db.run(SCHEMA_SQL);
  ensureConfigDefaults();
  ensureColumnasNuevas();
  return db;
}

// Migraciones ligeras: agrega columnas nuevas a bases de datos creadas
// con una versión anterior de la app, sin perder los datos existentes.
function ensureColumnasNuevas() {
  const columnasMov = queryAll("PRAGMA table_info(movimientos)").map((c) => c.name);
  if (!columnasMov.includes('pago_fijo_id')) {
    db.run('ALTER TABLE movimientos ADD COLUMN pago_fijo_id INTEGER REFERENCES pagos_fijos(id)');
    persist();
  }
  if (!columnasMov.includes('ingreso_fijo_id')) {
    db.run('ALTER TABLE movimientos ADD COLUMN ingreso_fijo_id INTEGER REFERENCES ingresos_fijos(id)');
    persist();
  }
  const columnasPF = queryAll("PRAGMA table_info(pagos_fijos)").map((c) => c.name);
  if (!columnasPF.includes('deuda_id')) {
    db.run('ALTER TABLE pagos_fijos ADD COLUMN deuda_id INTEGER REFERENCES lo_que_debo(id)');
    persist();
  }
  const columnasIF = queryAll("PRAGMA table_info(ingresos_fijos)").map((c) => c.name);
  if (!columnasIF.includes('categoria_id')) {
    db.run('ALTER TABLE ingresos_fijos ADD COLUMN categoria_id INTEGER REFERENCES categorias(id)');
    persist();
  }
}

function seedInitialData() {
  for (const c of CUENTAS_SEED) {
    db.run('INSERT INTO cuentas (nombre, tipo, saldo_inicial) VALUES (?, ?, ?)', [c.nombre, c.tipo, c.saldo_inicial]);
  }
  for (const c of CATEGORIAS_SEED) {
    db.run('INSERT INTO categorias (nombre, tipo, icono, ingreso_tipo) VALUES (?, ?, ?, ?)', [
      c.nombre, c.tipo, c.icono, c.ingreso_tipo || null,
    ]);
  }
  for (const [clave, valor] of Object.entries(CONFIG_DEFAULT)) {
    db.run('INSERT INTO config (clave, valor) VALUES (?, ?)', [clave, valor]);
  }
  for (const p of PAGOS_FIJOS_SEED) {
    db.run('INSERT INTO pagos_fijos (nombre, monto_esperado, dia_esperado) VALUES (?, ?, ?)', [
      p.nombre, p.monto_esperado, p.dia_esperado,
    ]);
  }
  for (const i of INGRESOS_FIJOS_SEED) {
    db.run('INSERT INTO ingresos_fijos (nombre, monto_esperado, dia_esperado) VALUES (?, ?, ?)', [
      i.nombre, i.monto_esperado, i.dia_esperado,
    ]);
  }
}

function ensureConfigDefaults() {
  for (const [clave, valor] of Object.entries(CONFIG_DEFAULT)) {
    const exists = queryOne('SELECT 1 FROM config WHERE clave = ?', [clave]);
    if (!exists) db.run('INSERT INTO config (clave, valor) VALUES (?, ?)', [clave, valor]);
  }
}

// Guarda en IndexedDB con un pequeño debounce para no escribir en cada tecla.
export function persist() {
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    const bytes = db.export();
    saveBytes(bytes);
  }, 300);
}

export function getRawBytes() {
  return db.export();
}

export async function replaceDatabase(uint8array) {
  db = new SQL.Database(uint8array);
  db.run(SCHEMA_SQL);
  ensureConfigDefaults();
  ensureColumnasNuevas();
  persist();
}

// Ejecuta una sentencia de escritura (INSERT/UPDATE/DELETE).
export function run(sql, params = []) {
  db.run(sql, params);
  persist();
}

// Devuelve todas las filas como array de objetos.
export function queryAll(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

// Devuelve la primera fila como objeto, o null.
export function queryOne(sql, params = []) {
  const rows = queryAll(sql, params);
  return rows.length ? rows[0] : null;
}

export function getConfig(clave) {
  const row = queryOne('SELECT valor FROM config WHERE clave = ?', [clave]);
  return row ? row.valor : null;
}

export function setConfig(clave, valor) {
  run('INSERT INTO config (clave, valor) VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor', [clave, String(valor)]);
}
