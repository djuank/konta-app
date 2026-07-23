// Módulo de precios en línea.
//
// Este es el ÚNICO archivo de la app que habla con internet. Todo lo demás
// funciona sin red: los precios se pueden escribir a mano y la app sigue
// completa. Si mañana estas APIs desaparecen, Konta no se rompe.
//
// Dos fuentes, ambas gratuitas y sin API key:
//   - CoinGecko: precio de criptomonedas (en la moneda que pidamos)
//   - datos.gov.co: TRM oficial certificada por la Superintendencia Financiera
//
// Ninguna de las dos recibe información tuya: solo se les pregunta
// "¿cuánto vale esto?". No se envía nada de tu base de datos.

const TIMEOUT_MS = 12000;

// fetch con tiempo límite, para que un servidor caído no deje la app colgada.
async function fetchConTimeout(url) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// --- CoinGecko: precio de cripto ---
// ids: lista de identificadores de CoinGecko (ej. ['bitcoin','ethereum'])
// moneda: 'usd' o 'cop'
// Devuelve un objeto { bitcoin: 62000, ethereum: 3100 }
export async function obtenerPreciosCripto(ids, moneda = 'usd') {
  if (!ids || ids.length === 0) return {};
  const lista = ids.join(',');
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(lista)}&vs_currencies=${encodeURIComponent(moneda)}`;
  const data = await fetchConTimeout(url);
  const salida = {};
  for (const id of ids) {
    if (data[id] && typeof data[id][moneda] === 'number') {
      salida[id] = data[id][moneda];
    }
  }
  return salida;
}

// --- TRM oficial (datos.gov.co) ---
// Dataset de la Superintendencia Financiera con la TRM diaria.
// Devuelve { valor, vigenciaDesde } o lanza error.
export async function obtenerTRMOficial() {
  const url = 'https://www.datos.gov.co/resource/32sa-8pi3.json?$order=vigenciadesde%20DESC&$limit=1';
  const data = await fetchConTimeout(url);
  if (!Array.isArray(data) || data.length === 0) throw new Error('Sin datos de TRM');
  const fila = data[0];
  const valor = parseFloat(fila.valor);
  if (!Number.isFinite(valor) || valor <= 0) throw new Error('TRM inválida');
  return { valor, vigenciaDesde: fila.vigenciadesde || null };
}

// Traduce errores técnicos a algo que una persona entienda.
export function mensajeDeError(e) {
  const txt = String((e && e.message) || e || '');
  if (txt.includes('abort')) return 'La consulta tardó demasiado. Revisa tu conexión e intenta de nuevo.';
  if (txt.includes('Failed to fetch') || txt.includes('NetworkError')) {
    return 'No hay conexión a internet, o el servicio no respondió. Puedes escribir el precio a mano.';
  }
  if (txt.includes('429')) return 'El servicio está limitando las consultas. Espera un minuto e intenta otra vez.';
  if (txt.includes('HTTP')) return 'El servicio respondió con un error (' + txt + '). Intenta más tarde.';
  return 'No se pudo obtener el precio: ' + txt;
}
