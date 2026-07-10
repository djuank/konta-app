import { initDatabase, run, queryAll, getConfig, setConfig, getRawBytes, replaceDatabase } from './db.js';
import * as domain from './domain.js';
import { TIPOS_INVERSION } from './schema.js';
import {
  downloadDatabaseFile, downloadJsonExport, pickFile, readFileAsUint8Array,
} from './storage.js';

const app = document.getElementById('app');
let currentScreen = 'inicio';
let currentPeriodo = 'semana';
let seccionesAbiertas = new Set(); // categorías desplegadas en los acordeones

const fmt = (v) => '$' + Math.round(v || 0).toLocaleString('es-CO');
const pct = (v) => Math.round(v || 0) + '%';

function icon(name, cls) {
  return `<i class="ti ${name}" aria-hidden="true"></i>`;
}

// ---------- Router ----------

function navigate(screen) {
  currentScreen = screen;
  render();
}
window.navigate = navigate;

function render() {
  let html = '';
  if (currentScreen === 'inicio') html = screenInicio();
  else if (currentScreen === 'movimientos') html = screenMovimientos();
  else if (currentScreen === 'cuentas') html = screenCuentas();
  else if (currentScreen === 'inversiones') html = screenInversiones();
  else if (currentScreen === 'patrimonio') html = screenPatrimonio();
  else if (currentScreen === 'analisis') html = screenAnalisis();
  else if (currentScreen === 'configuracion') html = screenConfiguracion();

  const tips = domain.generarTips();

  app.innerHTML = `
    ${topBar(tips.length)}
    <div class="screen">${html}</div>
    ${currentScreen === 'movimientos' ? '<button class="fab" id="fab-add" aria-label="Agregar movimiento"><i class="ti ti-plus" aria-hidden="true"></i></button>' : ''}
    ${navBar()}
  `;
  attachGlobalEvents();
  if (currentScreen === 'analisis') attachAnalisisEvents();
}

function topBar(cantidadTips) {
  return `
    <div class="topbar">
      <span class="wordmark">Konta</span>
      <button class="bell-btn" id="btn-notificaciones" aria-label="Consejos y notificaciones">
        <i class="ti ti-bell" aria-hidden="true"></i>
        ${cantidadTips > 0 ? `<span class="bell-badge">${cantidadTips}</span>` : ''}
      </button>
    </div>
  `;
}

function abrirPanelNotificaciones() {
  const tips = domain.generarTips();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-sheet">
      <div class="row-between" style="margin-bottom:14px;">
        <h2 style="margin:0;">Consejos para hacer crecer tu patrimonio</h2>
        <button class="icon-btn" id="modal-close" aria-label="Cerrar"><i class="ti ti-x" aria-hidden="true"></i></button>
      </div>
      ${tips.length === 0 ? emptyState('ti-bell-off', 'No tienes consejos nuevos por ahora') :
        tips.map((t) => `
          <div class="notif-item">
            <div class="icon-badge ${t.tono}"><i class="ti ${t.icon}" aria-hidden="true"></i></div>
            <p style="font-size:13px;margin:0;flex:1;">${t.texto}</p>
          </div>
        `).join('')}
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector('#modal-close').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

function navBar() {
  const items = [
    { id: 'inicio', icon: 'ti-home', label: 'Inicio' },
    { id: 'movimientos', icon: 'ti-list', label: 'Movim.' },
    { id: 'cuentas', icon: 'ti-wallet', label: 'Cuentas' },
    { id: 'inversiones', icon: 'ti-chart-pie', label: 'Invers.' },
    { id: 'analisis', icon: 'ti-chart-bar', label: 'Análisis' },
    { id: 'configuracion', icon: 'ti-settings', label: 'Ajustes' },
  ];
  return `<nav class="bottom-nav">
    ${items.map((it) => `
      <button data-nav="${it.id}" class="${currentScreen === it.id ? 'active' : ''}">
        <i class="ti ${it.icon}" aria-hidden="true"></i>
        <span>${it.label}</span>
      </button>
    `).join('')}
  </nav>`;
}

function attachGlobalEvents() {
  const btnBell = document.getElementById('btn-notificaciones');
  if (btnBell) btnBell.addEventListener('click', () => abrirPanelNotificaciones());
  const btnVerPatrimonio = document.getElementById('btn-ver-patrimonio');
  if (btnVerPatrimonio) btnVerPatrimonio.addEventListener('click', () => navigate('patrimonio'));
  app.querySelectorAll('[data-nav]').forEach((btn) => {
    btn.addEventListener('click', () => navigate(btn.dataset.nav));
  });
  const fab = document.getElementById('fab-add');
  if (fab) fab.addEventListener('click', () => openModalMovimiento());
  app.querySelectorAll('[data-mov-id]').forEach((row) => {
    row.addEventListener('click', () => {
      const mov = domain.obtenerMovimiento(Number(row.dataset.movId));
      if (mov) openModalMovimiento(mov);
    });
  });
  app.querySelectorAll('[data-acordeon]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const clave = btn.dataset.acordeon;
      if (seccionesAbiertas.has(clave)) seccionesAbiertas.delete(clave);
      else seccionesAbiertas.add(clave);
      render();
    });
  });
  app.querySelectorAll('[data-pago-fijo-row]').forEach((row) => {
    row.addEventListener('click', () => {
      const id = Number(row.dataset.pagoFijoRow);
      const pago = domain.estadoPagosFijosMes().find((p) => p.id === id);
      if (pago) openModalDetallePagoFijo(pago);
    });
  });
  const btnAddPagoFijo = document.getElementById('btn-add-pago-fijo');
  if (btnAddPagoFijo) btnAddPagoFijo.addEventListener('click', () => openModalPagoFijo());
  app.querySelectorAll('[data-ingreso-fijo-row]').forEach((row) => {
    row.addEventListener('click', () => {
      const id = Number(row.dataset.ingresoFijoRow);
      const ingreso = domain.estadoIngresosFijosMes().find((i) => i.id === id);
      if (!ingreso) return;
      if (ingreso.recibido) {
        if (confirm(`¿Deshacer el ingreso de "${ingreso.nombre}" este mes?`)) {
          domain.desmarcarIngresoFijo(ingreso.movimiento.id);
          render();
        }
      } else {
        openModalMarcarIngreso(ingreso);
      }
    });
  });
  const btnAddIngresoFijoInicio = document.getElementById('btn-add-ingreso-fijo-inicio');
  if (btnAddIngresoFijoInicio) btnAddIngresoFijoInicio.addEventListener('click', () => openModalIngresoFijo());
}

// ---------- Pantalla: Inicio ----------

function screenInicio() {
  const efectivo = domain.totalEnCuentas();
  const resumenMes = domain.resumenPeriodo('mes');
  const ultimos = domain.ultimosMovimientos(4);
  const pagosFijos = domain.estadoPagosFijosMes();
  const ingresosFijos = domain.estadoIngresosFijosMes();
  const plan = domain.planGastoConsciente();

  return `
    <h1>Inicio</h1>
    <div class="card">
      <p class="label">Tu efectivo disponible</p>
      <p class="hero-number">${fmt(efectivo)}</p>
      <button id="btn-ver-patrimonio" style="margin-top:6px;padding:0;border:none;background:none;color:var(--text-secondary);font-size:12px;display:flex;align-items:center;gap:2px;">
        Ver patrimonio total <i class="ti ti-chevron-right" style="font-size:13px;" aria-hidden="true"></i>
      </button>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:14px 0;">
        <div class="metric-card">
          <p class="label"><i class="ti ti-arrow-down" style="font-size:13px" aria-hidden="true"></i> Entró este mes</p>
          <p style="font-size:16px;font-weight:500;margin:0;" class="pos">${fmt(resumenMes.totalIngresos)}</p>
        </div>
        <div class="metric-card">
          <p class="label"><i class="ti ti-arrow-up" style="font-size:13px" aria-hidden="true"></i> Salió este mes</p>
          <p style="font-size:16px;font-weight:500;margin:0;" class="neg">${fmt(resumenMes.totalGastos)}</p>
        </div>
      </div>
    </div>

    <h2>Presupuesto de este mes</h2>
    <div class="card">
      <div class="row-between" style="font-size:13px;margin-bottom:4px;">
        <span class="muted">Ingresos fijos</span><span style="font-weight:500;" class="pos">${fmt(plan.ingresosFijos)}</span>
      </div>
      <div class="row-between" style="font-size:13px;margin-bottom:10px;">
        <span class="muted">Gastos fijos</span><span style="font-weight:500;" class="neg">${fmt(plan.gastosFijos)}</span>
      </div>
      <div style="border-top:0.5px solid var(--border);padding-top:10px;">
        ${plan.haySobrante ? `
          <p class="label" style="margin-bottom:2px;">Te sobran</p>
          <p class="hero-number pos" style="font-size:22px;">${fmt(plan.restante)}</p>
          <p class="muted" style="margin:2px 0 12px;">después de cubrir tus gastos fijos</p>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;">
            <div class="metric-card">
              <p class="label" style="font-size:11px;">Invertir</p>
              <p style="font-size:13px;font-weight:500;margin:0;">${fmt(plan.montoInversion)}</p>
            </div>
            <div class="metric-card">
              <p class="label" style="font-size:11px;">Ahorrar</p>
              <p style="font-size:13px;font-weight:500;margin:0;">${fmt(plan.montoAhorro)}</p>
            </div>
            <div class="metric-card">
              <p class="label" style="font-size:11px;">Disfrutar</p>
              <p style="font-size:13px;font-weight:500;margin:0;">${fmt(plan.montoDisfrute)}</p>
            </div>
          </div>
        ` : plan.gastosFijos > 0 || plan.ingresosFijos > 0 ? `
          <p class="label" style="margin-bottom:2px;">Vas a quedar corto por</p>
          <p class="hero-number neg" style="font-size:22px;">${fmt(Math.abs(plan.restante))}</p>
          <p class="muted" style="margin:2px 0 0;">tus gastos fijos superan tus ingresos fijos este mes</p>
        ` : `
          <p class="muted">Parametriza tus ingresos y gastos fijos en Ajustes para ver tu presupuesto del mes.</p>
        `}
      </div>
    </div>

    <div class="row-between">
      <h2 style="margin-bottom:0;">Ingresos fijos de este mes</h2>
      <button class="icon-btn" id="btn-add-ingreso-fijo-inicio" aria-label="Agregar ingreso fijo"><i class="ti ti-plus" aria-hidden="true"></i></button>
    </div>
    <div class="card">
      ${ingresosFijos.length === 0 ? emptyState('ti-cash', 'No tienes ingresos fijos registrados todavía') :
        renderIngresosFijosAgrupados(ingresosFijos)}
    </div>

    <div class="row-between">
      <h2 style="margin-bottom:0;">Pagos fijos de este mes</h2>
      <button class="icon-btn" id="btn-add-pago-fijo" aria-label="Agregar pago fijo"><i class="ti ti-plus" aria-hidden="true"></i></button>
    </div>
    <div class="card">
      ${pagosFijos.length === 0 ? emptyState('ti-calendar-due', 'No tienes pagos fijos registrados todavía') :
        renderPagosFijosAgrupados(pagosFijos)}
    </div>

    <h2>Últimos movimientos</h2>
    <div class="card">
      ${ultimos.length === 0 ? emptyState('ti-receipt', 'Aún no has registrado movimientos') :
        ultimos.map((m) => movimientoRow(m)).join('')}
    </div>
  `;
}

function agruparPorCategoria(lista) {
  const grupos = {};
  for (const item of lista) {
    const clave = item.categoria_nombre || 'Sin categoría';
    if (!grupos[clave]) grupos[clave] = [];
    grupos[clave].push(item);
  }
  return grupos;
}

function renderPagosFijosAgrupados(pagosFijos) {
  const grupos = agruparPorCategoria(pagosFijos);
  return Object.keys(grupos).map((nombreGrupo) => {
    const items = grupos[nombreGrupo];
    const clave = `pago:${nombreGrupo}`;
    const abierta = seccionesAbiertas.has(clave);
    const totalPagado = items.reduce((s, p) => s + p.totalPagado, 0);
    const totalEsperado = items.reduce((s, p) => s + p.monto_esperado, 0);
    const completos = items.filter((p) => p.estado === 'completo').length;
    return `
      <button class="acordeon-header" data-acordeon="${clave}">
        <i class="ti ${abierta ? 'ti-chevron-down' : 'ti-chevron-right'}" aria-hidden="true"></i>
        <span style="flex:1;text-align:left;">${nombreGrupo}</span>
        <span class="muted" style="font-size:12px;">${completos}/${items.length} · ${fmt(totalPagado)} de ${fmt(totalEsperado)}</span>
      </button>
      ${abierta ? `<div style="padding:2px 0 8px;">${items.map((p) => pagoFijoRow(p)).join('')}</div>` : ''}
    `;
  }).join('');
}

function renderPagosFijosAjustesAgrupados(pagosFijos) {
  const grupos = agruparPorCategoria(pagosFijos);
  const nombres = Object.keys(grupos);
  return nombres.map((nombreGrupo, idx) => `
    ${idx > 0 ? '<div style="height:14px;"></div>' : ''}
    <p class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:0.03em;margin:0 0 4px;">${nombreGrupo}</p>
    ${grupos[nombreGrupo].map((p) => `
      <div class="list-item">
        <div class="icon-badge neutral"><i class="ti ${p.icono || 'ti-calendar-due'}" aria-hidden="true"></i></div>
        <div style="flex:1;">
          <p style="font-size:13px;margin:0;">${p.nombre}</p>
          <p class="muted" style="margin:0;">${fmt(p.monto_esperado)}${p.dia_esperado ? ' · día ' + p.dia_esperado : ''}${p.deuda_nombre ? ' · abona a ' + p.deuda_nombre : ''}</p>
        </div>
        <button class="icon-btn" data-edit-pago-fijo="${p.id}" aria-label="Editar"><i class="ti ti-pencil" aria-hidden="true"></i></button>
      </div>
    `).join('')}
  `).join('');
}

function pagoFijoRow(p) {
  const badgeTono = p.estado === 'completo' ? 'success' : p.estado === 'parcial' ? 'warning' : 'warning';
  const icono = p.estado === 'completo' ? 'ti-check' : p.estado === 'parcial' ? 'ti-progress' : 'ti-clock';
  let subtexto;
  if (p.estado === 'completo') subtexto = 'Pagado este mes';
  else if (p.estado === 'parcial') subtexto = `Pagado ${fmt(p.totalPagado)} de ${fmt(p.monto_esperado)} · falta ${fmt(p.restante)}`;
  else subtexto = p.dia_esperado ? `Vence cerca del día ${p.dia_esperado}` : 'Pendiente este mes';

  return `
    <div class="list-item" data-pago-fijo-row="${p.id}" style="cursor:pointer;">
      <div class="icon-badge ${badgeTono}">
        <i class="ti ${icono}" aria-hidden="true"></i>
      </div>
      <div style="flex:1;">
        <p style="font-size:13px;margin:0;">${p.nombre}${p.deuda_nombre ? ` <span class="muted" style="font-size:11px;">· abona a ${p.deuda_nombre}</span>` : ''}</p>
        <p class="muted" style="margin:0;">${subtexto}</p>
      </div>
      <span style="font-size:13px;font-weight:500;" class="${p.estado === 'completo' ? 'pos' : ''}">${fmt(p.estado === 'pendiente' ? p.monto_esperado : p.totalPagado)}</span>
    </div>
  `;
}

function renderIngresosFijosAgrupados(ingresosFijos) {
  const grupos = agruparPorCategoria(ingresosFijos);
  return Object.keys(grupos).map((nombreGrupo) => {
    const items = grupos[nombreGrupo];
    const clave = `ingreso:${nombreGrupo}`;
    const abierta = seccionesAbiertas.has(clave);
    const totalEsperado = items.reduce((s, i) => s + i.monto_esperado, 0);
    const recibidos = items.filter((i) => i.recibido).length;
    return `
      <button class="acordeon-header" data-acordeon="${clave}">
        <i class="ti ${abierta ? 'ti-chevron-down' : 'ti-chevron-right'}" aria-hidden="true"></i>
        <span style="flex:1;text-align:left;">${nombreGrupo}</span>
        <span class="muted" style="font-size:12px;">${recibidos}/${items.length} · ${fmt(totalEsperado)}</span>
      </button>
      ${abierta ? `<div style="padding:2px 0 8px;">${items.map((i) => ingresoFijoRow(i)).join('')}</div>` : ''}
    `;
  }).join('');
}

function ingresoFijoRow(i) {
  return `
    <div class="list-item" data-ingreso-fijo-row="${i.id}" style="cursor:pointer;">
      <div class="icon-badge ${i.recibido ? 'success' : 'warning'}">
        <i class="ti ${i.recibido ? 'ti-check' : 'ti-clock'}" aria-hidden="true"></i>
      </div>
      <div style="flex:1;">
        <p style="font-size:13px;margin:0;">${i.nombre}</p>
        <p class="muted" style="margin:0;">${i.recibido ? 'Recibido este mes' : (i.dia_esperado ? `Se espera cerca del día ${i.dia_esperado}` : 'Pendiente este mes')}</p>
      </div>
      <span style="font-size:13px;font-weight:500;" class="${i.recibido ? 'pos' : ''}">${fmt(i.recibido ? i.movimiento.monto : i.monto_esperado)}</span>
    </div>
  `;
}

function movimientoRow(m) {
  const esIngreso = m.tipo === 'ingreso';
  return `
    <div class="list-item" data-mov-id="${m.id}" style="cursor:pointer;">
      <div class="icon-badge ${esIngreso ? 'success' : 'warning'}"><i class="ti ${m.icono || 'ti-circle'}" aria-hidden="true"></i></div>
      <div style="flex:1;">
        <p style="font-size:13px;margin:0;">${m.categoria_nombre}</p>
        <p class="muted" style="margin:0;">${m.fecha}${m.cuenta_nombre ? ' · ' + m.cuenta_nombre : ''}</p>
      </div>
      <span style="font-size:13px;font-weight:500;" class="${esIngreso ? 'pos' : 'neg'}">${esIngreso ? '+' : '-'}${fmt(m.monto)}</span>
    </div>
  `;
}

function emptyState(iconName, text) {
  return `<div class="empty-state"><i class="ti ${iconName}" aria-hidden="true"></i>${text}</div>`;
}

// ---------- Pantalla: Movimientos ----------

function screenMovimientos() {
  const movs = domain.movimientosPeriodo('mes');
  return `
    <h1>Movimientos</h1>
    <p class="muted" style="margin-bottom:8px;">Este mes · toca un movimiento para editarlo</p>
    <div class="card">
      ${movs.length === 0 ? emptyState('ti-receipt', 'Todavía no hay movimientos este mes. Toca + para agregar uno.') :
        movs.map((m) => movimientoRow(m)).join('')}
    </div>
  `;
}

function openModalMovimiento(movimientoExistente) {
  const esEdicion = !!movimientoExistente;
  const cuentas = queryAll('SELECT * FROM cuentas WHERE activa = 1');
  const catGasto = domain.categorias('gasto');
  const catIngreso = domain.categorias('ingreso');

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-sheet">
      <div class="row-between" style="margin-bottom:14px;">
        <h2 style="margin:0;">${esEdicion ? 'Editar movimiento' : 'Nuevo movimiento'}</h2>
        <button class="icon-btn" id="modal-close" aria-label="Cerrar"><i class="ti ti-x" aria-hidden="true"></i></button>
      </div>

      <div class="toggle-group">
        <button type="button" class="tipo-btn" data-tipo="gasto">Salió</button>
        <button type="button" class="tipo-btn" data-tipo="ingreso">Entró</button>
      </div>

      <div class="field">
        <label>¿Cuánto?</label>
        <input type="number" id="mov-monto" placeholder="0" min="0" step="1" value="${esEdicion ? movimientoExistente.monto : ''}" />
        <p class="muted" id="mov-monto-error" style="display:none;color:var(--danger-text);margin:4px 0 0;">Escribe cuánto entró o salió.</p>
      </div>

      <div class="field">
        <label id="mov-categoria-label">¿De/para qué?</label>
        <div class="chip-group" id="mov-categorias"></div>
      </div>

      <div class="field">
        <label>¿De qué cuenta?</label>
        ${cuentas.length === 0
          ? '<p class="muted" style="color:var(--danger-text);">Primero agrega una cuenta en la pestaña Cuentas.</p>'
          : `<select id="mov-cuenta">
          ${cuentas.map((c) => `<option value="${c.id}" ${esEdicion && movimientoExistente.cuenta_id === c.id ? 'selected' : ''}>${c.nombre}</option>`).join('')}
        </select>`}
      </div>

      <div class="field">
        <label>Fecha</label>
        <input type="date" id="mov-fecha" value="${esEdicion ? movimientoExistente.fecha : new Date().toISOString().slice(0, 10)}" />
      </div>

      <div class="field">
        <label>Nota (opcional)</label>
        <input type="text" id="mov-nota" placeholder="Ej: mercado de la semana" value="${esEdicion && movimientoExistente.nota ? movimientoExistente.nota : ''}" />
      </div>

      <button class="primary" id="mov-guardar" style="width:100%;margin-bottom:8px;">${esEdicion ? 'Guardar cambios' : 'Guardar'}</button>
      ${esEdicion ? '<button id="mov-eliminar" style="width:100%;color:var(--danger-text);">Eliminar movimiento</button>' : ''}
    </div>
  `;
  document.body.appendChild(overlay);

  let tipoActual = esEdicion ? movimientoExistente.tipo : 'gasto';
  let categoriaSeleccionada = esEdicion ? movimientoExistente.categoria_id : null;

  const labelTexto = { gasto: '¿En qué se fue?', ingreso: '¿De dónde vino?' };

  function renderCategorias() {
    overlay.querySelector('#mov-categoria-label').textContent = labelTexto[tipoActual];
    const lista = tipoActual === 'gasto' ? catGasto : catIngreso;
    const cont = overlay.querySelector('#mov-categorias');
    cont.innerHTML = lista.map((c) => `
      <button type="button" class="chip" data-cat="${c.id}"><i class="ti ${c.icono}" aria-hidden="true"></i>${c.nombre}</button>
    `).join('');
    const yaSeleccionadaEnLista = lista.some((c) => c.id === categoriaSeleccionada);
    if (!yaSeleccionadaEnLista) categoriaSeleccionada = lista.length ? lista[0].id : null;
    cont.querySelectorAll('.chip').forEach((chip) => {
      if (Number(chip.dataset.cat) === categoriaSeleccionada) chip.classList.add('active');
      chip.addEventListener('click', () => {
        cont.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
        chip.classList.add('active');
        categoriaSeleccionada = Number(chip.dataset.cat);
      });
    });
  }

  overlay.querySelectorAll('.tipo-btn').forEach((btn) => {
    if (btn.dataset.tipo === tipoActual) btn.classList.add('active');
    btn.addEventListener('click', () => {
      overlay.querySelectorAll('.tipo-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      tipoActual = btn.dataset.tipo;
      renderCategorias();
    });
  });
  renderCategorias();

  overlay.querySelector('#modal-close').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  overlay.querySelector('#mov-guardar').addEventListener('click', () => {
    const montoInput = overlay.querySelector('#mov-monto');
    const montoError = overlay.querySelector('#mov-monto-error');
    const cuentaSelect = overlay.querySelector('#mov-cuenta');
    const monto = Number(montoInput.value);
    const fecha = overlay.querySelector('#mov-fecha').value;
    const nota = overlay.querySelector('#mov-nota').value;

    const sinMonto = !monto || monto <= 0;
    montoError.style.display = sinMonto ? 'block' : 'none';
    montoInput.style.borderColor = sinMonto ? 'var(--danger-text)' : '';
    if (sinMonto) { montoInput.focus(); return; }

    if (!cuentaSelect) return;
    const cuentaId = Number(cuentaSelect.value);
    if (!categoriaSeleccionada || !cuentaId) return;

    if (esEdicion) {
      domain.actualizarMovimiento(movimientoExistente.id, { fecha, cuentaId, categoriaId: categoriaSeleccionada, monto, tipo: tipoActual, nota });
    } else {
      domain.agregarMovimiento({ fecha, cuentaId, categoriaId: categoriaSeleccionada, monto, tipo: tipoActual, nota });
    }
    overlay.remove();
    render();
  });

  const btnEliminar = overlay.querySelector('#mov-eliminar');
  if (btnEliminar) {
    btnEliminar.addEventListener('click', () => {
      domain.eliminarMovimiento(movimientoExistente.id);
      overlay.remove();
      render();
    });
  }
}

// ---------- Modal: marcar pago fijo como pagado ----------

function openModalDetallePagoFijo(pagoInicial) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  document.body.appendChild(overlay);

  function renderContenido() {
    const pago = domain.estadoPagosFijosMes().find((p) => p.id === pagoInicial.id);
    if (!pago) { overlay.remove(); return; }
    const cuentas = queryAll('SELECT * FROM cuentas WHERE activa = 1');

    overlay.innerHTML = `
      <div class="modal-sheet">
        <div class="row-between" style="margin-bottom:14px;">
          <h2 style="margin:0;">${pago.nombre}</h2>
          <button class="icon-btn" id="modal-close" aria-label="Cerrar"><i class="ti ti-x" aria-hidden="true"></i></button>
        </div>

        <div class="row-between" style="font-size:13px;margin-bottom:4px;">
          <span class="muted">Esperado</span><span style="font-weight:500;">${fmt(pago.monto_esperado)}</span>
        </div>
        <div class="row-between" style="font-size:13px;margin-bottom:10px;">
          <span class="muted">Pagado hasta ahora</span><span style="font-weight:500;" class="${pago.estado === 'completo' ? 'pos' : ''}">${fmt(pago.totalPagado)}</span>
        </div>
        ${pago.restante > 0 ? `<div class="row-between" style="font-size:13px;margin-bottom:14px;">
          <span class="muted">Falta</span><span style="font-weight:500;">${fmt(pago.restante)}</span>
        </div>` : ''}
        ${pago.deuda_nombre ? `<p class="muted" style="margin:0 0 14px;">Cada pago de este item abona a "${pago.deuda_nombre}".</p>` : ''}

        ${pago.pagos.length > 0 ? `
          <p class="label" style="margin-bottom:6px;">Pagos registrados este mes</p>
          ${pago.pagos.map((m) => `
            <div class="list-item">
              <div class="icon-badge success" style="width:26px;height:26px;"><i class="ti ti-check" style="font-size:13px;" aria-hidden="true"></i></div>
              <div style="flex:1;"><p style="font-size:13px;margin:0;">${m.fecha}</p></div>
              <span style="font-size:13px;font-weight:500;margin-right:6px;">${fmt(m.monto)}</span>
              <button class="icon-btn" data-eliminar-pago="${m.id}" aria-label="Eliminar pago"><i class="ti ti-trash" style="font-size:15px;" aria-hidden="true"></i></button>
            </div>
          `).join('')}
          <div style="height:10px;"></div>
        ` : ''}

        <p class="label" style="margin-bottom:6px;">${pago.pagos.length > 0 ? 'Agregar otro pago' : 'Registrar pago'}</p>
        <div class="field">
          <input type="number" id="dp-monto" placeholder="0" min="0" step="1" value="${pago.restante > 0 ? pago.restante : ''}" />
          <p class="muted" id="dp-monto-error" style="display:none;color:var(--danger-text);margin:4px 0 0;">Escribe cuánto pagaste.</p>
        </div>
        <div class="field">
          ${cuentas.length === 0
            ? '<p class="muted" style="color:var(--danger-text);">Primero agrega una cuenta en la pestaña Cuentas.</p>'
            : `<select id="dp-cuenta">${cuentas.map((c) => `<option value="${c.id}">${c.nombre}</option>`).join('')}</select>`}
        </div>
        <div class="field">
          <input type="date" id="dp-fecha" value="${new Date().toISOString().slice(0, 10)}" />
        </div>
        <button class="primary" id="dp-guardar" style="width:100%;">Agregar pago</button>
      </div>
    `;

    overlay.querySelector('#modal-close').addEventListener('click', () => overlay.remove());
    overlay.querySelectorAll('[data-eliminar-pago]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (confirm('¿Eliminar este pago?')) {
          domain.desmarcarPagoFijo(Number(btn.dataset.eliminarPago));
          renderContenido();
          render();
        }
      });
    });
    overlay.querySelector('#dp-guardar').addEventListener('click', () => {
      const montoInput = overlay.querySelector('#dp-monto');
      const monto = Number(montoInput.value);
      const cuentaSelect = overlay.querySelector('#dp-cuenta');
      const sinMonto = !monto || monto <= 0;
      overlay.querySelector('#dp-monto-error').style.display = sinMonto ? 'block' : 'none';
      montoInput.style.borderColor = sinMonto ? 'var(--danger-text)' : '';
      if (sinMonto || !cuentaSelect) return;
      const cuentaId = Number(cuentaSelect.value);
      const fecha = overlay.querySelector('#dp-fecha').value;
      domain.marcarPagoFijoPagado(pago.id, { monto, cuentaId, fecha });
      renderContenido();
      render();
    });
  }

  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  renderContenido();
}

// ---------- Modal: marcar ingreso fijo como recibido ----------

function openModalMarcarIngreso(ingreso) {
  const cuentas = queryAll('SELECT * FROM cuentas WHERE activa = 1');
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-sheet">
      <div class="row-between" style="margin-bottom:14px;">
        <h2 style="margin:0;">Marcar "${ingreso.nombre}" como recibido</h2>
        <button class="icon-btn" id="modal-close" aria-label="Cerrar"><i class="ti ti-x" aria-hidden="true"></i></button>
      </div>
      <div class="field">
        <label>¿Cuánto recibiste?</label>
        <input type="number" id="if-monto-real" value="${ingreso.monto_esperado || ''}" placeholder="0" min="0" step="1" />
        <p class="muted" id="if-monto-real-error" style="display:none;color:var(--danger-text);margin:4px 0 0;">Escribe cuánto recibiste.</p>
      </div>
      <div class="field">
        <label>¿A qué cuenta llegó?</label>
        ${cuentas.length === 0
          ? '<p class="muted" style="color:var(--danger-text);">Primero agrega una cuenta en la pestaña Cuentas.</p>'
          : `<select id="if-cuenta">${cuentas.map((c) => `<option value="${c.id}">${c.nombre}</option>`).join('')}</select>`}
      </div>
      <div class="field">
        <label>Fecha</label>
        <input type="date" id="if-fecha" value="${new Date().toISOString().slice(0, 10)}" />
      </div>
      <button class="primary" id="if-guardar" style="width:100%;">Marcar como recibido</button>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector('#modal-close').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('#if-guardar').addEventListener('click', () => {
    const montoInput = overlay.querySelector('#if-monto-real');
    const monto = Number(montoInput.value);
    const cuentaSelect = overlay.querySelector('#if-cuenta');
    const sinMonto = !monto || monto <= 0;
    overlay.querySelector('#if-monto-real-error').style.display = sinMonto ? 'block' : 'none';
    montoInput.style.borderColor = sinMonto ? 'var(--danger-text)' : '';
    if (sinMonto || !cuentaSelect) return;
    const cuentaId = Number(cuentaSelect.value);
    const fecha = overlay.querySelector('#if-fecha').value;
    domain.marcarIngresoFijoRecibido(ingreso.id, { monto, cuentaId, fecha });
    overlay.remove();
    render();
  });
}

// ---------- Modal: definir / editar un ingreso fijo ----------

function openModalIngresoFijo(ingresoExistente) {
  const esEdicion = !!ingresoExistente;
  const catIngreso = domain.categorias('ingreso');
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-sheet">
      <div class="row-between" style="margin-bottom:14px;">
        <h2 style="margin:0;">${esEdicion ? 'Editar ingreso fijo' : 'Nuevo ingreso fijo'}</h2>
        <button class="icon-btn" id="modal-close" aria-label="Cerrar"><i class="ti ti-x" aria-hidden="true"></i></button>
      </div>
      <div class="field">
        <label>Nombre</label>
        <input type="text" id="if-nombre" placeholder="Ej: Salario, Arriendo Piso 1" value="${esEdicion ? ingresoExistente.nombre : ''}" />
      </div>
      <div class="field">
        <label>Monto esperado (aprox.)</label>
        <input type="number" id="if-monto-esperado" placeholder="0" value="${esEdicion ? ingresoExistente.monto_esperado : ''}" />
      </div>
      <div class="field">
        <label>Categoría</label>
        <select id="if-categoria">
          ${catIngreso.map((c) => `<option value="${c.id}" ${esEdicion && ingresoExistente.categoria_id === c.id ? 'selected' : ''}>${c.nombre}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label>Día aproximado del mes (opcional)</label>
        <input type="number" id="if-dia" min="1" max="31" placeholder="Ej: 30" value="${esEdicion && ingresoExistente.dia_esperado ? ingresoExistente.dia_esperado : ''}" />
      </div>
      <button class="primary" id="if-def-guardar" style="width:100%;margin-bottom:8px;">Guardar</button>
      ${esEdicion ? '<button id="if-def-eliminar" style="width:100%;color:var(--danger-text);">Eliminar ingreso fijo</button>' : ''}
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector('#modal-close').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('#if-def-guardar').addEventListener('click', () => {
    const nombre = overlay.querySelector('#if-nombre').value.trim();
    if (!nombre) { overlay.querySelector('#if-nombre').focus(); return; }
    const montoEsperado = Number(overlay.querySelector('#if-monto-esperado').value) || 0;
    const categoriaId = Number(overlay.querySelector('#if-categoria').value);
    const diaEsperado = Number(overlay.querySelector('#if-dia').value) || null;
    if (esEdicion) {
      domain.actualizarIngresoFijo(ingresoExistente.id, { nombre, montoEsperado, categoriaId, diaEsperado });
    } else {
      domain.agregarIngresoFijo({ nombre, montoEsperado, categoriaId, diaEsperado });
    }
    overlay.remove();
    render();
  });
  const btnEliminar = overlay.querySelector('#if-def-eliminar');
  if (btnEliminar) {
    btnEliminar.addEventListener('click', () => {
      domain.eliminarIngresoFijo(ingresoExistente.id);
      overlay.remove();
      render();
    });
  }
}

function openModalPagoFijo(pagoExistente) {
  const esEdicion = !!pagoExistente;
  const catGasto = domain.categorias('gasto');
  const deudas = domain.listaDeudas();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-sheet">
      <div class="row-between" style="margin-bottom:14px;">
        <h2 style="margin:0;">${esEdicion ? 'Editar pago fijo' : 'Nuevo pago fijo'}</h2>
        <button class="icon-btn" id="modal-close" aria-label="Cerrar"><i class="ti ti-x" aria-hidden="true"></i></button>
      </div>
      <div class="field">
        <label>Nombre</label>
        <input type="text" id="pf-nombre" placeholder="Ej: Seguridad social" value="${esEdicion ? pagoExistente.nombre : ''}" />
      </div>
      <div class="field">
        <label>Monto esperado (aprox.)</label>
        <input type="number" id="pf-monto-esperado" placeholder="0" value="${esEdicion ? pagoExistente.monto_esperado : ''}" />
      </div>
      <div class="field">
        <label>Categoría</label>
        <select id="pf-categoria">
          ${catGasto.map((c) => `<option value="${c.id}" ${esEdicion && pagoExistente.categoria_id === c.id ? 'selected' : ''}>${c.nombre}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label>Día aproximado del mes (opcional)</label>
        <input type="number" id="pf-dia" min="1" max="31" placeholder="Ej: 5" value="${esEdicion && pagoExistente.dia_esperado ? pagoExistente.dia_esperado : ''}" />
      </div>
      <div class="field">
        <label>¿Es el pago de una deuda?</label>
        <select id="pf-deuda">
          <option value="">No, es un gasto normal</option>
          ${deudas.map((d) => `<option value="${d.id}" ${esEdicion && pagoExistente.deuda_id === d.id ? 'selected' : ''}>${d.nombre} (debes ${fmt(d.valor)})</option>`).join('')}
        </select>
        <p class="muted" style="margin:4px 0 0;">Si la vinculas, cada vez que marques este pago como hecho, se descuenta automáticamente de esa deuda.</p>
      </div>
      <button class="primary" id="pf-def-guardar" style="width:100%;margin-bottom:8px;">Guardar</button>
      ${esEdicion ? '<button id="pf-def-eliminar" style="width:100%;color:var(--danger-text);">Eliminar pago fijo</button>' : ''}
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector('#modal-close').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('#pf-def-guardar').addEventListener('click', () => {
    const nombre = overlay.querySelector('#pf-nombre').value.trim();
    if (!nombre) { overlay.querySelector('#pf-nombre').focus(); return; }
    const montoEsperado = Number(overlay.querySelector('#pf-monto-esperado').value) || 0;
    const categoriaId = Number(overlay.querySelector('#pf-categoria').value);
    const diaEsperado = Number(overlay.querySelector('#pf-dia').value) || null;
    const deudaValue = overlay.querySelector('#pf-deuda').value;
    const deudaId = deudaValue ? Number(deudaValue) : null;
    if (esEdicion) {
      domain.actualizarPagoFijo(pagoExistente.id, { nombre, montoEsperado, categoriaId, diaEsperado, deudaId });
    } else {
      domain.agregarPagoFijo({ nombre, montoEsperado, categoriaId, diaEsperado, deudaId });
    }
    overlay.remove();
    render();
  });
  const btnEliminar = overlay.querySelector('#pf-def-eliminar');
  if (btnEliminar) {
    btnEliminar.addEventListener('click', () => {
      domain.eliminarPagoFijo(pagoExistente.id);
      overlay.remove();
      render();
    });
  }
}

function screenCuentas() {
  const cuentas = domain.listaCuentasConSaldo();
  return `
    <h1>Cuentas</h1>
    <div class="card">
      ${cuentas.length === 0 ? emptyState('ti-wallet', 'No tienes cuentas todavía') :
        cuentas.map((c) => `
        <div class="list-item" data-cuenta-id="${c.id}" style="cursor:pointer;">
          <div class="icon-badge neutral"><i class="ti ti-wallet" aria-hidden="true"></i></div>
          <div style="flex:1;">
            <p style="font-size:13px;margin:0;">${c.nombre}</p>
            <p class="muted" style="margin:0;">${c.tipo}</p>
          </div>
          <span style="font-size:13px;font-weight:500;">${fmt(c.saldo)}</span>
        </div>
      `).join('')}
    </div>
    <button id="btn-add-cuenta" style="width:100%;"><i class="ti ti-plus" aria-hidden="true"></i> Agregar cuenta</button>
  `;
}

function attachCuentasEvents() {
  const btn = document.getElementById('btn-add-cuenta');
  if (btn) btn.addEventListener('click', () => openModalCuenta());
  document.querySelectorAll('[data-cuenta-id]').forEach((row) => {
    row.addEventListener('click', () => {
      const cuenta = domain.listaCuentasConSaldo().find((c) => c.id === Number(row.dataset.cuentaId));
      if (cuenta) openModalCuenta(cuenta);
    });
  });
}

function openModalCuenta(cuentaExistente) {
  const esEdicion = !!cuentaExistente;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-sheet">
      <div class="row-between" style="margin-bottom:14px;">
        <h2 style="margin:0;">${esEdicion ? 'Editar cuenta' : 'Nueva cuenta'}</h2>
        <button class="icon-btn" id="modal-close" aria-label="Cerrar"><i class="ti ti-x" aria-hidden="true"></i></button>
      </div>
      <div class="field"><label>Nombre</label><input type="text" id="cta-nombre" placeholder="Ej: Nequi" value="${esEdicion ? cuentaExistente.nombre : ''}" /></div>
      <div class="field">
        <label>Tipo</label>
        <select id="cta-tipo">
          <option value="efectivo" ${esEdicion && cuentaExistente.tipo === 'efectivo' ? 'selected' : ''}>Efectivo</option>
          <option value="ahorros" ${esEdicion && cuentaExistente.tipo === 'ahorros' ? 'selected' : ''}>Ahorros</option>
          <option value="corriente" ${esEdicion && cuentaExistente.tipo === 'corriente' ? 'selected' : ''}>Corriente</option>
          <option value="tarjeta_credito" ${esEdicion && cuentaExistente.tipo === 'tarjeta_credito' ? 'selected' : ''}>Tarjeta de crédito</option>
          <option value="billetera_digital" ${esEdicion && cuentaExistente.tipo === 'billetera_digital' ? 'selected' : ''}>Billetera digital</option>
        </select>
      </div>
      <div class="field">
        <label>Saldo actual</label>
        <input type="number" id="cta-saldo" placeholder="0" value="${esEdicion ? cuentaExistente.saldo : ''}" />
        ${esEdicion ? '<p class="muted" style="margin:4px 0 0;">Ajusta este número si el saldo no coincide con la realidad.</p>' : ''}
      </div>
      <button class="primary" id="cta-guardar" style="width:100%;margin-bottom:8px;">Guardar</button>
      ${esEdicion ? '<button id="cta-eliminar" style="width:100%;color:var(--danger-text);">Eliminar cuenta</button>' : ''}
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector('#modal-close').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('#cta-guardar').addEventListener('click', () => {
    const nombre = overlay.querySelector('#cta-nombre').value.trim();
    const tipo = overlay.querySelector('#cta-tipo').value;
    const saldoIngresado = Number(overlay.querySelector('#cta-saldo').value) || 0;
    if (!nombre) { overlay.querySelector('#cta-nombre').focus(); return; }
    if (esEdicion) {
      // El campo muestra el saldo actual (ya incluye movimientos); recalculamos
      // el saldo inicial para que el saldo actual quede exactamente en lo que escribiste.
      const movimientosNetos = cuentaExistente.saldo - cuentaExistente.saldo_inicial;
      const nuevoSaldoInicial = saldoIngresado - movimientosNetos;
      domain.actualizarCuenta(cuentaExistente.id, { nombre, tipo, saldoInicial: nuevoSaldoInicial });
    } else {
      run('INSERT INTO cuentas (nombre, tipo, saldo_inicial) VALUES (?, ?, ?)', [nombre, tipo, saldoIngresado]);
    }
    overlay.remove();
    render();
  });
  const btnEliminar = overlay.querySelector('#cta-eliminar');
  if (btnEliminar) {
    btnEliminar.addEventListener('click', () => {
      domain.eliminarCuenta(cuentaExistente.id);
      overlay.remove();
      render();
    });
  }
}

// ---------- Pantalla: Inversiones ----------

function tipoInversionInfo(tipoId) {
  return TIPOS_INVERSION.find((t) => t.id === tipoId) || TIPOS_INVERSION[TIPOS_INVERSION.length - 1];
}

function screenInversiones() {
  const inversiones = domain.listaInversiones();
  const total = domain.totalInvertido();
  const rentabilidad = domain.rentabilidadTotalPortafolio();
  const distribucion = domain.distribucionInversionesPorTipo();

  const donutGradient = buildDonutGradient(distribucion);

  return `
    <div class="row-between">
      <h1 style="margin-bottom:0;">Inversiones</h1>
      <button class="icon-btn" id="btn-add-inversion" aria-label="Agregar inversión"><i class="ti ti-plus" aria-hidden="true"></i></button>
    </div>

    <div class="card">
      <p class="label">Total invertido</p>
      <p class="hero-number" style="font-size:24px;">${fmt(total)}</p>
      ${total > 0 ? `<p class="muted ${rentabilidad >= 0 ? 'pos' : 'neg'}">
        <i class="ti ${rentabilidad >= 0 ? 'ti-arrow-up' : 'ti-arrow-down'}" aria-hidden="true"></i>
        ${rentabilidad.toFixed(1)}% desde que invertiste
      </p>` : ''}
    </div>

    ${inversiones.length === 0 ? '' : `
    <div class="card row" style="gap:20px;">
      <div style="width:88px;height:88px;border-radius:50%;flex-shrink:0;background:${donutGradient};
        display:flex;align-items:center;justify-content:center;">
        <div style="width:52px;height:52px;border-radius:50%;background:var(--surface-1);"></div>
      </div>
      <div style="flex:1;display:flex;flex-direction:column;gap:6px;">
        ${distribucion.map((d) => `
          <div class="row" style="gap:6px;">
            <span style="width:9px;height:9px;border-radius:2px;background:${tipoInversionInfo(d.tipo).color};flex-shrink:0;"></span>
            <span class="muted" style="font-size:12px;flex:1;">${tipoInversionInfo(d.tipo).nombre}</span>
            <span style="font-size:12px;font-weight:500;">${Math.round(d.porcentaje)}%</span>
          </div>
        `).join('')}
      </div>
    </div>`}

    ${metaCard()}

    <h2>Tus inversiones</h2>
    <div class="card">
      ${inversiones.length === 0 ? emptyState('ti-chart-pie', 'Aún no has agregado ninguna inversión') :
        inversiones.map((inv) => inversionRow(inv)).join('')}
    </div>
  `;
}

function formatTiempo(meses) {
  if (meses === null) return 'más de 100 años a este ritmo';
  if (meses === 0) return '¡ya la alcanzaste!';
  const anios = Math.floor(meses / 12);
  const resto = meses % 12;
  const partes = [];
  if (anios > 0) partes.push(`${anios} año${anios !== 1 ? 's' : ''}`);
  if (resto > 0) partes.push(`${resto} mes${resto !== 1 ? 'es' : ''}`);
  return partes.join(' y ');
}

function metaCard() {
  const p = domain.proyeccionHaciaMeta();

  if (p.meta === 0) {
    return `
      <h2>Tu camino a la meta</h2>
      <div class="card">
        <p class="muted" style="margin-bottom:12px;">Define cuánto patrimonio quieres alcanzar y te decimos, a tu ritmo actual de inversión, cuánto tiempo te tomaría llegar.</p>
        <button class="primary" id="btn-set-meta" style="width:100%;">Definir mi meta de patrimonio</button>
      </div>
    `;
  }

  return `
    <div class="row-between">
      <h2 style="margin-bottom:0;">Tu camino a la meta</h2>
      <button class="icon-btn" id="btn-set-meta" aria-label="Editar meta"><i class="ti ti-pencil" aria-hidden="true"></i></button>
    </div>
    <div class="card">
      <div class="row-between" style="margin-bottom:4px;">
        <span class="label" style="margin:0;">Meta</span>
        <span style="font-weight:500;font-size:13px;">${fmt(p.meta)}</span>
      </div>
      <div class="row-between" style="margin-bottom:10px;">
        <span class="label" style="margin:0;">Hoy tienes</span>
        <span style="font-weight:500;font-size:13px;">${fmt(p.actual)} (${p.progresoPct.toFixed(1)}%)</span>
      </div>
      <div style="height:8px;border-radius:4px;background:var(--surface-2);overflow:hidden;margin-bottom:14px;">
        <div style="height:100%;width:${p.progresoPct}%;background:#1baf7a;"></div>
      </div>

      <p class="label" style="margin-bottom:2px;">A tu ritmo actual, la alcanzas en</p>
      <p class="hero-number" style="font-size:22px;" id="meta-tiempo">${formatTiempo(p.meses)}</p>
      <p class="muted" style="margin:2px 0 14px;">aportando <span id="meta-aporte-texto">${fmt(p.aporte)}</span> al mes, a un ${p.tasaAnual}% anual esperado</p>

      <div class="field" style="margin-bottom:6px;">
        <label>Prueba aportando más al mes</label>
        <input type="range" id="meta-slider" min="0" max="${Math.max(p.aporte * 3, 500000)}" step="10000" value="${p.aporte}" style="width:100%;" />
      </div>
    </div>
  `;
}

function inversionRow(inv) {
  const rent = domain.rentabilidadInversion(inv);
  const info = tipoInversionInfo(inv.tipo);
  return `
    <div class="list-item" data-inv-id="${inv.id}" style="cursor:pointer;">
      <div class="icon-badge neutral" style="background:${info.color}22;color:${info.color};"><i class="ti ti-chart-pie" aria-hidden="true"></i></div>
      <div style="flex:1;">
        <p style="font-size:13px;margin:0;">${inv.nombre}</p>
        <p class="muted" style="margin:0;">${info.nombre}</p>
      </div>
      <div style="text-align:right;">
        <p style="font-size:13px;font-weight:500;margin:0;">${fmt(inv.valor_actual)}</p>
        <p class="muted ${rent >= 0 ? 'pos' : 'neg'}" style="margin:0;">${rent >= 0 ? '+' : ''}${rent.toFixed(1)}%</p>
      </div>
    </div>
  `;
}

function buildDonutGradient(distribucion) {
  if (distribucion.length === 0) return 'var(--surface-2)';
  let acc = 0;
  const stops = distribucion.map((d) => {
    const start = acc;
    acc += d.porcentaje;
    return `${tipoInversionInfo(d.tipo).color} ${start}% ${acc}%`;
  });
  return `conic-gradient(${stops.join(', ')})`;
}

function attachInversionesEvents() {
  const btn = document.getElementById('btn-add-inversion');
  if (btn) btn.addEventListener('click', () => openModalInversion());
  document.querySelectorAll('[data-inv-id]').forEach((row) => {
    row.addEventListener('click', () => {
      const inv = domain.listaInversiones().find((i) => i.id === Number(row.dataset.invId));
      if (inv) openModalInversion(inv);
    });
  });

  const btnMeta = document.getElementById('btn-set-meta');
  if (btnMeta) btnMeta.addEventListener('click', () => openModalMeta());

  const slider = document.getElementById('meta-slider');
  if (slider) {
    slider.addEventListener('input', () => {
      const p = domain.proyeccionHaciaMeta();
      const aporte = Number(slider.value);
      const meses = domain.mesesParaAlcanzarMeta(p.meta, aporte, p.tasaAnual);
      document.getElementById('meta-tiempo').textContent = formatTiempo(meses);
      document.getElementById('meta-aporte-texto').textContent = fmt(aporte);
    });
  }
}

function openModalMeta() {
  const p = domain.proyeccionHaciaMeta();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-sheet">
      <div class="row-between" style="margin-bottom:14px;">
        <h2 style="margin:0;">Tu meta de patrimonio</h2>
        <button class="icon-btn" id="modal-close" aria-label="Cerrar"><i class="ti ti-x" aria-hidden="true"></i></button>
      </div>
      <div class="field">
        <label>¿Cuánto patrimonio quieres alcanzar?</label>
        <input type="number" id="meta-monto" placeholder="Ej: 1000000000" value="${p.meta || ''}" />
      </div>
      <div class="field">
        <label>Rentabilidad anual esperada de tus inversiones (%)</label>
        <input type="number" id="meta-tasa" placeholder="8" value="${p.tasaAnual}" />
        <p class="muted" style="margin:4px 0 0;">Un valor conservador y razonable suele estar entre 6% y 10% anual.</p>
      </div>
      <button class="primary" id="meta-guardar" style="width:100%;">Guardar meta</button>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector('#modal-close').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('#meta-guardar').addEventListener('click', () => {
    const monto = Number(overlay.querySelector('#meta-monto').value) || 0;
    const tasa = Number(overlay.querySelector('#meta-tasa').value) || 8;
    domain.setMetaPatrimonio(monto);
    domain.setTasaAnualEsperada(tasa);
    overlay.remove();
    render();
  });
}

function openModalInversion(invExistente) {
  const esEdicion = !!invExistente;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-sheet">
      <div class="row-between" style="margin-bottom:14px;">
        <h2 style="margin:0;">${esEdicion ? 'Editar inversión' : 'Nueva inversión'}</h2>
        <button class="icon-btn" id="modal-close" aria-label="Cerrar"><i class="ti ti-x" aria-hidden="true"></i></button>
      </div>
      <div class="field">
        <label>Nombre</label>
        <input type="text" id="inv-nombre" placeholder="Ej: Bitcoin, CDT Bancolombia" value="${esEdicion ? invExistente.nombre : ''}" />
      </div>
      <div class="field">
        <label>Tipo</label>
        <select id="inv-tipo">
          ${TIPOS_INVERSION.map((t) => `<option value="${t.id}" ${esEdicion && invExistente.tipo === t.id ? 'selected' : ''}>${t.nombre}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label>Cuánto has invertido en total (costo)</label>
        <input type="number" id="inv-costo" placeholder="0" value="${esEdicion ? invExistente.valor_invertido : ''}" />
      </div>
      <div class="field">
        <label>Cuánto vale hoy</label>
        <input type="number" id="inv-actual" placeholder="0" value="${esEdicion ? invExistente.valor_actual : ''}" />
      </div>
      <button class="primary" id="inv-guardar" style="width:100%;margin-bottom:8px;">Guardar</button>
      ${esEdicion ? '<button id="inv-eliminar" style="width:100%;color:var(--danger-text);">Eliminar inversión</button>' : ''}
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector('#modal-close').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  overlay.querySelector('#inv-guardar').addEventListener('click', () => {
    const nombre = overlay.querySelector('#inv-nombre').value.trim();
    if (!nombre) { overlay.querySelector('#inv-nombre').focus(); return; }
    const tipo = overlay.querySelector('#inv-tipo').value;
    const valorInvertido = Number(overlay.querySelector('#inv-costo').value) || 0;
    const valorActual = Number(overlay.querySelector('#inv-actual').value) || 0;
    if (esEdicion) {
      domain.actualizarInversion(invExistente.id, { nombre, tipo, valorInvertido, valorActual });
    } else {
      domain.agregarInversion({ nombre, tipo, valorInvertido, valorActual });
    }
    overlay.remove();
    render();
  });

  const btnEliminar = overlay.querySelector('#inv-eliminar');
  if (btnEliminar) {
    btnEliminar.addEventListener('click', () => {
      domain.eliminarInversion(invExistente.id);
      overlay.remove();
      render();
    });
  }
}

// ---------- Pantalla: Patrimonio ----------

function screenPatrimonio() {
  const efectivo = domain.totalEnCuentas();
  const invertido = domain.totalInvertido();
  const bienes = domain.listaBienes();
  const totalBienes = domain.totalOtrosBienes();
  const deudas = domain.listaDeudas();
  const totalDeudas = domain.totalLoQueDebo();
  const patrimonio = domain.dineroReal();
  const variacion = domain.variacionUltimoMes();

  return `
    <div class="row" style="gap:8px;margin-bottom:4px;">
      <button class="icon-btn" id="btn-volver-inicio" aria-label="Volver"><i class="ti ti-arrow-left" aria-hidden="true"></i></button>
      <h1 style="margin:0;">Patrimonio</h1>
    </div>

    <div class="card">
      <p class="label">Patrimonio total</p>
      <p class="hero-number">${fmt(patrimonio)}</p>
      ${variacion !== 0 ? `<p class="muted ${variacion >= 0 ? 'pos' : 'neg'}">
        <i class="ti ${variacion >= 0 ? 'ti-arrow-up' : 'ti-arrow-down'}" aria-hidden="true"></i>
        ${Math.abs(variacion).toFixed(1)}% vs. hace un mes
      </p>` : ''}
      <p class="muted" style="margin-top:6px;">Todo lo que tienes, menos todo lo que debes.</p>

      <div style="border-top:0.5px solid var(--border);margin-top:12px;padding-top:10px;">
        <div class="row-between" style="font-size:13px;margin-bottom:6px;">
          <span class="muted">Efectivo (tus cuentas)</span><span style="font-weight:500;">${fmt(efectivo)}</span>
        </div>
        <div class="row-between" style="font-size:13px;margin-bottom:6px;">
          <span class="muted">Inversiones</span><span style="font-weight:500;">${fmt(invertido)}</span>
        </div>
        <div class="row-between" style="font-size:13px;margin-bottom:6px;">
          <span class="muted">Otros bienes</span><span style="font-weight:500;">${fmt(totalBienes)}</span>
        </div>
        <div class="row-between" style="font-size:13px;">
          <span class="muted">Deudas</span><span style="font-weight:500;" class="neg">-${fmt(totalDeudas)}</span>
        </div>
      </div>
    </div>

    <div class="row-between">
      <h2 style="margin-bottom:0;">Otros bienes</h2>
      <button class="icon-btn" id="btn-add-bien" aria-label="Agregar bien"><i class="ti ti-plus" aria-hidden="true"></i></button>
    </div>
    <p class="muted" style="margin:-4px 0 8px;">Casa, carro, o cualquier cosa de valor que no sea efectivo ni inversión.</p>
    <div class="card">
      ${bienes.length === 0 ? emptyState('ti-home', 'No has agregado ningún bien todavía') :
        bienes.map((b) => `
          <div class="list-item" data-bien-id="${b.id}" style="cursor:pointer;">
            <div class="icon-badge neutral"><i class="ti ti-building-estate" aria-hidden="true"></i></div>
            <div style="flex:1;"><p style="font-size:13px;margin:0;">${b.nombre}</p></div>
            <span style="font-size:13px;font-weight:500;">${fmt(b.valor)}</span>
          </div>
        `).join('')}
    </div>

    <div class="row-between">
      <h2 style="margin-bottom:0;">Deudas</h2>
      <button class="icon-btn" id="btn-add-deuda" aria-label="Agregar deuda"><i class="ti ti-plus" aria-hidden="true"></i></button>
    </div>
    <div class="card">
      ${deudas.length === 0 ? emptyState('ti-credit-card', 'No tienes deudas registradas') :
        deudas.map((d) => `
          <div class="list-item" data-deuda-id="${d.id}" style="cursor:pointer;">
            <div class="icon-badge danger"><i class="ti ti-credit-card" aria-hidden="true"></i></div>
            <div style="flex:1;"><p style="font-size:13px;margin:0;">${d.nombre}</p></div>
            <span style="font-size:13px;font-weight:500;" class="neg">${fmt(d.valor)}</span>
          </div>
        `).join('')}
    </div>
  `;
}

function attachPatrimonioEvents() {
  const btnVolver = document.getElementById('btn-volver-inicio');
  if (btnVolver) btnVolver.addEventListener('click', () => navigate('inicio'));

  const btnAddBien = document.getElementById('btn-add-bien');
  if (btnAddBien) btnAddBien.addEventListener('click', () => openModalBien());
  document.querySelectorAll('[data-bien-id]').forEach((row) => {
    row.addEventListener('click', () => {
      const bien = domain.listaBienes().find((b) => b.id === Number(row.dataset.bienId));
      if (bien) openModalBien(bien);
    });
  });

  const btnAddDeuda = document.getElementById('btn-add-deuda');
  if (btnAddDeuda) btnAddDeuda.addEventListener('click', () => openModalDeuda());
  document.querySelectorAll('[data-deuda-id]').forEach((row) => {
    row.addEventListener('click', () => {
      const deuda = domain.listaDeudas().find((d) => d.id === Number(row.dataset.deudaId));
      if (deuda) openModalDeuda(deuda);
    });
  });
}

function openModalBien(bienExistente) {
  const esEdicion = !!bienExistente;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-sheet">
      <div class="row-between" style="margin-bottom:14px;">
        <h2 style="margin:0;">${esEdicion ? 'Editar bien' : 'Nuevo bien'}</h2>
        <button class="icon-btn" id="modal-close" aria-label="Cerrar"><i class="ti ti-x" aria-hidden="true"></i></button>
      </div>
      <div class="field">
        <label>Nombre</label>
        <input type="text" id="bien-nombre" placeholder="Ej: Casa, Carro" value="${esEdicion ? bienExistente.nombre : ''}" />
      </div>
      <div class="field">
        <label>Valor aproximado</label>
        <input type="number" id="bien-valor" placeholder="0" value="${esEdicion ? bienExistente.valor : ''}" />
      </div>
      <button class="primary" id="bien-guardar" style="width:100%;margin-bottom:8px;">Guardar</button>
      ${esEdicion ? '<button id="bien-eliminar" style="width:100%;color:var(--danger-text);">Eliminar</button>' : ''}
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector('#modal-close').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('#bien-guardar').addEventListener('click', () => {
    const nombre = overlay.querySelector('#bien-nombre').value.trim();
    if (!nombre) { overlay.querySelector('#bien-nombre').focus(); return; }
    const valor = Number(overlay.querySelector('#bien-valor').value) || 0;
    if (esEdicion) domain.actualizarBien(bienExistente.id, { nombre, valor });
    else domain.agregarBien({ nombre, valor });
    overlay.remove();
    render();
  });
  const btnEliminar = overlay.querySelector('#bien-eliminar');
  if (btnEliminar) btnEliminar.addEventListener('click', () => {
    domain.eliminarBien(bienExistente.id);
    overlay.remove();
    render();
  });
}

function openModalDeuda(deudaExistente) {
  const esEdicion = !!deudaExistente;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-sheet">
      <div class="row-between" style="margin-bottom:14px;">
        <h2 style="margin:0;">${esEdicion ? 'Editar deuda' : 'Nueva deuda'}</h2>
        <button class="icon-btn" id="modal-close" aria-label="Cerrar"><i class="ti ti-x" aria-hidden="true"></i></button>
      </div>
      <div class="field">
        <label>Nombre</label>
        <input type="text" id="deuda-nombre" placeholder="Ej: Tarjeta Bancolombia, Crédito BBVA" value="${esEdicion ? deudaExistente.nombre : ''}" />
      </div>
      <div class="field">
        <label>Cuánto debes hoy</label>
        <input type="number" id="deuda-valor" placeholder="0" value="${esEdicion ? deudaExistente.valor : ''}" />
      </div>
      <button class="primary" id="deuda-guardar" style="width:100%;margin-bottom:8px;">Guardar</button>
      ${esEdicion ? '<button id="deuda-eliminar" style="width:100%;color:var(--danger-text);">Eliminar</button>' : ''}
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector('#modal-close').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('#deuda-guardar').addEventListener('click', () => {
    const nombre = overlay.querySelector('#deuda-nombre').value.trim();
    if (!nombre) { overlay.querySelector('#deuda-nombre').focus(); return; }
    const valor = Number(overlay.querySelector('#deuda-valor').value) || 0;
    if (esEdicion) domain.actualizarDeuda(deudaExistente.id, { nombre, valor });
    else domain.agregarDeuda({ nombre, valor });
    overlay.remove();
    render();
  });
  const btnEliminar = overlay.querySelector('#deuda-eliminar');
  if (btnEliminar) btnEliminar.addEventListener('click', () => {
    domain.eliminarDeuda(deudaExistente.id);
    overlay.remove();
    render();
  });
}

// ---------- Pantalla: Análisis ----------

function screenAnalisis() {
  const resumen = domain.resumenPeriodo(currentPeriodo);
  return `
    <h1>Análisis</h1>
    <div class="toggle-group">
      <button data-periodo="semana" class="${currentPeriodo === 'semana' ? 'active' : ''}">Esta semana</button>
      <button data-periodo="mes" class="${currentPeriodo === 'mes' ? 'active' : ''}">Este mes</button>
      <button data-periodo="anio" class="${currentPeriodo === 'anio' ? 'active' : ''}">Este año</button>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px;">
      <div class="metric-card">
        <p class="label">Total gastado</p>
        <p style="font-size:20px;font-weight:500;margin:0;">${fmt(resumen.totalGastos)}</p>
      </div>
      <div class="metric-card">
        <p class="label">Total ingresado</p>
        <p style="font-size:20px;font-weight:500;margin:0;">${fmt(resumen.totalIngresos)}</p>
      </div>
    </div>

    <div class="card">
      <p class="label" style="margin-bottom:10px;">Ingreso cubierto por lo que no depende de tu trabajo</p>
      <div class="row" style="gap:16px;">
        <div style="position:relative;width:56px;height:56px;flex-shrink:0;">
          <svg viewBox="0 0 36 36" style="width:56px;height:56px;transform:rotate(-90deg);">
            <circle cx="18" cy="18" r="15.5" fill="none" stroke="var(--border)" stroke-width="4"></circle>
            <circle cx="18" cy="18" r="15.5" fill="none" stroke="#1baf7a" stroke-width="4"
              stroke-dasharray="${(resumen.porcentajePasivo * 0.97).toFixed(1)} 97" stroke-linecap="round"></circle>
          </svg>
          <span style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:500;">${pct(resumen.porcentajePasivo)}</span>
        </div>
        <p class="muted" style="margin:0;">De cada peso que entra, ${pct(resumen.porcentajePasivo)} no depende de que trabajes hoy.</p>
      </div>
    </div>

    <h2>En qué gastas más</h2>
    <div class="card" id="lista-gastos">
      ${renderRankingCategoria(resumen.gastosPorCategoria, 'neg')}
    </div>

    <h2>De dónde ganas más</h2>
    <div class="card" id="lista-ingresos">
      ${renderRankingCategoria(resumen.ingresosPorCategoria, 'pos')}
    </div>
  `;
}

function renderRankingCategoria(obj, claseColor) {
  const entradas = Object.entries(obj).sort((a, b) => b[1] - a[1]);
  if (entradas.length === 0) return emptyState('ti-chart-bar', 'Sin datos para este periodo');
  const max = entradas[0][1];
  return entradas.map(([nombre, monto]) => `
    <div style="margin-bottom:10px;">
      <div class="row-between" style="font-size:13px;margin-bottom:4px;">
        <span>${nombre}</span><span style="font-weight:500;">${fmt(monto)}</span>
      </div>
      <div style="height:6px;border-radius:3px;background:var(--surface-2);overflow:hidden;">
        <div style="height:100%;width:${(monto / max) * 100}%;background:${claseColor === 'neg' ? '#e34948' : '#1baf7a'};"></div>
      </div>
    </div>
  `).join('');
}

function attachAnalisisEvents() {
  app.querySelectorAll('[data-periodo]').forEach((btn) => {
    btn.addEventListener('click', () => {
      currentPeriodo = btn.dataset.periodo;
      render();
    });
  });
}

// ---------- Pantalla: Configuración ----------

function screenConfiguracion() {
  const plan = domain.planGastoConsciente();
  const pagosFijos = domain.listaPagosFijos();
  const ingresosFijos = domain.listaIngresosFijos();
  return `
    <h1>Ajustes</h1>

    <h2>Reparto de lo que te sobra</h2>
    <div class="card">
      <p class="muted" style="margin-bottom:12px;">Cuando tus ingresos fijos superan tus gastos fijos, así se reparte el sobrante entre invertir, ahorrar y disfrutar.</p>
      <div class="field"><label>% Costos fijos (referencial)</label><input type="number" id="cfg-fijos" value="${plan.baldes.fijos}" /></div>
      <div class="field"><label>% Inversión</label><input type="number" id="cfg-inversion" value="${plan.baldes.inversion}" /></div>
      <div class="field"><label>% Ahorro</label><input type="number" id="cfg-ahorro" value="${plan.baldes.ahorro}" /></div>
      <div class="field"><label>% Disfrute</label><input type="number" id="cfg-disfrute" value="${plan.baldes.disfrute}" /></div>
      <button class="primary" id="cfg-guardar" style="width:100%;">Guardar reparto</button>
    </div>

    <div class="row-between">
      <h2 style="margin-bottom:0;">Ingresos fijos mensuales</h2>
      <button class="icon-btn" id="btn-add-ingreso-fijo" aria-label="Agregar ingreso fijo"><i class="ti ti-plus" aria-hidden="true"></i></button>
    </div>
    <div class="card">
      ${ingresosFijos.length === 0 ? emptyState('ti-cash', 'No has definido ingresos fijos todavía') :
        ingresosFijos.map((i) => `
          <div class="list-item">
            <div class="icon-badge success"><i class="ti ti-cash" aria-hidden="true"></i></div>
            <div style="flex:1;">
              <p style="font-size:13px;margin:0;">${i.nombre}</p>
              <p class="muted" style="margin:0;">${fmt(i.monto_esperado)}${i.dia_esperado ? ' · día ' + i.dia_esperado : ''}</p>
            </div>
            <button class="icon-btn" data-edit-ingreso-fijo="${i.id}" aria-label="Editar"><i class="ti ti-pencil" aria-hidden="true"></i></button>
          </div>
        `).join('')}
    </div>

    <div class="row-between">
      <h2 style="margin-bottom:0;">Pagos fijos mensuales</h2>
      <button class="icon-btn" id="btn-add-pago-fijo-ajustes" aria-label="Agregar pago fijo"><i class="ti ti-plus" aria-hidden="true"></i></button>
    </div>
    <div class="card">
      ${pagosFijos.length === 0 ? emptyState('ti-calendar-due', 'No has definido pagos fijos todavía') :
        renderPagosFijosAjustesAgrupados(pagosFijos)}
    </div>

    <h2>Respaldo de tus datos</h2>
    <div class="card">
      <p class="muted" style="margin-bottom:12px;">Guarda una copia de toda tu información, o restaura una copia anterior.</p>
      <div style="display:flex;flex-direction:column;gap:8px;">
        <button id="btn-export-sqlite"><i class="ti ti-download" aria-hidden="true"></i> Descargar copia (.sqlite)</button>
        <button id="btn-export-json"><i class="ti ti-file-download" aria-hidden="true"></i> Descargar copia (.json)</button>
        <button id="btn-import"><i class="ti ti-upload" aria-hidden="true"></i> Restaurar copia (.sqlite)</button>
      </div>
    </div>
  `;
}

function attachConfiguracionEvents() {
  const guardar = document.getElementById('cfg-guardar');
  if (guardar) guardar.addEventListener('click', () => {
    setConfig('balde_fijos', document.getElementById('cfg-fijos').value);
    setConfig('balde_inversion', document.getElementById('cfg-inversion').value);
    setConfig('balde_ahorro', document.getElementById('cfg-ahorro').value);
    setConfig('balde_disfrute', document.getElementById('cfg-disfrute').value);
    render();
  });

  const btnAddIngresoFijo = document.getElementById('btn-add-ingreso-fijo');
  if (btnAddIngresoFijo) btnAddIngresoFijo.addEventListener('click', () => openModalIngresoFijo());
  document.querySelectorAll('[data-edit-ingreso-fijo]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const ingreso = domain.listaIngresosFijos().find((i) => i.id === Number(btn.dataset.editIngresoFijo));
      if (ingreso) openModalIngresoFijo(ingreso);
    });
  });

  const btnAddPagoFijo = document.getElementById('btn-add-pago-fijo-ajustes');
  if (btnAddPagoFijo) btnAddPagoFijo.addEventListener('click', () => openModalPagoFijo());
  document.querySelectorAll('[data-edit-pago-fijo]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const pago = domain.listaPagosFijos().find((p) => p.id === Number(btn.dataset.editPagoFijo));
      if (pago) openModalPagoFijo(pago);
    });
  });

  const btnExportSqlite = document.getElementById('btn-export-sqlite');
  if (btnExportSqlite) btnExportSqlite.addEventListener('click', () => {
    downloadDatabaseFile(getRawBytes());
  });

  const btnExportJson = document.getElementById('btn-export-json');
  if (btnExportJson) btnExportJson.addEventListener('click', () => {
    const data = {
      cuentas: queryAll('SELECT * FROM cuentas'),
      categorias: queryAll('SELECT * FROM categorias'),
      movimientos: queryAll('SELECT * FROM movimientos'),
      lo_que_tengo: queryAll('SELECT * FROM lo_que_tengo'),
      lo_que_debo: queryAll('SELECT * FROM lo_que_debo'),
      metas: queryAll('SELECT * FROM metas'),
      inversiones: queryAll('SELECT * FROM inversiones'),
      patrimonio_historico: queryAll('SELECT * FROM patrimonio_historico'),
    };
    downloadJsonExport(data);
  });

  const btnImport = document.getElementById('btn-import');
  if (btnImport) btnImport.addEventListener('click', async () => {
    const file = await pickFile('.sqlite,.db');
    if (!file) return;
    const bytes = await readFileAsUint8Array(file);
    await replaceDatabase(bytes);
    render();
  });
}

// ---------- Bootstrap ----------

const originalRender = render;
function renderWithScreenEvents() {
  originalRender();
  if (currentScreen === 'cuentas') attachCuentasEvents();
  if (currentScreen === 'inversiones') attachInversionesEvents();
  if (currentScreen === 'patrimonio') attachPatrimonioEvents();
  if (currentScreen === 'configuracion') attachConfiguracionEvents();
}

async function boot() {
  app.innerHTML = '<div class="screen"><p class="muted" style="text-align:center;margin-top:40vh;">Cargando tus datos…</p></div>';
  await initDatabase();
  render = renderWithScreenEvents;
  render();
}

boot();
