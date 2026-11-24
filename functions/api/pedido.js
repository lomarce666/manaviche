// =============================================================
//  Envía a la cocina (grupo de Telegram) los pedidos de las mesas,
//  y los avisos de "llamar al mesero" y "pedir la cuenta".
//
//  · El token del bot NO va aquí: se guarda en Cloudflare como
//    variable secreta TELEGRAM_TOKEN.
//  · El grupo de la cocina, las mesas y los precios se leen de
//    restaurante.json (así los precios no se pueden falsear desde
//    el celular del cliente).
//  · Numeración en orden: conecta en Cloudflare una base de datos D1
//    con el nombre de variable DB. Los pedidos se numeran 1, 2, 3…
//    y el contador vuelve a 1 todos los días a las 5:00 a. m.
//    (Sin base de datos conectada, llevan un número corto al azar.)
// =============================================================

const responder = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

// Evita que alguien meta código raro en el mensaje
const limpiar = (t, max) =>
  String(t ?? "").slice(0, max).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Quita espacios, saltos de línea y comillas que se cuelan al copiar y pegar
const sinBasura = (v) => String(v ?? "").trim().replace(/^["'\s]+|["'\s]+$/g, "");

// Día de trabajo: empieza a las 5:00 a. m. (hora de Ecuador). Un pedido a la 1:00 a. m.
// todavía cuenta para el día anterior.
function diaDeTrabajo(ahora) {
  return new Date(ahora.getTime() - 5 * 3600 * 1000).toLocaleDateString("en-CA", { timeZone: "America/Guayaquil" });
}

async function contar(env, dia, monto) {
  if (!env.DB) return { numero: Math.floor(100 + Math.random() * 900), enOrden: false };
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS contador (dia TEXT PRIMARY KEY, n INTEGER NOT NULL, total REAL NOT NULL)").run();
  // Suma 1 de forma segura aunque lleguen varios pedidos al mismo tiempo
  const fila = await env.DB.prepare(
    "INSERT INTO contador (dia, n, total) VALUES (?1, 1, ?2) " +
    "ON CONFLICT(dia) DO UPDATE SET n = n + 1, total = total + ?2 RETURNING n, total"
  ).bind(dia, monto).first();
  return { numero: fila.n, totalDia: fila.total, enOrden: true };
}

async function descontar(env, dia, monto, numero) {
  if (!env.DB) return;
  try {
    // Devuelve el monto; y si nadie pidió después, también devuelve el número (así no quedan saltos)
    await env.DB.prepare("UPDATE contador SET total = total - ?2, n = CASE WHEN n = ?3 THEN n - 1 ELSE n END WHERE dia = ?1")
      .bind(dia, monto, numero).run();
  } catch {}
}

export async function onRequestPost({ request, env }) {
  let TOKEN = sinBasura(env.TELEGRAM_TOKEN);
  if (TOKEN.toLowerCase().startsWith("bot")) TOKEN = TOKEN.slice(3);
  if (!TOKEN) return responder(500, { ok: false, error: "Falta TELEGRAM_TOKEN en Cloudflare" });

  // ---- Datos del restaurante ----
  let R;
  try {
    const r = await env.ASSETS.fetch(new URL("/restaurante.json", request.url));
    R = await r.json();
  } catch {
    return responder(500, { ok: false, error: "No se pudo leer restaurante.json" });
  }
  const CHAT = sinBasura(R.telegram_chat_id).replace(/\s/g, "");
  if (!CHAT) return responder(500, { ok: false, error: "Falta telegram_chat_id en restaurante.json" });

  let datos;
  try { datos = await request.json(); } catch { return responder(400, { ok: false, error: "Datos inválidos" }); }

  const mesa = Number(datos.mesa);
  if (!Number.isInteger(mesa) || mesa < 1 || mesa > Number(R.mesas || 0))
    return responder(400, { ok: false, error: "Mesa no válida" });

  const ahora = new Date();
  const hora = ahora.toLocaleTimeString("es-EC", { timeZone: "America/Guayaquil", hour: "2-digit", minute: "2-digit" });
  const hoy = diaDeTrabajo(ahora);
  const tipo = datos.tipo || "pedido";
  let texto, numero, conteo, total = 0;

  if (tipo === "mesero" || tipo === "cuenta") {
    texto = tipo === "cuenta"
      ? `🧾 <b>PIDEN LA CUENTA</b>\n🍽️ <b>MESA ${mesa}</b>   🕐 ${hora}`
      : `🙋 <b>LLAMAN AL MESERO</b>\n🍽️ <b>MESA ${mesa}</b>   🕐 ${hora}`;
  } else {
    // Los precios salen de restaurante.json, no de lo que manda el celular
    const porId = new Map((R.platos || []).map((p, i) => [p.id || "p" + i, p]));
    const lista = (Array.isArray(datos.items) ? datos.items.slice(0, 40) : [])
      .map((it) => ({ p: porId.get(String(it.id)), cantidad: Math.floor(Number(it.cantidad)) }))
      .filter((it) => it.p && !it.p.agotado && it.cantidad >= 1 && it.cantidad <= 50);
    if (!lista.length) return responder(400, { ok: false, error: "Pedido vacío" });

    total = lista.reduce((t, it) => t + it.cantidad * Number(it.p.precio), 0);
    const notas = limpiar(datos.notas, 300).trim();
    try { conteo = await contar(env, hoy, total); }
    catch (e) { console.log("Base de datos:", String(e)); conteo = { numero: Math.floor(100 + Math.random() * 900), enOrden: false }; }
    numero = conteo.numero;

    texto = `🔔 <b>PEDIDO #${numero}</b>\n🍽️ <b>MESA ${mesa}</b>   🕐 ${hora}\n\n`;
    for (const it of lista)
      texto += `• <b>${it.cantidad} x</b> ${limpiar(it.p.nombre, 60)}  —  $${(it.cantidad * Number(it.p.precio)).toFixed(2)}\n`;
    texto += `\n💰 <b>Total: $${total.toFixed(2)}</b>`;
    if (notas) texto += `\n\n📝 <b>Indicaciones:</b> ${notas}`;
    if (conteo.enOrden) texto += `\n\n📊 Hoy van <b>${numero}</b> pedido${numero === 1 ? "" : "s"} · $${conteo.totalDia.toFixed(2)} vendidos`;
  }

  // ---- Enviar a Telegram ----
  // Telegram deja enviar unos 20 mensajes por minuto a un mismo grupo. Si en hora pico
  // se pasa, responde "espera X segundos" (error 429): esperamos y reintentamos solos,
  // así el pedido no se pierde aunque muchas mesas pidan al mismo tiempo.
  const enviar = () => fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT, text: texto, parse_mode: "HTML" }),
  }).then((r) => r.json());
  try {
    let j = await enviar();
    let espera = 0;
    for (let intento = 0; !j.ok && j.error_code === 429 && intento < 3; intento++) {
      const seg = Math.min(Number(j.parameters?.retry_after) || 3, 20);
      if (espera + seg > 40) break;                 // no hacemos esperar al cliente más de ~40 s
      espera += seg;
      await new Promise((ok) => setTimeout(ok, seg * 1000));
      j = await enviar();
    }
    if (!j.ok) {
      if (conteo?.enOrden) await descontar(env, hoy, total, numero);   // si no llegó a la cocina, no se suma a la caja
      console.log("Telegram rechazó:", j.error_code, j.description);
      return responder(502, {
        ok: false,
        error: "Telegram no aceptó el mensaje",
        motivo: `${j.error_code}: ${j.description}`,
        nuevo_chat_id: j.parameters?.migrate_to_chat_id,
        pista: `token: ${TOKEN.length} caracteres, ${TOKEN.includes(":") ? "con" : "SIN"} dos puntos · chat_id empieza con "${CHAT.slice(0, 4)}"`,
      });
    }
    return responder(200, { ok: true, numero });
  } catch {
    if (conteo?.enOrden) await descontar(env, hoy, total, numero);
    return responder(502, { ok: false, error: "No se pudo conectar con Telegram" });
  }
}

export async function onRequest() {
  return responder(405, { ok: false, error: "Método no permitido" });
}
