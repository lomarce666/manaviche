// /mesero: la pantalla del mesero (pedidos del QR, avisos, tomar pedidos a mano, mandar la mesa a caja).
// Usa el mismo archivo que caja; aquí se le pone su propio nombre, ícono y manifest
// para que al "Agregar a pantalla de inicio" quede como la app "Mesero".
export async function onRequest({ request, env }) {
  const r = await env.ASSETS.fetch(new URL("/cocina", request.url));
  const h = new Headers(r.headers); h.set("Cache-Control", "no-cache");
  return new HTMLRewriter()
    .on('link[rel="manifest"]', { element(e) { e.setAttribute("href", "/mesero.webmanifest"); } })
    .on('link[rel="icon"], link[rel="apple-touch-icon"]', { element(e) { e.setAttribute("href", (e.getAttribute("href") || "").replace("/iconos/cocina-", "/iconos/mesero-")); } })
    .on('meta[name="apple-mobile-web-app-title"]', { element(e) { e.setAttribute("content", "Mesero"); } })
    .on("title", { element(e) { e.setInnerContent("Mesero"); } })
    .transform(new Response(r.body, { status: r.status, headers: h }));
}
