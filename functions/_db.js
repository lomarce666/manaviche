// =============================================================
//  Base de datos de pedidos (Cloudflare D1, variable DB).
//  Los archivos que empiezan con "_" no son páginas: son ayudas
//  compartidas por las funciones de /api.
//
//  DÍAS DE TRABAJO (tabla jornadas): la cocina abre un día con
//  "Nuevo día laboral" y lo cierra con "Culminar día de trabajo".
//  Los pedidos se numeran 1, 2, 3… dentro de cada día. Si llega un
//  pedido y no hay un día abierto, se abre solo con la fecha de hoy.
// =============================================================

export const hoyEcuador = (ms = Date.now()) =>
  new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/Guayaquil" });   // AAAA-MM-DD

let listo = false;
export async function prepararTablas(DB) {
  if (listo) return;
  await DB.batch([
    DB.prepare(`CREATE TABLE IF NOT EXISTS pedidos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dia TEXT NOT NULL, numero INTEGER, tipo TEXT NOT NULL, mesa INTEGER NOT NULL,
      items TEXT, notas TEXT, total REAL NOT NULL DEFAULT 0,
      estado TEXT NOT NULL DEFAULT 'nuevo', creado INTEGER NOT NULL, actualizado INTEGER NOT NULL)`),
    DB.prepare(`CREATE TABLE IF NOT EXISTS jornadas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fecha TEXT NOT NULL, abierta INTEGER NOT NULL, cerrada INTEGER,
      n INTEGER NOT NULL DEFAULT 0, total REAL NOT NULL DEFAULT 0, resumen TEXT)`),
    // Solo puede haber UN día abierto a la vez
    DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS una_jornada_abierta ON jornadas ((cerrada IS NULL)) WHERE cerrada IS NULL"),
    // Carrito compartido de cada mesa y quién lo está usando
    DB.prepare("CREATE TABLE IF NOT EXISTS carritos (mesa INTEGER PRIMARY KEY, lineas TEXT NOT NULL DEFAULT '[]', version INTEGER NOT NULL DEFAULT 0, actualizado INTEGER NOT NULL DEFAULT 0, ultimo TEXT)"),
    DB.prepare("CREATE TABLE IF NOT EXISTS presencia (mesa INTEGER NOT NULL, yo TEXT NOT NULL, nombre TEXT, visto INTEGER NOT NULL, PRIMARY KEY (mesa, yo))"),
    // Cuenta de cada mesa: suma todos los pedidos de la mesa hasta que se cobra
    DB.prepare("CREATE TABLE IF NOT EXISTS cuentas (id INTEGER PRIMARY KEY AUTOINCREMENT, mesa INTEGER NOT NULL, jornada INTEGER, abierta INTEGER NOT NULL, actualizada INTEGER NOT NULL, cerrada INTEGER, total REAL NOT NULL DEFAULT 0, pedidos INTEGER NOT NULL DEFAULT 0)"),
    DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS una_cuenta_por_mesa ON cuentas (mesa) WHERE cerrada IS NULL"),
    // Cambios hechos desde la cocina: agotados, precios y plato del día (sin tocar GitHub)
    DB.prepare("CREATE TABLE IF NOT EXISTS ajustes (clave TEXT PRIMARY KEY, valor TEXT NOT NULL, actualizado INTEGER NOT NULL)"),
  ]);
  // Columna nueva en bases creadas antes (si ya existe, no pasa nada)
  try { await DB.prepare("ALTER TABLE pedidos ADD COLUMN jornada INTEGER").run(); } catch {}
  try { await DB.prepare("CREATE INDEX IF NOT EXISTS pedidos_jornada ON pedidos (jornada, estado)").run(); } catch {}
  try { await DB.prepare("ALTER TABLE pedidos ADD COLUMN cuenta INTEGER").run(); } catch {}
  try { await DB.prepare("ALTER TABLE pedidos ADD COLUMN por TEXT").run(); } catch {}
  try { await DB.prepare("ALTER TABLE pedidos ADD COLUMN reparto TEXT").run(); } catch {}
  try { await DB.prepare("ALTER TABLE pedidos ADD COLUMN servidos TEXT").run(); } catch {}
  try { await DB.prepare("ALTER TABLE cuentas ADD COLUMN metodo TEXT").run(); } catch {}
  try { await DB.prepare("ALTER TABLE cuentas ADD COLUMN pago_pref TEXT").run(); } catch {}
  try { await DB.prepare("ALTER TABLE pedidos ADD COLUMN pago TEXT").run(); } catch {}
  try { await DB.prepare("ALTER TABLE pedidos ADD COLUMN para TEXT").run(); } catch {}        // caja: 'mostrador' / 'llevar'
  try { await DB.prepare("ALTER TABLE jornadas ADD COLUMN fondo REAL").run(); } catch {}      // efectivo con que se abre la caja
  try { await DB.prepare("ALTER TABLE jornadas ADD COLUMN arqueo TEXT").run(); } catch {}     // conteo al cerrar la caja
  try { await DB.prepare("ALTER TABLE pedidos ADD COLUMN anulado TEXT").run(); } catch {}
  try { await DB.prepare("ALTER TABLE cuentas ADD COLUMN enviada INTEGER").run(); } catch {}  // cuándo el mesero la mandó a caja
  try { await DB.prepare("ALTER TABLE cuentas ADD COLUMN cliente TEXT").run(); } catch {}    // pedidos por teléfono: nombre o número     // {motivo, hora} si se anuló
  // Salidas de dinero de la caja (pago a proveedores, compras, adelantos…)
  try { await DB.prepare("CREATE TABLE IF NOT EXISTS movimientos (id INTEGER PRIMARY KEY AUTOINCREMENT, jornada INTEGER NOT NULL, monto REAL NOT NULL, motivo TEXT NOT NULL, creado INTEGER NOT NULL)").run(); } catch {}
  try { await DB.prepare("CREATE INDEX IF NOT EXISTS movimientos_jornada ON movimientos (jornada)").run(); } catch {}
  // Índices: la cocina pregunta cada 3 s; así cada consulta lee pocas filas aunque haya meses de pedidos
  // (el plan gratis de Cloudflare D1 permite 5 millones de filas leídas por día)
  for (const q of [
    "CREATE INDEX IF NOT EXISTS pedidos_pendientes ON pedidos (estado) WHERE estado != 'listo'",
    "CREATE INDEX IF NOT EXISTS pedidos_cuenta ON pedidos (cuenta, tipo)",
    "CREATE INDEX IF NOT EXISTS pedidos_creado ON pedidos (creado)",
    "CREATE INDEX IF NOT EXISTS cuentas_jornada ON cuentas (jornada)",
  ]) { try { await DB.prepare(q).run(); } catch {} }
  listo = true;
}

// Día de trabajo abierto; si no hay y `crear` es true, abre uno con la fecha de hoy
export async function jornadaAbierta(DB, crear = false) {
  let j = await DB.prepare("SELECT * FROM jornadas WHERE cerrada IS NULL").first();
  if (!j && crear) {
    await DB.prepare("INSERT OR IGNORE INTO jornadas (fecha, abierta) VALUES (?1, ?2)").bind(hoyEcuador(), Date.now()).run();
    j = await DB.prepare("SELECT * FROM jornadas WHERE cerrada IS NULL").first();
  }
  return j || null;
}

// Una mesa sin pedidos nuevos en 3 horas: su cuenta se cierra sola
export const CUENTA_VENCE = 3 * 3600 * 1000;

// Cuenta abierta de una mesa (cierra la vieja si venció); si `crear`, abre una nueva
export async function cuentaAbierta(DB, mesa, jornada, crear = false) {
  const ahora = Date.now();
  let c = await DB.prepare("SELECT * FROM cuentas WHERE mesa = ?1 AND cerrada IS NULL").bind(mesa).first();
  if (c && ahora - c.actualizada > CUENTA_VENCE) {
    await DB.prepare("UPDATE cuentas SET cerrada = ?2 WHERE id = ?1").bind(c.id, ahora).run();
    c = null;
  }
  if (!c && crear) {
    await DB.prepare("INSERT OR IGNORE INTO cuentas (mesa, jornada, abierta, actualizada) VALUES (?1, ?2, ?3, ?3)").bind(mesa, jornada, ahora).run();
    c = await DB.prepare("SELECT * FROM cuentas WHERE mesa = ?1 AND cerrada IS NULL").bind(mesa).first();
  }
  return c || null;
}

// Detalle de una cuenta: cada pedido y los platos sumados
export async function detalleCuenta(DB, c) {
  const { results } = await DB.prepare(
    "SELECT id, numero, items, total, creado, por, estado, reparto, servidos, pago FROM pedidos WHERE cuenta = ?1 AND tipo = 'pedido' ORDER BY id"
  ).bind(c.id).all();
  const pedidos = results.map((p) => ({ ...p, items: p.items ? JSON.parse(p.items) : [], reparto: p.reparto ? JSON.parse(p.reparto) : null, servidos: p.servidos ? JSON.parse(p.servidos) : [] }));
  // Cuánto le toca a cada persona (según quién agregó cada plato)
  const personas = {};
  for (const p of pedidos) {
    const precio = Object.fromEntries(p.items.map((it) => [it.nombre, it.precio]));
    const partes = p.reparto && p.reparto.length ? p.reparto : [{ n: p.por || "", nombre: null, todo: true }];
    for (const r of partes) {
      const quien = (r.n || "").trim() || "Sin nombre";
      personas[quien] = personas[quien] || { nombre: quien, total: 0 };
      if (r.todo) personas[quien].total += p.total;
      else personas[quien].total += (precio[r.plato] || 0) * r.q;
    }
  }
  const platos = {};
  for (const p of pedidos) for (const it of p.items) {
    platos[it.nombre] = platos[it.nombre] || { nombre: it.nombre, cantidad: 0, precio: it.precio, total: 0 };
    platos[it.nombre].cantidad += it.cantidad; platos[it.nombre].total += it.cantidad * it.precio;
  }
  // Cuánto se paga con cada forma de pago (cada pedido guarda la suya)
  // y qué platos van con cada forma (ej. 3 platos por transferencia y 1 en efectivo)
  const pp = {};
  for (const p of pedidos) {
    const k = p.pago || c.pago_pref || "Sin elegir";
    const g = (pp[k] = pp[k] || { metodo: k, total: 0, platos: {} });
    g.total = Math.round((g.total + p.total) * 100) / 100;
    for (const it of p.items) {
      const x = (g.platos[it.nombre] = g.platos[it.nombre] || { nombre: it.nombre, cantidad: 0, total: 0 });
      x.cantidad += it.cantidad; x.total = Math.round((x.total + it.cantidad * it.precio) * 100) / 100;
    }
  }
  const porPago = Object.values(pp).map((g) => ({ ...g, platos: Object.values(g.platos) }));
  return { id: c.id, mesa: c.mesa, abierta: c.abierta, pago: c.pago_pref || null, porPago,
    enviada: c.enviada || null, cliente: c.cliente || null, telefono: c.mesa < 0, total: Math.round(c.total * 100) / 100, pedidos, platos: Object.values(platos),
    personas: Object.values(personas).map((x) => ({ ...x, total: Math.round(x.total * 100) / 100 })) };
}

// Resumen para hacer caja de un día de trabajo
export async function resumenJornada(DB, j) {
  const { results } = await DB.prepare(
    "SELECT numero, tipo, mesa, items, notas, total, estado, creado, para, anulado, cuenta, pago FROM pedidos WHERE jornada = ?1 ORDER BY id"
  ).bind(j.id).all();
  const pedidos = results.filter((p) => p.tipo === "pedido").map((p) => ({ ...p, items: p.items ? JSON.parse(p.items) : [] }));
  const platos = {}, mesas = {};
  for (const p of pedidos) {
    for (const it of p.items) {
      const k = it.nombre;
      platos[k] = platos[k] || { nombre: k, cantidad: 0, precio: it.precio, total: 0 };
      platos[k].cantidad += it.cantidad; platos[k].total += it.cantidad * it.precio;
    }
    const km = p.para === "telefono" ? "Pedidos por teléfono" : p.para && p.para !== "mesa" ? (p.para === "llevar" ? "Para llevar" : "Mostrador") : p.mesa;     // ventas sin mesa
    mesas[km] = mesas[km] || { mesa: km, pedidos: 0, total: 0 };
    mesas[km].pedidos++; mesas[km].total += p.total;
  }
  const total = pedidos.reduce((t, p) => t + p.total, 0);
  // Cobros por forma de pago (cuentas de mesa cerradas en este día)
  let pagos = [];
  try {
    // cada pedido cuenta con su propia forma de pago (una mesa puede pagar parte en efectivo y parte por transferencia)
    const ps = (await DB.prepare("SELECT p.total, p.pago, p.cuenta, c.metodo, c.cerrada FROM pedidos p LEFT JOIN cuentas c ON c.id = p.cuenta " +
      "WHERE p.jornada = ?1 AND p.tipo = 'pedido'").bind(j.id).all()).results;
    const m = {};
    for (const p of ps) {
      const k = p.cuenta != null && p.cerrada == null ? "Sin cobrar" : (p.pago || (p.metodo && p.metodo !== "Mixto" ? p.metodo : "") || "Sin registrar");
      m[k] = m[k] || { metodo: k, cuentas: new Set(), total: 0 };
      m[k].cuentas.add(p.cuenta ?? "x" + Math.random()); m[k].total = Math.round((m[k].total + p.total) * 100) / 100;
    }
    pagos = Object.values(m).map((x) => ({ metodo: x.metodo, cuentas: x.cuentas.size, total: x.total }));
  } catch {}
  let caja = null; try { caja = await estadoCaja(DB, j); } catch {}
  // Detalle de cada mesa atendida y de cada pedido por teléfono: qué pidieron, cuánto y cómo pagaron
  let detalle = [];
  try {
    const cs = Object.fromEntries((await DB.prepare("SELECT id, mesa, cliente, abierta, cerrada, metodo FROM cuentas WHERE id IN (SELECT DISTINCT cuenta FROM pedidos WHERE jornada = ?1 AND cuenta IS NOT NULL)").bind(j.id).all()).results.map((c) => [c.id, c]));
    const g = {};
    for (const p of pedidos) {
      const k = p.cuenta != null ? "c" + p.cuenta : "p" + p.numero;
      const c = p.cuenta != null ? cs[p.cuenta] : null;
      if (!g[k]) g[k] = { tipo: p.para === "telefono" ? "telefono" : p.para === "llevar" || p.para === "mostrador" ? p.para : "mesa",
        mesa: p.mesa > 0 ? p.mesa : null, cliente: c ? c.cliente || null : null, desde: p.creado, cobrada: c ? !!c.cerrada : true,
        total: 0, platos: {}, pagos: {} };
      const x = g[k]; x.total += p.total;
      x.pagos[p.pago || (c && c.metodo && c.metodo !== "Mixto" ? c.metodo : "") || "Sin registrar"] = 1;
      for (const it of p.items) { const q = (x.platos[it.nombre] = x.platos[it.nombre] || { nombre: it.nombre, cantidad: 0, total: 0 }); q.cantidad += it.cantidad; q.total += it.cantidad * it.precio; }
    }
    detalle = Object.values(g).map((x) => ({ ...x, total: Math.round(x.total * 100) / 100, pagos: Object.keys(x.pagos),
      platos: Object.values(x.platos).map((q) => ({ ...q, total: Math.round(q.total * 100) / 100 })) }));
  } catch (e) { console.log("detalle", String(e)); }
  return {
    pagos, caja, detalle,
    anuladas: results.filter((p) => p.tipo === "anulado").map((p) => ({ numero: p.numero, total: p.total, para: p.para, mesa: p.mesa, ...(p.anulado ? JSON.parse(p.anulado) : {}) })),
    fecha: j.fecha, abierta: j.abierta, cerrada: j.cerrada || null,
    pedidos: pedidos.length, total: Math.round(total * 100) / 100,
    promedio: pedidos.length ? Math.round((total / pedidos.length) * 100) / 100 : 0,
    primero: pedidos[0]?.creado || null, ultimo: pedidos.at(-1)?.creado || null,
    pendientes: pedidos.filter((p) => p.estado !== "listo").length,
    mesero: results.filter((p) => p.tipo === "mesero").length,
    cuenta: results.filter((p) => p.tipo === "cuenta").length,
    platos: Object.values(platos).sort((a, b) => b.cantidad - a.cantidad),
    mesas: Object.values(mesas).sort((a, b) => (typeof a.mesa === "string") - (typeof b.mesa === "string") || (a.mesa > b.mesa ? 1 : -1)),
    lista: pedidos.map((p) => ({ numero: p.numero, mesa: p.mesa, para: p.para || null, total: p.total, creado: p.creado, items: p.items, notas: p.notas })),
  };
}

export const responder = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });


// =============================================================
//  CARTA EFECTIVA: restaurante.json + cambios hechos desde la cocina
//  (ajustes "plato:<id>" → {agotado, precio}; "promo" → {id, texto})
// =============================================================
export async function cartaEfectiva(env, url) {
  const R = await (await env.ASSETS.fetch(new URL("/restaurante.json", url))).json();
  R.platos = (R.platos || []).map((p, i) => ({ ...p, id: p.id || "p" + i }));
  if (env.DB) try {
    await prepararTablas(env.DB);
    const { results } = await env.DB.prepare("SELECT clave, valor FROM ajustes").all();
    const aj = Object.fromEntries(results.map((r) => [r.clave, JSON.parse(r.valor)]));
    R.platos = R.platos.map((p) => {
      const a = aj["plato:" + p.id];
      if (!a) return p;
      return { ...p, agotado: typeof a.agotado === "boolean" ? a.agotado : p.agotado, precio: Number.isFinite(a.precio) && a.precio > 0 ? a.precio : p.precio };
    });
    // (el plato del día ya no se usa)
  } catch (e) { console.log("Ajustes:", String(e)); }
  agregarParaLlevar(R);
  return R;
}

// Cada plato (no bebidas ni adicionales) tiene su versión "para llevar": va en tarrina y cuesta
// "recargo_llevar" más (restaurante.json, $0.25 si no se dice). Su id termina en "~llevar".
// Sigue al plato original en precio y agotado. No se muestra en la carta: se elige desde el carrito o el mesero.
export const SIN_LLEVAR = ["Bebidas", "Adicionales"];
export function agregarParaLlevar(R) {
  const rec = Number.isFinite(Number(R.recargo_llevar)) ? Number(R.recargo_llevar) : 0.25;
  const base = (R.platos || []).filter((p) => !p.llevar_de && !String(p.id).endsWith("~llevar") && !SIN_LLEVAR.includes(p.categoria || ""));
  R.platos = (R.platos || []).filter((p) => !p.llevar_de).concat(base.map((p) => ({
    id: p.id + "~llevar", nombre: p.nombre + " · para llevar", precio: Math.round((Number(p.precio) + rec) * 100) / 100,
    categoria: p.categoria || "", solo_carta: true, agotado: !!p.agotado, llevar_de: p.id, desc: "",
  })));
  R.recargo_llevar = rec;
  return R;
}

// ¿Está abierto ahora? (hora de Ecuador). Sin horario = siempre abierto.
export function estadoHorario(R, ms = Date.now()) {
  const H = R.horario;
  if (!H) return { abierto: true };
  const f = new Date(ms - 5 * 3600 * 1000);                   // Ecuador = UTC-5, sin horario de verano
  const dia = f.getUTCDay(), min = f.getUTCHours() * 60 + f.getUTCMinutes();
  const aMin = (t) => { const [h, m] = String(t).split(":").map(Number); return h * 60 + (m || 0); };
  const hoy = H[String(dia)];
  let abierto = false;
  if (Array.isArray(hoy)) {
    const a = aMin(hoy[0]), c = aMin(hoy[1]);
    abierto = c > a ? min >= a && min < c : min >= a || min < c;   // ej. 18:00 a 02:00 cruza la medianoche
  }
  return { abierto, hoy: hoy || null };
}

// Código secreto de cada mesa (va en el QR). Solo se exige si existe MESA_SECRETO.
export async function codigoMesa(secreto, mesa) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secreto), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const firma = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode("mesa:" + mesa)));
  return [...firma.slice(0, 5)].map((b) => b.toString(36).padStart(2, "0")).join("").slice(0, 8);
}
export async function mesaAutorizada(env, mesa, k) {
  const secreto = String(env.MESA_SECRETO ?? "").trim();
  if (!secreto) return true;
  return String(k ?? "") === (await codigoMesa(secreto, mesa));
}


// =============================================================
//  Ayudas compartidas por pedido.js y caja.js
// =============================================================
export const limpiar = (t, max) =>
  String(t ?? "").slice(0, max).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Quita espacios, saltos de línea y comillas que se cuelan al copiar y pegar
export const sinBasura = (v) => String(v ?? "").trim().replace(/^["'\s]+|["'\s]+$/g, "");

export async function contar(DB, jornada, monto) {
  // Suma 1 de forma segura aunque lleguen varios pedidos al mismo tiempo
  const fila = await DB.prepare("UPDATE jornadas SET n = n + 1, total = total + ?2 WHERE id = ?1 RETURNING n, total")
    .bind(jornada, monto).first();
  return { numero: fila.n, totalDia: fila.total };
}

export async function deshacer(DB, jornada, monto, numero, id) {
  try {
    // Devuelve el monto; y si nadie pidió después, también el número (así no quedan saltos)
    if (numero && jornada) await DB.prepare("UPDATE jornadas SET total = total - ?2, n = CASE WHEN n = ?3 THEN n - 1 ELSE n END WHERE id = ?1")
      .bind(jornada, monto, numero).run();
    if (id) await DB.prepare("DELETE FROM pedidos WHERE id = ?1").bind(id).run();
  } catch {}
}

export async function enviarTelegram(TOKEN, CHAT, texto) {
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


// Cobrar una cuenta de mesa. metodo: "Efectivo"/"Transferencia"/"Tarjeta" = todo con esa forma;
// "Mixto" = cada pedido con la que eligió el cliente
export const METODOS_PAGO = ["Efectivo", "Transferencia", "Tarjeta"];
export async function cobrarCuenta(DB, id, metodoPedido) {
  const metodo = METODOS_PAGO.includes(metodoPedido) ? metodoPedido : metodoPedido === "Mixto" ? "Mixto" : null;
  if (METODOS_PAGO.includes(metodo)) await DB.prepare("UPDATE pedidos SET pago = ?2 WHERE cuenta = ?1 AND tipo = 'pedido'").bind(id, metodo).run();
  await DB.prepare("UPDATE cuentas SET cerrada = ?2, metodo = ?3 WHERE id = ?1 AND cerrada IS NULL").bind(id, Date.now(), metodo).run();
  // La próxima gente que use esa mesa empieza con el carrito vacío
  const c = await DB.prepare("SELECT mesa FROM cuentas WHERE id = ?1").bind(id).first();
  if (c) await DB.batch([
    DB.prepare("UPDATE carritos SET lineas = '[]', version = version + 1, actualizado = ?2, ultimo = NULL WHERE mesa = ?1").bind(c.mesa, Date.now()),
    // Los avisos de esa mesa (mesero / cuenta) ya quedan atendidos
    DB.prepare("UPDATE pedidos SET estado = 'listo', actualizado = ?2 WHERE mesa = ?1 AND tipo != 'pedido' AND estado != 'listo'").bind(c.mesa, Date.now()),
    DB.prepare("DELETE FROM presencia WHERE mesa = ?1").bind(c.mesa),
  ]);
}

// Caja del día: fondo inicial + efectivo cobrado = lo que debería haber en el cajón
export async function estadoCaja(DB, j) {
  if (!j) return null;
  const r = await DB.prepare("SELECT COALESCE(SUM(p.total), 0) AS efectivo FROM pedidos p LEFT JOIN cuentas c ON c.id = p.cuenta " +
    "WHERE p.jornada = ?1 AND p.tipo = 'pedido' AND (p.cuenta IS NULL OR c.cerrada IS NOT NULL) " +
    "AND COALESCE(p.pago, CASE WHEN c.metodo != 'Mixto' THEN c.metodo END) = 'Efectivo'").bind(j.id).first();
  const efectivo = Math.round((r?.efectivo || 0) * 100) / 100;
  const fondo = j.fondo == null ? null : Number(j.fondo);
  let lista = [];
  try { lista = (await DB.prepare("SELECT id, monto, motivo, creado FROM movimientos WHERE jornada = ?1 ORDER BY id").bind(j.id).all()).results; } catch {}
  const salidas = Math.round(lista.reduce((t, m) => t + m.monto, 0) * 100) / 100;
  return { fondo, efectivo, salidas, listaSalidas: lista,
    esperado: Math.round(((fondo || 0) + efectivo - salidas) * 100) / 100, arqueo: j.arqueo ? JSON.parse(j.arqueo) : null };
}

// Anular un pedido (por error, cliente se fue, pedido de broma): sale de la cocina, del total del día y de la cuenta de la mesa.
// soloCaja = true → solo ventas hechas en la caja.
export async function anularPedido(DB, j, id, motivoTxt, soloCaja = false) {
  const motivo = String(motivoTxt ?? "").replace(/[<>]/g, "").trim().slice(0, 200);
  if (!Number.isInteger(id) || !motivo) return { status: 400, error: "Escribe el motivo" };
  const p = await DB.prepare(`SELECT * FROM pedidos WHERE id = ?1 AND jornada = ?2 AND tipo = 'pedido'${soloCaja ? " AND para IS NOT NULL" : ""}`).bind(id, j.id).first();
  if (!p) return { status: 404, error: "Ese pedido no existe o ya fue anulado" };
  if (p.cuenta != null) {
    const c = await DB.prepare("SELECT cerrada FROM cuentas WHERE id = ?1").bind(p.cuenta).first();
    if (c && c.cerrada != null) return { status: 409, error: "Esa mesa ya fue cobrada; no se puede anular" };
  }
  const ahora = Date.now();
  await DB.batch([
    DB.prepare("UPDATE pedidos SET tipo = 'anulado', estado = 'listo', actualizado = ?2, anulado = ?3 WHERE id = ?1").bind(id, ahora, JSON.stringify({ motivo, hora: ahora })),
    DB.prepare("UPDATE jornadas SET total = total - ?2 WHERE id = ?1").bind(j.id, p.total),
    ...(p.cuenta != null ? [DB.prepare("UPDATE cuentas SET total = total - ?2, pedidos = pedidos - 1 WHERE id = ?1").bind(p.cuenta, p.total)] : []),
  ]);
  return { status: 200 };
}
