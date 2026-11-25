// =============================================================
//  CAJA (punto de venta)  —  /api/caja
//  Clave: CAJA_CLAVE (si existe) o la de la cocina (COCINA_CLAVE, el dueño entra a todo)
//
//  GET                                   → día abierto, caja (fondo, efectivo esperado, arqueo),
//                                          carta, mesas por cobrar y ventas de caja de hoy
//  POST {accion:"abrir_caja", fondo}     → efectivo con el que empieza la caja
//  POST {accion:"venta", para, mesa?, items:[{id,cantidad}], notas, pago, recibido}
//        para: "mostrador" | "llevar"  → se cobra al momento
//        para: "mesa" (con mesa N)       → se suma a la cuenta de la mesa (se cobra al final)
//  POST {accion:"cobrar", id, metodo}    → cobrar la cuenta de una mesa
//  POST {accion:"arqueo", contado, nota} → contar el efectivo al cerrar la caja
//  POST {accion:"anular", id, motivo}    → anular una venta hecha en caja (por error)
//  POST {accion:"salida", monto, motivo} → registrar dinero que sale del cajón
//  POST {accion:"borrar_salida", id}     → quitar una salida registrada por error
// =============================================================

import {
  hoyEcuador, prepararTablas, jornadaAbierta, cuentaAbierta, detalleCuenta, cartaEfectiva, cobrarCuenta,
  estadoCaja, METODOS_PAGO, CUENTA_VENCE, responder, limpiar, sinBasura, contar, enviarTelegram,
} from "../_db.js";

const r2 = (x) => Math.round(Number(x) * 100) / 100;

function autorizado(request, env) {
  const dada = String(request.headers.get("x-clave") ?? "").trim();
  const claves = [env.CAJA_CLAVE, env.COCINA_CLAVE].map((c) => String(c ?? "").trim()).filter(Boolean);
  if (!claves.length) return responder(500, { ok: false, error: "Falta COCINA_CLAVE en Cloudflare" });
  if (!dada || !claves.includes(dada)) return responder(401, { ok: false, error: "Clave incorrecta" });
  if (!env.DB) return responder(500, { ok: false, error: "Falta conectar la base de datos (DB)" });
  return null;
}

export async function onRequestGet({ request, env }) {
  const no = autorizado(request, env); if (no) return no;
  const DB = env.DB; await prepararTablas(DB);
  const j = await jornadaAbierta(DB, false);
  const R = await cartaEfectiva(env, request.url);
  const carta = R.platos.map((p) => ({ id: p.id, nombre: p.nombre, precio: Number(p.precio), agotado: !!p.agotado, categoria: p.categoria || "Otros" }));
  // Mesas con cuenta abierta (para cobrar desde la caja)
  const { results: cs } = await DB.prepare("SELECT * FROM cuentas WHERE cerrada IS NULL AND pedidos > 0 ORDER BY mesa").all();
  const mesas = [];
  for (const c of cs) {
    if (Date.now() - c.actualizada > CUENTA_VENCE) continue;
    const det = await detalleCuenta(DB, c);
    mesas.push({ ...det, servido: det.pedidos.every((p) => p.estado === "listo") });
  }
  // Ventas hechas en la caja hoy
  let ventas = [];
  if (j) ventas = (await DB.prepare("SELECT id, numero, tipo, mesa, para, items, total, pago, creado, estado, anulado FROM pedidos " +
    "WHERE jornada = ?1 AND tipo IN ('pedido', 'anulado') AND para IS NOT NULL ORDER BY id DESC LIMIT 200").bind(j.id).all())
    .results.map((p) => ({ ...p, items: p.items ? JSON.parse(p.items) : [], anulado: p.anulado ? JSON.parse(p.anulado) : null }));
  return responder(200, {
    ok: true, nombre: R.nombre, mesasTotal: Number(R.mesas || 0),
    jornada: j ? { id: j.id, fecha: j.fecha, abierta: j.abierta } : null,
    caja: j ? await estadoCaja(DB, j) : null,
    carta, mesas, ventas,
  });
}

export async function onRequestPost({ request, env }) {
  const no = autorizado(request, env); if (no) return no;
  const DB = env.DB; await prepararTablas(DB);
  let d; try { d = await request.json(); } catch { return responder(400, { ok: false, error: "Datos inválidos" }); }
  const j = await jornadaAbierta(DB, false);

  if (d.accion === "cobrar") {
    const id = Number(d.id);
    if (!Number.isInteger(id)) return responder(400, { ok: false, error: "Datos inválidos" });
    await cobrarCuenta(DB, id, d.metodo);
    return responder(200, { ok: true });
  }

  if (!j) return responder(409, { ok: false, error: "Primero abre el día laboral en la cocina", codigo: "cerrado" });

  if (d.accion === "abrir_caja") {
    const fondo = r2(d.fondo);
    if (!(fondo >= 0 && fondo <= 100000)) return responder(400, { ok: false, error: "Monto no válido" });
    await DB.prepare("UPDATE jornadas SET fondo = ?2 WHERE id = ?1").bind(j.id, fondo).run();
    return responder(200, { ok: true });
  }

  if (d.accion === "arqueo") {
    const contado = r2(d.contado);
    if (!(contado >= 0 && contado <= 1000000)) return responder(400, { ok: false, error: "Monto no válido" });
    const c = await estadoCaja(DB, j);
    const arqueo = { contado, esperado: c.esperado, diferencia: r2(contado - c.esperado), hora: Date.now(),
      nota: String(d.nota ?? "").replace(/[<>]/g, "").trim().slice(0, 200) };
    await DB.prepare("UPDATE jornadas SET arqueo = ?2 WHERE id = ?1").bind(j.id, JSON.stringify(arqueo)).run();
    return responder(200, { ok: true, arqueo });
  }

  if (d.accion === "anular") {
    const id = Number(d.id), motivo = String(d.motivo ?? "").replace(/[<>]/g, "").trim().slice(0, 200);
    if (!Number.isInteger(id) || !motivo) return responder(400, { ok: false, error: "Escribe el motivo" });
    const p = await DB.prepare("SELECT * FROM pedidos WHERE id = ?1 AND jornada = ?2 AND tipo = 'pedido' AND para IS NOT NULL").bind(id, j.id).first();
    if (!p) return responder(404, { ok: false, error: "Esa venta no existe o ya fue anulada" });
    if (p.cuenta != null) {
      const c = await DB.prepare("SELECT cerrada FROM cuentas WHERE id = ?1").bind(p.cuenta).first();
      if (c && c.cerrada != null) return responder(409, { ok: false, error: "Esa mesa ya fue cobrada; no se puede anular" });
    }
    const ahora = Date.now();
    await DB.batch([
      // sale de la cocina, de los totales y del efectivo esperado
      DB.prepare("UPDATE pedidos SET tipo = 'anulado', estado = 'listo', actualizado = ?2, anulado = ?3 WHERE id = ?1").bind(id, ahora, JSON.stringify({ motivo, hora: ahora })),
      DB.prepare("UPDATE jornadas SET total = total - ?2 WHERE id = ?1").bind(j.id, p.total),
      ...(p.cuenta != null ? [DB.prepare("UPDATE cuentas SET total = total - ?2, pedidos = pedidos - 1 WHERE id = ?1").bind(p.cuenta, p.total)] : []),
    ]);
    return responder(200, { ok: true });
  }

  if (d.accion === "salida") {
    const monto = r2(d.monto), motivo = String(d.motivo ?? "").replace(/[<>]/g, "").trim().slice(0, 120);
    if (!(monto > 0 && monto <= 100000)) return responder(400, { ok: false, error: "Monto no válido" });
    if (!motivo) return responder(400, { ok: false, error: "Escribe para qué fue la salida" });
    await DB.prepare("INSERT INTO movimientos (jornada, monto, motivo, creado) VALUES (?1, ?2, ?3, ?4)").bind(j.id, monto, motivo, Date.now()).run();
    return responder(200, { ok: true });
  }
  if (d.accion === "borrar_salida") {
    await DB.prepare("DELETE FROM movimientos WHERE id = ?1 AND jornada = ?2").bind(Number(d.id), j.id).run();
    return responder(200, { ok: true });
  }

  if (d.accion === "venta") {
    const R = await cartaEfectiva(env, request.url);
    const para = ["mostrador", "llevar", "mesa"].includes(d.para) ? d.para : "mostrador";
    const mesa = para === "mesa" ? Number(d.mesa) : 0;
    if (para === "mesa" && !(Number.isInteger(mesa) && mesa >= 1 && mesa <= Number(R.mesas || 0)))
      return responder(400, { ok: false, error: "Mesa no válida" });
    const porId = new Map(R.platos.map((p) => [p.id, p]));
    const lista = (Array.isArray(d.items) ? d.items.slice(0, 60) : [])
      .map((it) => ({ p: porId.get(String(it.id)), cantidad: Math.floor(Number(it.cantidad)) }))
      .filter((it) => it.p && !it.p.agotado && it.cantidad >= 1 && it.cantidad <= 99);
    if (!lista.length) return responder(400, { ok: false, error: "La venta está vacía" });
    const items = lista.map((it) => ({ nombre: it.p.nombre, cantidad: it.cantidad, precio: Number(it.p.precio) }));
    const total = r2(items.reduce((t, it) => t + it.cantidad * it.precio, 0));
    const notas = String(d.notas ?? "").slice(0, 300).trim();
    const pago = METODOS_PAGO.includes(d.pago) ? d.pago : null;
    if (para !== "mesa" && !pago) return responder(400, { ok: false, error: "Elige la forma de pago" });
    const ahora = Date.now();

    const { numero, totalDia } = await contar(DB, j.id, total);
    let cuenta = null;
    if (para === "mesa") {                              // el mesero tomó el pedido: va a la cuenta de la mesa
      const c = await cuentaAbierta(DB, mesa, j.id, true);
      const rr = await DB.prepare("UPDATE cuentas SET total = total + ?2, pedidos = pedidos + 1, actualizada = ?3 WHERE id = ?1 RETURNING total, pedidos")
        .bind(c.id, total, ahora).first();
      cuenta = { id: c.id, total: rr.total, pedidos: rr.pedidos };
      if (pago) await DB.prepare("UPDATE cuentas SET pago_pref = ?2 WHERE id = ?1").bind(c.id, pago).run();
    }
    const fila = await DB.prepare(
      "INSERT INTO pedidos (dia, numero, tipo, mesa, items, notas, total, estado, creado, actualizado, jornada, cuenta, por, pago, para) " +
      "VALUES (?1, ?2, 'pedido', ?3, ?4, ?5, ?6, 'nuevo', ?7, ?7, ?8, ?9, 'Caja', ?10, ?11) RETURNING id"
    ).bind(hoyEcuador(ahora), numero, mesa, JSON.stringify(items), notas, total, ahora, j.id, cuenta ? cuenta.id : null, pago, para).first();

    // Aviso a Telegram (si falla, igual queda en la pantalla de cocina)
    try {
      let TOKEN = sinBasura(env.TELEGRAM_TOKEN); if (TOKEN.toLowerCase().startsWith("bot")) TOKEN = TOKEN.slice(3);
      const CHAT = sinBasura(R.telegram_chat_id).replace(/\s/g, "");
      const hora = new Date(ahora).toLocaleTimeString("es-EC", { timeZone: "America/Guayaquil", hour: "2-digit", minute: "2-digit" });
      const donde = para === "llevar" ? "🥡 <b>PARA LLEVAR</b>" : para === "mostrador" ? "🧍 <b>MOSTRADOR</b>" : `🍽️ <b>MESA ${mesa}</b>`;
      let t = `🔔 <b>PEDIDO #${numero}</b> (caja)\n${donde}   🕐 ${hora}\n\n`;
      for (const it of items) t += `• <b>${it.cantidad} x</b> ${limpiar(it.nombre, 60)}  —  $${(it.cantidad * it.precio).toFixed(2)}\n`;
      t += `\n💰 <b>Total: $${total.toFixed(2)}</b>${pago ? `\n💳 ${para === "mesa" ? "Pagará" : "Pagó"} con: <b>${pago}</b>` : ""}`;
      if (notas) t += `\n\n📝 <b>Indicaciones:</b> ${limpiar(notas, 300)}`;
      t += `\n\n📊 Hoy van <b>${numero}</b> pedidos · $${Number(totalDia).toFixed(2)} vendidos`;
      await enviarTelegram(TOKEN, CHAT, t);
    } catch (e) { console.log("Telegram caja:", String(e)); }

    const recibido = r2(d.recibido);
    return responder(200, { ok: true, id: fila.id, numero, total,
      vuelto: pago === "Efectivo" && recibido >= total ? r2(recibido - total) : null });
  }

  return responder(400, { ok: false, error: "Acción desconocida" });
}
