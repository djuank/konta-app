// Capa de dominio.
// Todos los cálculos financieros de la app viven aquí, como funciones puras
// que reciben datos y devuelven números. No conocen SQL ni HTML.
// Esto es lo que permite que mañana cambie la UI o el motor de datos
// sin tener que volver a escribir "cómo se calcula el patrimonio".

import { queryAll, queryOne, getConfig, setConfig, run } from './db.js';

const hoy = () => new Date();

function inicioDia(fecha) {
  const d = new Date(fecha);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function rangoPeriodo(periodo) {
  const fin = new Date();
  const inicio = new Date();
  if (periodo === 'semana') {
    const diaSemana = (fin.getDay() + 6) % 7; // lunes = 0
    inicio.setDate(fin.getDate() - diaSemana);
  } else if (periodo === 'mes') {
    inicio.setDate(1);
  } else if (periodo === 'anio') {
    inicio.setMonth(0, 1);
  }
  return { inicio: inicioDia(inicio), fin };
}

function toISODate(d) {
  return d.toISOString().slice(0, 10);
}

// --- Cuentas ---

export function saldoCuenta(cuentaId) {
  const cuenta = queryOne('SELECT saldo_inicial FROM cuentas WHERE id = ?', [cuentaId]);
  if (!cuenta) return 0;
  const mov = queryOne(
    `SELECT
      COALESCE(SUM(CASE WHEN tipo = 'ingreso' THEN monto ELSE 0 END), 0) AS ingresos,
      COALESCE(SUM(CASE WHEN tipo = 'gasto' THEN monto ELSE 0 END), 0) AS gastos
     FROM movimientos WHERE cuenta_id = ?`,
    [cuentaId]
  );
  return cuenta.saldo_inicial + mov.ingresos - mov.gastos;
}

export function listaCuentasConSaldo() {
  const cuentas = queryAll('SELECT * FROM cuentas WHERE activa = 1 ORDER BY id');
  return cuentas.map((c) => ({ ...c, saldo: saldoCuenta(c.id) }));
}

export function obtenerCuenta(id) {
  return queryOne('SELECT * FROM cuentas WHERE id = ?', [id]);
}

export function actualizarCuenta(id, { nombre, tipo, saldoInicial }) {
  run('UPDATE cuentas SET nombre = ?, tipo = ?, saldo_inicial = ? WHERE id = ?', [
    nombre, tipo, saldoInicial, id,
  ]);
}

export function eliminarCuenta(id) {
  run('UPDATE cuentas SET activa = 0 WHERE id = ?', [id]);
}

export function totalEnCuentas() {
  return listaCuentasConSaldo().reduce((sum, c) => sum + c.saldo, 0);
}

// --- Lo que tengo / lo que debo (patrimonio) ---

export function listaBienes() {
  return queryAll('SELECT * FROM lo_que_tengo ORDER BY valor DESC');
}

export function agregarBien({ nombre, valor }) {
  run('INSERT INTO lo_que_tengo (nombre, valor, fecha_actualizacion) VALUES (?, ?, ?)', [
    nombre, valor, toISODate(hoy()),
  ]);
  guardarSnapshotPatrimonio();
}

export function actualizarBien(id, { nombre, valor }) {
  run('UPDATE lo_que_tengo SET nombre = ?, valor = ?, fecha_actualizacion = ? WHERE id = ?', [
    nombre, valor, toISODate(hoy()), id,
  ]);
  guardarSnapshotPatrimonio();
}

export function eliminarBien(id) {
  run('DELETE FROM lo_que_tengo WHERE id = ?', [id]);
  guardarSnapshotPatrimonio();
}

export function listaDeudas() {
  return queryAll('SELECT * FROM lo_que_debo ORDER BY valor DESC');
}

export function agregarDeuda({ nombre, valor }) {
  run('INSERT INTO lo_que_debo (nombre, valor, fecha_actualizacion) VALUES (?, ?, ?)', [
    nombre, valor, toISODate(hoy()),
  ]);
  guardarSnapshotPatrimonio();
}

export function actualizarDeuda(id, { nombre, valor }) {
  run('UPDATE lo_que_debo SET nombre = ?, valor = ?, fecha_actualizacion = ? WHERE id = ?', [
    nombre, valor, toISODate(hoy()), id,
  ]);
  guardarSnapshotPatrimonio();
}

export function eliminarDeuda(id) {
  run('DELETE FROM lo_que_debo WHERE id = ?', [id]);
  guardarSnapshotPatrimonio();
}

export function totalOtrosBienes() {
  return queryOne('SELECT COALESCE(SUM(valor), 0) AS total FROM lo_que_tengo').total;
}

export function totalLoQueTengo() {
  return totalEnCuentas() + totalOtrosBienes() + totalInvertido();
}

export function totalLoQueDebo() {
  return queryOne('SELECT COALESCE(SUM(valor), 0) AS total FROM lo_que_debo').total;
}

export function dineroReal() {
  return totalLoQueTengo() - totalLoQueDebo();
}

// --- Movimientos y resumen por periodo ---

export function movimientosPeriodo(periodo) {
  const { inicio, fin } = rangoPeriodo(periodo);
  return queryAll(
    `SELECT m.*, c.nombre AS categoria_nombre, c.icono, c.ingreso_tipo, cu.nombre AS cuenta_nombre
     FROM movimientos m
     JOIN categorias c ON c.id = m.categoria_id
     JOIN cuentas cu ON cu.id = m.cuenta_id
     WHERE date(m.fecha) BETWEEN date(?) AND date(?)
     ORDER BY m.fecha DESC, m.id DESC`,
    [toISODate(inicio), toISODate(fin)]
  );
}

export function resumenPeriodo(periodo) {
  const movs = movimientosPeriodo(periodo);
  const gastosPorCategoria = {};
  const ingresosPorCategoria = {};
  let totalIngresos = 0;
  let totalGastos = 0;
  let ingresoPasivo = 0;

  for (const m of movs) {
    if (m.tipo === 'gasto') {
      gastosPorCategoria[m.categoria_nombre] = (gastosPorCategoria[m.categoria_nombre] || 0) + m.monto;
      totalGastos += m.monto;
    } else {
      ingresosPorCategoria[m.categoria_nombre] = (ingresosPorCategoria[m.categoria_nombre] || 0) + m.monto;
      totalIngresos += m.monto;
      if (m.ingreso_tipo === 'pasivo') ingresoPasivo += m.monto;
    }
  }

  return {
    totalIngresos,
    totalGastos,
    balance: totalIngresos - totalGastos,
    gastosPorCategoria,
    ingresosPorCategoria,
    ingresoPasivo,
    porcentajePasivo: totalIngresos > 0 ? (ingresoPasivo / totalIngresos) * 100 : 0,
  };
}

export function ultimosMovimientos(n = 5) {
  return queryAll(
    `SELECT m.*, c.nombre AS categoria_nombre, c.icono
     FROM movimientos m JOIN categorias c ON c.id = m.categoria_id
     ORDER BY m.fecha DESC, m.id DESC LIMIT ?`,
    [n]
  );
}

export function agregarMovimiento({ fecha, cuentaId, categoriaId, monto, tipo, nota }) {
  run(
    'INSERT INTO movimientos (fecha, cuenta_id, categoria_id, monto, tipo, nota) VALUES (?, ?, ?, ?, ?, ?)',
    [fecha, cuentaId, categoriaId, monto, tipo, nota || null]
  );
  guardarSnapshotPatrimonio();
}

export function obtenerMovimiento(id) {
  return queryOne(
    `SELECT m.*, c.nombre AS categoria_nombre, c.icono, c.tipo AS categoria_tipo
     FROM movimientos m JOIN categorias c ON c.id = m.categoria_id WHERE m.id = ?`,
    [id]
  );
}

export function actualizarMovimiento(id, { fecha, cuentaId, categoriaId, monto, tipo, nota }) {
  run(
    'UPDATE movimientos SET fecha = ?, cuenta_id = ?, categoria_id = ?, monto = ?, tipo = ?, nota = ? WHERE id = ?',
    [fecha, cuentaId, categoriaId, monto, tipo, nota || null, id]
  );
  guardarSnapshotPatrimonio();
}

export function eliminarMovimiento(id) {
  run('DELETE FROM movimientos WHERE id = ?', [id]);
  guardarSnapshotPatrimonio();
}

export function categorias(tipo) {
  return queryAll('SELECT * FROM categorias WHERE tipo = ? ORDER BY nombre', [tipo]);
}

// --- Pagos fijos mensuales (ej. seguridad social, arriendo, servicios) ---
// La idea: en vez de tener que recordar de memoria qué pagos fijos tienes
// cada mes, los registras una vez y la app te muestra cuáles ya pagaste
// este mes y cuáles te faltan.

export function listaPagosFijos() {
  return queryAll(
    `SELECT p.*, c.nombre AS categoria_nombre, c.icono, d.nombre AS deuda_nombre
     FROM pagos_fijos p
     LEFT JOIN categorias c ON c.id = p.categoria_id
     LEFT JOIN lo_que_debo d ON d.id = p.deuda_id
     WHERE p.activo = 1 ORDER BY p.dia_esperado, p.nombre`
  );
}

export function estadoPagosFijosMes() {
  const pagos = listaPagosFijos();
  return pagos.map((p) => {
    const pagosDelMes = queryAll(
      `SELECT * FROM movimientos WHERE pago_fijo_id = ? AND date(fecha) >= date('now','start of month') ORDER BY fecha DESC`,
      [p.id]
    );
    const totalPagado = pagosDelMes.reduce((sum, m) => sum + m.monto, 0);
    let estado = 'pendiente';
    if (totalPagado > 0 && totalPagado < p.monto_esperado) estado = 'parcial';
    else if (totalPagado > 0 && totalPagado >= p.monto_esperado) estado = 'completo';
    return {
      ...p,
      pagos: pagosDelMes,
      totalPagado,
      restante: Math.max(0, p.monto_esperado - totalPagado),
      estado,
      pagado: estado === 'completo', // se mantiene por compatibilidad
    };
  });
}

export function agregarPagoFijo({ nombre, montoEsperado, categoriaId, diaEsperado, deudaId }) {
  run('INSERT INTO pagos_fijos (nombre, monto_esperado, categoria_id, dia_esperado, deuda_id) VALUES (?, ?, ?, ?, ?)', [
    nombre, montoEsperado || 0, categoriaId || null, diaEsperado || null, deudaId || null,
  ]);
}

export function actualizarPagoFijo(id, { nombre, montoEsperado, categoriaId, diaEsperado, deudaId }) {
  run('UPDATE pagos_fijos SET nombre = ?, monto_esperado = ?, categoria_id = ?, dia_esperado = ?, deuda_id = ? WHERE id = ?', [
    nombre, montoEsperado || 0, categoriaId || null, diaEsperado || null, deudaId || null, id,
  ]);
}

export function eliminarPagoFijo(id) {
  run('UPDATE pagos_fijos SET activo = 0 WHERE id = ?', [id]);
}

// Marcar un pago fijo como pagado. Si está vinculado a una deuda, el monto
// pagado se descuenta automáticamente de esa deuda (sin bajar de $0).
export function marcarPagoFijoPagado(pagoFijoId, { monto, cuentaId, fecha, nota }) {
  const pago = queryOne('SELECT * FROM pagos_fijos WHERE id = ?', [pagoFijoId]);
  if (!pago) return;
  const categoriaId = pago.categoria_id
    || categorias('gasto').find((c) => c.nombre === 'Otros gastos')?.id
    || categorias('gasto')[0]?.id;
  run(
    'INSERT INTO movimientos (fecha, cuenta_id, categoria_id, monto, tipo, nota, pago_fijo_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [fecha, cuentaId, categoriaId, monto, 'gasto', nota || null, pagoFijoId]
  );
  if (pago.deuda_id) {
    const deuda = queryOne('SELECT * FROM lo_que_debo WHERE id = ?', [pago.deuda_id]);
    if (deuda) {
      const nuevoSaldo = Math.max(0, deuda.valor - monto);
      run('UPDATE lo_que_debo SET valor = ?, fecha_actualizacion = ? WHERE id = ?', [
        nuevoSaldo, toISODate(hoy()), pago.deuda_id,
      ]);
    }
  }
  guardarSnapshotPatrimonio();
}

// Deshacer un pago fijo: elimina el movimiento y, si estaba vinculado a una
// deuda, le devuelve el monto que se había descontado.
export function desmarcarPagoFijo(movimientoId) {
  const mov = queryOne('SELECT * FROM movimientos WHERE id = ?', [movimientoId]);
  if (mov && mov.pago_fijo_id) {
    const pago = queryOne('SELECT * FROM pagos_fijos WHERE id = ?', [mov.pago_fijo_id]);
    if (pago && pago.deuda_id) {
      const deuda = queryOne('SELECT * FROM lo_que_debo WHERE id = ?', [pago.deuda_id]);
      if (deuda) {
        run('UPDATE lo_que_debo SET valor = ?, fecha_actualizacion = ? WHERE id = ?', [
          deuda.valor + mov.monto, toISODate(hoy()), pago.deuda_id,
        ]);
      }
    }
  }
  run('DELETE FROM movimientos WHERE id = ?', [movimientoId]);
  guardarSnapshotPatrimonio();
}

// --- Ingresos fijos mensuales (ej. salario, arriendos que recibes) ---
// El mismo concepto que los pagos fijos, pero del lado de lo que entra.
// Parametrizas una vez cuánto esperas recibir, y la app lo usa para
// proyectar tu mes ANTES de que termine — no con promedios históricos.

export function listaIngresosFijos() {
  return queryAll(
    `SELECT i.*, c.nombre AS categoria_nombre, c.icono
     FROM ingresos_fijos i LEFT JOIN categorias c ON c.id = i.categoria_id
     WHERE i.activo = 1 ORDER BY i.dia_esperado, i.nombre`
  );
}

export function estadoIngresosFijosMes() {
  const ingresos = listaIngresosFijos();
  return ingresos.map((i) => {
    const mov = queryOne(
      `SELECT * FROM movimientos WHERE ingreso_fijo_id = ? AND date(fecha) >= date('now','start of month') ORDER BY fecha DESC LIMIT 1`,
      [i.id]
    );
    return { ...i, recibido: !!mov, movimiento: mov || null };
  });
}

export function agregarIngresoFijo({ nombre, montoEsperado, categoriaId, diaEsperado }) {
  run('INSERT INTO ingresos_fijos (nombre, monto_esperado, categoria_id, dia_esperado) VALUES (?, ?, ?, ?)', [
    nombre, montoEsperado || 0, categoriaId || null, diaEsperado || null,
  ]);
}

export function actualizarIngresoFijo(id, { nombre, montoEsperado, categoriaId, diaEsperado }) {
  run('UPDATE ingresos_fijos SET nombre = ?, monto_esperado = ?, categoria_id = ?, dia_esperado = ? WHERE id = ?', [
    nombre, montoEsperado || 0, categoriaId || null, diaEsperado || null, id,
  ]);
}

export function eliminarIngresoFijo(id) {
  run('UPDATE ingresos_fijos SET activo = 0 WHERE id = ?', [id]);
}

// Marcar un ingreso fijo como recibido (ej. ya cayó la nómina, ya pagaron
// el arriendo). Crea el movimiento real, igual que con los pagos fijos.
export function marcarIngresoFijoRecibido(ingresoFijoId, { monto, cuentaId, fecha, nota }) {
  const ingreso = queryOne('SELECT * FROM ingresos_fijos WHERE id = ?', [ingresoFijoId]);
  if (!ingreso) return;
  const categoriaId = ingreso.categoria_id
    || categorias('ingreso').find((c) => c.nombre === 'Otros ingresos')?.id
    || categorias('ingreso')[0]?.id;
  run(
    'INSERT INTO movimientos (fecha, cuenta_id, categoria_id, monto, tipo, nota, ingreso_fijo_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [fecha, cuentaId, categoriaId, monto, 'ingreso', nota || null, ingresoFijoId]
  );
  guardarSnapshotPatrimonio();
}

export function desmarcarIngresoFijo(movimientoId) {
  run('DELETE FROM movimientos WHERE id = ?', [movimientoId]);
  guardarSnapshotPatrimonio();
}

export function totalIngresosFijos() {
  return queryOne('SELECT COALESCE(SUM(monto_esperado), 0) AS total FROM ingresos_fijos WHERE activo = 1').total;
}

export function totalGastosFijosEsperados() {
  return queryOne('SELECT COALESCE(SUM(monto_esperado), 0) AS total FROM pagos_fijos WHERE activo = 1').total;
}

// --- Presupuesto del mes (parametrizado, no histórico) ---
// Esto es lo que ya sabes de memoria con tu Excel: si sumas tus ingresos
// fijos y les restas tus gastos fijos, sabes ANTES de que termine el mes
// si te va a sobrar o si vas a quedar en negativo. Si sobra, se reparte
// entre invertir, ahorrar y disfrutar según tu plan.

export function planGastoConsciente() {
  const ingresosFijos = totalIngresosFijos();
  const gastosFijos = totalGastosFijosEsperados();
  const restante = ingresosFijos - gastosFijos;

  const baldes = {
    fijos: Number(getConfig('balde_fijos')),
    inversion: Number(getConfig('balde_inversion')),
    ahorro: Number(getConfig('balde_ahorro')),
    disfrute: Number(getConfig('balde_disfrute')),
  };

  // El % de "fijos" ya está representado por tus gastos fijos reales,
  // así que lo que sobra se reparte proporcionalmente entre invertir,
  // ahorrar y disfrutar, respetando las proporciones que definiste.
  const denominador = baldes.inversion + baldes.ahorro + baldes.disfrute;
  const factor = denominador > 0 ? 1 / denominador : 0;
  const haySobrante = restante > 0;

  return {
    ingresosFijos,
    gastosFijos,
    restante,
    haySobrante,
    baldes,
    montoInversion: haySobrante ? restante * baldes.inversion * factor : 0,
    montoAhorro: haySobrante ? restante * baldes.ahorro * factor : 0,
    montoDisfrute: haySobrante ? restante * baldes.disfrute * factor : 0,
  };
}

// --- Inversiones ---

export function listaInversiones() {
  return queryAll('SELECT * FROM inversiones ORDER BY valor_actual DESC');
}

export function totalInvertido() {
  return queryOne('SELECT COALESCE(SUM(valor_actual), 0) AS total FROM inversiones').total;
}

export function totalCostoInvertido() {
  return queryOne('SELECT COALESCE(SUM(valor_invertido), 0) AS total FROM inversiones').total;
}

export function rentabilidadInversion(inv) {
  if (!inv.valor_invertido) return 0;
  return ((inv.valor_actual - inv.valor_invertido) / inv.valor_invertido) * 100;
}

export function rentabilidadTotalPortafolio() {
  const costo = totalCostoInvertido();
  if (!costo) return 0;
  return ((totalInvertido() - costo) / costo) * 100;
}

export function distribucionInversionesPorTipo() {
  const rows = queryAll(
    `SELECT tipo, COALESCE(SUM(valor_actual), 0) AS total FROM inversiones GROUP BY tipo ORDER BY total DESC`
  );
  const total = rows.reduce((s, r) => s + r.total, 0);
  return rows.map((r) => ({ ...r, porcentaje: total > 0 ? (r.total / total) * 100 : 0 }));
}

export function agregarInversion({ nombre, tipo, valorInvertido, valorActual }) {
  run('INSERT INTO inversiones (nombre, tipo, valor_invertido, valor_actual) VALUES (?, ?, ?, ?)', [
    nombre, tipo, valorInvertido, valorActual,
  ]);
}

export function actualizarInversion(id, { nombre, tipo, valorInvertido, valorActual }) {
  run('UPDATE inversiones SET nombre = ?, tipo = ?, valor_invertido = ?, valor_actual = ? WHERE id = ?', [
    nombre, tipo, valorInvertido, valorActual, id,
  ]);
}

export function eliminarInversion(id) {
  run('DELETE FROM inversiones WHERE id = ?', [id]);
}

// --- Proyección de patrimonio (interés compuesto) ---

export function proyectarPatrimonio({ years, aporteMensual, tasaAnual }) {
  const tasaMensual = tasaAnual / 12;
  let valor = dineroReal();
  const serie = [valor];
  const meses = years * 12;
  for (let i = 1; i <= meses; i++) {
    valor = valor * (1 + tasaMensual) + aporteMensual;
    if (i % 12 === 0) serie.push(valor);
  }
  return serie;
}

// --- Meta de patrimonio ("¿cuándo soy millonario a este ritmo?") ---

export function metaPatrimonio() {
  return Number(getConfig('meta_patrimonio')) || 0;
}

export function setMetaPatrimonio(monto) {
  setConfig('meta_patrimonio', monto);
}

export function tasaAnualEsperada() {
  return Number(getConfig('meta_tasa_anual')) || 8;
}

export function setTasaAnualEsperada(pct) {
  setConfig('meta_tasa_anual', pct);
}

// Lo que tu plan de este mes ya sugiere destinar a construir patrimonio
// (invertir + ahorrar), que es lo que usamos como aporte mensual por defecto.
export function aporteMensualSugerido() {
  const plan = planGastoConsciente();
  return plan.haySobrante ? plan.montoInversion + plan.montoAhorro : 0;
}

// Cuántos meses toma llegar a una meta de patrimonio, aportando un monto
// fijo cada mes a una tasa anual esperada. Tope de 100 años para no
// quedarse calculando para siempre si el aporte es 0 o negativo.
export function mesesParaAlcanzarMeta(meta, aporteMensual, tasaAnualPct) {
  let valor = dineroReal();
  if (meta <= valor) return 0;
  if (aporteMensual <= 0 && tasaAnualPct <= 0) return null; // nunca, a este ritmo
  const tasaMensual = tasaAnualPct / 100 / 12;
  const TOPE_MESES = 1200;
  for (let m = 1; m <= TOPE_MESES; m++) {
    valor = valor * (1 + tasaMensual) + aporteMensual;
    if (valor >= meta) return m;
  }
  return null; // no se alcanza en 100 años a este ritmo
}

export function proyeccionHaciaMeta() {
  const meta = metaPatrimonio();
  const tasaAnual = tasaAnualEsperada();
  const aporte = aporteMensualSugerido();
  const actual = dineroReal();
  const meses = meta > 0 ? mesesParaAlcanzarMeta(meta, aporte, tasaAnual) : null;
  return {
    meta,
    tasaAnual,
    aporte,
    actual,
    progresoPct: meta > 0 ? Math.min(100, (actual / meta) * 100) : 0,
    meses,
    anios: meses !== null ? Math.floor(meses / 12) : null,
    mesesRestoDeAnio: meses !== null ? meses % 12 : null,
  };
}

// --- Patrimonio histórico (snapshots automáticos) ---

export function guardarSnapshotPatrimonio() {
  const totalTengo = totalLoQueTengo();
  const totalDebo = totalLoQueDebo();
  const fecha = toISODate(hoy());
  run(
    `INSERT INTO patrimonio_historico (fecha, total_tengo, total_debo, dinero_real) VALUES (?, ?, ?, ?)
     ON CONFLICT(fecha) DO UPDATE SET total_tengo = excluded.total_tengo, total_debo = excluded.total_debo, dinero_real = excluded.dinero_real`,
    [fecha, totalTengo, totalDebo, totalTengo - totalDebo]
  );
}

export function historicoPatrimonio() {
  return queryAll('SELECT * FROM patrimonio_historico ORDER BY fecha');
}

export function variacionUltimoMes() {
  const hist = historicoPatrimonio();
  if (hist.length < 2) return 0;
  const actual = hist[hist.length - 1].dinero_real;
  const haceUnMes = new Date();
  haceUnMes.setMonth(haceUnMes.getMonth() - 1);
  const anterior = hist.find((h) => new Date(h.fecha) >= haceUnMes) || hist[0];
  if (anterior.dinero_real === 0) return 0;
  return ((actual - anterior.dinero_real) / Math.abs(anterior.dinero_real)) * 100;
}

// --- Consejos basados en principios de grandes inversores ---
// Reglas simples, sin IA: "págate primero", evitar plata parada,
// método avalancha de deudas, y seguimiento del ingreso pasivo.

export function generarTips() {
  const tips = [];
  const plan = planGastoConsciente();
  const resumenMes = resumenPeriodo('mes');
  const totalCuentas = totalEnCuentas();
  const inversiones = listaInversiones();
  const totalInv = totalInvertido();

  // 0. Vas a quedar en negativo este mes según tus ingresos y gastos fijos
  if (plan.gastosFijos > 0 && plan.restante < 0) {
    tips.push({
      icon: 'ti-alert-triangle',
      tono: 'danger',
      texto: `Este mes tus gastos fijos (${fmtMoney(plan.gastosFijos)}) superan tus ingresos fijos (${fmtMoney(plan.ingresosFijos)}) por ${fmtMoney(Math.abs(plan.restante))}. Revisa qué se puede recortar antes de que avance el mes.`,
    });
  }

  // 1. ¿Ya se pagó a sí mismo? (principio de Buffett/Kiyosaki)
  if (plan.haySobrante && totalInv === 0) {
    tips.push({
      icon: 'ti-piggy-bank',
      tono: 'warning',
      texto: `Este mes te sobran ${fmtMoney(plan.restante)} después de tus gastos fijos. Tu plan sugiere invertir ${fmtMoney(plan.montoInversion)} de eso — sepáralo antes de gastarlo en otra cosa.`,
    });
  }

  // 2. Plata parada sin generar nada (vs. ingresos fijos)
  if (totalCuentas > plan.ingresosFijos * 2 && plan.ingresosFijos > 0) {
    tips.push({
      icon: 'ti-bulb',
      tono: 'neutral',
      texto: `Tienes ${fmtMoney(totalCuentas)} en tus cuentas — más de 2 meses de tu ingreso fijo. La plata parada pierde valor con la inflación; considera mover el excedente a una inversión.`,
    });
  }

  // 3. Deudas: sugerencia de método avalancha (pagar primero la de mayor interés)
  const pasivos = queryAll('SELECT * FROM lo_que_debo ORDER BY valor DESC');
  if (pasivos.length > 1) {
    tips.push({
      icon: 'ti-credit-card',
      tono: 'danger',
      texto: `Tienes ${pasivos.length} deudas registradas. El método más eficiente es pagar primero la de mayor interés (aunque no sea la más grande) — así ahorras más a largo plazo.`,
    });
  }

  // 4. Ingreso pasivo: tendencia
  const variacionPasivo = resumenMes.porcentajePasivo;
  if (variacionPasivo > 0) {
    tips.push({
      icon: 'ti-trending-up',
      tono: 'success',
      texto: `${pctFmt(variacionPasivo)} de tu ingreso este mes no depende de tu trabajo directo. Sigue así — es la base de la libertad financiera.`,
    });
  }

  // 5. Diversificación de inversiones
  if (inversiones.length === 1) {
    tips.push({
      icon: 'ti-chart-pie',
      tono: 'neutral',
      texto: `Todo tu portafolio está en "${inversiones[0].nombre}". Los grandes inversores diversifican entre varios tipos de activo para reducir el riesgo.`,
    });
  }

  return tips;
}

function fmtMoney(v) {
  return '$' + Math.round(v || 0).toLocaleString('es-CO');
}
function pctFmt(v) {
  return Math.round(v || 0) + '%';
}
