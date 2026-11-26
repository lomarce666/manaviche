// Link viejo: la pantalla de cocina ahora es la del mesero
export function onRequest({ request }) {
  return Response.redirect(new URL("/mesero", request.url).toString(), 302);
}
