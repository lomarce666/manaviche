// =============================================================
//  Recibe los pedidos de las mesas (y "llamar al mesero" / "pedir
//  la cuenta") y los hace llegar a la cocina por dos caminos:
//
//   1. La PANTALLA DE COCINA (/cocina): se guardan en la base de
//      datos D1 (variable DB) y la pantalla suena hasta que alguien
//      toca "Recibido".
//   2. TELEGRAM: un mensaje al grupo de la cocina (respaldo).
//
//  · El token del bot NO va aquí: es la variable secreta TELEGRAM_TOKEN.
//  · Mesas, precios y grupo de Telegram salen de restaurante.json
//    (así los precios no se pueden falsear desde el celular del cliente).
//  · Los pedidos se numeran 1, 2, 3… y el contador vuelve a 1 todos
//    los días a las 5:00 a. m.
//  · Si restaurante.json tiene "pantalla_cocina": true, basta con que
//    el pedido quede guardado para la pantalla; Telegram es extra.
// =============================================================

import { diaDeTrabajo, prepararTablas, responder } from "../_db.js";

// Evita que alguien meta código raro en el mensaje
const limpiar = (t, max) =>
  String(t ?? "").slice(0, max).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Quita espacios, saltos de línea y comillas que se cuelan al copiar y pegar
const sinBasura = (v) => String(v ?? "").trim().replace(/^["'\s]+|["'\s]+$/g, "");

async function contar(DB, dia, monto) {
  // Suma 1 de forma segura aunque lleguen varios pedidos al mismo tiempo
  const fila = await DB.prepare(
    "INSERT INTO contador (dia, n, total) VALUES (?1, 1, ?2) " +
    "ON CONFLICT(dia) DO UPDATE SET n = n + 1, total = total + ?2 RETURNING n, total"
  ).bind(dia, monto).first();
  return { numero: fila.n, totalDia: fila.total };
}

async function deshacer(DB, dia, monto, numero, id) {
  try {
    // Devuelve el monto; y si nadie pidió después, también el número (así no quedan saltos)
    if (numero) await DB.prepare("UPDATE contador SET total = total - ?2, n = CASE WHEN n = ?3 THEN n - 1 ELSE n END WHERE dia = ?1")
      .bind(dia, monto, numero).run();
    if (id) await DB.prepare("DELETE FROM pedidos WHERE id = ?1").bind(id).run();
  } catch {}
}

async function enviarTelegram(TOKEN, CHAT, texto) {
  if (!TOKEN || !CHAT) return { ok: false, description: "Falta configurar Telegram" };
  // Telegram deja unos 20 mensajes por minuto por grupo. Si en hora pico pide esperar
  // (error 429), esperamos y reintentamos solos.
  const enviar = () => fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT, text: texto, parse_mode: "HTML" }),
  }).then((r) => r.json());
  try {
    let j = await enviar(), espera = 0;
    for (let intento = 0; !j.ok && j.error_code === 429 && intento < 3; intento++) {
      const seg = Math.min(Number(j.parameters?.retry_after) || 3, 20);
      if (espera + seg > 40) break;
      espera += seg;
      await new Promise((ok) => setTimeout(ok, seg * 1000));
      j = await enviar();
    }
    return j;
  } catch (e) {
    return { ok: false, description: "No se pudo conectar con Telegram" };
  }
}

export async function onRequestPost({ request, env }) {
  let TOKEN = sinBasura(env.TELEGRAM_TOKEN);
  if (TOKEN.toLowerCase().startsWith("bot")) TOKEN = TOKEN.slice(3);

  // ---- Datos del restaurante ----
  let R;
  try {
    R = await (await env.ASSETS.fetch(new URL("/restaurante.json", request.url))).json();
  } catch {
    return responder(500, { ok: false, error: "No se pudo leer restaurante.json" });
  }
  const CHAT = sinBasura(R.telegram_chat_id).replace(/\s/g, "");
  const usaPantalla = R.pantalla_cocina === true && !!env.DB;

  let datos;
  try { datos = await request.json(); } catch { return responder(400, { ok: false, error: "Datos inválidos" }); }

  const mesa = Number(datos.mesa);
  if (!Number.isInteger(mesa) || mesa < 1 || mesa > Number(R.mesas || 0))
    return responder(400, { ok: false, error: "Mesa no válida" });

  const ahora = new Date();
  const hora = ahora.toLocaleTimeString("es-EC", { timeZone: "America/Guayaquil", hour: "2-digit", minute: "2-digit" });
  const hoy = diaDeTrabajo(ahora);
  const tipo = datos.tipo === "mesero" || datos.tipo === "cuenta" ? datos.tipo : "pedido";
  let texto, numero = null, totalDia = null, total = 0, items = null, notas = "";

  if (tipo === "pedido") {
    // Los precios salen de restaurante.json, no de lo que manda el celular
    const porId = new Map((R.platos || []).map((p, i) => [p.id || "p" + i, p]));
    const lista = (Array.isArray(datos.items) ? datos.items.slice(0, 40) : [])
      .map((it) => ({ p: porId.get(String(it.id)), cantidad: Math.floor(Number(it.cantidad)) }))
      .filter((it) => it.p && !it.p.agotado && it.cantidad >= 1 && it.cantidad <= 50);
    if (!lista.length) return responder(400, { ok: false, error: "Pedido vacío" });
    total = lista.reduce((t, it) => t + it.cantidad * Number(it.p.precio), 0);
    notas = String(datos.notas ?? "").slice(0, 300).trim();
    items = lista.map((it) => ({ nombre: it.p.nombre, cantidad: it.cantidad, precio: Number(it.p.precio) }));
  }

  // ---- Guardar en la base de datos (número en orden + pantalla de cocina) ----
  let id = null;
  if (env.DB) {
    try {
      await prepararTablas(env.DB);
      if (tipo === "pedido") ({ numero, totalDia } = await contar(env.DB, hoy, total));
      const fila = await env.DB.prepare(
        "INSERT INTO pedidos (dia, numero, tipo, mesa, items, notas, total, estado, creado, actualizado) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'nuevo', ?8, ?8) RETURNING id"
      ).bind(hoy, numero, tipo, mesa, items ? JSON.stringify(items) : null, notas, total, ahora.getTime()).first();
      id = fila.id;
    } catch (e) {
      console.log("Base de datos:", String(e));
    }
  }
  if (tipo === "pedido" && numero == null) numero = Math.floor(100 + Math.random() * 900);

  // ---- Mensaje de Telegram ----
  if (tipo === "pedido") {
    texto = `🔔 <b>PEDIDO #${numero}</b>\n🍽️ <b>MESA ${mesa}</b>   🕐 ${hora}\n\n`;
    for (const it of items)
      texto += `• <b>${it.cantidad} x</b> ${limpiar(it.nombre, 60)}  —  $${(it.cantidad * it.precio).toFixed(2)}\n`;
    texto += `\n💰 <b>Total: $${total.toFixed(2)}</b>`;
    if (notas) texto += `\n\n📝 <b>Indicaciones:</b> ${limpiar(notas, 300)}`;
    if (totalDia != null) texto += `\n\n📊 Hoy van <b>${numero}</b> pedido${numero === 1 ? "" : "s"} · $${totalDia.toFixed(2)} vendidos`;
  } else {
    texto = tipo === "cuenta"
      ? `🧾 <b>PIDEN LA CUENTA</b>\n🍽️ <b>MESA ${mesa}</b>   🕐 ${hora}`
      : `🙋 <b>LLAMAN AL MESERO</b>\n🍽️ <b>MESA ${mesa}</b>   🕐 ${hora}`;
  }
  const j = await enviarTelegram(TOKEN, CHAT, texto);
  if (!j.ok) console.log("Telegram:", j.error_code, j.description);

  // Llegó a la cocina si: Telegram lo aceptó, o quedó guardado para la pantalla de cocina
  const llego = j.ok || (usaPantalla && id != null);
  if (!llego) {
    if (env.DB) await deshacer(env.DB, hoy, total, totalDia != null ? numero : null, id);
    return responder(502, {
      ok: false,
      error: "No llegó a la cocina",
      motivo: `${j.error_code ?? ""} ${j.description ?? ""}`.trim(),
      nuevo_chat_id: j.parameters?.migrate_to_chat_id,
    });
  }
  return responder(200, { ok: true, numero: tipo === "pedido" ? numero : undefined });
}

export async function onRequest() {
  return responder(405, { ok: false, error: "Método no permitido" });
}
