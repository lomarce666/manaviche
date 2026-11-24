// =============================================================
//  Manaviche · Envía los pedidos de las mesas a Telegram
//  La clave del bot NO va aquí: se guarda en Netlify como
//  variables de entorno TELEGRAM_TOKEN y TELEGRAM_CHAT_ID.
// =============================================================

const MESAS = Number(process.env.MESAS || 6);

const responder = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

// Evita que alguien meta código raro en el mensaje
const limpiar = (t, max) =>
  String(t ?? "").slice(0, max).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export default async (req) => {
  if (req.method !== "POST") return responder(405, { ok: false, error: "Método no permitido" });

  // Limpia espacios, saltos de línea y comillas que se cuelan al copiar y pegar
  const limpia = (v) => String(v ?? "").trim().replace(/^["'\s]+|["'\s]+$/g, "");
  let TOKEN = limpia(process.env.TELEGRAM_TOKEN);
  if (TOKEN.toLowerCase().startsWith("bot")) TOKEN = TOKEN.slice(3);   // por si pegaron "bot123:ABC"
  const CHAT = limpia(process.env.TELEGRAM_CHAT_ID).replace(/\s/g, "");
  if (!TOKEN || !CHAT) return responder(500, { ok: false, error: "Falta configurar Telegram en Netlify" });

  let datos;
  try { datos = await req.json(); } catch { return responder(400, { ok: false, error: "Datos inválidos" }); }

  // ---- Revisar que el pedido tenga sentido ----
  const mesa = Number(datos.mesa);
  if (!Number.isInteger(mesa) || mesa < 1 || mesa > MESAS)
    return responder(400, { ok: false, error: "Mesa no válida" });

  const items = Array.isArray(datos.items) ? datos.items.slice(0, 30) : [];
  const lista = items
    .map((it) => ({
      nombre: limpiar(it.nombre, 60),
      cantidad: Math.floor(Number(it.cantidad)),
      precio: Number(it.precio),
    }))
    .filter((it) => it.nombre && it.cantidad >= 1 && it.cantidad <= 50 && it.precio >= 0 && it.precio < 1000);
  if (!lista.length) return responder(400, { ok: false, error: "Pedido vacío" });

  const total = lista.reduce((t, it) => t + it.cantidad * it.precio, 0);
  const notas = limpiar(datos.notas, 300).trim();
  const hora = new Date().toLocaleTimeString("es-EC", {
    timeZone: "America/Guayaquil", hour: "2-digit", minute: "2-digit",
  });

  // ---- Armar el mensaje para la cocina ----
  let texto = `🔔 <b>NUEVO PEDIDO</b>\n🍽️ <b>MESA ${mesa}</b>   🕐 ${hora}\n\n`;
  for (const it of lista) texto += `• <b>${it.cantidad} x</b> ${it.nombre}  —  $${(it.cantidad * it.precio).toFixed(2)}\n`;
  texto += `\n💰 <b>Total: $${total.toFixed(2)}</b>`;
  if (notas) texto += `\n\n📝 <b>Indicaciones:</b> ${notas}`;

  // ---- Enviar a Telegram ----
  try {
    const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT, text: texto, parse_mode: "HTML" }),
    });
    const j = await r.json();
    if (!j.ok) {
      console.log("Telegram rechazó:", j.error_code, j.description);
      return responder(502, {
        ok: false,
        error: "Telegram no aceptó el mensaje",
        motivo: `${j.error_code}: ${j.description}`,
        nuevo_chat_id: j.parameters?.migrate_to_chat_id,
        pista: `token: ${TOKEN.length} caracteres, ${TOKEN.includes(":") ? "con" : "SIN"} dos puntos · chat_id empieza con "${CHAT.slice(0, 4)}"`,
      });
    }
    return responder(200, { ok: true });
  } catch {
    return responder(502, { ok: false, error: "No se pudo conectar con Telegram" });
  }
};
