// Link viejo: /cobros ahora es /caja
export function onRequest({ request }) {
  return Response.redirect(new URL("/caja", request.url).toString(), 302);
}
