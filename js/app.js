import {
  run, queryAll, getConfig, setConfig, getRawBytes, replaceDatabase,
  prepararArranque, abrirBaseDatos, establecerLlaveMaestra, olvidarLlaveMaestra,
  tieneLlaveMaestra, persistInmediato, descifrarBytes, desactivarCifradoYGuardarPlano,
} from './db.js';
import * as domain from './domain.js';
import { TIPOS_INVERSION } from './schema.js';
import * as security from './security.js';
import * as precios from './precios.js';
import {
  downloadDatabaseFile, downloadJsonExport, pickFile, readFileAsUint8Array,
  loadSecurityConfig, saveSecurityConfig, clearSecurityConfig,
} from './storage.js';

const app = document.getElementById('app');
let currentScreen = 'inicio';
let currentPeriodo = 'semana';
let seccionesAbiertas = new Set(); // categorías desplegadas en los acordeones

const fmt = (v) => '$' + Math.round(v || 0).toLocaleString('es-CO');
const pct = (v) => Math.round(v || 0) + '%';

// Formatea en la moneda del activo. Los precios en USD necesitan decimales
// (un BTC a 62.000,50) y las cantidades de cripto muchos más (0.00234 BTC).
function fmtMoneda(v, moneda, decimales) {
  const n = v || 0;
  const dec = decimales !== undefined ? decimales : (moneda === 'USD' ? 2 : 0);
  const texto = n.toLocaleString('es-CO', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  return moneda === 'USD' ? 'US$' + texto : '$' + texto;
}

// Cantidades de activos: cripto necesita precisión, acciones no tanto.
function fmtCantidad(v) {
  const n = v || 0;
  if (n === 0) return '0';
  if (n < 1) return n.toLocaleString('es-CO', { maximumFractionDigits: 8 });
  if (n < 1000) return n.toLocaleString('es-CO', { maximumFractionDigits: 4 });
  return n.toLocaleString('es-CO', { maximumFractionDigits: 2 });
}

// Formatea un input de dinero mientras el usuario escribe (1500000 -> 1.500.000),
// conservando la posición del cursor, y da una función para leer el número real.
function formatearMiles(texto) {
  const digitos = String(texto).replace(/\D/g, '');
  if (!digitos) return '';
  return Number(digitos).toLocaleString('es-CO');
}

function activarSeparadorMiles(input) {
  if (!input) return;
  input.addEventListener('input', () => {
    const digitosAntes = input.value.slice(0, input.selectionStart).replace(/\D/g, '').length;
    input.value = formatearMiles(input.value);
    let pos = 0, contados = 0;
    while (pos < input.value.length && contados < digitosAntes) {
      if (/\d/.test(input.value[pos])) contados++;
      pos++;
    }
    input.setSelectionRange(pos, pos);
  });
}

function valorMiles(input) {
  if (!input) return 0;
  return Number(String(input.value).replace(/\D/g, '')) || 0;
}

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
  app.style.paddingBottom = '';
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

// ---------- Sistema de modales ----------
// Un solo lugar que arregla el comportamiento de TODAS las ventanas
// superpuestas de la app, sin tener que reescribir cada una:
//   - barra para deslizar hacia abajo y cerrar (gesto esperado en móvil)
//   - pantalla completa automática si el formulario es largo
//   - el campo enfocado siempre visible cuando sube el teclado
//   - cerrar con la tecla Escape
//   - bloquear el scroll del fondo mientras el modal está abierto

const ALTURA_PARA_PANTALLA_COMPLETA = 0.72; // 72% de la pantalla

function mejorarModal(overlay) {
  const sheet = overlay.querySelector('.modal-sheet');
  if (!sheet || sheet.dataset.mejorado) return;
  sheet.dataset.mejorado = '1';

  // Si el modal no usa la estructura nueva, se marca como "plano"
  // para que el CSS le dé padding y scroll correctos.
  if (!sheet.querySelector('.modal-body')) sheet.classList.add('modal-plano');

  // Barra de arrastre arriba
  if (!sheet.querySelector('.modal-grabber')) {
    const grabber = document.createElement('div');
    grabber.className = 'modal-grabber';
    grabber.setAttribute('aria-hidden', 'true');
    sheet.insertBefore(grabber, sheet.firstChild);
  }

  // Formularios largos → pantalla completa (decidido por contenido real)
  requestAnimationFrame(() => {
    const alto = sheet.scrollHeight;
    const disponible = window.innerHeight;
    if (alto > disponible * ALTURA_PARA_PANTALLA_COMPLETA) {
      sheet.classList.add('modal-full');
    }
  });

  cerrarConGesto(overlay, sheet);
  cerrarConEscape(overlay);
  mantenerCampoVisible(sheet);
  bloquearFondo();
  observarCierre(overlay);
}

// Deslizar hacia abajo para cerrar
function cerrarConGesto(overlay, sheet) {
  const grabber = sheet.querySelector('.modal-grabber');
  if (!grabber) return;
  let inicioY = 0;
  let desplazamiento = 0;
  let arrastrando = false;

  const empezar = (y) => { inicioY = y; arrastrando = true; sheet.style.transition = 'none'; };
  const mover = (y) => {
    if (!arrastrando) return;
    desplazamiento = Math.max(0, y - inicioY);
    sheet.style.transform = `translateY(${desplazamiento}px)`;
  };
  const soltar = () => {
    if (!arrastrando) return;
    arrastrando = false;
    sheet.style.transition = 'transform 0.2s ease';
    // Si arrastró más de 100px, se cierra; si no, vuelve a su sitio.
    if (desplazamiento > 100) {
      sheet.style.transform = 'translateY(100%)';
      setTimeout(() => overlay.remove(), 180);
    } else {
      sheet.style.transform = '';
    }
    desplazamiento = 0;
  };

  grabber.addEventListener('touchstart', (e) => empezar(e.touches[0].clientY), { passive: true });
  grabber.addEventListener('touchmove', (e) => mover(e.touches[0].clientY), { passive: true });
  grabber.addEventListener('touchend', soltar);
  grabber.addEventListener('mousedown', (e) => {
    empezar(e.clientY);
    const onMove = (ev) => mover(ev.clientY);
    const onUp = () => {
      soltar();
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

function cerrarConEscape(overlay) {
  const onKey = (e) => {
    if (e.key === 'Escape') {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
    }
  };
  document.addEventListener('keydown', onKey);
}

// Cuando sube el teclado en iOS, lleva el campo enfocado a la vista.
function mantenerCampoVisible(sheet) {
  sheet.querySelectorAll('input, select, textarea').forEach((campo) => {
    campo.addEventListener('focus', () => {
      setTimeout(() => {
        campo.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }, 250);
    });
  });
}

// Evita que el contenido de atrás se mueva mientras hay un modal abierto.
function bloquearFondo() {
  if (document.querySelectorAll('.modal-overlay').length === 1) {
    document.body.dataset.scrollY = String(window.scrollY);
    document.body.style.overflow = 'hidden';
  }
}

function liberarFondo() {
  if (document.querySelectorAll('.modal-overlay').length === 0) {
    document.body.style.overflow = '';
  }
}

// Detecta cuándo se quita el modal del DOM para liberar el fondo.
function observarCierre(overlay) {
  const obs = new MutationObserver(() => {
    if (!document.body.contains(overlay)) {
      liberarFondo();
      obs.disconnect();
    }
  });
  obs.observe(document.body, { childList: true });
}

// Intercepta la inserción de modales para mejorarlos automáticamente.
// Así las 14 ventanas existentes se benefician sin reescribir ninguna.
(function activarMejoraDeModales() {
  const bodyAppend = document.body.appendChild.bind(document.body);
  document.body.appendChild = function (nodo) {
    const resultado = bodyAppend(nodo);
    if (nodo && nodo.classList && nodo.classList.contains('modal-overlay')) {
      mejorarModal(nodo);
      // Algunos modales se vuelven a pintar solos (por ejemplo el detalle
      // de una inversión al agregar una compra). Cuando eso pasa se pierde
      // la barra de arrastre, así que la reponemos.
      const obs = new MutationObserver(() => {
        const sheet = nodo.querySelector('.modal-sheet');
        if (sheet && !sheet.dataset.mejorado) mejorarModal(nodo);
      });
      obs.observe(nodo, { childList: true, subtree: true });
    }
    return resultado;
  };
})();

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

  const btnAddPuntual = document.getElementById('btn-add-puntual');
  if (btnAddPuntual) btnAddPuntual.addEventListener('click', () => openModalPuntual());
  app.querySelectorAll('[data-puntual-row]').forEach((row) => {
    row.addEventListener('click', () => {
      const id = Number(row.dataset.puntualRow);
      const p = domain.listaPuntualesMes().find((x) => x.id === id);
      if (!p) return;
      if (confirm(`¿Eliminar "${p.concepto}"?`)) {
        domain.eliminarPuntual(id);
        render();
      }
    });
  });
}

// ---------- Pantalla: Inicio ----------

function screenInicio() {
  const efectivo = domain.totalEnCuentas();
  const resumenMes = domain.resumenPeriodo('mes');
  const ultimos = domain.ultimosMovimientos(4);
  const pagosFijos = domain.estadoPagosFijosMes();
  const ingresosFijos = domain.estadoIngresosFijosMes();
  const puntuales = domain.listaPuntualesMes();
  const plan = domain.planGastoConsciente();

  const desgloseAbierto = seccionesAbiertas.has('presupuesto:detalle');

  return `
    <h1>Inicio</h1>
    <div class="card">
      ${plan.haySobrante ? `
        <p class="label" style="margin-bottom:2px;">Disponible real hoy</p>
        <p class="hero-number ${plan.disponibleReal >= 0 ? 'pos' : 'neg'}">${fmt(plan.disponibleReal)}</p>
        <p class="muted" style="margin:2px 0 10px;">de tu plan de ${fmt(plan.restante)} para este mes</p>
        ${(() => {
          const usado = plan.restante > 0 ? Math.min(100, Math.max(0, (plan.gastoVariable / plan.restante) * 100)) : 0;
          const barraColor = plan.disponibleReal < 0 ? 'var(--danger-text)' : usado > 80 ? 'var(--warning-text, #b8860b)' : 'var(--accent)';
          return `
        <div style="height:6px;background:var(--surface-2);border-radius:3px;overflow:hidden;margin-bottom:14px;">
          <div style="height:100%;width:${usado}%;background:${barraColor};border-radius:3px;"></div>
        </div>`;
        })()}
        <p class="label" style="font-size:11px;margin-bottom:6px;">Tu plan reparte lo libre así:</p>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:14px;">
          <div class="metric-card">
            <p class="label" style="font-size:11px;">Invertir</p>
            <p style="font-size:14px;font-weight:500;margin:0;">${fmt(plan.montoInversion)}</p>
          </div>
          <div class="metric-card">
            <p class="label" style="font-size:11px;">Ahorrar</p>
            <p style="font-size:14px;font-weight:500;margin:0;">${fmt(plan.montoAhorro)}</p>
          </div>
          <div class="metric-card">
            <p class="label" style="font-size:11px;">Disfrutar</p>
            <p style="font-size:14px;font-weight:500;margin:0;">${fmt(plan.montoDisfrute)}</p>
          </div>
        </div>
      ` : (plan.gastosDelMes > 0 || plan.ingresosDelMes > 0) ? `
        <p class="label" style="margin-bottom:2px;">Vas a quedar corto este mes</p>
        <p class="hero-number neg">${fmt(Math.abs(plan.restante))}</p>
        <p class="muted" style="margin:2px 0 14px;">tus gastos superan tus ingresos este mes</p>
      ` : `
        <p class="label" style="margin-bottom:2px;">Tu presupuesto del mes</p>
        <p class="muted" style="margin:8px 0 14px;">Parametriza tus ingresos y gastos fijos en Ajustes para verlo.</p>
      `}

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;padding-top:12px;border-top:0.5px solid var(--border);">
        <div>
          <p class="label" style="font-size:11px;">Efectivo disponible ahora</p>
          <p style="font-size:15px;font-weight:500;margin:0;">${fmt(efectivo)}</p>
        </div>
        <div>
          <p class="label" style="font-size:11px;">Movido este mes</p>
          <p style="font-size:15px;font-weight:500;margin:0;"><span class="pos">+${fmt(resumenMes.totalIngresos)}</span> <span class="muted" style="font-size:11px;">/</span> <span class="neg">−${fmt(resumenMes.totalGastos)}</span></p>
        </div>
      </div>

      ${(plan.gastosDelMes > 0 || plan.ingresosDelMes > 0) ? `
      <button class="acordeon-header" data-acordeon="presupuesto:detalle" style="margin-top:12px;width:100%;justify-content:space-between;border-bottom:none;">
        <span style="font-size:12px;color:var(--text-secondary);font-weight:400;">Ver cómo se calcula</span>
        <i class="ti ti-chevron-${desgloseAbierto ? 'up' : 'down'}" style="font-size:14px;color:var(--text-secondary);" aria-hidden="true"></i>
      </button>
      ${desgloseAbierto ? `
      <div style="padding-top:10px;">
        <div class="row-between" style="font-size:13px;margin-bottom:4px;">
          <span class="muted">Ingresos fijos${plan.ingresosFijos !== plan.ingresosFijosBase ? ' <span style="color:var(--text-secondary);">(ya recibiste más)</span>' : ''}</span><span style="font-weight:500;" class="pos">${fmt(plan.ingresosFijos)}</span>
        </div>
        ${plan.puntualesIngresos > 0 ? `
        <div class="row-between" style="font-size:13px;margin-bottom:4px;">
          <span class="muted">Ingresos extra del mes</span><span style="font-weight:500;" class="pos">+${fmt(plan.puntualesIngresos)}</span>
        </div>` : ''}
        <div class="row-between" style="font-size:13px;margin-bottom:4px;">
          <span class="muted">Gastos fijos</span><span style="font-weight:500;" class="neg">−${fmt(plan.gastosFijos)}</span>
        </div>
        ${plan.puntualesGastos > 0 ? `
        <div class="row-between" style="font-size:13px;margin-bottom:4px;">
          <span class="muted">Gastos puntuales del mes</span><span style="font-weight:500;" class="neg">−${fmt(plan.puntualesGastos)}</span>
        </div>` : ''}
        <div class="row-between" style="font-size:13px;margin-top:8px;padding-top:8px;border-top:0.5px solid var(--border);">
          <span style="font-weight:500;">Tu plan del mes</span><span style="font-weight:600;" class="${plan.haySobrante ? 'pos' : 'neg'}">${fmt(plan.restante)}</span>
        </div>
        ${plan.gastoVariable > 0 ? `
        <div class="row-between" style="font-size:13px;margin-top:6px;">
          <span class="muted">Ya gastaste (día a día)</span><span style="font-weight:500;" class="neg">−${fmt(plan.gastoVariable)}</span>
        </div>
        <div class="row-between" style="font-size:13px;margin-top:8px;padding-top:8px;border-top:0.5px solid var(--border);">
          <span style="font-weight:500;">Disponible real hoy</span><span style="font-weight:600;" class="${plan.disponibleReal >= 0 ? 'pos' : 'neg'}">${fmt(plan.disponibleReal)}</span>
        </div>` : ''}
        <p class="muted" style="font-size:11px;margin:10px 0 0;">Tu plan (fijos + ajustes) sale de arriba. El "día a día" son tus gastos variables de Movimientos, y son los que bajan lo que te queda libre hoy.</p>
      </div>` : ''}` : ''}
    </div>

    <button id="btn-ver-patrimonio" style="margin:-4px 0 4px;padding:6px 0;border:none;background:none;color:var(--text-secondary);font-size:12px;display:flex;align-items:center;gap:2px;">
      Ver patrimonio total <i class="ti ti-chevron-right" style="font-size:13px;" aria-hidden="true"></i>
    </button>

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

    <div class="row-between">
      <h2 style="margin-bottom:0;">Puntuales de este mes</h2>
      <button class="icon-btn" id="btn-add-puntual" aria-label="Agregar movimiento puntual"><i class="ti ti-plus" aria-hidden="true"></i></button>
    </div>
    <p class="muted" style="font-size:12px;margin:2px 0 8px;">Un ingreso extra o una compra que solo cuentan para este mes. No se repiten.</p>
    <div class="card">
      ${puntuales.length === 0 ? emptyState('ti-calendar-plus', 'Nada puntual este mes') :
        puntuales.map((p) => puntualRow(p)).join('')}
    </div>

    <h2>Últimos movimientos</h2>
    <div class="card">
      ${ultimos.length === 0 ? emptyState('ti-receipt', 'Aún no has registrado movimientos') :
        ultimos.map((m) => movimientoRow(m)).join('')}
    </div>
  `;
}

function puntualRow(p) {
  const esIngreso = p.tipo === 'ingreso';
  return `
    <div class="list-item" data-puntual-row="${p.id}" style="cursor:pointer;">
      <div class="icon-badge ${esIngreso ? 'success' : 'warning'}">
        <i class="ti ${esIngreso ? 'ti-arrow-down' : 'ti-arrow-up'}" aria-hidden="true"></i>
      </div>
      <div style="flex:1;min-width:0;">
        <p style="margin:0;font-weight:500;">${p.concepto}</p>
        <p class="muted" style="margin:0;">${esIngreso ? 'Ingreso extra' : 'Gasto puntual'} · toca para eliminar</p>
      </div>
      <span style="font-size:13px;font-weight:500;" class="${esIngreso ? 'pos' : 'neg'}">${esIngreso ? '+' : '−'}${fmt(p.monto)}</span>
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
    const totalEsperado = items.filter((p) => p.estado !== 'omitido').reduce((s, p) => s + p.monto_esperado, 0);
    const resueltos = items.filter((p) => p.estado === 'completo' || p.estado === 'omitido').length;
    return `
      <button class="acordeon-header" data-acordeon="${clave}">
        <i class="ti ${abierta ? 'ti-chevron-down' : 'ti-chevron-right'}" aria-hidden="true"></i>
        <span style="flex:1;text-align:left;">${nombreGrupo}</span>
        <span class="muted" style="font-size:12px;">${resueltos}/${items.length} · ${fmt(totalPagado)} de ${fmt(totalEsperado)}</span>
      </button>
      ${abierta ? `<div style="padding:2px 0 8px;">${items.map((p) => pagoFijoRow(p)).join('')}</div>` : ''}
    `;
  }).join('');
}

function renderPagosFijosAjustesAgrupados(pagosFijos) {
  const grupos = agruparPorCategoria(pagosFijos);
  return Object.keys(grupos).map((nombreGrupo) => {
    const items = grupos[nombreGrupo];
    const clave = `ajuste-pago:${nombreGrupo}`;
    const abierta = seccionesAbiertas.has(clave);
    const totalEsperado = items.reduce((s, p) => s + p.monto_esperado, 0);
    return `
      <button class="acordeon-header" data-acordeon="${clave}">
        <i class="ti ${abierta ? 'ti-chevron-down' : 'ti-chevron-right'}" aria-hidden="true"></i>
        <span style="flex:1;text-align:left;">${nombreGrupo}</span>
        <span class="muted" style="font-size:12px;">${items.length} · ${fmt(totalEsperado)}</span>
      </button>
      ${abierta ? `<div style="padding:2px 0 8px;">${items.map((p) => `
        <div class="list-item">
          <div class="icon-badge neutral"><i class="ti ${p.icono || 'ti-calendar-due'}" aria-hidden="true"></i></div>
          <div style="flex:1;">
            <p style="font-size:13px;margin:0;">${p.nombre}</p>
            <p class="muted" style="margin:0;">${fmt(p.monto_esperado)}${p.dia_esperado ? ' · día ' + p.dia_esperado : ''}${p.deuda_nombre ? ' · abona a ' + p.deuda_nombre : ''}</p>
          </div>
          <button class="icon-btn" data-edit-pago-fijo="${p.id}" aria-label="Editar"><i class="ti ti-pencil" aria-hidden="true"></i></button>
        </div>
      `).join('')}</div>` : ''}
    `;
  }).join('');
}

function renderIngresosFijosAjustesAgrupados(ingresosFijos) {
  const grupos = agruparPorCategoria(ingresosFijos);
  return Object.keys(grupos).map((nombreGrupo) => {
    const items = grupos[nombreGrupo];
    const clave = `ajuste-ingreso:${nombreGrupo}`;
    const abierta = seccionesAbiertas.has(clave);
    const totalEsperado = items.reduce((s, i) => s + i.monto_esperado, 0);
    return `
      <button class="acordeon-header" data-acordeon="${clave}">
        <i class="ti ${abierta ? 'ti-chevron-down' : 'ti-chevron-right'}" aria-hidden="true"></i>
        <span style="flex:1;text-align:left;">${nombreGrupo}</span>
        <span class="muted" style="font-size:12px;">${items.length} · ${fmt(totalEsperado)}</span>
      </button>
      ${abierta ? `<div style="padding:2px 0 8px;">${items.map((i) => `
        <div class="list-item">
          <div class="icon-badge success"><i class="ti ${i.icono || 'ti-cash'}" aria-hidden="true"></i></div>
          <div style="flex:1;">
            <p style="font-size:13px;margin:0;">${i.nombre}</p>
            <p class="muted" style="margin:0;">${fmt(i.monto_esperado)}${i.dia_esperado ? ' · día ' + i.dia_esperado : ''}</p>
          </div>
          <button class="icon-btn" data-edit-ingreso-fijo="${i.id}" aria-label="Editar"><i class="ti ti-pencil" aria-hidden="true"></i></button>
        </div>
      `).join('')}</div>` : ''}
    `;
  }).join('');
}

function pagoFijoRow(p) {
  const badgeTono = p.estado === 'completo' ? 'success' : p.estado === 'omitido' ? 'neutral' : 'warning';
  const icono = p.estado === 'completo' ? 'ti-check' : p.estado === 'omitido' ? 'ti-player-skip-forward' : p.estado === 'parcial' ? 'ti-progress' : 'ti-clock';
  let subtexto;
  if (p.estado === 'completo') subtexto = 'Pagado este mes';
  else if (p.estado === 'omitido') subtexto = 'Omitido este mes';
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
      <span style="font-size:13px;font-weight:500;" class="${p.estado === 'completo' ? 'pos' : ''}">${p.estado === 'omitido' ? '—' : fmt(p.estado === 'pendiente' ? p.monto_esperado : p.totalPagado)}</span>
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
        <input type="text" inputmode="numeric" id="mov-monto" placeholder="0" value="${esEdicion ? formatearMiles(movimientoExistente.monto) : ''}" />
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
  activarSeparadorMiles(overlay.querySelector('#mov-monto'));

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
    const monto = valorMiles(montoInput);
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

        ${pago.omitido ? `
          <div class="metric-card" style="margin-bottom:14px;">
            <p style="font-size:13px;margin:0;"><i class="ti ti-player-skip-forward" aria-hidden="true"></i> Marcaste este pago como omitido este mes.</p>
          </div>
          <button id="dp-deshacer-omitir" style="width:100%;">Deshacer, sí lo voy a pagar</button>
        ` : `
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
          <input type="text" inputmode="numeric" id="dp-monto" placeholder="0" value="${pago.restante > 0 ? formatearMiles(pago.restante) : ''}" />
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
        <button class="primary" id="dp-guardar" style="width:100%;margin-bottom:8px;">Agregar pago</button>
        ${pago.pagos.length === 0 ? '<button id="dp-omitir" style="width:100%;">Omitir este mes</button>' : ''}
        `}
      </div>
    `;

    overlay.querySelector('#modal-close').addEventListener('click', () => overlay.remove());
    activarSeparadorMiles(overlay.querySelector('#dp-monto'));
    const btnOmitir = overlay.querySelector('#dp-omitir');
    if (btnOmitir) btnOmitir.addEventListener('click', () => {
      domain.omitirPagoFijoEsteMes(pago.id);
      renderContenido();
      render();
    });
    const btnDeshacerOmitir = overlay.querySelector('#dp-deshacer-omitir');
    if (btnDeshacerOmitir) btnDeshacerOmitir.addEventListener('click', () => {
      domain.deshacerOmisionPagoFijo(pago.id);
      renderContenido();
      render();
    });
    overlay.querySelectorAll('[data-eliminar-pago]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (confirm('¿Eliminar este pago?')) {
          domain.desmarcarPagoFijo(Number(btn.dataset.eliminarPago));
          renderContenido();
          render();
        }
      });
    });
    const btnGuardarPago = overlay.querySelector('#dp-guardar');
    if (btnGuardarPago) btnGuardarPago.addEventListener('click', () => {
      const montoInput = overlay.querySelector('#dp-monto');
      const monto = valorMiles(montoInput);
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

// ---------- Categorías: gestión ----------

const ICONOS_CATEGORIA = [
  'ti-circle', 'ti-home', 'ti-shopping-cart', 'ti-car', 'ti-bolt', 'ti-device-tv',
  'ti-heart', 'ti-pizza', 'ti-coffee', 'ti-shirt', 'ti-gift', 'ti-plane',
  'ti-book', 'ti-briefcase', 'ti-cash', 'ti-coin', 'ti-building-bank', 'ti-pig-money',
  'ti-medical-cross', 'ti-paw', 'ti-school', 'ti-tools', 'ti-wifi', 'ti-phone',
];

function renderCategoriasAgrupadas() {
  const cats = domain.todasLasCategorias();
  const gastos = cats.filter((c) => c.tipo === 'gasto');
  const ingresos = cats.filter((c) => c.tipo === 'ingreso');
  function grupo(titulo, lista) {
    if (lista.length === 0) return '';
    return `
      <p class="label" style="font-size:11px;margin:6px 0 4px;">${titulo}</p>
      ${lista.map((c) => `
        <div class="list-item" data-categoria-row="${c.id}" style="cursor:pointer;">
          <div class="icon-badge"><i class="ti ${c.icono}" aria-hidden="true"></i></div>
          <div style="flex:1;min-width:0;">
            <p style="margin:0;font-weight:500;">${c.nombre}</p>
          </div>
          <i class="ti ti-chevron-right" style="color:var(--text-secondary);font-size:16px;" aria-hidden="true"></i>
        </div>
      `).join('')}
    `;
  }
  return grupo('Gastos', gastos) + grupo('Ingresos', ingresos);
}

function openModalCategoria(categoriaId) {
  const esEdicion = !!categoriaId;
  const cat = esEdicion ? domain.todasLasCategorias().find((c) => c.id === categoriaId) : null;
  let tipo = cat ? cat.tipo : 'gasto';
  let iconoSel = cat ? cat.icono : 'ti-circle';
  let ingresoTipo = cat ? (cat.ingreso_tipo || 'activo') : 'activo';

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';

  function iconosGrid() {
    return ICONOS_CATEGORIA.map((ic) => `
      <button type="button" class="icono-opcion ${ic === iconoSel ? 'icono-activo' : ''}" data-icono="${ic}" style="padding:8px;border:1px solid var(--border);background:var(--surface-1);border-radius:8px;cursor:pointer;">
        <i class="ti ${ic}" style="font-size:18px;" aria-hidden="true"></i>
      </button>`).join('');
  }

  function pintar() {
    overlay.innerHTML = `
      <div class="modal-sheet">
        <div class="row-between" style="margin-bottom:14px;">
          <h2 style="margin:0;">${esEdicion ? 'Editar categoría' : 'Nueva categoría'}</h2>
          <button class="icon-btn" id="modal-close" aria-label="Cerrar"><i class="ti ti-x" aria-hidden="true"></i></button>
        </div>
        ${!esEdicion ? `
        <div class="field">
          <label>Tipo</label>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
            <button type="button" class="seg-btn ${tipo === 'gasto' ? 'seg-activo' : ''}" data-tipo="gasto">Gasto</button>
            <button type="button" class="seg-btn ${tipo === 'ingreso' ? 'seg-activo' : ''}" data-tipo="ingreso">Ingreso</button>
          </div>
        </div>` : ''}
        <div class="field">
          <label>Nombre</label>
          <input type="text" id="cat-nombre" value="${cat ? cat.nombre.replace(/"/g, '&quot;') : ''}" placeholder="Ej. Mercado, Mascota, Freelance" />
          <p class="muted" id="cat-nombre-error" style="display:none;color:var(--danger-text);margin:4px 0 0;">Escribe un nombre.</p>
        </div>
        ${tipo === 'ingreso' ? `
        <div class="field">
          <label>¿Ingreso activo o pasivo?</label>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
            <button type="button" class="seg-btn ${ingresoTipo === 'activo' ? 'seg-activo' : ''}" data-ingtipo="activo">Activo (trabajo)</button>
            <button type="button" class="seg-btn ${ingresoTipo === 'pasivo' ? 'seg-activo' : ''}" data-ingtipo="pasivo">Pasivo (rinde solo)</button>
          </div>
        </div>` : ''}
        <div class="field">
          <label>Ícono</label>
          <div style="display:grid;grid-template-columns:repeat(6,1fr);gap:6px;">${iconosGrid()}</div>
        </div>
        <button class="primary" id="cat-guardar" style="width:100%;margin-bottom:${esEdicion ? '8px' : '0'};">${esEdicion ? 'Guardar cambios' : 'Crear categoría'}</button>
        ${esEdicion ? '<button id="cat-eliminar" style="width:100%;color:var(--danger-text);"><i class="ti ti-trash" aria-hidden="true"></i> Eliminar categoría</button>' : ''}
      </div>
    `;
    overlay.querySelector('#modal-close').addEventListener('click', () => overlay.remove());
    overlay.querySelectorAll('[data-tipo]').forEach((b) => b.addEventListener('click', () => { tipo = b.dataset.tipo; pintar(); }));
    overlay.querySelectorAll('[data-ingtipo]').forEach((b) => b.addEventListener('click', () => { ingresoTipo = b.dataset.ingtipo; pintar(); }));
    overlay.querySelectorAll('[data-icono]').forEach((b) => b.addEventListener('click', () => { iconoSel = b.dataset.icono; pintar(); }));
    overlay.querySelector('#cat-guardar').addEventListener('click', () => {
      const nombre = overlay.querySelector('#cat-nombre').value.trim();
      if (!nombre) { overlay.querySelector('#cat-nombre-error').style.display = 'block'; return; }
      if (esEdicion) {
        domain.actualizarCategoria(categoriaId, { nombre, icono: iconoSel, ingresoTipo });
      } else {
        domain.crearCategoria({ nombre, tipo, icono: iconoSel, ingresoTipo });
      }
      overlay.remove();
      render();
    });
    const btnEliminar = overlay.querySelector('#cat-eliminar');
    if (btnEliminar) btnEliminar.addEventListener('click', () => confirmarEliminarCategoria(categoriaId, cat, overlay));
  }

  pintar();
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

function confirmarEliminarCategoria(id, cat, overlayPadre) {
  const uso = domain.usoDeCategoria(id);
  if (uso.total === 0) {
    if (confirm(`¿Eliminar la categoría "${cat.nombre}"?`)) {
      domain.eliminarCategoria(id);
      overlayPadre.remove();
      render();
    }
    return;
  }
  // Está en uso: pedir categoría destino para reasignar.
  const mismoTipo = domain.categorias(cat.tipo).filter((c) => c.id !== id);
  if (mismoTipo.length === 0) {
    alert(`No puedes eliminar "${cat.nombre}" porque tiene movimientos y no hay otra categoría de ${cat.tipo} a la cual moverlos. Crea otra primero.`);
    return;
  }
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-sheet">
      <div class="row-between" style="margin-bottom:14px;">
        <h2 style="margin:0;">Mover y eliminar</h2>
        <button class="icon-btn" id="modal-close" aria-label="Cerrar"><i class="ti ti-x" aria-hidden="true"></i></button>
      </div>
      <p class="muted" style="margin-bottom:14px;">"${cat.nombre}" tiene ${uso.total} registro${uso.total === 1 ? '' : 's'} asociado${uso.total === 1 ? '' : 's'}. Elige a qué categoría moverlos antes de eliminar.</p>
      <div class="field">
        <label>Mover todo a</label>
        <select id="cat-destino">
          ${mismoTipo.map((c) => `<option value="${c.id}">${c.nombre}</option>`).join('')}
        </select>
      </div>
      <button class="primary" id="cat-confirmar-mover" style="width:100%;color:var(--danger-text);">Mover y eliminar "${cat.nombre}"</button>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector('#modal-close').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('#cat-confirmar-mover').addEventListener('click', () => {
    const destino = Number(overlay.querySelector('#cat-destino').value);
    domain.eliminarCategoria(id, destino);
    overlay.remove();
    if (overlayPadre) overlayPadre.remove();
    render();
  });
}

// ---------- Modal: agregar movimiento puntual del mes ----------

function openModalPuntual() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-sheet">
      <div class="row-between" style="margin-bottom:14px;">
        <h2 style="margin:0;">Movimiento puntual</h2>
        <button class="icon-btn" id="modal-close" aria-label="Cerrar"><i class="ti ti-x" aria-hidden="true"></i></button>
      </div>
      <p class="muted" style="margin:0 0 14px;">Solo afecta el presupuesto de este mes. No se repite el mes que viene.</p>
      <div class="field">
        <label>¿Qué es?</label>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
          <button type="button" class="seg-btn seg-activo" id="pt-tipo-ingreso" data-tipo="ingreso">Ingreso extra</button>
          <button type="button" class="seg-btn" id="pt-tipo-gasto" data-tipo="gasto">Gasto puntual</button>
        </div>
      </div>
      <div class="field">
        <label>Concepto</label>
        <input type="text" id="pt-concepto" placeholder="Ej. Trabajo extra, préstamo de Ana, compra de llanta" />
        <p class="muted" id="pt-concepto-error" style="display:none;color:var(--danger-text);margin:4px 0 0;">Escribe un concepto.</p>
      </div>
      <div class="field">
        <label>Monto</label>
        <input type="text" inputmode="numeric" id="pt-monto" placeholder="0" />
        <p class="muted" id="pt-monto-error" style="display:none;color:var(--danger-text);margin:4px 0 0;">Escribe un monto.</p>
      </div>
      <button class="primary" id="pt-guardar" style="width:100%;">Agregar</button>
    </div>
  `;
  document.body.appendChild(overlay);
  activarSeparadorMiles(overlay.querySelector('#pt-monto'));

  let tipo = 'ingreso';
  const btnIngreso = overlay.querySelector('#pt-tipo-ingreso');
  const btnGasto = overlay.querySelector('#pt-tipo-gasto');
  function setTipo(nuevo) {
    tipo = nuevo;
    btnIngreso.classList.toggle('seg-activo', nuevo === 'ingreso');
    btnGasto.classList.toggle('seg-activo', nuevo === 'gasto');
  }
  btnIngreso.addEventListener('click', () => setTipo('ingreso'));
  btnGasto.addEventListener('click', () => setTipo('gasto'));

  overlay.querySelector('#modal-close').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('#pt-guardar').addEventListener('click', () => {
    const concepto = overlay.querySelector('#pt-concepto').value.trim();
    const montoInput = overlay.querySelector('#pt-monto');
    const monto = valorMiles(montoInput);
    const sinConcepto = !concepto;
    const sinMonto = !monto || monto <= 0;
    overlay.querySelector('#pt-concepto-error').style.display = sinConcepto ? 'block' : 'none';
    overlay.querySelector('#pt-monto-error').style.display = sinMonto ? 'block' : 'none';
    if (sinConcepto || sinMonto) return;
    domain.agregarPuntual({ tipo, concepto, monto });
    overlay.remove();
    render();
  });
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
        <input type="text" inputmode="numeric" id="if-monto-real" value="${ingreso.monto_esperado ? formatearMiles(ingreso.monto_esperado) : ''}" placeholder="0" />
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
  activarSeparadorMiles(overlay.querySelector('#if-monto-real'));
  overlay.querySelector('#modal-close').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('#if-guardar').addEventListener('click', () => {
    const montoInput = overlay.querySelector('#if-monto-real');
    const monto = valorMiles(montoInput);
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
        <input type="text" inputmode="numeric" id="if-monto-esperado" placeholder="0" value="${esEdicion ? formatearMiles(ingresoExistente.monto_esperado) : ''}" />
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
  activarSeparadorMiles(overlay.querySelector('#if-monto-esperado'));
  overlay.querySelector('#modal-close').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('#if-def-guardar').addEventListener('click', () => {
    const nombre = overlay.querySelector('#if-nombre').value.trim();
    if (!nombre) { overlay.querySelector('#if-nombre').focus(); return; }
    const montoEsperado = valorMiles(overlay.querySelector('#if-monto-esperado'));
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
        <input type="text" inputmode="numeric" id="pf-monto-esperado" placeholder="0" value="${esEdicion ? formatearMiles(pagoExistente.monto_esperado) : ''}" />
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
  activarSeparadorMiles(overlay.querySelector('#pf-monto-esperado'));
  overlay.querySelector('#modal-close').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('#pf-def-guardar').addEventListener('click', () => {
    const nombre = overlay.querySelector('#pf-nombre').value.trim();
    if (!nombre) { overlay.querySelector('#pf-nombre').focus(); return; }
    const montoEsperado = valorMiles(overlay.querySelector('#pf-monto-esperado'));
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
        <input type="text" inputmode="numeric" id="cta-saldo" placeholder="0" value="${esEdicion ? formatearMiles(cuentaExistente.saldo) : ''}" />
        ${esEdicion ? '<p class="muted" style="margin:4px 0 0;">Ajusta este número si el saldo no coincide con la realidad.</p>' : ''}
      </div>
      <button class="primary" id="cta-guardar" style="width:100%;margin-bottom:8px;">Guardar</button>
      ${esEdicion ? '<button id="cta-eliminar" style="width:100%;color:var(--danger-text);">Eliminar cuenta</button>' : ''}
    </div>
  `;
  document.body.appendChild(overlay);
  activarSeparadorMiles(overlay.querySelector('#cta-saldo'));
  overlay.querySelector('#modal-close').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('#cta-guardar').addEventListener('click', () => {
    const nombre = overlay.querySelector('#cta-nombre').value.trim();
    const tipo = overlay.querySelector('#cta-tipo').value;
    const saldoIngresado = valorMiles(overlay.querySelector('#cta-saldo'));
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
  const aportado = domain.totalCostoInvertido();
  const rentabilidad = domain.rentabilidadTotalPortafolio();
  const distribucion = domain.distribucionInversionesPorTipo();
  const trm = domain.obtenerTRM();
  const trmFecha = domain.obtenerTRMFecha();
  const hayUSD = inversiones.some((i) => i.moneda === 'USD');
  const ganancia = total - aportado;

  const donutGradient = buildDonutGradient(distribucion);

  return `
    <div class="row-between">
      <h1 style="margin-bottom:0;">Inversiones</h1>
      <button class="icon-btn" id="btn-add-inversion" aria-label="Agregar inversión"><i class="ti ti-plus" aria-hidden="true"></i></button>
    </div>

    <div class="card">
      <p class="label">Valor de mercado hoy</p>
      <p class="hero-number" style="font-size:24px;">${fmt(total)}</p>
      ${aportado > 0 ? `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px;padding-top:12px;border-top:0.5px solid var(--border);">
          <div>
            <p class="label" style="font-size:11px;">Capital aportado</p>
            <p style="font-size:15px;font-weight:500;margin:0;">${fmt(aportado)}</p>
          </div>
          <div>
            <p class="label" style="font-size:11px;">Ganancia / pérdida</p>
            <p style="font-size:15px;font-weight:500;margin:0;" class="${ganancia >= 0 ? 'pos' : 'neg'}">${ganancia >= 0 ? '+' : ''}${fmt(ganancia)} <span style="font-size:12px;">(${rentabilidad >= 0 ? '+' : ''}${rentabilidad.toFixed(1)}%)</span></p>
          </div>
        </div>
        <p class="muted" style="font-size:11px;margin:10px 0 0;">El capital aportado es lo que has puesto de tu bolsillo: solo sube cuando inviertes. El valor de mercado sube y baja con los precios.</p>
      ` : ''}
    </div>

    ${hayUSD ? `
    <div class="card">
      <div class="row-between">
        <div style="flex:1;min-width:0;">
          <p class="label" style="font-size:11px;margin-bottom:2px;">Tasa de cambio (TRM)</p>
          <p style="font-size:15px;font-weight:500;margin:0;">${trm > 0 ? `$${trm.toLocaleString('es-CO', { maximumFractionDigits: 2 })} por USD` : 'Sin definir'}</p>
          <p class="muted" style="font-size:11px;margin:2px 0 0;">${trm > 0 ? (trmFecha ? `Actualizada ${tiempoRelativo(trmFecha)}` : 'Actualizada manualmente') : 'Necesaria para ver tus activos en USD dentro del patrimonio'}</p>
        </div>
        <button class="icon-btn" id="btn-actualizar-trm" aria-label="Actualizar TRM"><i class="ti ti-refresh" aria-hidden="true"></i></button>
      </div>
      <p id="trm-error" class="muted" style="display:none;color:var(--danger-text);font-size:12px;margin:8px 0 0;"></p>
      <button id="btn-trm-manual" style="width:100%;margin-top:10px;font-size:12px;">Escribir TRM a mano</button>
    </div>` : ''}

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

    <div class="row-between">
      <h2 style="margin-bottom:0;">Tus inversiones</h2>
      ${inversiones.some((i) => i.coingecko_id) ? '<button class="icon-btn" id="btn-actualizar-precios" aria-label="Actualizar precios"><i class="ti ti-refresh" aria-hidden="true"></i></button>' : ''}
    </div>
    <p id="precios-error" class="muted" style="display:none;color:var(--danger-text);font-size:12px;margin:4px 0;"></p>
    <div class="card">
      ${inversiones.length === 0 ? emptyState('ti-chart-pie', 'Aún no has agregado ninguna inversión') :
        inversiones.map((inv) => inversionRow(inv)).join('')}
    </div>
  `;
}

// "hace 3 horas", "hace 2 días" — para que nunca confundas un precio
// viejo con el de hoy.
function tiempoRelativo(fechaISO) {
  if (!fechaISO) return '';
  const then = new Date(fechaISO).getTime();
  if (!Number.isFinite(then)) return '';
  const mins = Math.floor((Date.now() - then) / 60000);
  if (mins < 1) return 'hace un momento';
  if (mins < 60) return `hace ${mins} min`;
  const horas = Math.floor(mins / 60);
  if (horas < 24) return `hace ${horas} h`;
  const dias = Math.floor(horas / 24);
  if (dias === 1) return 'ayer';
  if (dias < 30) return `hace ${dias} días`;
  const meses = Math.floor(dias / 30);
  return `hace ${meses} mes${meses !== 1 ? 'es' : ''}`;
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
  const esUSD = inv.moneda === 'USD';
  const valorCOP = domain.aCOP(inv.valor_actual, inv.moneda);
  return `
    <div class="list-item" data-inv-id="${inv.id}" style="cursor:pointer;">
      <div class="icon-badge neutral" style="background:${info.color}22;color:${info.color};"><i class="ti ti-chart-pie" aria-hidden="true"></i></div>
      <div style="flex:1;min-width:0;">
        <p style="font-size:13px;margin:0;">${inv.nombre}${esUSD ? ' <span class="muted" style="font-size:10px;border:0.5px solid var(--border);border-radius:4px;padding:0 4px;">USD</span>' : ''}</p>
        <p class="muted" style="margin:0;">${info.nombre}${inv.usa_precio_unidad && inv.precio_actual_unidad ? ` · ${fmtMoneda(inv.precio_actual_unidad, inv.moneda)}` : ''}</p>
      </div>
      <div style="text-align:right;">
        <p style="font-size:13px;font-weight:500;margin:0;">${esUSD ? fmtMoneda(inv.valor_actual, 'USD') : fmt(inv.valor_actual)}</p>
        ${esUSD && valorCOP > 0 ? `<p class="muted" style="margin:0;font-size:10px;">${fmt(valorCOP)}</p>` : ''}
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
      if (inv) openModalDetalleInversion(inv);
    });
  });

  // --- Actualizar TRM desde datos.gov.co ---
  const btnTRM = document.getElementById('btn-actualizar-trm');
  if (btnTRM) btnTRM.addEventListener('click', async () => {
    const err = document.getElementById('trm-error');
    if (err) err.style.display = 'none';
    btnTRM.disabled = true;
    btnTRM.innerHTML = '<i class="ti ti-loader-2" aria-hidden="true"></i>';
    try {
      const { valor, vigenciaDesde } = await precios.obtenerTRMOficial();
      domain.guardarTRM(valor, vigenciaDesde || new Date().toISOString());
      render();
    } catch (e) {
      btnTRM.disabled = false;
      btnTRM.innerHTML = '<i class="ti ti-refresh" aria-hidden="true"></i>';
      if (err) { err.textContent = precios.mensajeDeError(e); err.style.display = 'block'; }
    }
  });

  const btnTRMManual = document.getElementById('btn-trm-manual');
  if (btnTRMManual) btnTRMManual.addEventListener('click', () => {
    const actual = domain.obtenerTRM();
    const txt = prompt('¿Cuántos pesos vale un dólar hoy?', actual > 0 ? String(Math.round(actual)) : '');
    if (txt === null) return;
    const valor = parseFloat(String(txt).replace(/[^\d.,]/g, '').replace(/\./g, '').replace(',', '.'));
    if (!Number.isFinite(valor) || valor <= 0) { alert('Escribe un número válido.'); return; }
    domain.guardarTRM(valor, new Date().toISOString());
    render();
  });

  // --- Actualizar precios de cripto desde CoinGecko ---
  const btnPrecios = document.getElementById('btn-actualizar-precios');
  if (btnPrecios) btnPrecios.addEventListener('click', async () => {
    const err = document.getElementById('precios-error');
    if (err) err.style.display = 'none';
    btnPrecios.disabled = true;
    btnPrecios.innerHTML = '<i class="ti ti-loader-2" aria-hidden="true"></i>';
    try {
      const invs = domain.listaInversiones().filter((i) => i.coingecko_id);
      // Agrupamos por moneda: CoinGecko puede dar el precio en usd o cop.
      const porMoneda = {};
      for (const inv of invs) {
        const m = (inv.moneda || 'COP').toLowerCase();
        if (!porMoneda[m]) porMoneda[m] = [];
        porMoneda[m].push(inv);
      }
      let actualizadas = 0;
      const noEncontradas = [];
      for (const [moneda, lista] of Object.entries(porMoneda)) {
        const ids = lista.map((i) => i.coingecko_id);
        const mapa = await precios.obtenerPreciosCripto(ids, moneda);
        for (const inv of lista) {
          const precio = mapa[inv.coingecko_id];
          if (typeof precio === 'number') {
            domain.actualizarPrecioUnidad(inv.id, precio, new Date().toISOString());
            actualizadas++;
          } else {
            noEncontradas.push(inv.nombre);
          }
        }
      }
      render();
      if (noEncontradas.length > 0) {
        const err2 = document.getElementById('precios-error');
        if (err2) {
          err2.textContent = `No se encontró precio para: ${noEncontradas.join(', ')}. Revisa el identificador de CoinGecko o escribe el precio a mano.`;
          err2.style.display = 'block';
        }
      }
    } catch (e) {
      btnPrecios.disabled = false;
      btnPrecios.innerHTML = '<i class="ti ti-refresh" aria-hidden="true"></i>';
      if (err) { err.textContent = precios.mensajeDeError(e); err.style.display = 'block'; }
    }
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
        <input type="text" inputmode="numeric" id="meta-monto" placeholder="Ej: 1.000.000.000" value="${p.meta ? formatearMiles(p.meta) : ''}" />
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
  activarSeparadorMiles(overlay.querySelector('#meta-monto'));
  overlay.querySelector('#modal-close').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('#meta-guardar').addEventListener('click', () => {
    const monto = valorMiles(overlay.querySelector('#meta-monto'));
    const tasa = Number(overlay.querySelector('#meta-tasa').value) || 8;
    domain.setMetaPatrimonio(monto);
    domain.setTasaAnualEsperada(tasa);
    overlay.remove();
    render();
  });
}

function openModalInversion() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-sheet">
      <div class="row-between" style="margin-bottom:14px;">
        <h2 style="margin:0;">Nueva inversión</h2>
        <button class="icon-btn" id="modal-close" aria-label="Cerrar"><i class="ti ti-x" aria-hidden="true"></i></button>
      </div>
      <div class="field">
        <label>Nombre</label>
        <input type="text" id="inv-nombre" placeholder="Ej: Bitcoin, CDT Bancolombia" />
      </div>
      <div class="field">
        <label>Tipo</label>
        <select id="inv-tipo">
          ${TIPOS_INVERSION.map((t) => `<option value="${t.id}">${t.nombre}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label>¿En qué moneda compras este activo?</label>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
          <button type="button" class="seg-btn seg-activo" id="inv-moneda-cop" data-moneda="COP">Pesos (COP)</button>
          <button type="button" class="seg-btn" id="inv-moneda-usd" data-moneda="USD">Dólares (USD)</button>
        </div>
        <p class="muted" style="font-size:11px;margin:6px 0 0;">Cripto, ETFs y bolsa normalmente se compran en USD. Los cálculos se harán en esta moneda.</p>
      </div>
      <div class="field">
        <label>Identificador en CoinGecko <span class="muted">(opcional)</span></label>
        <input type="text" id="inv-coingecko" placeholder="Ej: bitcoin, ethereum, solana" />
        <p class="muted" style="font-size:11px;margin:6px 0 0;">Si lo llenas, podrás traer el precio con un botón. Si lo dejas vacío, actualizas el precio a mano.</p>
      </div>
      <div class="field">
        <label>Cuánto has invertido en total (costo)</label>
        <input type="text" inputmode="decimal" id="inv-costo" placeholder="0" />
      </div>
      <div class="field">
        <label>Cuánto vale hoy</label>
        <input type="text" inputmode="decimal" id="inv-actual" placeholder="0" />
      </div>
      <p class="muted" style="margin:-4px 0 12px;">Después de crearla podrás llevar un historial de compras (DCA) tocándola desde la lista.</p>
      <button class="primary" id="inv-guardar" style="width:100%;">Guardar</button>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector('#modal-close').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  let monedaSel = 'COP';
  const btnCOP = overlay.querySelector('#inv-moneda-cop');
  const btnUSD = overlay.querySelector('#inv-moneda-usd');
  function setMoneda(m) {
    monedaSel = m;
    btnCOP.classList.toggle('seg-activo', m === 'COP');
    btnUSD.classList.toggle('seg-activo', m === 'USD');
  }
  btnCOP.addEventListener('click', () => setMoneda('COP'));
  btnUSD.addEventListener('click', () => setMoneda('USD'));

  overlay.querySelector('#inv-guardar').addEventListener('click', () => {
    const nombre = overlay.querySelector('#inv-nombre').value.trim();
    if (!nombre) { overlay.querySelector('#inv-nombre').focus(); return; }
    const tipo = overlay.querySelector('#inv-tipo').value;
    const coingeckoId = overlay.querySelector('#inv-coingecko').value.trim().toLowerCase() || null;
    const valorInvertido = numeroDecimal(overlay.querySelector('#inv-costo').value);
    const valorActual = numeroDecimal(overlay.querySelector('#inv-actual').value);
    domain.agregarInversion({ nombre, tipo, valorInvertido, valorActual, moneda: monedaSel, coingeckoId });
    overlay.remove();
    render();
  });
}

// Lee un número que puede traer separadores de miles y decimales.
// Acepta "1.234,56" (formato local) y "1234.56" (formato de exchange).
function numeroDecimal(texto) {
  if (texto === null || texto === undefined) return 0;
  let t = String(texto).trim().replace(/\s/g, '');
  if (!t) return 0;
  const tieneComa = t.includes(',');
  const tienePunto = t.includes('.');
  if (tieneComa && tienePunto) {
    // El último separador que aparece es el decimal
    if (t.lastIndexOf(',') > t.lastIndexOf('.')) t = t.replace(/\./g, '').replace(',', '.');
    else t = t.replace(/,/g, '');
  } else if (tieneComa) {
    t = t.replace(',', '.');
  }
  const n = parseFloat(t.replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

// ---------- Modal: editar una compra del historial DCA ----------

function openModalEditarCompra(compra, inv, alGuardar) {
  const mon = inv.moneda || 'COP';
  const esUSD = mon === 'USD';
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-sheet">
      <div class="row-between" style="margin-bottom:4px;">
        <h2 style="margin:0;">Editar compra</h2>
        <button class="icon-btn" id="modal-close" aria-label="Cerrar"><i class="ti ti-x" aria-hidden="true"></i></button>
      </div>
      <p class="muted" style="margin:0 0 14px;">${inv.nombre}${esUSD ? ' · USD' : ''}</p>

      <div class="field">
        <label>Fecha</label>
        <input type="date" id="ec-fecha" value="${compra.fecha}" />
      </div>
      <div class="field">
        <label>Cantidad comprada</label>
        <input type="text" inputmode="decimal" id="ec-cantidad" value="${compra.cantidad || ''}" placeholder="Ej: 0.0045" />
      </div>
      <div class="field">
        <label>Precio por unidad${esUSD ? ' (USD)' : ''}</label>
        <input type="text" inputmode="decimal" id="ec-precio" value="${compra.precio_unidad || ''}" placeholder="Ej: 62000" />
      </div>
      <div class="field">
        <label>Total invertido</label>
        <input type="text" inputmode="decimal" id="ec-monto" value="${compra.monto_invertido || ''}" placeholder="0" />
        <p class="muted" style="font-size:11px;margin:6px 0 0;">Si cambias cantidad o precio, el total se recalcula solo.</p>
      </div>
      <p class="muted" id="ec-error" style="display:none;color:var(--danger-text);margin:0 0 10px;"></p>
      <button class="primary" id="ec-guardar" style="width:100%;margin-bottom:8px;">Guardar cambios</button>
      <button id="ec-eliminar" style="width:100%;color:var(--danger-text);"><i class="ti ti-trash" aria-hidden="true"></i> Eliminar esta compra</button>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector('#modal-close').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  const inCant = overlay.querySelector('#ec-cantidad');
  const inPrecio = overlay.querySelector('#ec-precio');
  const inMonto = overlay.querySelector('#ec-monto');
  function recalc() {
    const c = numeroDecimal(inCant.value);
    const p = numeroDecimal(inPrecio.value);
    if (c > 0 && p > 0) inMonto.value = String(Number((c * p).toFixed(esUSD ? 2 : 0)));
  }
  inCant.addEventListener('input', recalc);
  inPrecio.addEventListener('input', recalc);

  overlay.querySelector('#ec-guardar').addEventListener('click', () => {
    const fecha = overlay.querySelector('#ec-fecha').value;
    const cantidad = numeroDecimal(inCant.value);
    const precioUnidad = numeroDecimal(inPrecio.value);
    const monto = numeroDecimal(inMonto.value);
    const err = overlay.querySelector('#ec-error');
    if (!fecha) { err.textContent = 'Escribe una fecha.'; err.style.display = 'block'; return; }
    if ((!cantidad || !precioUnidad) && !monto) {
      err.textContent = 'Escribe cantidad y precio, o al menos el total invertido.';
      err.style.display = 'block';
      return;
    }
    domain.actualizarCompraInversion(compra.id, inv.id, {
      fecha,
      montoInvertido: monto || null,
      cantidad: cantidad || null,
      precioUnidad: precioUnidad || null,
    });
    overlay.remove();
    if (alGuardar) alGuardar();
  });

  overlay.querySelector('#ec-eliminar').addEventListener('click', () => {
    if (!confirm('¿Eliminar esta compra? El promedio se recalculará.')) return;
    domain.eliminarCompraInversion(compra.id, inv.id);
    overlay.remove();
    if (alGuardar) alGuardar();
  });
}

// ---------- Modal: detalle de una inversión existente (con historial DCA) ----------

function openModalDetalleInversion(invInicial) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  document.body.appendChild(overlay);

  function renderContenido() {
    const inv = domain.listaInversiones().find((i) => i.id === invInicial.id);
    if (!inv) { overlay.remove(); return; }
    const compras = domain.listaComprasInversion(inv.id);
    const pos = domain.resumenPosicion(inv.id);
    const info = tipoInversionInfo(inv.tipo);
    const mon = inv.moneda || 'COP';
    const esUSD = mon === 'USD';
    const trm = domain.obtenerTRM();

    overlay.innerHTML = `
      <div class="modal-sheet">
        <div class="row-between" style="margin-bottom:4px;">
          <h2 style="margin:0;">${inv.nombre}</h2>
          <button class="icon-btn" id="modal-close" aria-label="Cerrar"><i class="ti ti-x" aria-hidden="true"></i></button>
        </div>
        <p class="muted" style="margin:0 0 14px;">${info.nombre}${esUSD ? ' · cotiza en USD' : ''}</p>

        ${pos && pos.cantidad > 0 ? `
        <div class="card" style="background:var(--surface-2);margin-bottom:14px;">
          <p class="label" style="font-size:11px;margin-bottom:2px;">Tu posición</p>
          <p style="font-size:20px;font-weight:500;margin:0 0 2px;">${fmtCantidad(pos.cantidad)} <span style="font-size:13px;" class="muted">unidades</span></p>
          <p class="muted" style="font-size:11px;margin:0 0 12px;">en ${pos.numeroCompras} compra${pos.numeroCompras !== 1 ? 's' : ''}</p>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
            <div>
              <p class="label" style="font-size:11px;">Precio promedio</p>
              <p style="font-size:14px;font-weight:500;margin:0;">${fmtMoneda(pos.precioPromedio, mon, esUSD ? 2 : 0)}</p>
            </div>
            <div>
              <p class="label" style="font-size:11px;">Precio actual</p>
              <p style="font-size:14px;font-weight:500;margin:0;">${pos.precioActual > 0 ? fmtMoneda(pos.precioActual, mon, esUSD ? 2 : 0) : '—'}</p>
              ${inv.precio_actualizado_en ? `<p class="muted" style="font-size:10px;margin:0;">${tiempoRelativo(inv.precio_actualizado_en)}</p>` : ''}
            </div>
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px;padding-top:10px;border-top:0.5px solid var(--border);">
            <div>
              <p class="label" style="font-size:11px;">Invertido</p>
              <p style="font-size:14px;font-weight:500;margin:0;">${fmtMoneda(pos.invertido, mon)}</p>
            </div>
            <div>
              <p class="label" style="font-size:11px;">Vale hoy</p>
              <p style="font-size:14px;font-weight:500;margin:0;">${fmtMoneda(pos.valorMercado, mon)}</p>
            </div>
          </div>

          <div style="margin-top:10px;padding-top:10px;border-top:0.5px solid var(--border);">
            <p class="label" style="font-size:11px;">Ganancia / pérdida</p>
            <p style="font-size:18px;font-weight:500;margin:0;" class="${pos.ganancia >= 0 ? 'pos' : 'neg'}">
              ${pos.ganancia >= 0 ? '+' : ''}${fmtMoneda(pos.ganancia, mon)}
              <span style="font-size:13px;">(${pos.gananciaPct >= 0 ? '+' : ''}${pos.gananciaPct.toFixed(1)}%)</span>
            </p>
            ${esUSD ? (trm > 0
              ? `<p class="muted" style="font-size:11px;margin:6px 0 0;">En pesos: ${fmt(pos.valorMercadoCOP)} · aportaste ${fmt(pos.invertidoCOP)} (TRM ${Math.round(trm).toLocaleString('es-CO')})</p>`
              : '<p class="muted" style="font-size:11px;margin:6px 0 0;color:var(--warning-text);">Define la TRM para ver el equivalente en pesos y que sume al patrimonio.</p>') : ''}
          </div>
        </div>` : ''}

        <div style="border-top:0.5px solid var(--border);padding-top:10px;margin-bottom:14px;">
          <div class="field" style="display:flex;align-items:center;gap:8px;margin-bottom:${inv.usa_precio_unidad ? '10px' : '0'};">
            <input type="checkbox" id="inv-usa-precio" ${inv.usa_precio_unidad ? 'checked' : ''} style="width:auto;height:auto;" />
            <label for="inv-usa-precio" style="margin:0;font-size:13px;">Calcular el valor actual solo (cantidad × precio)</label>
          </div>
          ${inv.usa_precio_unidad ? `
            <div class="field" style="margin-bottom:0;">
              <label>Precio actual por unidad${esUSD ? ' (USD)' : ''}</label>
              <input type="text" inputmode="decimal" id="inv-precio-unidad" value="${inv.precio_actual_unidad || ''}" placeholder="0" />
            </div>
            <button id="inv-actualizar-precio" style="width:100%;margin-top:8px;">Guardar precio</button>
            ${inv.coingecko_id ? `<button id="inv-traer-precio" style="width:100%;margin-top:6px;"><i class="ti ti-download" aria-hidden="true"></i> Traer precio de CoinGecko</button>
            <p id="inv-precio-error" class="muted" style="display:none;color:var(--danger-text);font-size:12px;margin:6px 0 0;"></p>` : ''}
          ` : `
            <div class="field" style="margin-bottom:0;">
              <label>Valor actual (manual)${esUSD ? ' (USD)' : ''}</label>
              <input type="text" inputmode="decimal" id="inv-actual-manual" value="${inv.valor_actual || ''}" />
            </div>
            <button id="inv-actualizar-manual" style="width:100%;margin-top:8px;">Actualizar valor</button>
          `}
        </div>

        ${compras.length > 0 ? `
          <p class="label" style="margin-bottom:6px;">Historial de compras (DCA)</p>
          ${compras.map((c) => `
            <div class="list-item" data-editar-compra="${c.id}" style="cursor:pointer;">
              <div class="icon-badge neutral" style="width:26px;height:26px;"><i class="ti ti-shopping-cart" style="font-size:13px;" aria-hidden="true"></i></div>
              <div style="flex:1;min-width:0;">
                <p style="font-size:13px;margin:0;">${c.fecha}</p>
                <p class="muted" style="margin:0;font-size:11px;">
                  ${c.cantidad ? fmtCantidad(c.cantidad) + ' u.' : ''}${c.cantidad && c.precio_unidad ? ' × ' : ''}${c.precio_unidad ? fmtMoneda(c.precio_unidad, mon, esUSD ? 2 : 0) : ''}
                </p>
              </div>
              <span style="font-size:13px;font-weight:500;margin-right:6px;">${fmtMoneda(c.monto_invertido, mon)}</span>
              <i class="ti ti-pencil" style="color:var(--text-secondary);font-size:15px;" aria-hidden="true"></i>
            </div>
          `).join('')}
          <div style="height:10px;"></div>
        ` : '<p class="muted" style="margin-bottom:10px;">Aún no tienes compras registradas. Si haces DCA (compras periódicas), regístralas aquí y el promedio se calcula solo.</p>'}

        <p class="label" style="margin-bottom:6px;">Registrar una compra</p>
        <div class="field">
          <label>Cantidad comprada</label>
          <input type="text" inputmode="decimal" id="compra-cantidad" placeholder="Ej: 0.0045" />
        </div>
        <div class="field">
          <label>Precio por unidad${esUSD ? ' (USD)' : ''}</label>
          <input type="text" inputmode="decimal" id="compra-precio" placeholder="Ej: 62000" />
        </div>
        <div class="field">
          <label>Total invertido <span class="muted">(se calcula solo)</span></label>
          <input type="text" inputmode="decimal" id="compra-monto" placeholder="0" />
        </div>
        <div class="field">
          <input type="date" id="compra-fecha" value="${new Date().toISOString().slice(0, 10)}" />
        </div>
        <button class="primary" id="compra-guardar" style="width:100%;margin-bottom:8px;">Agregar compra</button>
        <button id="inv-eliminar" style="width:100%;color:var(--danger-text);">Eliminar inversión</button>
      </div>
    `;

    overlay.querySelector('#modal-close').addEventListener('click', () => overlay.remove());

    // Cantidad × precio = total, calculado en vivo mientras escribes.
    const inCant = overlay.querySelector('#compra-cantidad');
    const inPrecio = overlay.querySelector('#compra-precio');
    const inMonto = overlay.querySelector('#compra-monto');
    function recalcTotal() {
      const c = numeroDecimal(inCant.value);
      const p = numeroDecimal(inPrecio.value);
      if (c > 0 && p > 0) inMonto.value = String(Number((c * p).toFixed(esUSD ? 2 : 0)));
    }
    inCant.addEventListener('input', recalcTotal);
    inPrecio.addEventListener('input', recalcTotal);

    // Traer precio desde CoinGecko para este activo
    const btnTraer = overlay.querySelector('#inv-traer-precio');
    if (btnTraer) btnTraer.addEventListener('click', async () => {
      const errEl = overlay.querySelector('#inv-precio-error');
      if (errEl) errEl.style.display = 'none';
      btnTraer.disabled = true;
      const textoOriginal = btnTraer.innerHTML;
      btnTraer.textContent = 'Consultando...';
      try {
        const mapa = await precios.obtenerPreciosCripto([inv.coingecko_id], mon.toLowerCase());
        const precio = mapa[inv.coingecko_id];
        if (typeof precio !== 'number') throw new Error('No se encontró "' + inv.coingecko_id + '" en CoinGecko');
        domain.actualizarPrecioUnidad(inv.id, precio, new Date().toISOString());
        renderContenido();
        render();
      } catch (e) {
        btnTraer.disabled = false;
        btnTraer.innerHTML = textoOriginal;
        if (errEl) { errEl.textContent = precios.mensajeDeError(e); errEl.style.display = 'block'; }
      }
    });

    overlay.querySelector('#inv-usa-precio').addEventListener('change', (e) => {
      domain.configurarPrecioUnidad(inv.id, {
        usaPrecioUnidad: e.target.checked,
        precioActualUnidad: inv.precio_actual_unidad,
      });
      renderContenido();
      render();
    });

    const precioInput = overlay.querySelector('#inv-precio-unidad');
    const btnActualizarPrecio = overlay.querySelector('#inv-actualizar-precio');
    if (btnActualizarPrecio) btnActualizarPrecio.addEventListener('click', () => {
      const precio = numeroDecimal(precioInput.value);
      domain.actualizarPrecioUnidad(inv.id, precio, new Date().toISOString());
      renderContenido();
      render();
    });

    const manualInput = overlay.querySelector('#inv-actual-manual');
    const btnActualizarManual = overlay.querySelector('#inv-actualizar-manual');
    if (btnActualizarManual) btnActualizarManual.addEventListener('click', () => {
      const nuevoValor = numeroDecimal(manualInput.value);
      domain.actualizarInversion(inv.id, { nombre: inv.nombre, tipo: inv.tipo, valorInvertido: inv.valor_invertido, valorActual: nuevoValor, moneda: inv.moneda });
      renderContenido();
      render();
    });

    overlay.querySelectorAll('[data-editar-compra]').forEach((row) => {
      row.addEventListener('click', () => {
        const compra = domain.obtenerCompraInversion(Number(row.dataset.editarCompra));
        if (compra) openModalEditarCompra(compra, inv, () => { renderContenido(); render(); });
      });
    });

    overlay.querySelector('#compra-guardar').addEventListener('click', () => {
      const cantidad = numeroDecimal(overlay.querySelector('#compra-cantidad').value);
      const precioUnidad = numeroDecimal(overlay.querySelector('#compra-precio').value);
      const monto = numeroDecimal(overlay.querySelector('#compra-monto').value);
      const fecha = overlay.querySelector('#compra-fecha').value;
      // Basta con cantidad+precio, o con el monto total.
      if ((!cantidad || !precioUnidad) && !monto) {
        alert('Escribe cantidad y precio por unidad, o al menos el total invertido.');
        return;
      }
      domain.agregarCompraInversion(inv.id, {
        fecha,
        montoInvertido: monto || null,
        cantidad: cantidad || null,
        precioUnidad: precioUnidad || null,
      });
      renderContenido();
      render();
    });

    overlay.querySelector('#inv-eliminar').addEventListener('click', () => {
      if (!confirm(`¿Eliminar "${inv.nombre}" y todo su historial de compras?`)) return;
      domain.eliminarInversion(inv.id);
      overlay.remove();
      render();
    });
  }

  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  renderContenido();
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
      <div class="row" style="gap:4px;">
        <button class="icon-btn" id="btn-simular-credito" aria-label="Simular crédito"><i class="ti ti-calculator" aria-hidden="true"></i></button>
        <button class="icon-btn" id="btn-add-deuda" aria-label="Agregar deuda"><i class="ti ti-plus" aria-hidden="true"></i></button>
      </div>
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

  const btnSimularCredito = document.getElementById('btn-simular-credito');
  if (btnSimularCredito) btnSimularCredito.addEventListener('click', () => openModalSimuladorCredito());
}

function openModalSimuladorCredito() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  let resultado = null;

  function render() {
    overlay.innerHTML = `
      <div class="modal-sheet">
        <div class="row-between" style="margin-bottom:14px;">
          <h2 style="margin:0;">Simular crédito</h2>
          <button class="icon-btn" id="modal-close" aria-label="Cerrar"><i class="ti ti-x" aria-hidden="true"></i></button>
        </div>

        <div class="field">
          <label>Monto del crédito</label>
          <input type="text" inputmode="numeric" id="sc-monto" placeholder="0" />
        </div>
        <div class="field">
          <label>Tasa de interés</label>
          <div class="row" style="gap:8px;">
            <input type="number" id="sc-tasa" placeholder="Ej: 1.5" step="0.01" style="flex:1;" />
            <select id="sc-tasa-tipo" style="flex:1;">
              <option value="mensual">% mensual</option>
              <option value="anual">% anual (÷12)</option>
            </select>
          </div>
        </div>
        <div class="field">
          <label>Plazo (número de cuotas)</label>
          <input type="number" id="sc-plazo" placeholder="Ej: 12" min="1" max="360" />
        </div>
        <button class="primary" id="sc-calcular" style="width:100%;margin-bottom:8px;">Calcular</button>

        ${resultado ? `
          <div style="border-top:0.5px solid var(--border);padding-top:14px;margin-top:6px;">
            <div class="row-between" style="font-size:13px;margin-bottom:4px;">
              <span class="muted">Cuota mensual</span><span style="font-weight:500;">${fmt(resultado.cuotaMensual)}</span>
            </div>
            <div class="row-between" style="font-size:13px;margin-bottom:4px;">
              <span class="muted">Total intereses</span><span style="font-weight:500;" class="neg">${fmt(resultado.totalIntereses)}</span>
            </div>
            <div class="row-between" style="font-size:13px;margin-bottom:14px;">
              <span class="muted">Total pagado</span><span style="font-weight:500;">${fmt(resultado.totalPagado)}</span>
            </div>

            <p class="label" style="margin-bottom:6px;">Tabla de amortización</p>
            <div style="max-height:220px;overflow-y:auto;border:0.5px solid var(--border);border-radius:var(--radius);">
              ${resultado.filas.map((f) => `
                <div class="list-item" style="padding:8px 10px;">
                  <div style="flex:1;">
                    <p style="font-size:12px;margin:0;">Cuota ${f.numero}</p>
                    <p class="muted" style="margin:0;font-size:11px;">Interés ${fmt(f.interes)} · Abono ${fmt(f.abonoCapital)}</p>
                  </div>
                  <div style="text-align:right;">
                    <p style="font-size:12px;font-weight:500;margin:0;">${fmt(f.cuota)}</p>
                    <p class="muted" style="margin:0;font-size:11px;">Saldo ${fmt(f.saldoFinal)}</p>
                  </div>
                </div>
              `).join('')}
            </div>

            <div class="field" style="margin-top:14px;">
              <label>Nombre para guardarlo como deuda</label>
              <input type="text" id="sc-nombre-deuda" placeholder="Ej: Crédito vehículo" />
            </div>
            <div class="field" style="display:flex;align-items:center;gap:8px;">
              <input type="checkbox" id="sc-crear-pago-fijo" checked style="width:auto;height:auto;" />
              <label for="sc-crear-pago-fijo" style="margin:0;font-size:13px;">Crear también un pago fijo mensual para la cuota</label>
            </div>
            <button class="primary" id="sc-guardar-deuda" style="width:100%;">Guardar como deuda</button>
          </div>
        ` : ''}
      </div>
    `;

    activarSeparadorMiles(overlay.querySelector('#sc-monto'));
    overlay.querySelector('#modal-close').addEventListener('click', () => overlay.remove());
    overlay.querySelector('#sc-calcular').addEventListener('click', () => {
      const monto = valorMiles(overlay.querySelector('#sc-monto'));
      const tasaIngresada = Number(overlay.querySelector('#sc-tasa').value) || 0;
      const tipoTasa = overlay.querySelector('#sc-tasa-tipo').value;
      const plazoMeses = Number(overlay.querySelector('#sc-plazo').value) || 0;
      if (monto <= 0 || tasaIngresada < 0 || plazoMeses <= 0) return;
      const tasaMensualPct = tipoTasa === 'anual' ? tasaIngresada / 12 : tasaIngresada;
      resultado = domain.simularAmortizacion({ monto, tasaMensualPct, plazoMeses });
      resultado.montoOriginal = monto;
      render();
    });

    const btnGuardarDeuda = overlay.querySelector('#sc-guardar-deuda');
    if (btnGuardarDeuda) btnGuardarDeuda.addEventListener('click', () => {
      const nombre = overlay.querySelector('#sc-nombre-deuda').value.trim();
      if (!nombre) { overlay.querySelector('#sc-nombre-deuda').focus(); return; }
      const deudaId = domain.agregarDeuda({ nombre, valor: resultado.montoOriginal });
      if (overlay.querySelector('#sc-crear-pago-fijo').checked) {
        const catDeudas = domain.categorias('gasto').find((c) => c.nombre === 'Deudas');
        domain.agregarPagoFijo({
          nombre: `Cuota ${nombre}`,
          montoEsperado: Math.round(resultado.cuotaMensual),
          categoriaId: catDeudas ? catDeudas.id : null,
          diaEsperado: null,
          deudaId,
        });
      }
      overlay.remove();
      window.navigate('patrimonio');
    });
  }

  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  render();
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
        <input type="text" inputmode="numeric" id="bien-valor" placeholder="0" value="${esEdicion ? formatearMiles(bienExistente.valor) : ''}" />
      </div>
      <button class="primary" id="bien-guardar" style="width:100%;margin-bottom:8px;">Guardar</button>
      ${esEdicion ? '<button id="bien-eliminar" style="width:100%;color:var(--danger-text);">Eliminar</button>' : ''}
    </div>
  `;
  document.body.appendChild(overlay);
  activarSeparadorMiles(overlay.querySelector('#bien-valor'));
  overlay.querySelector('#modal-close').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('#bien-guardar').addEventListener('click', () => {
    const nombre = overlay.querySelector('#bien-nombre').value.trim();
    if (!nombre) { overlay.querySelector('#bien-nombre').focus(); return; }
    const valor = valorMiles(overlay.querySelector('#bien-valor'));
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
        <input type="text" inputmode="numeric" id="deuda-valor" placeholder="0" value="${esEdicion ? formatearMiles(deudaExistente.valor) : ''}" />
      </div>
      <button class="primary" id="deuda-guardar" style="width:100%;margin-bottom:8px;">Guardar</button>
      ${esEdicion ? '<button id="deuda-eliminar" style="width:100%;color:var(--danger-text);">Eliminar</button>' : ''}
    </div>
  `;
  document.body.appendChild(overlay);
  activarSeparadorMiles(overlay.querySelector('#deuda-valor'));
  overlay.querySelector('#modal-close').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('#deuda-guardar').addEventListener('click', () => {
    const nombre = overlay.querySelector('#deuda-nombre').value.trim();
    if (!nombre) { overlay.querySelector('#deuda-nombre').focus(); return; }
    const valor = valorMiles(overlay.querySelector('#deuda-valor'));
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
        renderIngresosFijosAjustesAgrupados(ingresosFijos)}
    </div>

    <div class="row-between">
      <h2 style="margin-bottom:0;">Pagos fijos mensuales</h2>
      <button class="icon-btn" id="btn-add-pago-fijo-ajustes" aria-label="Agregar pago fijo"><i class="ti ti-plus" aria-hidden="true"></i></button>
    </div>
    <div class="card">
      ${pagosFijos.length === 0 ? emptyState('ti-calendar-due', 'No has definido pagos fijos todavía') :
        renderPagosFijosAjustesAgrupados(pagosFijos)}
    </div>

    <div class="row-between">
      <h2 style="margin-bottom:0;">Categorías</h2>
      <button class="icon-btn" id="btn-add-categoria" aria-label="Agregar categoría"><i class="ti ti-plus" aria-hidden="true"></i></button>
    </div>
    <div class="card">
      <p class="muted" style="margin-bottom:10px;">Organiza tus gastos e ingresos a tu manera. Toca una para editarla.</p>
      ${renderCategoriasAgrupadas()}
    </div>

    <h2>Seguridad</h2>
    <div class="card">
      ${securityConfigCache ? `
        <p class="row" style="gap:6px;color:var(--success-text);margin-bottom:12px;"><i class="ti ti-shield-check" aria-hidden="true"></i> Tus datos están cifrados en este dispositivo</p>
        <div style="display:flex;flex-direction:column;gap:8px;">
          <button id="btn-bloquear-ahora"><i class="ti ti-lock" aria-hidden="true"></i> Bloquear ahora</button>
          <button id="btn-cambiar-pin"><i class="ti ti-key" aria-hidden="true"></i> Cambiar PIN</button>
          ${securityConfigCache.biometria
            ? '<button id="btn-quitar-faceid"><i class="ti ti-face-id" aria-hidden="true"></i> Desactivar Face ID / Touch ID</button>'
            : '<button id="btn-activar-faceid-ajustes"><i class="ti ti-face-id" aria-hidden="true"></i> Activar Face ID / Touch ID</button>'}
          <button id="btn-desactivar-seguridad" style="color:var(--danger-text);"><i class="ti ti-shield-off" aria-hidden="true"></i> Desactivar seguridad</button>
        </div>
      ` : `
        <p class="muted" style="margin-bottom:12px;">Tu app no tiene PIN ni cifrado activado. Cualquiera que abra tu teléfono puede ver tu información financiera.</p>
        <button class="primary" id="btn-activar-seguridad" style="width:100%;">Activar seguridad</button>
      `}
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

  const btnAddCategoria = document.getElementById('btn-add-categoria');
  if (btnAddCategoria) btnAddCategoria.addEventListener('click', () => openModalCategoria());
  document.querySelectorAll('[data-categoria-row]').forEach((row) => {
    row.addEventListener('click', () => openModalCategoria(Number(row.dataset.categoriaRow)));
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

  const btnActivarSeguridad = document.getElementById('btn-activar-seguridad');
  if (btnActivarSeguridad) btnActivarSeguridad.addEventListener('click', () => {
    asistenteSeguridad((configurado) => {
      if (configurado) {
        setConfig('seguridad_omitida', '0');
        actualizarCacheSeguridad().then(() => { activarAutoBloqueo(); render(); });
      } else {
        render();
      }
    });
  });

  const btnBloquearAhora = document.getElementById('btn-bloquear-ahora');
  if (btnBloquearAhora) btnBloquearAhora.addEventListener('click', () => {
    olvidarLlaveMaestra();
    bloquearApp();
  });

  const btnCambiarPin = document.getElementById('btn-cambiar-pin');
  if (btnCambiarPin) btnCambiarPin.addEventListener('click', () => abrirModalCambiarPin());

  const btnActivarFaceIdAjustes = document.getElementById('btn-activar-faceid-ajustes');
  if (btnActivarFaceIdAjustes) btnActivarFaceIdAjustes.addEventListener('click', () => activarFaceIdDesdeAjustes());

  const btnQuitarFaceId = document.getElementById('btn-quitar-faceid');
  if (btnQuitarFaceId) btnQuitarFaceId.addEventListener('click', async () => {
    const config = await loadSecurityConfig();
    config.biometria = null;
    await saveSecurityConfig(config);
    await security.olvidarLlaveDispositivo();
    await actualizarCacheSeguridad();
    render();
  });

  const btnDesactivarSeguridad = document.getElementById('btn-desactivar-seguridad');
  if (btnDesactivarSeguridad) btnDesactivarSeguridad.addEventListener('click', async () => {
    if (!confirm('Tus datos van a quedar sin cifrar en este dispositivo. ¿Seguro que quieres desactivar la seguridad?')) return;
    await desactivarCifradoYGuardarPlano();
    await clearSecurityConfig();
    securityConfigCache = null;
    render();
  });
}

async function actualizarCacheSeguridad() {
  securityConfigCache = await loadSecurityConfig();
}

function abrirModalCambiarPin() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-sheet">
      <div class="row-between" style="margin-bottom:14px;">
        <h2 style="margin:0;">Cambiar PIN</h2>
        <button class="icon-btn" id="modal-close" aria-label="Cerrar"><i class="ti ti-x" aria-hidden="true"></i></button>
      </div>
      <div class="field">
        <label>PIN actual</label>
        <input type="tel" inputmode="numeric" pattern="[0-9]*" id="pin-actual" maxlength="6" style="font-size:20px;text-align:center;letter-spacing:6px;" />
      </div>
      <div class="field">
        <label>PIN nuevo</label>
        <input type="tel" inputmode="numeric" pattern="[0-9]*" id="pin-nuevo3" maxlength="6" style="font-size:20px;text-align:center;letter-spacing:6px;" />
      </div>
      <p class="muted" id="cambiar-pin-error" style="display:none;color:var(--danger-text);margin-bottom:8px;"></p>
      <button class="primary" id="btn-guardar-pin-cambio" style="width:100%;">Guardar</button>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector('#modal-close').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('#btn-guardar-pin-cambio').addEventListener('click', async () => {
    const actual = overlay.querySelector('#pin-actual').value.trim();
    const nuevo = overlay.querySelector('#pin-nuevo3').value.trim();
    const errorEl = overlay.querySelector('#cambiar-pin-error');
    if (!security.pinTieneFormatoValido(nuevo)) {
      errorEl.textContent = 'El PIN nuevo debe tener entre 4 y 6 números.';
      errorEl.style.display = 'block';
      return;
    }
    const config = await loadSecurityConfig();
    const llave = await security.desenvolverLlave(config.envueltaPin, actual);
    if (!llave) {
      errorEl.textContent = 'El PIN actual no es correcto.';
      errorEl.style.display = 'block';
      return;
    }
    config.envueltaPin = await security.envolverLlave(llave, nuevo);
    await saveSecurityConfig(config);
    overlay.remove();
  });
}

async function activarFaceIdDesdeAjustes() {
  const disponible = await security.biometriaDisponible();
  if (!disponible) {
    alert('Face ID / Touch ID no está disponible en este dispositivo o navegador.');
    return;
  }
  const config = await loadSecurityConfig();
  const pin = prompt('Escribe tu PIN para activar Face ID / Touch ID');
  if (!pin) return;
  const llave = await security.desenvolverLlave(config.envueltaPin, pin);
  if (!llave) { alert('PIN incorrecto.'); return; }

  const credId = await security.registrarBiometria('konta-usuario');
  if (!credId) { alert('No se pudo registrar Face ID. Intenta de nuevo.'); return; }
  try {
    // La llave que desenvuelve queda como CryptoKey no exportable en
    // IndexedDB; en config solo guardamos la envoltura (iv + wrapped).
    const envoltura = await security.envolverLlaveConDispositivo(llave);
    config.biometria = {
      credentialId: credId,
      iv: envoltura.iv,
      wrapped: envoltura.wrapped,
    };
    await saveSecurityConfig(config);
    await actualizarCacheSeguridad();
    alert('Face ID / Touch ID activado. Tu PIN sigue funcionando como respaldo.');
  } catch (e) {
    alert('No se pudo activar Face ID: ' + (e.message || e));
  }
  render();
}

// ---------- Seguridad: configuración inicial, bloqueo y desbloqueo ----------

let minutosParaBloqueo = 5;
let momentoOcultado = null;
let appBloqueada = false;
let securityConfigCache = null; // copia en memoria para poder leerla sin await en render()

function screenShell(contenidoHtml) {
  app.style.paddingBottom = '0';
  app.innerHTML = `<div class="screen-shell">${contenidoHtml}</div>`;
}

// --- Asistente de configuración (primera vez) ---

function asistenteSeguridad(onTerminado) {
  let paso = 'intro';
  let pinTemp = '';
  let fraseTemp = '';
  let masterKeyTemp = null;

  function render() {
    if (paso === 'intro') {
      screenShell(`
        <div class="card">
          <h1 style="margin-top:0;">Protege tu información</h1>
          <p class="muted" style="margin-bottom:16px;">Vamos a pedirte un PIN para abrir la app, y tus datos van a quedar cifrados en este dispositivo — así, si alguien más tiene tu teléfono, no puede ver tu información financiera.</p>
          <button class="primary" id="btn-continuar" style="width:100%;margin-bottom:8px;">Configurar ahora</button>
          <button id="btn-omitir" style="width:100%;">Omitir por ahora</button>
        </div>
      `);
      document.getElementById('btn-continuar').addEventListener('click', () => { paso = 'crear-pin'; render(); });
      document.getElementById('btn-omitir').addEventListener('click', () => onTerminado(false));
    }

    else if (paso === 'crear-pin') {
      screenShell(`
        <div class="card">
          <h1 style="margin-top:0;">Crea tu PIN</h1>
          <p class="muted" style="margin-bottom:16px;">Entre 4 y 6 números. Tienes que recordarlo — es la llave de tus datos.</p>
          <div class="field">
            <input type="tel" inputmode="numeric" pattern="[0-9]*" id="pin-nuevo" placeholder="••••" maxlength="6" style="font-size:24px;text-align:center;letter-spacing:8px;" />
          </div>
          <p class="muted" id="pin-error" style="display:none;color:var(--danger-text);margin-bottom:12px;">El PIN debe tener entre 4 y 6 números.</p>
          <button class="primary" id="btn-siguiente" style="width:100%;">Siguiente</button>
        </div>
      `);
      const input = document.getElementById('pin-nuevo');
      input.focus();
      document.getElementById('btn-siguiente').addEventListener('click', () => {
        const valor = input.value.trim();
        if (!security.pinTieneFormatoValido(valor)) {
          document.getElementById('pin-error').style.display = 'block';
          return;
        }
        pinTemp = valor;
        paso = 'confirmar-pin';
        render();
      });
    }

    else if (paso === 'confirmar-pin') {
      screenShell(`
        <div class="card">
          <h1 style="margin-top:0;">Confírmalo</h1>
          <p class="muted" style="margin-bottom:16px;">Escribe el mismo PIN otra vez.</p>
          <div class="field">
            <input type="tel" inputmode="numeric" pattern="[0-9]*" id="pin-confirmar" placeholder="••••" maxlength="6" style="font-size:24px;text-align:center;letter-spacing:8px;" />
          </div>
          <p class="muted" id="pin-error" style="display:none;color:var(--danger-text);margin-bottom:12px;">No coincide. Intenta otra vez.</p>
          <button class="primary" id="btn-siguiente" style="width:100%;">Siguiente</button>
        </div>
      `);
      const input = document.getElementById('pin-confirmar');
      input.focus();
      document.getElementById('btn-siguiente').addEventListener('click', () => {
        if (input.value.trim() !== pinTemp) {
          document.getElementById('pin-error').style.display = 'block';
          return;
        }
        fraseTemp = security.generarFraseRecuperacion();
        paso = 'frase-recuperacion';
        render();
      });
    }

    else if (paso === 'frase-recuperacion') {
      screenShell(`
        <div class="card">
          <h1 style="margin-top:0;">Tu frase de recuperación</h1>
          <p class="muted" style="margin-bottom:16px;">Si algún día olvidas tu PIN, esta es la única forma de recuperar tus datos. Anótala en un lugar seguro — no la guardamos en ningún servidor, así que si la pierdes junto con el PIN, no hay forma de recuperar tu información.</p>
          <div class="metric-card" style="text-align:center;margin-bottom:16px;">
            <p style="font-family:monospace;font-size:18px;font-weight:600;letter-spacing:1px;margin:0;">${fraseTemp}</p>
          </div>
          <div class="field" style="display:flex;align-items:center;gap:8px;">
            <input type="checkbox" id="check-guardada" style="width:auto;height:auto;" />
            <label for="check-guardada" style="margin:0;font-size:13px;">Ya la anoté en un lugar seguro</label>
          </div>
          <button class="primary" id="btn-siguiente" style="width:100%;margin-top:12px;" disabled>Siguiente</button>
        </div>
      `);
      const check = document.getElementById('check-guardada');
      const btn = document.getElementById('btn-siguiente');
      check.addEventListener('change', () => { btn.disabled = !check.checked; });
      btn.addEventListener('click', async () => {
        paso = 'guardando';
        render();
        masterKeyTemp = await security.generarLlaveMaestra();
        const envueltaPin = await security.envolverLlave(masterKeyTemp, pinTemp);
        const envueltaFrase = await security.envolverLlave(masterKeyTemp, fraseTemp);
        await saveSecurityConfig({ envueltaPin, envueltaFrase, biometria: null, timeoutMin: 5 });
        establecerLlaveMaestra(masterKeyTemp);
        await persistInmediato();
        const disponibleBiometria = await security.biometriaDisponible();
        paso = disponibleBiometria ? 'face-id' : 'listo';
        render();
      });
    }

    else if (paso === 'guardando') {
      screenShell(`<p class="muted" style="text-align:center;">Cifrando tus datos…</p>`);
    }

    else if (paso === 'face-id') {
      screenShell(`
        <div class="card">
          <h1 style="margin-top:0;">¿Desbloqueo rápido?</h1>
          <p class="muted" style="margin-bottom:16px;">Puedes usar Face ID o Touch ID para no escribir el PIN cada vez. Tu PIN sigue siendo la protección real de tus datos — esto es solo un atajo.</p>
          <button class="primary" id="btn-activar-faceid" style="width:100%;margin-bottom:8px;">Activar Face ID / Touch ID</button>
          <button id="btn-saltar-faceid" style="width:100%;">Prefiero solo el PIN</button>
        </div>
      `);
      document.getElementById('btn-activar-faceid').addEventListener('click', async () => {
        const btn = document.getElementById('btn-activar-faceid');
        btn.disabled = true;
        try {
          const credId = await security.registrarBiometria('konta-usuario');
          if (credId) {
            // Guardamos SOLO la envoltura (iv + wrapped). La llave que
            // desenvuelve queda como CryptoKey no exportable en IndexedDB,
            // nunca en texto plano.
            const envoltura = await security.envolverLlaveConDispositivo(masterKeyTemp);
            const config = await loadSecurityConfig();
            config.biometria = {
              credentialId: credId,
              iv: envoltura.iv,
              wrapped: envoltura.wrapped,
            };
            await saveSecurityConfig(config);
          }
        } catch (e) {
          alert('No se pudo activar Face ID. Podrás activarlo luego desde Configuración. Tu PIN sigue funcionando.');
        }
        paso = 'listo';
        render();
      });
      document.getElementById('btn-saltar-faceid').addEventListener('click', () => { paso = 'listo'; render(); });
    }

    else if (paso === 'listo') {
      screenShell(`
        <div class="card" style="text-align:center;">
          <i class="ti ti-shield-check" style="font-size:40px;color:var(--success-text);" aria-hidden="true"></i>
          <h1>Listo</h1>
          <p class="muted" style="margin-bottom:16px;">Tus datos ya están protegidos.</p>
          <button class="primary" id="btn-empezar" style="width:100%;">Empezar a usar Konta</button>
        </div>
      `);
      document.getElementById('btn-empezar').addEventListener('click', () => onTerminado(true));
    }
  }

  render();
}

// --- Pantalla de bloqueo (cada vez que se abre o vuelve del segundo plano) ---

function pantallaBloqueo(onDesbloqueado) {
  let modo = 'pin';

  async function intentarBiometria(config) {
    if (!config.biometria) return;
    const btnBio = document.getElementById('btn-usar-biometria');
    const errEl = document.getElementById('bio-error');
    if (btnBio) { btnBio.disabled = true; btnBio.style.opacity = '0.6'; }
    const resultado = await security.verificarBiometria(config.biometria.credentialId);
    if (btnBio) { btnBio.disabled = false; btnBio.style.opacity = '1'; }

    if (resultado !== true) {
      // Face ID no verificó: mostramos por qué en vez de fallar en silencio.
      const nombre = resultado && resultado.error ? resultado.error : '';
      let msg = 'No se pudo usar Face ID. Ingresa tu PIN.';
      if (nombre === 'NotAllowedError') msg = 'Face ID cancelado o sin permiso. Ingresa tu PIN.';
      else if (nombre === 'InvalidStateError') msg = 'Este dispositivo no reconoce el registro. Reactiva Face ID desde Configuración.';
      else if (nombre === 'SecurityError') msg = 'Face ID no disponible en este contexto. Ingresa tu PIN.';
      if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; }
      return;
    }

    // Face ID verificó: ahora sí desenvolvemos con la llave de dispositivo
    // no exportable guardada en IndexedDB.
    const masterKey = await security.desenvolverLlaveConDispositivo(config.biometria);
    if (!masterKey) {
      if (errEl) {
        errEl.textContent = 'No se encontró la llave de este dispositivo. Entra con tu PIN y reactiva Face ID.';
        errEl.style.display = 'block';
      }
      return;
    }
    onDesbloqueado(masterKey);
  }

  function fromBase64Local(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  async function render() {
    const config = await loadSecurityConfig();

    if (modo === 'pin') {
      screenShell(`
        <div class="card" style="text-align:center;">
          <i class="ti ti-lock" style="font-size:32px;color:var(--text-secondary);" aria-hidden="true"></i>
          <h1>Konta está bloqueada</h1>
          <div class="field">
            <input type="tel" inputmode="numeric" pattern="[0-9]*" id="pin-desbloqueo" placeholder="PIN" maxlength="6" style="font-size:24px;text-align:center;letter-spacing:8px;" />
          </div>
          <p class="muted" id="pin-desbloqueo-error" style="display:none;color:var(--danger-text);margin-bottom:8px;">PIN incorrecto.</p>
          ${config.biometria ? '<p id="bio-error" class="muted" style="display:none;color:var(--danger-text);font-size:12px;margin-bottom:8px;"></p><button class="primary" id="btn-usar-biometria" style="width:100%;margin-bottom:10px;"><i class="ti ti-face-id" aria-hidden="true"></i> Usar Face ID / Touch ID</button>' : ''}
          <button class="${config.biometria ? '' : 'primary'}" id="btn-desbloquear" style="width:100%;margin-bottom:10px;">Desbloquear con PIN</button>
          <button id="btn-olvide-pin" style="width:100%;border:none;background:none;color:var(--text-secondary);font-size:12px;">¿Olvidaste tu PIN?</button>
        </div>
      `);
      const input = document.getElementById('pin-desbloqueo');
      input.focus();

      async function intentarPin() {
        const pin = input.value.trim();
        const llave = await security.desenvolverLlave(config.envueltaPin, pin);
        if (!llave) {
          document.getElementById('pin-desbloqueo-error').style.display = 'block';
          input.value = '';
          input.focus();
          return;
        }
        onDesbloqueado(llave);
      }
      document.getElementById('btn-desbloquear').addEventListener('click', intentarPin);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') intentarPin(); });
      const btnBio = document.getElementById('btn-usar-biometria');
      if (btnBio) btnBio.addEventListener('click', () => intentarBiometria(config));
      document.getElementById('btn-olvide-pin').addEventListener('click', () => { modo = 'recuperar'; render(); });

      // NO disparamos Face ID automáticamente: iOS bloquea navigator.credentials.get()
      // si no viene de un gesto directo del usuario (un toque). Antes se llamaba
      // aquí al renderizar y por eso Face ID "no hacía nada" en el iPhone.
      // Ahora el usuario toca el botón de arriba y ahí sí se dispara.
    }

    else if (modo === 'recuperar') {
      screenShell(`
        <div class="card">
          <h1 style="margin-top:0;">Recuperar acceso</h1>
          <p class="muted" style="margin-bottom:16px;">Escribe tu frase de recuperación exactamente como la guardaste.</p>
          <div class="field">
            <input type="text" id="frase-recuperacion" placeholder="XXXX-XXXX-XXXX-XXXX-XXXX" style="text-transform:uppercase;" />
          </div>
          <p class="muted" id="frase-error" style="display:none;color:var(--danger-text);margin-bottom:8px;">Esa frase no es correcta.</p>
          <button class="primary" id="btn-verificar-frase" style="width:100%;margin-bottom:10px;">Verificar</button>
          <button id="btn-volver-pin" style="width:100%;">Volver a intentar con el PIN</button>
        </div>
      `);
      document.getElementById('btn-volver-pin').addEventListener('click', () => { modo = 'pin'; render(); });
      document.getElementById('btn-verificar-frase').addEventListener('click', async () => {
        const frase = document.getElementById('frase-recuperacion').value.trim().toUpperCase();
        const llave = await security.desenvolverLlave(config.envueltaFrase, frase);
        if (!llave) {
          document.getElementById('frase-error').style.display = 'block';
          return;
        }
        modo = 'nuevo-pin';
        window.__llaveRecuperada = llave;
        render();
      });
    }

    else if (modo === 'nuevo-pin') {
      screenShell(`
        <div class="card">
          <h1 style="margin-top:0;">Crea un nuevo PIN</h1>
          <div class="field">
            <input type="tel" inputmode="numeric" pattern="[0-9]*" id="pin-nuevo2" placeholder="••••" maxlength="6" style="font-size:24px;text-align:center;letter-spacing:8px;" />
          </div>
          <button class="primary" id="btn-guardar-pin-nuevo" style="width:100%;">Guardar y continuar</button>
        </div>
      `);
      document.getElementById('btn-guardar-pin-nuevo').addEventListener('click', async () => {
        const nuevo = document.getElementById('pin-nuevo2').value.trim();
        if (!security.pinTieneFormatoValido(nuevo)) return;
        const llave = window.__llaveRecuperada;
        const envueltaPin = await security.envolverLlave(llave, nuevo);
        const config2 = await loadSecurityConfig();
        config2.envueltaPin = envueltaPin;
        await saveSecurityConfig(config2);
        delete window.__llaveRecuperada;
        onDesbloqueado(llave);
      });
    }
  }

  render();
}

let autoBloqueoActivo = false;

function activarAutoBloqueo() {
  if (autoBloqueoActivo) return;
  autoBloqueoActivo = true;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      momentoOcultado = Date.now();
    } else if (momentoOcultado && tieneLlaveMaestra()) {
      const minutos = (Date.now() - momentoOcultado) / 60000;
      if (minutos >= minutosParaBloqueo) {
        bloquearApp();
      }
    }
  });
}

function bloquearApp() {
  if (appBloqueada) return;
  appBloqueada = true;
  pantallaBloqueo((llave) => {
    establecerLlaveMaestra(llave);
    appBloqueada = false;
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
  app.style.paddingBottom = '0';
  app.innerHTML = '<div class="screen-shell"><p class="muted" style="text-align:center;">Cargando tus datos…</p></div>';
  render = renderWithScreenEvents;

  const estado = await prepararArranque();

  if (estado.tieneSeguridad) {
    securityConfigCache = estado.securityConfig;
    minutosParaBloqueo = Number(estado.securityConfig.timeoutMin) || 5;
    pantallaBloqueo(async (llave) => {
      const bytesPlanos = estado.bytesGuardados ? await descifrarBytes(llave, estado.bytesGuardados) : null;
      await abrirBaseDatos(bytesPlanos);
      establecerLlaveMaestra(llave);
      render();
      activarAutoBloqueo();
    });
  } else {
    await abrirBaseDatos(estado.bytesGuardados);
    const yaOmitido = getConfig('seguridad_omitida') === '1';
    if (yaOmitido) {
      render();
    } else {
      asistenteSeguridad(async (configurado) => {
        if (!configurado) {
          setConfig('seguridad_omitida', '1');
        } else {
          await actualizarCacheSeguridad();
          activarAutoBloqueo();
        }
        render();
      });
    }
  }
}

boot();
