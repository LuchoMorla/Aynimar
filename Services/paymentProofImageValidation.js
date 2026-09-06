'use strict';

/**
 * Validación real de comprobantes de pago — imagen real, no URL libre.
 *
 * El backend no recibe bytes de archivo (mismo patrón que product.image: el
 * cliente sube a Firebase Storage y solo envía la URL resultante) — pero a
 * diferencia de una imagen de producto, un comprobante de pago es evidencia
 * financiera: se verifica que la URL apunte realmente a un archivo alojado en
 * el storage propio de Aynimar (no un sitio externo arbitrario), en la
 * carpeta esperada, con extensión de imagen permitida, y — mediante una
 * verificación HTTP real (HEAD) — que el archivo exista de verdad con un
 * Content-Type/tamaño de imagen razonables. Nunca se lee el contenido de la
 * imagen (sin OCR, sin reconocimiento automático) — la revisión sigue siendo
 * 100% manual (Services/paymentProofService.js).
 */

const boom = require('@hapi/boom');

// Dominio real de Firebase Storage para URLs de descarga (getDownloadURL) —
// mismo dominio que ya valida frontDashboardAynimar/src/firebase/storage/index.js
// (deleteFile) al borrar imágenes de producto. No es una URL inventada.
const TRUSTED_STORAGE_HOST = 'firebasestorage.googleapis.com';

// Firebase codifica "/" como "%2F" en la URL de descarga — se exige que el
// comprobante venga de la carpeta dedicada, no de cualquier carpeta ya
// existente en el mismo bucket (ej. no se acepta reenviar la URL de una
// imagen de producto como si fuera un comprobante).
const REQUIRED_PATH_SEGMENT = 'payment-proofs%2F';

const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const ALLOWED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];

// 8 MB — razonable para una foto/captura de pantalla de comprobante desde un celular.
const MAX_BYTES = 8 * 1024 * 1024;

function _extensionOf(pathname) {
  const decoded = decodeURIComponent(pathname);
  const match = decoded.match(/\.[a-z0-9]+$/i);
  return match ? match[0].toLowerCase() : null;
}

/**
 * Validación ESTRUCTURAL de la URL (dominio confiable, carpeta esperada,
 * extensión permitida, carpeta de la ORDEN correcta) — sin red. Lanza
 * boom.badRequest si la URL no puede corresponder a un comprobante subido
 * por el flujo real de Aynimar PARA ESTA orden específica.
 *
 * El chequeo de `orderId` es lo que impide que un cliente reutilice la URL
 * de un comprobante YA subido para OTRA orden (ej. la propia, de una compra
 * anterior, o — si la llegara a conocer — la de otro cliente) y la registre
 * como si fuera el pago de esta orden: el frontend sube cada comprobante a
 * `payment-proofs/<orderId>/...` (Services/paymentProofService.js exige que
 * ese segmento coincida exactamente con la orden que se está registrando).
 *
 * @param {string} fileUrl
 * @param {number|string} orderId  La orden contra la que se está registrando este comprobante.
 */
function assertTrustedProofUrl(fileUrl, orderId) {
  let parsed;
  try {
    parsed = new URL(fileUrl);
  } catch {
    throw boom.badRequest('fileUrl no es una URL válida.');
  }
  if (parsed.protocol !== 'https:') {
    throw boom.badRequest('El comprobante debe estar en una URL https.');
  }
  if (parsed.hostname !== TRUSTED_STORAGE_HOST) {
    throw boom.badRequest(
      `El comprobante debe estar alojado en el almacenamiento de Aynimar (${TRUSTED_STORAGE_HOST}) — no se aceptan URLs externas.`
    );
  }
  if (!parsed.pathname.includes(REQUIRED_PATH_SEGMENT)) {
    throw boom.badRequest('El comprobante no proviene de la carpeta de comprobantes de pago esperada.');
  }
  if (orderId != null) {
    // Firebase codifica "/" como "%2F" en toda la ruta — el segmento exacto
    // de esta orden es "payment-proofs%2F<orderId>%2F".
    const orderSegment = `${REQUIRED_PATH_SEGMENT}${orderId}%2F`;
    if (!parsed.pathname.includes(orderSegment)) {
      throw boom.badRequest(
        'El comprobante no corresponde a esta orden — no se puede reutilizar la URL de un comprobante subido para otro pedido.'
      );
    }
  }
  const ext = _extensionOf(parsed.pathname);
  if (!ext || !ALLOWED_EXTENSIONS.includes(ext)) {
    throw boom.badRequest(`Extensión de archivo no permitida (${ext ?? 'sin extensión'}). Usa JPG, PNG o WebP.`);
  }
}

/**
 * Verifica que el archivo REALMENTE exista en el storage, con Content-Type y
 * tamaño de imagen válidos — vía HEAD real, no confiando en la extensión del
 * nombre (que el cliente podría falsear). No lee ni interpreta el contenido.
 * @param {string} fileUrl
 */
async function verifyProofFileExists(fileUrl) {
  let response;
  try {
    response = await fetch(fileUrl, { method: 'HEAD' });
  } catch (err) {
    throw boom.badRequest(`No se pudo verificar el archivo del comprobante: ${err.message}`);
  }
  if (!response.ok) {
    throw boom.badRequest(`El archivo del comprobante no existe o no es accesible (HTTP ${response.status}).`);
  }

  const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!ALLOWED_MIME_TYPES.includes(contentType)) {
    throw boom.badRequest(
      `El archivo no es una imagen válida (tipo detectado: ${contentType || 'desconocido'}). Usa JPG, PNG o WebP.`
    );
  }

  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength)) {
    if (contentLength <= 0) {
      throw boom.badRequest('El archivo del comprobante está vacío.');
    }
    if (contentLength > MAX_BYTES) {
      throw boom.badRequest(`El comprobante es demasiado grande (máximo ${Math.round(MAX_BYTES / (1024 * 1024))} MB).`);
    }
  }
}

module.exports = {
  TRUSTED_STORAGE_HOST,
  REQUIRED_PATH_SEGMENT,
  ALLOWED_MIME_TYPES,
  ALLOWED_EXTENSIONS,
  MAX_BYTES,
  assertTrustedProofUrl,
  verifyProofFileExists,
};
