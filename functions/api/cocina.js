// =============================================================
//  Datos para la pantalla de cocina (/cocina).
//  GET  → pedidos del día que no están listos + resumen de caja
//  POST → cambiar el estado de un pedido: nuevo → recibido → preparando → listo
//  Pide la clave guardada en Cloudflare como variable secreta COCINA_CLAVE.
// =============================================================

import { diaDeTrabajo, prepararTablas, responder } from "../_db.js";

const ESTADOS = ["nuevo", "recibido", "preparando", "listo"];

function autorizado(request, env) {
  const clave = String(env.COCINA_CLAVE ?? "").trim();
  const dada = String(request.headers.get("x-clave") ?? "").trim();
  if (!clave) return { ok: false, res: responder(500, { ok: false, error: "Falta COCINA_CLAVE en Cloudflare" }) };
  if (dada !== clave) return { ok: false, res: responder(401, { ok: false, error: "Clave incorrecta" }) };
  return { ok: true };
}

export async function onRequestGet({ request, env }) {
  const a = autorizado(request, env); if (!a.ok) return a.res;
  if (!env.DB) return responder(500, { ok: false, error: "Falta conectar la base de datos (DB)" });
  await prepararTablas(env.DB);
  const hoy = diaDeTrabajo();
  const [lista, resumen, hechos] = await env.DB.batch([
    // Pendientes de hoy, y también los de ayer que quedaron sin terminar
    env.DB.prepare("SELECT id, numero, tipo, mesa, items, notas, total, estado, creado, actualizado FROM pedidos " +
      "WHERE estado != 'listo' AND creado > ?1 ORDER BY id").bind(Date.now() - 18 * 3600 * 1000),
    env.DB.prepare("SELECT n, total FROM contador WHERE dia = ?1").bind(hoy),
    // Pedidos ya preparados hoy (los más recientes primero)
    env.DB.prepare("SELECT id, numero, mesa, items, notas, total, creado, actualizado FROM pedidos " +
      "WHERE dia = ?1 AND tipo = 'pedido' AND estado = 'listo' ORDER BY actualizado DESC LIMIT 300").bind(hoy),
  ]);
  const pedidos = lista.results.map((p) => ({ ...p, items: p.items ? JSON.parse(p.items) : [] }));
  const r = resumen.results[0] || { n: 0, total: 0 };
  const listos = hechos.results.map((p) => ({ ...p, items: p.items ? JSON.parse(p.items) : [] }));
  return responder(200, { ok: true, dia: hoy, ahora: Date.now(), pedidos, listos, hoy: { pedidos: r.n, total: r.total } });
}

export async function onRequestPost({ request, env }) {
  const a = autorizado(request, env); if (!a.ok) return a.res;
  if (!env.DB) return responder(500, { ok: false, error: "Falta conectar la base de datos (DB)" });
  let d; try { d = await request.json(); } catch { return responder(400, { ok: false, error: "Datos inválidos" }); }
  const id = Number(d.id), estado = String(d.estado);
  if (!Number.isInteger(id) || !ESTADOS.includes(estado)) return responder(400, { ok: false, error: "Datos inválidos" });
  await prepararTablas(env.DB);
  await env.DB.prepare("UPDATE pedidos SET estado = ?2, actualizado = ?3 WHERE id = ?1").bind(id, estado, Date.now()).run();
  return responder(200, { ok: true });
}
