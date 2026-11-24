// =============================================================
//  GET /api/carta  → la carta que ve el cliente, con los cambios
//  hechos desde la cocina (agotados, precios, plato del día) y si
//  el local está abierto ahora. Si viene ?mesa=N&k=código, dice si
//  ese QR es válido.
// =============================================================

import { cartaEfectiva, estadoHorario, mesaAutorizada, responder } from "../_db.js";

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const R = await cartaEfectiva(env, request.url);
  delete R.telegram_chat_id;                       // no hace falta en el celular del cliente
  const mesa = Number(url.searchParams.get("mesa"));
  const exigeQR = !!String(env.MESA_SECRETO ?? "").trim();
  const mesaValida = Number.isInteger(mesa) && mesa >= 1 && mesa <= Number(R.mesas || 0)
    ? await mesaAutorizada(env, mesa, url.searchParams.get("k"))
    : false;
  return responder(200, { ok: true, carta: R, horario: estadoHorario(R), exigeQR, mesaValida });
}
