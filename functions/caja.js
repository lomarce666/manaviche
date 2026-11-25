// /caja: la pantalla de la persona de caja (abre y culmina el día, cobra las mesas, reportes).
// Es el mismo archivo que la cocina; la página detecta la ruta y muestra solo lo de caja.
export async function onRequest({ request, env }) {
  const r = await env.ASSETS.fetch(new URL("/cocina", request.url));
  return new Response(r.body, { status: r.status, headers: r.headers });
}
