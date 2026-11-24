// =============================================================
//  CARRITO COMPARTIDO POR MESA
//  Todos los celulares que escanean el QR de la misma mesa ven y
//  editan el mismo carrito. Cualquiera puede enviar el pedido.
//
//  GET  /api/mesa?mesa=3&yo=<id del celular>&nombre=Andy&ping=1
//       → carrito de la mesa, quiénes están conectados y el último pedido
//  POST /api/mesa {mesa, yo, nombre, plato, delta}
//       → suma o resta un plato del carrito de la mesa
//
//  "yo" es un código al azar que cada celular guarda; no identifica a nadie.
//  Un carrito sin movimiento por 3 horas se considera vacío (mesa nueva).
// =============================================================

import { prepararTablas, cuentaAbierta, detalleCuenta, responder } from "../_db.js";

const VENCE = 3 * 3600 * 1000;     // carrito viejo = vacío
const CONECTADO = 25 * 1000;       // visto en los últimos 25 s = está en la mesa
const limpio = (t, max) => String(t ?? "").replace(/[<>"'`]/g, "").trim().slice(0, max);

async function restaurante(env, url) {
  return (await env.ASSETS.fetch(new URL("/restaurante.json", url))).json();
}

async function leerMesa(DB, mesa, yo) {
  const ahora = Date.now();
  const [c, gente] = await DB.batch([
    DB.prepare("SELECT lineas, version, actualizado, ultimo FROM carritos WHERE mesa = ?1").bind(mesa),
    DB.prepare("SELECT yo, nombre FROM presencia WHERE mesa = ?1 AND visto > ?2 ORDER BY visto").bind(mesa, ahora - CONECTADO),
  ]);
  const fila = c.results[0];
  const viejo = !fila || ahora - fila.actualizado > VENCE;
  // Lo que la mesa ya pidió (cuenta abierta)
  const cta = await cuentaAbierta(DB, mesa, null, false);
  const cuenta = cta && cta.pedidos > 0 ? await detalleCuenta(DB, cta) : null;
  return {
    cuenta,
    ok: true,
    version: fila ? fila.version : 0,
    lineas: viejo ? [] : JSON.parse(fila.lineas || "[]"),
    ultimo: fila && fila.ultimo && !viejo ? JSON.parse(fila.ultimo) : null,
    personas: gente.results.map((g) => ({ nombre: g.nombre || "", soyYo: g.yo === yo })),
  };
}

function validarMesa(R, mesa) {
  return Number.isInteger(mesa) && mesa >= 1 && mesa <= Number(R.mesas || 0);
}

export async function onRequestGet({ request, env }) {
  if (!env.DB) return responder(503, { ok: false, error: "Sin base de datos" });
  const url = new URL(request.url);
  const mesa = Number(url.searchParams.get("mesa"));
  const yo = limpio(url.searchParams.get("yo"), 40);
  const R = await restaurante(env, request.url);
  if (!validarMesa(R, mesa) || !yo) return responder(400, { ok: false, error: "Datos inválidos" });
  await prepararTablas(env.DB);
  // Avisar "estoy en la mesa" (el celular lo pide cada ~15 s, no en cada consulta)
  if (url.searchParams.get("ping")) {
    await env.DB.prepare("INSERT INTO presencia (mesa, yo, nombre, visto) VALUES (?1, ?2, ?3, ?4) " +
      "ON CONFLICT(mesa, yo) DO UPDATE SET nombre = ?3, visto = ?4")
      .bind(mesa, yo, limpio(url.searchParams.get("nombre"), 20), Date.now()).run();
  }
  return responder(200, await leerMesa(env.DB, mesa, yo));
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) return responder(503, { ok: false, error: "Sin base de datos" });
  let d; try { d = await request.json(); } catch { return responder(400, { ok: false, error: "Datos inválidos" }); }
  const R = await restaurante(env, request.url);
  const mesa = Number(d.mesa), yo = limpio(d.yo, 40), nombre = limpio(d.nombre, 20);
  const delta = Math.sign(Number(d.delta)) || 0;
  const plato = (R.platos || []).find((p, i) => (p.id || "p" + i) === String(d.plato));
  if (!validarMesa(R, mesa) || !yo || !delta || !plato) return responder(400, { ok: false, error: "Datos inválidos" });
  if (delta > 0 && plato.agotado) return responder(409, { ok: false, error: "Ese plato está agotado" });
  const pid = plato.id;
  await prepararTablas(env.DB);

  // Varias personas pueden tocar al mismo tiempo: se guarda solo si nadie cambió
  // el carrito mientras tanto; si no, se vuelve a intentar con lo más nuevo.
  for (let intento = 0; intento < 6; intento++) {
    const fila = await env.DB.prepare("SELECT lineas, version, actualizado FROM carritos WHERE mesa = ?1").bind(mesa).first();
    const ahora = Date.now();
    const version = fila ? fila.version : 0;
    let lineas = fila && ahora - fila.actualizado <= VENCE ? JSON.parse(fila.lineas || "[]") : [];

    if (delta > 0) {
      const total = lineas.filter((l) => l.p === pid).reduce((t, l) => t + l.q, 0);
      if (total >= 50) return responder(409, { ok: false, error: "Máximo 50 por plato" });
      const mia = lineas.find((l) => l.p === pid && l.por === yo);
      if (mia) { mia.q++; mia.n = nombre; } else lineas.push({ p: pid, q: 1, por: yo, n: nombre, t: ahora });
    } else {
      // Resta primero de lo que agregó esta persona; si no tiene, de lo de otro
      const mia = lineas.find((l) => l.p === pid && l.por === yo) || lineas.filter((l) => l.p === pid).at(-1);
      if (mia) mia.q--;
      lineas = lineas.filter((l) => l.q > 0);
    }
    lineas = lineas.slice(0, 80);

    const r = fila
      ? await env.DB.prepare("UPDATE carritos SET lineas = ?2, version = version + 1, actualizado = ?3 WHERE mesa = ?1 AND version = ?4")
          .bind(mesa, JSON.stringify(lineas), ahora, version).run()
      : await env.DB.prepare("INSERT OR IGNORE INTO carritos (mesa, lineas, version, actualizado) VALUES (?1, ?2, 1, ?3)")
          .bind(mesa, JSON.stringify(lineas), ahora).run();
    if (r.meta?.changes ?? r.changes ?? 1) {
      await env.DB.prepare("INSERT INTO presencia (mesa, yo, nombre, visto) VALUES (?1, ?2, ?3, ?4) " +
        "ON CONFLICT(mesa, yo) DO UPDATE SET nombre = ?3, visto = ?4").bind(mesa, yo, nombre, ahora).run();
      return responder(200, await leerMesa(env.DB, mesa, yo));
    }
  }
  return responder(409, { ok: false, error: "Mucha gente tocando a la vez, intenta de nuevo" });
}
