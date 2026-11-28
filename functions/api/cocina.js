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
//  POST {accion:"tomar", para:"mesa"|"telefono", mesa?, items, notas?, cliente?, pago?} → el mesero anota un pedido a mano
//  POST {accion:"enviar_caja", id} / {accion:"devolver_caja", id} → mandar la cuenta a caja (o sacarla)
//  GET ?carta=1                    → carta con agotados/precios/plato del día
//  GET ?stats=7                    → estadísticas de los últimos N días
//  POST {accion:"plato", id, agotado?, precio?}   → cambiar un plato
//  POST {accion:"promo", id, texto} / {accion:"promo"} → plato del día / quitarlo
// =============================================================

import { hoyEcuador, prepararTablas, jornadaAbierta, resumenJornada, detalleCuenta, cartaEfectiva, cobrarCuenta, anularPedido, CUENTA_VENCE, responder,
  cuentaAbierta, contar, limpiar, sinBasura, enviarTelegram } from "../_db.js";

const METODOS = ["Efectivo", "Transferencia"];          // el local no acepta tarjeta

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
      "SELECT id, fecha, abierta, cerrada, n, total FROM jornadas WHERE cerrada IS NOT NULL ORDER BY fecha DESC, cerrada DESC LIMIT 1200"
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
    return responder(200, { ok: true, platos: R.platos.map((p) => ({ id: p.id, nombre: p.nombre, precio: p.precio, original: original[p.id], agotado: !!p.agotado, categoria: p.categoria || "", tipo: p.tipo || undefined, llevar_de: p.llevar_de || undefined })), recargo_llevar: R.recargo_llevar, promo: R.promo || null });
  }
  // Estadísticas
  if (url.searchParams.get("stats")) {
    const dias = Math.min(Math.max(Number(url.searchParams.get("stats")) || 7, 1), 90);
    const desde = Date.now() - dias * 86400000;
    const { results } = await DB.prepare("SELECT items, total, creado FROM pedidos WHERE tipo = 'pedido' AND creado >= ?1 AND jornada IN (SELECT id FROM jornadas) LIMIT 20000").bind(desde).all();
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
  const consultar = (indice) => DB.batch([
    DB.prepare("SELECT id, numero, tipo, mesa, items, notas, total, estado, creado, actualizado, por, cuenta, servidos, para, " +
      "(SELECT MIN(q.id) FROM pedidos q WHERE q.cuenta = pedidos.cuenta AND q.tipo = 'pedido') AS primero, " +
      "(SELECT c.total FROM cuentas c WHERE c.id = pedidos.cuenta) AS cuenta_total, " +
      "COALESCE(pago, (SELECT c.pago_pref FROM cuentas c WHERE c.id = pedidos.cuenta)) AS pago, " +
      "(SELECT c.id FROM cuentas c WHERE c.id = pedidos.cuenta AND c.cerrada IS NULL) AS cuenta_abierta " +
      `FROM pedidos ${indice} WHERE estado != 'listo' ORDER BY id LIMIT 200`),
    DB.prepare("SELECT id, numero, mesa, items, notas, total, creado, actualizado, cuenta, pago, para, " +
      "(SELECT c.cerrada FROM cuentas c WHERE c.id = pedidos.cuenta) AS cuenta_cerrada FROM pedidos " +
      "WHERE jornada = ?1 AND tipo = 'pedido' AND estado = 'listo' ORDER BY actualizado DESC LIMIT 400").bind(j ? j.id : -1),
  ]);
  // con el índice lee solo los pedidos pendientes; si por algo no existiera, igual funciona sin él
  // las ventas anuladas no cuentan como pedidos del día
  let anuladasHoy = 0;
  if (j) { try { anuladasHoy = (await DB.prepare("SELECT COUNT(*) AS n FROM pedidos WHERE jornada = ?1 AND tipo = 'anulado'").bind(j.id).first()).n || 0; } catch (e) {} }
  let pend, hechos;
  try { [pend, hechos] = await consultar("INDEXED BY pedidos_pendientes"); } catch (e) { [pend, hechos] = await consultar(""); }
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
    hoy: { pedidos: j ? j.n - anuladasHoy : 0, total: j ? j.total : 0 },
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

  // ---- El mesero anota un pedido a mano (cliente sin QR o pedido por teléfono) ----
  if (d.accion === "tomar") {
    const j = await jornadaAbierta(DB, false);
    if (!j) return responder(409, { ok: false, error: "No hay un día de trabajo abierto. Ábrelo en Caja." });
    const R = await cartaEfectiva(env, request.url);
    const para = d.para === "telefono" ? "telefono" : "mesa";
    const mesa = para === "mesa" ? Number(d.mesa) : 0;
    if (para === "mesa" && !(Number.isInteger(mesa) && mesa >= 1 && mesa <= Number(R.mesas || 0)))
      return responder(400, { ok: false, error: "Elige la mesa" });
    const porId = new Map(R.platos.map((p) => [p.id, p]));
    const lista = (Array.isArray(d.items) ? d.items.slice(0, 60) : [])
      .map((it) => ({ p: porId.get(String(it.id)), cantidad: Math.floor(Number(it.cantidad)) }))
      // Por pedido (teléfono) todos los platos van en tarrina: se cobran como "para llevar"
      .map((it) => (para === "telefono" && it.p && !it.p.llevar_de && porId.has(it.p.id + "~llevar") ? { ...it, p: porId.get(it.p.id + "~llevar") } : it))
      .filter((it) => it.p && !it.p.agotado && it.cantidad >= 1 && it.cantidad <= 99);
    if (!lista.length) return responder(400, { ok: false, error: "No hay platos en el pedido" });
    const items = lista.map((it) => ({ nombre: it.p.nombre, cantidad: it.cantidad, precio: Number(it.p.precio) }));
    const total = Math.round(items.reduce((t, it) => t + it.cantidad * it.precio, 0) * 100) / 100;
    const notas = String(d.notas ?? "").replace(/[<>]/g, "").slice(0, 300).trim();
    const cliente = String(d.cliente ?? "").replace(/[<>]/g, "").slice(0, 60).trim();
    if (para === "telefono" && cliente.length < 2) return responder(400, { ok: false, error: "Escribe el nombre o número del cliente" });
    const pago = null;                                            // cómo pagan lo marca la caja al cobrar
    if (para === "telefono" && !pago) return responder(400, { ok: false, error: "Elige cómo va a pagar" });
    const ahora = Date.now();
    const { numero, totalDia } = await contar(DB, j.id, total);
    let c;
    if (para === "mesa") c = await cuentaAbierta(DB, mesa, j.id, true);
    else {                                   // cada pedido por teléfono es su propia cuenta y va directo a caja
      const marca = -ahora;                  // número interno (negativo) para no chocar con las mesas
      await DB.prepare("INSERT INTO cuentas (mesa, jornada, abierta, actualizada, enviada, cliente, pago_pref) VALUES (?1, ?2, ?3, ?3, ?3, ?4, ?5)")
        .bind(marca, j.id, ahora, cliente || null, pago).run();
      c = await DB.prepare("SELECT * FROM cuentas WHERE mesa = ?1 AND cerrada IS NULL").bind(marca).first();
    }
    const rr = await DB.prepare("UPDATE cuentas SET total = total + ?2, pedidos = pedidos + 1, actualizada = ?3 WHERE id = ?1 RETURNING total, pedidos").bind(c.id, total, ahora).first();
    if (pago && para === "mesa") await DB.prepare("UPDATE cuentas SET pago_pref = COALESCE(pago_pref, ?2) WHERE id = ?1").bind(c.id, pago).run();
    await DB.prepare(
      "INSERT INTO pedidos (dia, numero, tipo, mesa, items, notas, total, estado, creado, actualizado, jornada, cuenta, por, pago, para) " +
      "VALUES (?1, ?2, 'pedido', ?3, ?4, ?5, ?6, 'preparando', ?7, ?7, ?8, ?9, ?10, ?11, ?12)"
    ).bind(hoyEcuador(ahora), numero, mesa, JSON.stringify(items), notas, total, ahora, j.id, c.id, para === "telefono" ? (cliente || "Por teléfono") : "Mesero", pago, para === "telefono" ? "telefono" : null).run();
    try {                                    // aviso a Telegram (si falla, igual queda en la pantalla)
      let TOKEN = sinBasura(env.TELEGRAM_TOKEN); if (TOKEN.toLowerCase().startsWith("bot")) TOKEN = TOKEN.slice(3);
      const CHAT = sinBasura(R.telegram_chat_id).replace(/\s/g, "");
      const hora = new Date(ahora).toLocaleTimeString("es-EC", { timeZone: "America/Guayaquil", hour: "2-digit", minute: "2-digit" });
      let t = `🔔 <b>PEDIDO #${numero}</b> (mesero)\n${para === "telefono" ? `📞 <b>POR TELÉFONO</b>${cliente ? " · " + limpiar(cliente, 60) : ""}` : `🍽️ <b>MESA ${mesa}</b>`}   🕐 ${hora}\n\n`;
      for (const it of items) t += `• <b>${it.cantidad} x</b> ${limpiar(it.nombre, 60)}  —  $${(it.cantidad * it.precio).toFixed(2)}\n`;
      t += `\n💰 <b>Total: $${total.toFixed(2)}</b>${pago ? `\n💳 Pagará con: <b>${pago}</b>` : ""}`;
      if (notas) t += `\n\n📝 <b>Indicaciones:</b> ${limpiar(notas, 300)}`;
      t += `\n\n📊 Hoy van <b>${numero}</b> pedidos · $${Number(totalDia).toFixed(2)} vendidos`;
      await enviarTelegram(TOKEN, CHAT, t);
    } catch (e) { console.log("Telegram mesero:", String(e)); }
    return responder(200, { ok: true, numero, total, cuenta: { id: c.id, total: rr.total } });
  }

  // ---- Mandar la cuenta a caja para que cobren (o sacarla si fue por error) ----
  if (d.accion === "enviar_caja" || d.accion === "devolver_caja") {
    const r = await DB.prepare("UPDATE cuentas SET enviada = ?2 WHERE id = ?1 AND cerrada IS NULL").bind(Number(d.id), d.accion === "enviar_caja" ? Date.now() : null).run();
    return responder(200, { ok: true, cambio: r.meta ? r.meta.changes : null });
  }

  // ---- Anular un pedido (por error, cliente se fue, broma) ----
  if (d.accion === "anular") {
    const j = await jornadaAbierta(DB, false);
    if (!j) return responder(409, { ok: false, error: "No hay un día de trabajo abierto" });
    const r = await anularPedido(DB, j, Number(d.id), d.motivo);
    return r.status === 200 ? responder(200, { ok: true }) : responder(r.status, { ok: false, error: r.error });
  }

  // ---- Cobrar: cerrar la cuenta de una mesa ----
  if (d.accion === "cobrar") {
    const id = Number(d.id);
    if (!Number.isInteger(id)) return responder(400, { ok: false, error: "Datos inválidos" });
    const r = await cobrarCuenta(DB, id, d.metodo, d.partes);
    return responder(200, { ok: true, ...r });
  }

  // ---- Carta: agotado / precio de un plato ----
  if (d.accion === "plato") {
    const R = await cartaEfectiva(env, request.url);
    const p = R.platos.find((x) => x.id === String(d.id) && !x.llevar_de);
    if (!p) return responder(404, { ok: false, error: "Ese plato no existe" });
    const actual = await DB.prepare("SELECT valor, actualizado FROM ajustes WHERE clave = ?1").bind("plato:" + p.id).first();
    const v = actual ? JSON.parse(actual.valor) : {};
    // Un precio guardado antes de "precios_desde" ya no vale: no hay que revivirlo al marcar agotado
    if (actual && Number(actual.actualizado) <= (Number(R.precios_desde) || 0)) delete v.precio;
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
  // ---- Editar menú: agregar una bebida o un adicional ----
  if (d.accion === "nuevo_item") {
    const categoria = d.categoria === "Adicionales" ? "Adicionales" : d.categoria === "Bebidas" ? "Bebidas" : null;
    const nombre = String(d.nombre ?? "").replace(/[<>"'`]/g, "").replace(/\s+/g, " ").trim().slice(0, 40);
    const precio = Math.round(Number(String(d.precio ?? "").replace(",", ".")) * 100) / 100;
    if (!categoria) return responder(400, { ok: false, error: "Elige si es bebida o adicional" });
    // Las bebidas van en Gaseosas, Jugos o Cervezas
    const tipo = categoria === "Bebidas" ? (["Gaseosas", "Jugos", "Cervezas"].includes(d.tipo) ? d.tipo : null) : undefined;
    if (categoria === "Bebidas" && !tipo) return responder(400, { ok: false, error: "Elige si es gaseosa, jugo o cerveza" });
    if (nombre.length < 2) return responder(400, { ok: false, error: "Escribe el nombre" });
    if (!(precio > 0 && precio <= 1000)) return responder(400, { ok: false, error: "Precio no válido" });
    const R = await cartaEfectiva(env, request.url);
    if (R.platos.some((p) => p.nombre.toLowerCase() === nombre.toLowerCase())) return responder(409, { ok: false, error: "Ya hay algo con ese nombre en el menú" });
    const id = "x-" + nombre.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) + "-" + Date.now().toString(36).slice(-4);
    await DB.prepare("INSERT INTO ajustes (clave, valor, actualizado) VALUES (?1, ?2, ?3)").bind("extra:" + id, JSON.stringify({ id, nombre, precio, categoria, tipo }), Date.now()).run();
    return responder(200, { ok: true, id });
  }
  // ---- Editar menú: quitar una bebida o un adicional ----
  if (d.accion === "quitar_item") {
    const R = await cartaEfectiva(env, request.url);
    const p = R.platos.find((x) => x.id === String(d.id) && !x.llevar_de);
    if (!p) return responder(404, { ok: false, error: "No existe" });
    if (!["Bebidas", "Adicionales"].includes(p.categoria)) return responder(400, { ok: false, error: "Los platos no se quitan desde aquí" });
    if (p.agregado) await DB.batch([DB.prepare("DELETE FROM ajustes WHERE clave = ?1").bind("extra:" + p.id), DB.prepare("DELETE FROM ajustes WHERE clave = ?1").bind("plato:" + p.id)]);
    else {
      const actual = await DB.prepare("SELECT valor FROM ajustes WHERE clave = ?1").bind("plato:" + p.id).first();
      const v = actual ? JSON.parse(actual.valor) : {}; v.oculto = true;
      await DB.prepare("INSERT INTO ajustes (clave, valor, actualizado) VALUES (?1, ?2, ?3) ON CONFLICT(clave) DO UPDATE SET valor = ?2, actualizado = ?3").bind("plato:" + p.id, JSON.stringify(v), Date.now()).run();
    }
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
        DB.prepare(`DELETE FROM cuentas WHERE jornada IN (${marcas}) AND cerrada IS NOT NULL`).bind(...ids),
        DB.prepare(`DELETE FROM jornadas WHERE id IN (${marcas}) AND cerrada IS NOT NULL`).bind(...ids),
      ]);
    }
    // Pedidos viejos que no pertenecen a ningún día (de antes de existir "Día laboral")
    if (d.alcance === "todo") {
      await DB.batch([
        DB.prepare("DELETE FROM pedidos WHERE (jornada IS NULL OR jornada NOT IN (SELECT id FROM jornadas)) AND estado = 'listo'"),
        DB.prepare("DELETE FROM cuentas WHERE cerrada IS NOT NULL AND (jornada IS NULL OR jornada NOT IN (SELECT id FROM jornadas))"),
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
