function abandonedCartEmail(orderId, items = []) {
  const itemRows = items
    .map(
      (item) => `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #f0eaff;font-size:14px;color:#333;">
          ${item.name || 'Producto'}
        </td>
        <td style="padding:8px 12px;border-bottom:1px solid #f0eaff;font-size:14px;color:#4900E4;text-align:right;">
          $${item.price != null ? Number(item.price).toFixed(2) : '—'}
        </td>
      </tr>`
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Tu carrito te espera 🦦</title>
</head>
<body style="margin:0;padding:0;background:#f5f0ff;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f0ff;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(73,0,228,0.10);">

          <!-- Header -->
          <tr>
            <td style="background:linear-gradient(135deg,#4900E4 0%,#7c3aed 100%);padding:36px 40px;text-align:center;">
              <img
                src="https://www.aynimar.com/_next/static/media/logo-Aynimar.c247031e.svg"
                alt="Aynimar"
                height="40"
                style="display:block;margin:0 auto 16px;"
              />
              <span style="font-size:40px;display:block;margin-bottom:8px;">🦦</span>
              <h1 style="margin:0;color:#ffffff;font-size:24px;font-weight:700;letter-spacing:-0.5px;">
                ¡Tu carrito te está esperando!
              </h1>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:40px 40px 24px;">
              <p style="margin:0 0 20px;font-size:16px;line-height:1.6;color:#333;">
                ¡Hola! Soy la <strong style="color:#4900E4;">Nutria de Aynimar</strong> 🦦. Vi que dejaste unos
                productos en tu carrito y quería recordarte que tu pedido está guardado de forma segura.
              </p>
              <p style="margin:0 0 28px;font-size:16px;line-height:1.6;color:#333;">
                El planeta y tu bolsillo te lo agradecerán con tus
                <strong style="color:#4900E4;">Ayni-Créditos</strong> 🌱.
              </p>

              <!-- Product table -->
              ${
                itemRows
                  ? `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #f0eaff;border-radius:8px;overflow:hidden;margin-bottom:32px;">
                      <thead>
                        <tr style="background:#f5f0ff;">
                          <th style="padding:10px 12px;text-align:left;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;color:#4900E4;">Producto</th>
                          <th style="padding:10px 12px;text-align:right;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;color:#4900E4;">Precio</th>
                        </tr>
                      </thead>
                      <tbody>${itemRows}</tbody>
                    </table>`
                  : ''
              }

              <!-- CTA Button -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center" style="padding-bottom:32px;">
                    <a
                      href="https://www.aynimar.com/checkout?oi=${orderId}"
                      style="display:inline-block;background:#4900E4;color:#ffffff;text-decoration:none;font-size:16px;font-weight:700;padding:16px 40px;border-radius:50px;letter-spacing:0.3px;"
                    >
                      Completar mi compra →
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin:0;font-size:13px;color:#888;text-align:center;line-height:1.5;">
                Este enlace es exclusivo para tu carrito #${orderId}.<br />
                Si ya completaste tu compra, ignora este mensaje.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#f5f0ff;padding:24px 40px;text-align:center;border-top:1px solid #ede9ff;">
              <p style="margin:0 0 6px;font-size:13px;color:#666;">
                Economía Circular Inteligente · Aynimar
              </p>
              <p style="margin:0;font-size:12px;color:#aaa;">
                ¿Tienes dudas? Escríbenos en
                <a href="https://www.aynimar.com/contact" style="color:#4900E4;text-decoration:none;">aynimar.com/contact</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

module.exports = { abandonedCartEmail };
