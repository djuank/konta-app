// Capa de acceso a datos.
// Inicializa sql.js (SQLite compilado a WebAssembly), crea el esquema
// si es la primera vez, y expone helpers simples de consulta.
// Ningún cálculo de negocio vive aquí — eso está en domain.js.

import { SCHEMA_SQL, CONFIG_DEFAULT, CATEGORIAS_SEED, CUENTAS_SEED, PAGOS_FIJOS_SEED, INGRESOS_FIJOS_SEED } from './schema.js';
import { loadSavedBytes, saveBytes, loadSecurityConfig } from './storage.js';
import { cifrarBytes, descifrarBytes } from './security.js';

let SQL = null;
let db = null;
let saveTimeout = null;
let masterKey = null; // en memoria solo mientras la app está abierta y desbloqueada

async function inicializarSQL() {
  if (!SQL) SQL = await initSqlJs({ locateFile: (file) => `vendor/${file}` });
  return SQL;
}

// Primer paso del arranque: mira si hay seguridad configurada y trae los
// bytes guardados (todavía cifrados si aplica) SIN crear la base de datos.
// app.js usa esto para decidir si mostrar la pantalla de bloqueo antes
// de abrir nada.
export async function prepararArranque() {
  await inicializarSQL();
  const securityConfig = await loadSecurityConfig();
  const bytesGuardados = await loadSavedBytes();
  return { tieneSeguridad: !!securityConfig, securityConfig, bytesGuardados };
}

// Segundo paso: ya con los bytes en claro (si había cifrado, ya
// desenvueltos), arma la base de datos real y corre migraciones.
export async function abrirBaseDatos(bytesPlanos) {
  if (bytesPlanos) {
    db = new SQL.Database(bytesPlanos);
  } else {
    db = new SQL.Database();
    db.run(SCHEMA_SQL);
    seedInitialData();
  }
  db.run(SCHEMA_SQL);
  ensureConfigDefaults();
  ensureColumnasNuevas();
  persist();
  return db;
}

export function establecerLlaveMaestra(llave) {
  masterKey = llave;
}

export function tieneLlaveMaestra() {
  return !!masterKey;
}

export function olvidarLlaveMaestra() {
  masterKey = null;
}

// Desactiva el cifrado: guarda los datos actuales en claro y olvida la
// llave maestra. Se usa cuando el usuario decide apagar la seguridad.
export async function desactivarCifradoYGuardarPlano() {
  const bytes = db.export();
  await saveBytes(bytes);
  masterKey = null;
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
  const columnasInv = queryAll("PRAGMA table_info(inversiones)").map((c) => c.name);
  if (!columnasInv.includes('usa_precio_unidad')) {
    db.run('ALTER TABLE inversiones ADD COLUMN usa_precio_unidad INTEGER NOT NULL DEFAULT 0');
    persist();
  }
  if (!columnasInv.includes('precio_actual_unidad')) {
    db.run('ALTER TABLE inversiones ADD COLUMN precio_actual_unidad REAL NOT NULL DEFAULT 0');
    persist();
  }
  // Moneda del activo: las inversiones existentes estaban en COP.
  if (!columnasInv.includes('moneda')) {
    db.run("ALTER TABLE inversiones ADD COLUMN moneda TEXT NOT NULL DEFAULT 'COP'");
    persist();
  }
  if (!columnasInv.includes('coingecko_id')) {
    db.run('ALTER TABLE inversiones ADD COLUMN coingecko_id TEXT DEFAULT NULL');
    persist();
  }
  if (!columnasInv.includes('precio_actualizado_en')) {
    db.run('ALTER TABLE inversiones ADD COLUMN precio_actualizado_en TEXT DEFAULT NULL');
    persist();
  }
  // Precio unitario explícito en cada compra (para el DCA).
  const columnasCompras = queryAll("PRAGMA table_info(inversiones_compras)").map((c) => c.name);
  if (!columnasCompras.includes('precio_unidad')) {
    db.run('ALTER TABLE inversiones_compras ADD COLUMN precio_unidad REAL');
    // Backfill: las compras viejas tienen monto y cantidad, así que el
    // precio unitario se puede deducir sin perder información.
    db.run('UPDATE inversiones_compras SET precio_unidad = monto_invertido / cantidad WHERE cantidad IS NOT NULL AND cantidad > 0 AND precio_unidad IS NULL');
    persist();
  }
  corregirCategoriasFaltantes();
}

// Repara pagos/ingresos fijos que hayan quedado sin categoría asignada
// (por ejemplo, los que se crearon antes de que existiera ese campo).
// Es segura de ejecutar siempre: solo toca filas con categoria_id vacío.
function corregirCategoriasFaltantes() {
  const pagosSinCategoria = queryAll('SELECT * FROM pagos_fijos WHERE categoria_id IS NULL');
  for (const p of pagosSinCategoria) {
    const categoriaId = buscarCategoriaId(p.nombre) || buscarCategoriaId('Otros gastos');
    if (categoriaId) {
      db.run('UPDATE pagos_fijos SET categoria_id = ? WHERE id = ?', [categoriaId, p.id]);
    }
  }
  const ingresosSinCategoria = queryAll('SELECT * FROM ingresos_fijos WHERE categoria_id IS NULL');
  for (const i of ingresosSinCategoria) {
    const categoriaId = buscarCategoriaId(i.nombre) || buscarCategoriaId('Otros ingresos');
    if (categoriaId) {
      db.run('UPDATE ingresos_fijos SET categoria_id = ? WHERE id = ?', [categoriaId, i.id]);
    }
  }
  if (pagosSinCategoria.length || ingresosSinCategoria.length) persist();
}

function buscarCategoriaId(nombre) {
  const row = queryOne('SELECT id FROM categorias WHERE nombre = ?', [nombre]);
  return row ? row.id : null;
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
    const categoriaId = buscarCategoriaId('Otros gastos');
    db.run('INSERT INTO pagos_fijos (nombre, monto_esperado, categoria_id, dia_esperado) VALUES (?, ?, ?, ?)', [
      p.nombre, p.monto_esperado, categoriaId, p.dia_esperado,
    ]);
  }
  for (const i of INGRESOS_FIJOS_SEED) {
    const categoriaId = buscarCategoriaId(i.nombre) || buscarCategoriaId('Otros ingresos');
    db.run('INSERT INTO ingresos_fijos (nombre, monto_esperado, categoria_id, dia_esperado) VALUES (?, ?, ?, ?)', [
      i.nombre, i.monto_esperado, categoriaId, i.dia_esperado,
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
// Si hay una llave maestra activa, cifra los bytes antes de guardarlos.
export function persist() {
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(async () => {
    const bytes = db.export();
    if (masterKey) {
      const cifrado = await cifrarBytes(masterKey, bytes);
      saveBytes(cifrado);
    } else {
      saveBytes(bytes);
    }
  }, 300);
}

// Fuerza el guardado inmediato (sin debounce) — útil justo después de
// activar el cifrado, para no dejar una ventana con datos sin proteger.
export async function persistInmediato() {
  clearTimeout(saveTimeout);
  const bytes = db.export();
  if (masterKey) {
    const cifrado = await cifrarBytes(masterKey, bytes);
    await saveBytes(cifrado);
  } else {
    await saveBytes(bytes);
  }
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

// Igual que run(), pero devuelve el id autogenerado de la fila insertada.
// Útil cuando otra operación necesita enlazarse a lo que se acaba de crear.
export function runYObtenerId(sql, params = []) {
  db.run(sql, params);
  const id = queryOne('SELECT last_insert_rowid() AS id').id;
  persist();
  return id;
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

export { descifrarBytes };
