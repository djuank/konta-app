// Módulo de seguridad.
//
// Cómo funciona (en resumen):
// - Hay una "llave maestra" (masterKey) generada al azar, que es la que
//   realmente cifra tus datos. Nunca se guarda en texto plano.
// - Esa llave maestra se guarda "envuelta" (cifrada) de DOS formas distintas:
//   una envuelta con una llave derivada de tu PIN, y otra envuelta con una
//   llave derivada de tu frase de recuperación. Cualquiera de las dos abre
//   la misma llave maestra.
// - Si el PIN o la frase no son correctos, el "desenvolver" falla solo
//   (AES-GCM detecta que la llave no coincide) — no hace falta guardar
//   el PIN en ningún lado para poder validarlo.
//
// Todo esto corre en el dispositivo, con la Web Crypto API nativa del
// navegador. Nada se envía a ningún servidor porque no existe ninguno.

const ITERACIONES_PBKDF2 = 250000;
const ALFABETO_LEGIBLE = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin 0/O/1/I/L para evitar confusión

function randomBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

export function generarFraseRecuperacion() {
  const bytes = randomBytes(20);
  let texto = '';
  for (let i = 0; i < bytes.length; i++) {
    texto += ALFABETO_LEGIBLE[bytes[i] % ALFABETO_LEGIBLE.length];
    if ((i + 1) % 4 === 0 && i !== bytes.length - 1) texto += '-';
  }
  return texto;
}

export function pinTieneFormatoValido(pin) {
  return /^\d{4,6}$/.test(pin);
}

function toBase64(bytes) {
  let binario = '';
  bytes.forEach((b) => { binario += String.fromCharCode(b); });
  return btoa(binario);
}

function fromBase64(b64) {
  const binario = atob(b64);
  const bytes = new Uint8Array(binario.length);
  for (let i = 0; i < binario.length; i++) bytes[i] = binario.charCodeAt(i);
  return bytes;
}

async function derivarLlaveDesdeSecreto(secreto, saltBytes) {
  const enc = new TextEncoder();
  const material = await crypto.subtle.importKey('raw', enc.encode(secreto), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: saltBytes, iterations: ITERACIONES_PBKDF2, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['wrapKey', 'unwrapKey']
  );
}

export async function generarLlaveMaestra() {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

// Envuelve (cifra) la llave maestra usando una llave derivada de un secreto
// (el PIN o la frase de recuperación). Devuelve algo seguro de guardar.
export async function envolverLlave(masterKey, secreto) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const wrappingKey = await derivarLlaveDesdeSecreto(secreto, salt);
  const wrapped = await crypto.subtle.wrapKey('raw', masterKey, wrappingKey, { name: 'AES-GCM', iv });
  return {
    salt: toBase64(salt),
    iv: toBase64(iv),
    wrapped: toBase64(new Uint8Array(wrapped)),
  };
}

// Intenta desenvolver la llave maestra con un secreto. Si el secreto es
// incorrecto, AES-GCM lanza un error solo — así detectamos "PIN incorrecto"
// sin tener que guardar el PIN en ningún lado.
export async function desenvolverLlave(envoltura, secreto) {
  const salt = fromBase64(envoltura.salt);
  const iv = fromBase64(envoltura.iv);
  const wrapped = fromBase64(envoltura.wrapped);
  const wrappingKey = await derivarLlaveDesdeSecreto(secreto, salt);
  try {
    return await crypto.subtle.unwrapKey(
      'raw', wrapped, wrappingKey, { name: 'AES-GCM', iv },
      { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']
    );
  } catch (e) {
    return null; // secreto incorrecto
  }
}

// Cifra bytes (el archivo de la base de datos) con la llave maestra.
export async function cifrarBytes(masterKey, bytes) {
  const iv = randomBytes(12);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, masterKey, bytes);
  // Guardamos todo junto: [12 bytes de iv][resto = contenido cifrado]
  const resultado = new Uint8Array(iv.length + ciphertext.byteLength);
  resultado.set(iv, 0);
  resultado.set(new Uint8Array(ciphertext), iv.length);
  return resultado;
}

export async function descifrarBytes(masterKey, bytesCifrados) {
  const iv = bytesCifrados.slice(0, 12);
  const ciphertext = bytesCifrados.slice(12);
  const plano = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, masterKey, ciphertext);
  return new Uint8Array(plano);
}

// --- Face ID / Touch ID (WebAuthn) como atajo rápido ---
// Importante y honesto: esto NO reemplaza al PIN como protección
// criptográfica. Es una conveniencia — evita escribir el PIN cada vez,
// pero técnicamente la llave de acceso rápido queda guardada en el
// dispositivo protegida solo por la verificación de Face ID/Touch ID de
// tu navegador, no por una llave derivada de un secreto que solo tú sabes.
// El PIN (o tu frase de recuperación) siguen siendo la única protección
// real si alguien logra extraer los datos crudos del dispositivo.

export async function biometriaDisponible() {
  if (!window.PublicKeyCredential) return false;
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch (e) {
    return false;
  }
}

// El rpId debe ser el dominio efectivo (sin puerto, sin esquema). Fijarlo
// explícitamente es clave en iOS: cuando la app corre como PWA en pantalla
// completa, si no se especifica rp.id la credencial se registra contra un
// contexto que luego no coincide al autenticar, y Face ID "no funciona".
// En localhost, WebAuthn permite 'localhost' como rpId.
function rpIdActual() {
  return window.location.hostname;
}

export async function registrarBiometria(nombreUsuario) {
  const challenge = randomBytes(32);
  const userId = randomBytes(16);
  const cred = await navigator.credentials.create({
    publicKey: {
      challenge,
      rp: { name: 'Konta', id: rpIdActual() },
      user: { id: userId, name: nombreUsuario, displayName: nombreUsuario },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        userVerification: 'required',
        residentKey: 'preferred',
      },
      timeout: 60000,
    },
  });
  return cred ? toBase64(new Uint8Array(cred.rawId)) : null;
}

export async function verificarBiometria(credentialIdB64) {
  const challenge = randomBytes(32);
  try {
    const cred = await navigator.credentials.get({
      publicKey: {
        challenge,
        rpId: rpIdActual(),
        allowCredentials: [{
          type: 'public-key',
          id: fromBase64(credentialIdB64),
          transports: ['internal'],
        }],
        userVerification: 'required',
        timeout: 60000,
      },
    });
    return !!cred;
  } catch (e) {
    // Devolvemos el error para poder mostrar un mensaje claro en la UI
    // en vez de fallar en silencio (que es lo que confundía antes).
    return { error: e.name || 'error', message: e.message || String(e) };
  }
}

// --- Almacén de la llave de dispositivo (no exportable) ---
// En vez de guardar en texto plano la llave que desenvuelve la maestra
// (el hueco de seguridad anterior), guardamos un CryptoKey NO exportable
// en IndexedDB. El navegador nunca deja leer sus bytes crudos: solo se
// puede usar para desenvolver, y en esta app solo tras verificar Face ID.
// Es lo máximo que permite una PWA de iPhone hoy.

const IDB_NAME = 'konta-keystore';
const IDB_STORE = 'keys';
const DEVICE_KEY_ID = 'device-wrapping-key';

function abrirKeystore() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function guardarDeviceKey(cryptoKey) {
  const db = await abrirKeystore();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(cryptoKey, DEVICE_KEY_ID);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

async function leerDeviceKey() {
  const db = await abrirKeystore();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(DEVICE_KEY_ID);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function borrarDeviceKey() {
  const db = await abrirKeystore();
  return new Promise((resolve) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(DEVICE_KEY_ID);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => resolve(false);
  });
}

// Activa el atajo biométrico: genera una llave de dispositivo NO exportable,
// la guarda en IndexedDB, y con ella envuelve la llave maestra. Devuelve solo
// los datos seguros de guardar en config (iv + wrapped), SIN la llave en claro.
export async function envolverLlaveConDispositivo(masterKey) {
  const deviceKey = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false, // NO exportable: el navegador nunca revela sus bytes
    ['wrapKey', 'unwrapKey']
  );
  await guardarDeviceKey(deviceKey);
  const iv = randomBytes(12);
  const wrapped = await crypto.subtle.wrapKey('raw', masterKey, deviceKey, { name: 'AES-GCM', iv });
  return {
    iv: toBase64(iv),
    wrapped: toBase64(new Uint8Array(wrapped)),
  };
}

// Desenvuelve la llave maestra usando la llave de dispositivo guardada.
// Solo debe llamarse DESPUÉS de que verificarBiometria haya tenido éxito.
export async function desenvolverLlaveConDispositivo(envoltura) {
  const deviceKey = await leerDeviceKey();
  if (!deviceKey) return null; // no hay llave de dispositivo (otro equipo, o se borró)
  const iv = fromBase64(envoltura.iv);
  const wrapped = fromBase64(envoltura.wrapped);
  try {
    return await crypto.subtle.unwrapKey(
      'raw', wrapped, deviceKey, { name: 'AES-GCM', iv },
      { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']
    );
  } catch (e) {
    return null;
  }
}

export async function olvidarLlaveDispositivo() {
  return borrarDeviceKey();
}
