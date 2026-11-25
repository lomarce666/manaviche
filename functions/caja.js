// /caja: la pantalla de la persona de caja (abre y culmina el día, cobra las mesas, reportes).
// Usa el mismo archivo que la cocina, pero aquí se le cambia la cabecera (nombre, ícono y
// manifest) para que al "Agregar a pantalla de inicio" quede como la app "Caja" que abre /caja.
export async function onRequest({ request, env }) {
  const r = await env.ASSETS.fetch(new URL("/cocina", request.url));
  const h = new Headers(r.headers); h.set("Cache-Control", "no-cache");
  const base = new Response(r.body, { status: r.status, headers: h });
  return new HTMLRewriter()
    .on('link[rel="manifest"]', { element(e) { e.setAttribute("href", "/caja.webmanifest"); } })
    .on('link[rel="icon"], link[rel="apple-touch-icon"]', { element(e) { e.setAttribute("href", (e.getAttribute("href") || "").replace("/iconos/cocina-", "/iconos/caja-")); } })
    .on('meta[name="apple-mobile-web-app-title"]', { element(e) { e.setAttribute("content", "Caja"); } })
    .on("title", { element(e) { e.setInnerContent("Caja"); } })
    .transform(base);
}
