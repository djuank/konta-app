// Esquema de la base de datos y datos iniciales.
// Todo el "modelo de datos" de la app vive aquí, en un solo lugar.

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS cuentas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL,
  tipo TEXT NOT NULL DEFAULT 'efectivo',
  saldo_inicial REAL NOT NULL DEFAULT 0,
  activa INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS categorias (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('ingreso','gasto')),
  icono TEXT NOT NULL DEFAULT 'ti-circle',
  ingreso_tipo TEXT DEFAULT NULL CHECK (ingreso_tipo IN ('activo','pasivo') OR ingreso_tipo IS NULL)
);

CREATE TABLE IF NOT EXISTS pagos_fijos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL,
  monto_esperado REAL NOT NULL DEFAULT 0,
  categoria_id INTEGER REFERENCES categorias(id),
  dia_esperado INTEGER,
  activo INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS ingresos_fijos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL,
  monto_esperado REAL NOT NULL DEFAULT 0,
  dia_esperado INTEGER,
  activo INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS movimientos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fecha TEXT NOT NULL,
  cuenta_id INTEGER NOT NULL REFERENCES cuentas(id),
  categoria_id INTEGER NOT NULL REFERENCES categorias(id),
  monto REAL NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('ingreso','gasto')),
  nota TEXT,
  pago_fijo_id INTEGER REFERENCES pagos_fijos(id)
);

CREATE TABLE IF NOT EXISTS lo_que_tengo (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL,
  valor REAL NOT NULL,
  fecha_actualizacion TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lo_que_debo (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL,
  valor REAL NOT NULL,
  fecha_actualizacion TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS metas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL,
  monto_objetivo REAL NOT NULL,
  monto_actual REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS inversiones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL,
  tipo TEXT NOT NULL,
  valor_invertido REAL NOT NULL DEFAULT 0,
  valor_actual REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS patrimonio_historico (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fecha TEXT NOT NULL UNIQUE,
  total_tengo REAL NOT NULL,
  total_debo REAL NOT NULL,
  dinero_real REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS config (
  clave TEXT PRIMARY KEY,
  valor TEXT
);
`;

// Config por defecto: cómo se reparte el ingreso en los 4 baldes (%).
export const CONFIG_DEFAULT = {
  balde_fijos: '52',
  balde_inversion: '12',
  balde_ahorro: '8',
  balde_disfrute: '28',
  meta_patrimonio: '0',
  meta_tasa_anual: '8',
};

export const CATEGORIAS_SEED = [
  // gastos
  { nombre: 'Mercado', tipo: 'gasto', icono: 'ti-shopping-cart' },
  { nombre: 'Vivienda', tipo: 'gasto', icono: 'ti-home' },
  { nombre: 'Salud', tipo: 'gasto', icono: 'ti-heart' },
  { nombre: 'Transporte', tipo: 'gasto', icono: 'ti-car' },
  { nombre: 'Educación', tipo: 'gasto', icono: 'ti-school' },
  { nombre: 'Familia y ocio', tipo: 'gasto', icono: 'ti-mood-smile' },
  { nombre: 'Deudas', tipo: 'gasto', icono: 'ti-credit-card' },
  { nombre: 'Otros gastos', tipo: 'gasto', icono: 'ti-dots' },
  // ingresos
  { nombre: 'Salario', tipo: 'ingreso', icono: 'ti-briefcase', ingreso_tipo: 'activo' },
  { nombre: 'Arriendos', tipo: 'ingreso', icono: 'ti-building', ingreso_tipo: 'pasivo' },
  { nombre: 'Dividendos e intereses', tipo: 'ingreso', icono: 'ti-chart-line', ingreso_tipo: 'pasivo' },
  { nombre: 'Otros ingresos', tipo: 'ingreso', icono: 'ti-plus', ingreso_tipo: 'activo' },
];

export const CUENTAS_SEED = [
  { nombre: 'Efectivo', tipo: 'efectivo', saldo_inicial: 0 },
];

// Un ejemplo para que el usuario entienda el concepto al abrir la app por primera vez.
export const PAGOS_FIJOS_SEED = [
  { nombre: 'Seguridad social', monto_esperado: 0, dia_esperado: 5 },
];

export const INGRESOS_FIJOS_SEED = [
  { nombre: 'Salario', monto_esperado: 0, dia_esperado: 30 },
];

export const TIPOS_INVERSION = [
  { id: 'cdt', nombre: 'CDT', color: '#2a78d6' },
  { id: 'cripto', nombre: 'Cripto', color: '#1baf7a' },
  { id: 'acciones', nombre: 'Acciones', color: '#eda100' },
  { id: 'etf', nombre: 'ETF', color: '#8a5cf5' },
  { id: 'cuenta_remunerada', nombre: 'Cuenta remunerada', color: '#4a3aa7' },
  { id: 'fondo', nombre: 'Fondo de inversión', color: '#d85a30' },
  { id: 'bien_raiz', nombre: 'Bien raíz', color: '#0f8a8a' },
  { id: 'otro', nombre: 'Otro', color: '#898781' },
];
