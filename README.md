# Konta — tu app de finanzas personales

Todo funciona local: tus datos viven en tu dispositivo, no en un servidor de terceros. Puedes usarla en tu computador, o instalarla en tu iPhone como una app real.

## Usarla en tu iPhone (recomendado)

Google Drive no sirve para esto — Drive guarda archivos, pero no puede "ejecutar" la app. Necesitas subirla a un hosting gratis de archivos estáticos (son un par de minutos):

**Paso 1 — Sube la carpeta (elige una opción):**

- **Netlify Drop** (la más simple): entra a **https://app.netlify.com/drop** desde tu computador, arrastra la carpeta `konta-app` completa a la página, y en segundos te da una dirección web (algo como `konta-app-123.netlify.app`). Gratis, sin necesidad de saber programar.
- **GitHub Pages** (si ya usas GitHub): sube la carpeta a un repositorio y activa GitHub Pages en la configuración. Un poco más de pasos, pero es permanente y gratis también.

**Paso 2 — Ábrela en tu iPhone:**
1. Abre esa dirección web en Safari (tiene que ser Safari, no Chrome, para que funcione la instalación)
2. Toca el ícono de compartir (el cuadrado con la flecha hacia arriba)
3. Elige "Agregar a pantalla de inicio"
4. Listo — te queda un ícono como cualquier otra app. Ábrela desde ahí, no desde Safari, para que se sienta como app real (sin barra de navegador).

Una vez instalada así, la app funciona sin internet la mayoría de las veces (queda guardada en el teléfono), y abre en cualquier momento sin depender de que tu computador esté prendido.

**Nota sobre tus datos:** cada dispositivo (tu iPhone, tu computador) guarda su propia copia de los datos por separado — no se sincronizan solos entre sí. Usa los respaldos (`.sqlite`) de Ajustes para pasar tu información de un dispositivo a otro cuando lo necesites.

## Usarla en tu computador

Los navegadores no dejan abrir este tipo de apps con doble clic directo sobre `index.html`. Necesitas un mini-servidor local — toma 10 segundos:

**Si tienes Python instalado** (viene en Mac y la mayoría de Linux):
1. Abre una terminal dentro de esta carpeta (`konta-app`)
2. Ejecuta: `python3 -m http.server 8000`
3. Abre tu navegador en: `http://localhost:8000`

**Si tienes Node.js instalado:**
1. Abre una terminal dentro de esta carpeta
2. Ejecuta: `npx serve .`
3. Abre la URL que te muestre (normalmente `http://localhost:3000`)

## Dónde viven tus datos

Tus datos se guardan automáticamente en el dispositivo donde la uses. Si cambias de navegador, de computador, o quieres pasar tus datos al iPhone:

- **Ajustes → Descargar copia (.sqlite)**: el archivo completo de tu base de datos.
- **Ajustes → Descargar copia (.json)**: una copia legible de tus datos.
- **Ajustes → Restaurar copia (.sqlite)**: para cargar un respaldo en otro dispositivo.

## Qué incluye esta versión

- **Inicio**: tu efectivo disponible, presupuesto del mes (ingresos y gastos fijos), pagos fijos pendientes, últimos movimientos.
- **Movimientos**: registro y edición de gastos e ingresos por categoría y cuenta.
- **Cuentas**: tus cuentas con saldo calculado automáticamente.
- **Inversiones**: portafolio, distribución por tipo, rentabilidad, y tu camino hacia una meta de patrimonio.
- **Patrimonio**: desglose completo (efectivo + inversiones + bienes − deudas), con gestión de bienes y deudas.
- **Análisis**: filtro por semana/mes/año, en qué gastas más, de dónde ganas más, % de ingreso pasivo.
- **Ajustes**: ingresos y gastos fijos, reparto del sobrante, y respaldos.
- **Notificaciones**: consejos financieros basados en tus datos reales (campanita arriba).

## Estructura del proyecto

```
konta-app/
├── index.html
├── manifest.json      Hace la app instalable en el celular
├── service-worker.js  Permite que funcione sin internet
├── icons/              Íconos para la pantalla de inicio
├── css/styles.css
├── js/
│   ├── schema.js     Modelo de datos
│   ├── db.js         Motor de base de datos (SQLite en el navegador)
│   ├── domain.js     Cálculos financieros
│   ├── storage.js    Guardado local y respaldos
│   └── app.js        Interfaz y navegación
└── vendor/           Librerías incluidas — todo sin internet
```

