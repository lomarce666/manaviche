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
//  · Los pedidos se numeran 1, 2, 3… dentro de cada día de trabajo
//    (lo abre y lo cierra la cocina; si no hay uno abierto, se abre solo).
//  · Si restaurante.json tiene "pantalla_cocina": true, basta con que
//    el pedido quede guardado para la pantalla; Telegram es extra.
// =============================================================

import { hoyEcuador, prepararTablas, jornadaAbierta, cuentaAbierta, cartaEfectiva, estadoHorario, mesaAutorizada, responder } from "../_db.js";

// Evita que alguien meta código raro en el mensaje
const limpiar = (t, max) =>
  String(t ?? "").slice(0, max).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Quita espacios, saltos de línea y comillas que se cuelan al copiar y pegar
const sinBasura = (v) => String(v ?? "").trim().replace(/^["'\s]+|["'\s]+$/g, "");

async function contar(DB, jornada, monto) {
  // Suma 1 de forma segura aunque lleguen varios pedidos al mismo tiempo
  const fila = await DB.prepare("UPDATE jornadas SET n = n + 1, total = total + ?2 WHERE id = ?1 RETURNING n, total")
    .bind(jornada, monto).first();
  return { numero: fila.n, totalDia: fila.total };
}

async function deshacer(DB, jornada, monto, numero, id) {
  try {
    // Devuelve el monto; y si nadie pidió después, también el número (así no quedan saltos)
    if (numero && jornada) await DB.prepare("UPDATE jornadas SET total = total - ?2, n = CASE WHEN n = ?3 THEN n - 1 ELSE n END WHERE id = ?1")
      .bind(jornada, monto, numero).run();
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
    R = await cartaEfectiva(env, request.url);   // incluye agotados y precios cambiados desde la cocina
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
  // Solo quien escaneó el QR real de la mesa puede pedir (si hay MESA_SECRETO)
  if (!(await mesaAutorizada(env, mesa, datos.k)))
    return responder(403, { ok: false, error: "Escanea el código QR de tu mesa para pedir", codigo: "sin_qr" });

  const ahora = new Date();
  const hora = ahora.toLocaleTimeString("es-EC", { timeZone: "America/Guayaquil", hour: "2-digit", minute: "2-digit" });
  const hoy = hoyEcuador(ahora.getTime());
  const tipo = datos.tipo === "mesero" || datos.tipo === "cuenta" ? datos.tipo : "pedido";
  let texto, numero = null, totalDia = null, total = 0, items = null, notas = "";

  // Fuera de horario no se reciben pedidos (sí se puede llamar al mesero o pedir la cuenta)
  if (tipo === "pedido" && !estadoHorario(R).abierto)
    return responder(409, { ok: false, error: "El local está cerrado en este momento", codigo: "cerrado" });

  let reparto = null;
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
    // Quién agregó cada plato (para dividir la cuenta); se ajusta a lo que de verdad se pidió
    if (Array.isArray(datos.reparto)) {
      const queda = Object.fromEntries(lista.map((it) => [it.p.id, it.cantidad]));
      reparto = [];
      for (const r of datos.reparto.slice(0, 80)) {
        const id = String(r.p), q = Math.min(Math.floor(Number(r.q)) || 0, queda[id] || 0);
        if (q < 1) continue;
        queda[id] -= q;
        reparto.push({ n: String(r.n ?? "").replace(/[<>"'`]/g, "").trim().slice(0, 20), plato: porId.get(id).nombre, q });
      }
      for (const [id, q] of Object.entries(queda)) if (q > 0) reparto.push({ n: "", plato: porId.get(id).nombre, q });
    }
  }

  // ---- Guardar en la base de datos (número en orden + pantalla de cocina) ----
  let id = null, jornada = null, cuenta = null, cuentaAntes = null;
  const por = String(datos.nombre ?? "").replace(/[<>"'`]/g, "").trim().slice(0, 20);
  if (env.DB) {
    try {
      await prepararTablas(env.DB);
      jornada = (await jornadaAbierta(env.DB, true)).id;
      if (tipo === "pedido") ({ numero, totalDia } = await contar(env.DB, jornada, total));
      // Cuenta de la mesa: los pedidos de comida se suman; mesero/cuenta solo la consultan
      const c = await cuentaAbierta(env.DB, mesa, jornada, tipo === "pedido");
      if (c) {
        cuentaAntes = { total: c.total, pedidos: c.pedidos };
        if (tipo === "pedido") {
          const r = await env.DB.prepare("UPDATE cuentas SET total = total + ?2, pedidos = pedidos + 1, actualizada = ?3 WHERE id = ?1 RETURNING total, pedidos")
            .bind(c.id, total, ahora.getTime()).first();
          cuenta = { id: c.id, total: r.total, pedidos: r.pedidos };
        } else cuenta = { id: c.id, total: c.total, pedidos: c.pedidos };
      }
      const fila = await env.DB.prepare(
        "INSERT INTO pedidos (dia, numero, tipo, mesa, items, notas, total, estado, creado, actualizado, jornada, cuenta, por, reparto) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'nuevo', ?8, ?8, ?9, ?10, ?11, ?12) RETURNING id"
      ).bind(hoy, numero, tipo, mesa, items ? JSON.stringify(items) : null, notas, total, ahora.getTime(), jornada, cuenta ? cuenta.id : null, por, reparto ? JSON.stringify(reparto) : null).first();
      id = fila.id;
    } catch (e) {
      console.log("Base de datos:", String(e));
    }
  }
  if (tipo === "pedido" && numero == null) numero = Math.floor(100 + Math.random() * 900);

  // ---- Mensaje de Telegram ----
  if (tipo === "pedido") {
    const adicional = cuenta && cuenta.pedidos > 1;
    texto = `${adicional ? "➕ <b>PEDIDO ADICIONAL" : "🔔 <b>PEDIDO"} #${numero}</b>\n🍽️ <b>MESA ${mesa}</b>   🕐 ${hora}${por ? `   👤 ${limpiar(por, 20)}` : ""}\n\n`;
    for (const it of items)
      texto += `• <b>${it.cantidad} x</b> ${limpiar(it.nombre, 60)}  —  $${(it.cantidad * it.precio).toFixed(2)}\n`;
    texto += `\n💰 <b>Total: $${total.toFixed(2)}</b>`;
    if (notas) texto += `\n\n📝 <b>Indicaciones:</b> ${limpiar(notas, 300)}`;
    if (adicional) texto += `\n\n🧾 Cuenta de la mesa ${mesa}: <b>$${cuenta.total.toFixed(2)}</b> (${cuenta.pedidos} pedidos)`;
    if (totalDia != null) texto += `\n\n📊 Hoy van <b>${numero}</b> pedido${numero === 1 ? "" : "s"} · $${totalDia.toFixed(2)} vendidos`;
  } else {
    texto = tipo === "cuenta"
      ? `🧾 <b>PIDEN LA CUENTA</b>\n🍽️ <b>MESA ${mesa}</b>   🕐 ${hora}${cuenta ? `\n💰 Total de la mesa: <b>$${cuenta.total.toFixed(2)}</b> (${cuenta.pedidos} pedidos)` : ""}`
      : `🙋 <b>LLAMAN AL MESERO</b>\n🍽️ <b>MESA ${mesa}</b>   🕐 ${hora}`;
  }
  const j = await enviarTelegram(TOKEN, CHAT, texto);
  if (!j.ok) console.log("Telegram:", j.error_code, j.description);

  // Llegó a la cocina si: Telegram lo aceptó, o quedó guardado para la pantalla de cocina
  const llego = j.ok || (usaPantalla && id != null);
  if (!llego) {
    if (env.DB) {
      await deshacer(env.DB, jornada, total, totalDia != null ? numero : null, id);
      if (tipo === "pedido" && cuenta && cuentaAntes) {
        try {
          if (cuentaAntes.pedidos === 0) await env.DB.prepare("DELETE FROM cuentas WHERE id = ?1").bind(cuenta.id).run();
          else await env.DB.prepare("UPDATE cuentas SET total = total - ?2, pedidos = pedidos - 1 WHERE id = ?1").bind(cuenta.id, total).run();
        } catch {}
      }
    }
    return responder(502, {
      ok: false,
      error: "No llegó a la cocina",
      motivo: `${j.error_code ?? ""} ${j.description ?? ""}`.trim(),
      nuevo_chat_id: j.parameters?.migrate_to_chat_id,
    });
  }
  // Carrito compartido de la mesa: se vacía para todos y se avisa quién envió el pedido
  if (tipo === "pedido" && datos.compartido && env.DB) {
    try {
      const ultimo = JSON.stringify({ numero, nombre: String(datos.nombre ?? "").replace(/[<>"'`]/g, "").slice(0, 20), yo: String(datos.yo ?? "").slice(0, 40), cuando: ahora.getTime(), total });
      await env.DB.prepare("INSERT INTO carritos (mesa, lineas, version, actualizado, ultimo) VALUES (?1, '[]', 1, ?2, ?3) " +
        "ON CONFLICT(mesa) DO UPDATE SET lineas = '[]', version = version + 1, actualizado = ?2, ultimo = ?3").bind(mesa, ahora.getTime(), ultimo).run();
    } catch (e) { console.log("Carrito compartido:", String(e)); }
  }
  return responder(200, { ok: true, numero: tipo === "pedido" ? numero : undefined });
}

export async function onRequest() {
  return responder(405, { ok: false, error: "Método no permitido" });
}
