// =============================================================
//  Datos para la pantalla de cocina (/cocina). Pide la clave
//  secreta COCINA_CLAVE (encabezado x-clave).
//
//  GET                 → día abierto, pedidos pendientes, preparados del día
//  GET ?dias=1         → carpeta de días guardados (cerrados)
//  GET ?dia=<id>       → reporte de caja de un día guardado
//  POST {id, estado}               → nuevo → preparando → listo
//  POST {accion:"abrir", fecha}    → Nuevo día laboral
//  POST {accion:"previa"}          → cierre de caja (sin guardar)
//  POST {accion:"cerrar"}          → Culminar día de trabajo (guarda)
//  POST {accion:"borrar", alcance:"dia"|"semana"|"todo", id?}
//  POST {accion:"cobrar", id}      → cerrar la cuenta de una mesa (ya pagó)
// =============================================================

import { hoyEcuador, prepararTablas, jornadaAbierta, resumenJornada, detalleCuenta, CUENTA_VENCE, responder } from "../_db.js";

const ESTADOS = ["nuevo", "recibido", "preparando", "listo"];
const fechaValida = (f) => /^\d{4}-\d{2}-\d{2}$/.test(String(f || ""));

function autorizado(request, env) {
  const clave = String(env.COCINA_CLAVE ?? "").trim();
  const dada = String(request.headers.get("x-clave") ?? "").trim();
  if (!clave) return responder(500, { ok: false, error: "Falta COCINA_CLAVE en Cloudflare" });
  if (dada !== clave) return responder(401, { ok: false, error: "Clave incorrecta" });
  if (!env.DB) return responder(500, { ok: false, error: "Falta conectar la base de datos (DB)" });
  return null;
}

export async function onRequestGet({ request, env }) {
  const no = autorizado(request, env); if (no) return no;
  const DB = env.DB; await prepararTablas(DB);
  const url = new URL(request.url);

  // Carpeta de días guardados
  if (url.searchParams.get("dias")) {
    const { results } = await DB.prepare(
      "SELECT id, fecha, abierta, cerrada, n, total FROM jornadas WHERE cerrada IS NOT NULL ORDER BY cerrada DESC LIMIT 400"
    ).all();
    return responder(200, { ok: true, dias: results });
  }
  // Reporte de un día guardado
  if (url.searchParams.get("dia")) {
    const j = await DB.prepare("SELECT * FROM jornadas WHERE id = ?1").bind(Number(url.searchParams.get("dia"))).first();
    if (!j) return responder(404, { ok: false, error: "Ese día ya no existe" });
    return responder(200, { ok: true, reporte: j.resumen ? JSON.parse(j.resumen) : await resumenJornada(DB, j) });
  }

  const j = await jornadaAbierta(DB, false);
  const [pend, hechos] = await DB.batch([
    DB.prepare("SELECT id, numero, tipo, mesa, items, notas, total, estado, creado, actualizado, por, cuenta, " +
      "(SELECT MIN(q.id) FROM pedidos q WHERE q.cuenta = pedidos.cuenta AND q.tipo = 'pedido') AS primero, " +
      "(SELECT c.total FROM cuentas c WHERE c.id = pedidos.cuenta) AS cuenta_total " +
      "FROM pedidos WHERE estado != 'listo' ORDER BY id LIMIT 200"),
    DB.prepare("SELECT id, numero, mesa, items, notas, total, creado, actualizado FROM pedidos " +
      "WHERE jornada = ?1 AND tipo = 'pedido' AND estado = 'listo' ORDER BY actualizado DESC LIMIT 400").bind(j ? j.id : -1),
  ]);
  const conItems = (p) => ({ ...p, items: p.items ? JSON.parse(p.items) : [], adicional: p.tipo === "pedido" && p.primero != null && p.primero !== p.id });
  // Cuentas de mesa abiertas (sin cobrar)
  const ahora = Date.now();
  const abiertas = (await DB.prepare("SELECT * FROM cuentas WHERE cerrada IS NULL AND pedidos > 0 ORDER BY mesa").all()).results
    .filter((c) => ahora - c.actualizada <= CUENTA_VENCE);
  const mesas = [];
  for (const c of abiertas) mesas.push({ ...(await detalleCuenta(DB, c)), actualizada: c.actualizada });
  return responder(200, {
    ok: true, ahora: Date.now(), hoyFecha: hoyEcuador(),
    jornada: j ? { id: j.id, fecha: j.fecha, abierta: j.abierta } : null,
    pedidos: pend.results.map(conItems),
    listos: hechos.results.map(conItems),
    mesas,
    hoy: { pedidos: j ? j.n : 0, total: j ? j.total : 0 },
  });
}

export async function onRequestPost({ request, env }) {
  const no = autorizado(request, env); if (no) return no;
  const DB = env.DB; await prepararTablas(DB);
  let d; try { d = await request.json(); } catch { return responder(400, { ok: false, error: "Datos inválidos" }); }

  // ---- Nuevo día laboral ----
  if (d.accion === "abrir") {
    if (await jornadaAbierta(DB, false)) return responder(409, { ok: false, error: "Ya hay un día de trabajo abierto. Culmínalo primero." });
    const fecha = fechaValida(d.fecha) ? d.fecha : hoyEcuador();
    await DB.prepare("INSERT OR IGNORE INTO jornadas (fecha, abierta) VALUES (?1, ?2)").bind(fecha, Date.now()).run();
    return responder(200, { ok: true, jornada: await jornadaAbierta(DB, false) });
  }

  // ---- Cierre de caja: vista previa o culminar ----
  if (d.accion === "previa" || d.accion === "cerrar") {
    const j = await jornadaAbierta(DB, false);
    if (!j) return responder(409, { ok: false, error: "No hay un día de trabajo abierto" });
    const ahora = Date.now();
    const rep = await resumenJornada(DB, { ...j, cerrada: ahora });
    if (d.accion === "previa") return responder(200, { ok: true, reporte: rep });
    await DB.batch([
      DB.prepare("UPDATE jornadas SET cerrada = ?2, resumen = ?3 WHERE id = ?1").bind(j.id, ahora, JSON.stringify(rep)),
      // Lo que quedó sin marcar como listo se archiva con el día
      DB.prepare("UPDATE pedidos SET estado = 'listo', actualizado = ?2 WHERE jornada = ?1 AND estado != 'listo'").bind(j.id, ahora),
      DB.prepare("UPDATE cuentas SET cerrada = ?1 WHERE cerrada IS NULL").bind(ahora),
    ]);
    return responder(200, { ok: true, reporte: rep });
  }

  // ---- Cobrar: cerrar la cuenta de una mesa ----
  if (d.accion === "cobrar") {
    const id = Number(d.id);
    if (!Number.isInteger(id)) return responder(400, { ok: false, error: "Datos inválidos" });
    await DB.prepare("UPDATE cuentas SET cerrada = ?2 WHERE id = ?1 AND cerrada IS NULL").bind(id, Date.now()).run();
    // La próxima gente que use esa mesa empieza con el carrito vacío
    const c = await DB.prepare("SELECT mesa FROM cuentas WHERE id = ?1").bind(id).first();
    if (c) await DB.prepare("UPDATE carritos SET lineas = '[]', version = version + 1, actualizado = ?2, ultimo = NULL WHERE mesa = ?1").bind(c.mesa, Date.now()).run();
    return responder(200, { ok: true });
  }

  // ---- Borrar días guardados ----
  if (d.accion === "borrar") {
    let ids = [];
    if (d.alcance === "dia") ids = [Number(d.id)].filter(Number.isInteger);
    else if (d.alcance === "semana")
      ids = (await DB.prepare("SELECT id FROM jornadas WHERE cerrada IS NOT NULL AND cerrada >= ?1").bind(Date.now() - 7 * 86400000).all()).results.map((r) => r.id);
    else if (d.alcance === "todo")
      ids = (await DB.prepare("SELECT id FROM jornadas WHERE cerrada IS NOT NULL").all()).results.map((r) => r.id);
    else return responder(400, { ok: false, error: "Datos inválidos" });
    ids = ids.slice(0, 90);
    if (ids.length) {
      const marcas = ids.map((_, i) => "?" + (i + 1)).join(",");
      await DB.batch([
        DB.prepare(`DELETE FROM pedidos WHERE jornada IN (${marcas})`).bind(...ids),
        DB.prepare(`DELETE FROM jornadas WHERE id IN (${marcas}) AND cerrada IS NOT NULL`).bind(...ids),
      ]);
    }
    return responder(200, { ok: true, borrados: ids.length });
  }

  // ---- Cambiar estado de un pedido ----
  const id = Number(d.id), estado = String(d.estado);
  if (!Number.isInteger(id) || !ESTADOS.includes(estado)) return responder(400, { ok: false, error: "Datos inválidos" });
  await DB.prepare("UPDATE pedidos SET estado = ?2, actualizado = ?3 WHERE id = ?1").bind(id, estado, Date.now()).run();
  return responder(200, { ok: true });
}
