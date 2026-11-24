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
//  POST {accion:"cobrar", id, metodo} → cerrar la cuenta de una mesa (ya pagó)
//  GET ?carta=1                    → carta con agotados/precios/plato del día
//  GET ?stats=7                    → estadísticas de los últimos N días
//  POST {accion:"plato", id, agotado?, precio?}   → cambiar un plato
//  POST {accion:"promo", id, texto} / {accion:"promo"} → plato del día / quitarlo
// =============================================================

import { hoyEcuador, prepararTablas, jornadaAbierta, resumenJornada, detalleCuenta, cartaEfectiva, CUENTA_VENCE, responder } from "../_db.js";

const METODOS = ["Efectivo", "Transferencia", "Tarjeta"];

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

  // Carta (para la pestaña Carta)
  if (url.searchParams.get("carta")) {
    const R = await cartaEfectiva(env, request.url);
    const base = await (await env.ASSETS.fetch(new URL("/restaurante.json", request.url))).json();
    const original = Object.fromEntries((base.platos || []).map((p, i) => [p.id || "p" + i, p.precio]));
    return responder(200, { ok: true, platos: R.platos.map((p) => ({ id: p.id, nombre: p.nombre, precio: p.precio, original: original[p.id], agotado: !!p.agotado, categoria: p.categoria || "" })), promo: R.promo || null });
  }
  // Estadísticas
  if (url.searchParams.get("stats")) {
    const dias = Math.min(Math.max(Number(url.searchParams.get("stats")) || 7, 1), 90);
    const desde = Date.now() - dias * 86400000;
    const { results } = await DB.prepare("SELECT items, total, creado FROM pedidos WHERE tipo = 'pedido' AND creado >= ?1 LIMIT 20000").bind(desde).all();
    const platos = {}, porDia = {}, porHora = Array(24).fill(0);
    let total = 0;
    const NOMBRES = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
    for (const p of results) {
      total += p.total;
      const f = new Date(p.creado - 5 * 3600000);
      const dia = f.toISOString().slice(0, 10);
      porDia[dia] = porDia[dia] || { dia, nombre: NOMBRES[f.getUTCDay()], pedidos: 0, total: 0 };
      porDia[dia].pedidos++; porDia[dia].total += p.total;
      porHora[f.getUTCHours()]++;
      for (const it of p.items ? JSON.parse(p.items) : []) {
        platos[it.nombre] = platos[it.nombre] || { nombre: it.nombre, cantidad: 0, total: 0 };
        platos[it.nombre].cantidad += it.cantidad; platos[it.nombre].total += it.cantidad * it.precio;
      }
    }
    const r2 = (x) => Math.round(x * 100) / 100;
    return responder(200, { ok: true, dias, pedidos: results.length, total: r2(total),
      ticket: results.length ? r2(total / results.length) : 0,
      platos: Object.values(platos).sort((a, b) => b.cantidad - a.cantidad).map((x) => ({ ...x, total: r2(x.total) })),
      porDia: Object.values(porDia).sort((a, b) => a.dia.localeCompare(b.dia)).map((x) => ({ ...x, total: r2(x.total) })),
      porHora });
  }

  const j = await jornadaAbierta(DB, false);
  const [pend, hechos] = await DB.batch([
    DB.prepare("SELECT id, numero, tipo, mesa, items, notas, total, estado, creado, actualizado, por, cuenta, servidos, " +
      "(SELECT MIN(q.id) FROM pedidos q WHERE q.cuenta = pedidos.cuenta AND q.tipo = 'pedido') AS primero, " +
      "(SELECT c.total FROM cuentas c WHERE c.id = pedidos.cuenta) AS cuenta_total, " +
      "(SELECT c.pago_pref FROM cuentas c WHERE c.id = pedidos.cuenta) AS pago, " +
      "(SELECT c.id FROM cuentas c WHERE c.id = pedidos.cuenta AND c.cerrada IS NULL) AS cuenta_abierta " +
      "FROM pedidos WHERE estado != 'listo' ORDER BY id LIMIT 200"),
    DB.prepare("SELECT id, numero, mesa, items, notas, total, creado, actualizado FROM pedidos " +
      "WHERE jornada = ?1 AND tipo = 'pedido' AND estado = 'listo' ORDER BY actualizado DESC LIMIT 400").bind(j ? j.id : -1),
  ]);
  const conItems = (p) => ({ ...p, items: p.items ? JSON.parse(p.items) : [], servidos: p.servidos ? JSON.parse(p.servidos) : [], adicional: p.tipo === "pedido" && p.primero != null && p.primero !== p.id });
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
    const metodo = METODOS.includes(d.metodo) ? d.metodo : null;
    await DB.prepare("UPDATE cuentas SET cerrada = ?2, metodo = ?3 WHERE id = ?1 AND cerrada IS NULL").bind(id, Date.now(), metodo).run();
    // La próxima gente que use esa mesa empieza con el carrito vacío
    const c = await DB.prepare("SELECT mesa FROM cuentas WHERE id = ?1").bind(id).first();
    if (c) await DB.batch([
      DB.prepare("UPDATE carritos SET lineas = '[]', version = version + 1, actualizado = ?2, ultimo = NULL WHERE mesa = ?1").bind(c.mesa, Date.now()),
      // Los avisos de esa mesa (mesero / cuenta) ya quedan atendidos
      DB.prepare("UPDATE pedidos SET estado = 'listo', actualizado = ?2 WHERE mesa = ?1 AND tipo != 'pedido' AND estado != 'listo'").bind(c.mesa, Date.now()),
      DB.prepare("DELETE FROM presencia WHERE mesa = ?1").bind(c.mesa),
    ]);
    return responder(200, { ok: true });
  }

  // ---- Carta: agotado / precio de un plato ----
  if (d.accion === "plato") {
    const R = await cartaEfectiva(env, request.url);
    const p = R.platos.find((x) => x.id === String(d.id));
    if (!p) return responder(404, { ok: false, error: "Ese plato no existe" });
    const actual = await DB.prepare("SELECT valor FROM ajustes WHERE clave = ?1").bind("plato:" + p.id).first();
    const v = actual ? JSON.parse(actual.valor) : {};
    if (typeof d.agotado === "boolean") v.agotado = d.agotado;
    if (d.precio !== undefined) {
      const pr = Math.round(Number(d.precio) * 100) / 100;
      if (d.precio === null) delete v.precio;
      else if (!(pr > 0 && pr <= 1000)) return responder(400, { ok: false, error: "Precio no válido" });
      else v.precio = pr;
    }
    await DB.prepare("INSERT INTO ajustes (clave, valor, actualizado) VALUES (?1, ?2, ?3) ON CONFLICT(clave) DO UPDATE SET valor = ?2, actualizado = ?3")
      .bind("plato:" + p.id, JSON.stringify(v), Date.now()).run();
    return responder(200, { ok: true });
  }
  // ---- Plato del día ----
  if (d.accion === "promo") {
    if (!d.id) { await DB.prepare("DELETE FROM ajustes WHERE clave = 'promo'").run(); return responder(200, { ok: true }); }
    const R = await cartaEfectiva(env, request.url);
    if (!R.platos.some((x) => x.id === String(d.id))) return responder(404, { ok: false, error: "Ese plato no existe" });
    const texto = String(d.texto ?? "").replace(/[<>]/g, "").trim().slice(0, 80);
    await DB.prepare("INSERT INTO ajustes (clave, valor, actualizado) VALUES ('promo', ?1, ?2) ON CONFLICT(clave) DO UPDATE SET valor = ?1, actualizado = ?2")
      .bind(JSON.stringify({ id: String(d.id), texto }), Date.now()).run();
    return responder(200, { ok: true });
  }

  // ---- Visto de cada plato servido: {accion:"servir", id, i, n} = del plato i ya se sirvieron n ----
  if (d.accion === "servir") {
    const id = Number(d.id), i = Math.floor(Number(d.i));
    const p = await DB.prepare("SELECT items, servidos FROM pedidos WHERE id = ?1 AND tipo = 'pedido'").bind(id).first();
    if (!p) return responder(404, { ok: false, error: "Ese pedido no existe" });
    const items = JSON.parse(p.items || "[]"), serv = p.servidos ? JSON.parse(p.servidos) : [];
    if (!(i >= 0 && i < items.length)) return responder(400, { ok: false, error: "Datos inválidos" });
    for (let k = 0; k < items.length; k++) serv[k] = Number(serv[k]) || 0;
    serv[i] = Math.min(Math.max(Math.floor(Number(d.n)) || 0, 0), items[i].cantidad);
    // Al marcar el primer plato, el pedido pasa a "en preparación" si seguía como nuevo
    await DB.prepare("UPDATE pedidos SET servidos = ?2, actualizado = ?3, estado = CASE WHEN estado = 'nuevo' THEN 'preparando' ELSE estado END WHERE id = ?1")
      .bind(id, JSON.stringify(serv), Date.now()).run();
    return responder(200, { ok: true, servidos: serv });
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
  if (estado === "listo") {
    const p = await DB.prepare("SELECT items FROM pedidos WHERE id = ?1").bind(id).first();
    const todo = p && p.items ? JSON.parse(p.items).map((it) => it.cantidad) : [];
    await DB.prepare("UPDATE pedidos SET estado = ?2, actualizado = ?3, servidos = ?4 WHERE id = ?1").bind(id, estado, Date.now(), JSON.stringify(todo)).run();
  } else {
    await DB.prepare("UPDATE pedidos SET estado = ?2, actualizado = ?3 WHERE id = ?1").bind(id, estado, Date.now()).run();
  }
  return responder(200, { ok: true });
}
