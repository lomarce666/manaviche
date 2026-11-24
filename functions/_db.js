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
  ]);
  // Columna nueva en bases creadas antes (si ya existe, no pasa nada)
  try { await DB.prepare("ALTER TABLE pedidos ADD COLUMN jornada INTEGER").run(); } catch {}
  try { await DB.prepare("CREATE INDEX IF NOT EXISTS pedidos_jornada ON pedidos (jornada, estado)").run(); } catch {}
  try { await DB.prepare("ALTER TABLE pedidos ADD COLUMN cuenta INTEGER").run(); } catch {}
  try { await DB.prepare("ALTER TABLE pedidos ADD COLUMN por TEXT").run(); } catch {}
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
    "SELECT numero, items, total, creado, por FROM pedidos WHERE cuenta = ?1 AND tipo = 'pedido' ORDER BY id"
  ).bind(c.id).all();
  const pedidos = results.map((p) => ({ ...p, items: p.items ? JSON.parse(p.items) : [] }));
  const platos = {};
  for (const p of pedidos) for (const it of p.items) {
    platos[it.nombre] = platos[it.nombre] || { nombre: it.nombre, cantidad: 0, precio: it.precio, total: 0 };
    platos[it.nombre].cantidad += it.cantidad; platos[it.nombre].total += it.cantidad * it.precio;
  }
  return { id: c.id, mesa: c.mesa, abierta: c.abierta, total: Math.round(c.total * 100) / 100, pedidos, platos: Object.values(platos) };
}

// Resumen para hacer caja de un día de trabajo
export async function resumenJornada(DB, j) {
  const { results } = await DB.prepare(
    "SELECT numero, tipo, mesa, items, notas, total, estado, creado FROM pedidos WHERE jornada = ?1 ORDER BY id"
  ).bind(j.id).all();
  const pedidos = results.filter((p) => p.tipo === "pedido").map((p) => ({ ...p, items: p.items ? JSON.parse(p.items) : [] }));
  const platos = {}, mesas = {};
  for (const p of pedidos) {
    for (const it of p.items) {
      const k = it.nombre;
      platos[k] = platos[k] || { nombre: k, cantidad: 0, precio: it.precio, total: 0 };
      platos[k].cantidad += it.cantidad; platos[k].total += it.cantidad * it.precio;
    }
    mesas[p.mesa] = mesas[p.mesa] || { mesa: p.mesa, pedidos: 0, total: 0 };
    mesas[p.mesa].pedidos++; mesas[p.mesa].total += p.total;
  }
  const total = pedidos.reduce((t, p) => t + p.total, 0);
  return {
    fecha: j.fecha, abierta: j.abierta, cerrada: j.cerrada || null,
    pedidos: pedidos.length, total: Math.round(total * 100) / 100,
    promedio: pedidos.length ? Math.round((total / pedidos.length) * 100) / 100 : 0,
    primero: pedidos[0]?.creado || null, ultimo: pedidos.at(-1)?.creado || null,
    pendientes: pedidos.filter((p) => p.estado !== "listo").length,
    mesero: results.filter((p) => p.tipo === "mesero").length,
    cuenta: results.filter((p) => p.tipo === "cuenta").length,
    platos: Object.values(platos).sort((a, b) => b.cantidad - a.cantidad),
    mesas: Object.values(mesas).sort((a, b) => a.mesa - b.mesa),
    lista: pedidos.map((p) => ({ numero: p.numero, mesa: p.mesa, total: p.total, creado: p.creado, items: p.items, notas: p.notas })),
  };
}

export const responder = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
