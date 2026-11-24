// =============================================================
//  Base de datos de pedidos (Cloudflare D1, variable DB).
//  Los archivos que empiezan con "_" no son páginas: son ayudas
//  compartidas por las funciones de /api.
// =============================================================

// Día de trabajo: empieza a las 5:00 a. m. (hora de Ecuador).
// Un pedido a la 1:00 a. m. todavía cuenta para el día anterior.
export function diaDeTrabajo(ahora = new Date()) {
  return new Date(ahora.getTime() - 5 * 3600 * 1000).toLocaleDateString("en-CA", { timeZone: "America/Guayaquil" });
}

let listo = false;
export async function prepararTablas(DB) {
  if (listo) return;
  await DB.batch([
    DB.prepare("CREATE TABLE IF NOT EXISTS contador (dia TEXT PRIMARY KEY, n INTEGER NOT NULL, total REAL NOT NULL)"),
    DB.prepare(`CREATE TABLE IF NOT EXISTS pedidos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dia TEXT NOT NULL, numero INTEGER, tipo TEXT NOT NULL, mesa INTEGER NOT NULL,
      items TEXT, notas TEXT, total REAL NOT NULL DEFAULT 0,
      estado TEXT NOT NULL DEFAULT 'nuevo', creado INTEGER NOT NULL, actualizado INTEGER NOT NULL)`),
    DB.prepare("CREATE INDEX IF NOT EXISTS pedidos_dia ON pedidos (dia, estado)"),
  ]);
  listo = true;
}

export const responder = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
