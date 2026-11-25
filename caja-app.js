/* =============================================================
   CAJA (punto de venta) — se usa en la pestaña 💵 Caja de la cocina
   y en la página /caja. Uso: montarCaja(elemento, () => clave)
   ============================================================= */
(function () {
  const css = `
  .pv{max-width:1100px;margin:0 auto;padding:14px 14px 40px;color:#e6e9ee}
  .pv h2{font-size:15px;letter-spacing:1px;text-transform:uppercase;opacity:.75;margin:0 0 10px;font-weight:900}
  .pv .hoja2{background:#1b2027;border:1px solid #2a313b;border-radius:18px;padding:14px;margin-bottom:14px}
  .pv .estadoCaja{display:flex;gap:10px;flex-wrap:wrap}
  .pv .estadoCaja div{flex:1 1 140px;background:#111418;border-radius:14px;padding:10px 12px}
  .pv .estadoCaja b{display:block;font-size:22px;color:#ffd166}
  .pv .estadoCaja span{font-size:13px;opacity:.75}
  .pv .rejillaPV{display:grid;grid-template-columns:1fr;gap:14px}
  @media(min-width:860px){.pv .rejillaPV{grid-template-columns:1.4fr 1fr}}
  .pv .tipos{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px}
  .pv .tipos button,.pv .chipsPV button{flex:1 1 auto;padding:11px 10px;border-radius:12px;background:#111418;color:#cfd6df;font-weight:900;font-size:15px;border:2px solid #2a313b}
  .pv .tipos button.on,.pv .chipsPV button.on{background:#ffd166;color:#111;border-color:#ffd166}
  .pv select,.pv input[type=number],.pv input[type=text]{font:inherit;font-size:17px;padding:10px 12px;border-radius:12px;border:2px solid #333a44;background:#111418;color:#fff;width:100%}
  .pv .buscarPV{margin-bottom:10px}
  .pv .catPV{font-size:13px;font-weight:900;opacity:.6;text-transform:uppercase;margin:10px 2px 6px}
  .pv .productos{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px}
  .pv .prod{background:#262d36;border:2px solid #2f3742;border-radius:14px;padding:12px 10px;text-align:left;color:#fff;min-height:74px}
  .pv .prod b{display:block;font-size:15px;line-height:1.2}
  .pv .prod span{display:block;margin-top:6px;color:#ffd166;font-weight:900}
  .pv .prod:active{transform:scale(.97)}
  .pv .prod.ago{opacity:.35;text-decoration:line-through}
  .pv .prodW{display:flex;flex-direction:column}
  .pv .prodW .prod{flex:1}
  .pv .prodW.sel .prod{border-color:#ffd166;border-bottom-left-radius:0;border-bottom-right-radius:0}
  .pv .quitarP{background:#4a1515;color:#ffb3b3;font-weight:900;font-size:14px;padding:8px;border-radius:0 0 14px 14px;border:2px solid #ffd166;border-top:none}
  .pv .prod .q{float:right;background:#ffd166;color:#111;border-radius:99px;padding:1px 8px;font-size:13px}
  .pv .pvTicket li{display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid #2a313b;list-style:none}
  .pv .pvTicket li .n{flex:1}
  .pv .pvTicket li button{width:36px;height:36px;border-radius:10px;background:#2a313b;color:#fff;font-size:20px;font-weight:900}
  .pv .pvTicket ul{margin:0;padding:0}
  .pv .totalPV{display:flex;justify-content:space-between;font-size:26px;font-weight:900;margin:12px 0}
  .pv .vacioPV{opacity:.6;text-align:center;padding:18px 0}
  .pv .rapidos2{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
  .pv .rapidos2 button{flex:1 1 60px;padding:10px 6px;border-radius:10px;background:#2a313b;color:#fff;font-weight:900}
  .pv .vuelto{margin-top:10px;font-size:20px;font-weight:900;text-align:center;padding:10px;border-radius:12px;background:#16351f;color:#6ee7a0}
  .pv .vuelto.falta{background:#4a1515;color:#ffb3b3}
  .pv .bPV{width:100%;padding:16px;border-radius:14px;font-size:18px;font-weight:900;margin-top:12px;background:#2ecc71;color:#08210f}
  .pv .bPV:disabled{opacity:.4}
  .pv .bPV.gris{background:#2a313b;color:#e6e9ee}
  .pv .bPV.azul{background:#4ea1ff;color:#06203d}
  .pv .mesaPV{background:#111418;border-radius:14px;padding:12px;margin-bottom:10px}
  .pv .mesaPV .cab3{display:flex;justify-content:space-between;font-size:18px;font-weight:900}
  .pv .mesaPV small{display:block;opacity:.75;margin-top:4px}
  .pv .ventaPV{display:flex;justify-content:space-between;gap:8px;padding:8px 0;border-bottom:1px solid #2a313b;font-size:14px}
  .pv .ventaPV small{display:block;opacity:.65}
  .pv .lineaA{display:flex;justify-content:space-between;padding:6px 0;font-size:16px}
  .pv .lineaA.tot{font-weight:900;font-size:19px;border-top:1px solid #2a313b;margin-top:4px;padding-top:10px}
  .pv .difA{margin-top:10px;padding:12px;border-radius:12px;font-weight:900;font-size:18px;text-align:center}
  .pv .difA.ok{background:#16351f;color:#6ee7a0}.pv .difA.mal{background:#4a1515;color:#ffb3b3}.pv .difA.mas{background:#3a3012;color:#ffd166}
  .pvModal{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:80;display:none;align-items:center;justify-content:center;padding:16px}
  .pvModal.ver{display:flex}
  .pvModal .cajaM{background:#fffaf0;color:#1d1d1f;border-radius:20px;padding:20px;max-width:420px;width:100%;max-height:90vh;overflow:auto}
  .pvModal h3{font-size:22px;font-weight:900;margin:0 0 6px}
  .pvModal .grande{font-size:34px;font-weight:900;text-align:center;margin:8px 0}
  .pvModal .bM{width:100%;padding:15px;border-radius:14px;font-size:17px;font-weight:900;margin-top:10px;background:#0d3b4f;color:#fff}
  .pvModal .bM.verde{background:#2ecc71;color:#08210f}.pvModal .bM.gris{background:#e6e1d6;color:#333}
  .pvModal input{font:inherit;font-size:20px;padding:12px;border-radius:12px;border:2px solid #d8cfbf;width:100%;margin-top:8px}
  .pvModal .vueltoM{margin-top:10px;font-size:20px;font-weight:900;text-align:center;padding:10px;border-radius:12px;background:#e7f6ec;color:#1a7f37}
  .pvModal .vueltoM.falta{background:#fde8e8;color:#a8242f}
  .pvToast{position:fixed;left:50%;bottom:30px;transform:translateX(-50%);background:#2ecc71;color:#08210f;font-weight:900;font-size:17px;padding:14px 20px;border-radius:99px;z-index:90;box-shadow:0 10px 30px rgba(0,0,0,.5);max-width:92vw;text-align:center}
  `;
  const st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);

  const ICON = { Efectivo: "💵", Transferencia: "📲", Tarjeta: "💳" };
  const plata = (n) => "$" + Number(n || 0).toFixed(2);
  const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const hora = (ms) => new Date(ms).toLocaleTimeString("es-EC", { hour: "2-digit", minute: "2-digit" });
  // acepta coma o punto para los centavos (30,50 o 30.50)
  const num = (v) => { const t = String(v).trim().replace(/\s/g, "").replace(",", "."); if (t === "" || !/^\d*\.?\d*$/.test(t)) return NaN; const n = Number(t); return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN; };

  window.montarCaja = function (raiz, claveFn) {
    let datos = null, ticket = {}, para = "mostrador", mesaSel = "", pago = "", recibido = "", buscar = "", notas = "", cargando = false;
    const modal = document.createElement("div"); modal.className = "pvModal"; modal.innerHTML = `<div class="cajaM"></div>`; document.body.appendChild(modal);
    const abrirM = (h) => { modal.firstElementChild.innerHTML = h; modal.classList.add("ver"); };
    const cerrarM = () => modal.classList.remove("ver");
    modal.addEventListener("click", (e) => { if (e.target === modal || e.target.closest("[data-x]")) cerrarM(); });
    const toast = (t) => { const d = document.createElement("div"); d.className = "pvToast"; d.textContent = t; document.body.appendChild(d); setTimeout(() => d.remove(), 3500); };

    async function api(metodo, cuerpo) {
      try {
        const r = await fetch("/api/caja", { method: metodo, headers: { "Content-Type": "application/json", "x-clave": claveFn() }, cache: "no-store", body: cuerpo ? JSON.stringify(cuerpo) : undefined });
        return await r.json();
      } catch (e) { return { ok: false, error: "Sin conexión" }; }
    }
    async function cargar() {
      if (cargando) return; cargando = true;
      const j = await api("GET"); cargando = false;
      if (!j.ok) { raiz.innerHTML = `<div class="pv"><div class="hoja2 vacioPV">${esc(j.error || "No se pudo cargar la caja")}</div></div>`; return j; }
      datos = j; pintar(); return j;
    }
    const total = () => Object.entries(ticket).reduce((t, [id, q]) => { const p = datos.carta.find((x) => x.id === id); return t + (p ? p.precio * q : 0); }, 0);

    function pintar() {
      const J = datos.jornada, C = datos.caja;
      if (!J) { raiz.innerHTML = `<div class="pv"><div class="hoja2 vacioPV">🔒 No hay un día laboral abierto.<br>Ábrelo en la pestaña <b>📅 Día</b> de la cocina para empezar a vender.</div></div>`; return; }
      const t = total(), n = Object.values(ticket).reduce((a, b) => a + b, 0);
      const cats = [...new Set(datos.carta.map((p) => p.categoria))];
      const q = buscar.trim().toLowerCase();
      const rec = num(recibido);
      const vuelto = pago === "Efectivo" && recibido !== "" && Number.isFinite(rec) ? rec - t : null;
      const necesitaPago = para !== "mesa";
      const listo = n > 0 && (!necesitaPago || pago) && (para !== "mesa" || mesaSel) && !(pago === "Efectivo" && vuelto != null && vuelto < 0);
      const sel = document.activeElement && raiz.contains(document.activeElement) ? document.activeElement.id : null;
      raiz.innerHTML = `<div class="pv">
        <div class="hoja2">
          <h2>💵 Caja · ${esc(J.fecha)}</h2>
          ${C.fondo == null ? `<div style="margin-bottom:10px">Antes de vender, escribe con cuánto efectivo empieza la caja (para dar vuelto).</div>
            <div style="display:flex;gap:8px"><input type="text" id="pvFondo" inputmode="decimal" autocomplete="off" placeholder="Ej: 30,50"><button class="bPV azul" id="pvAbrir" style="margin:0;width:auto;padding:0 18px">Abrir caja</button></div>`
          : `<div class="estadoCaja">
            <div><span>Fondo inicial</span><b>${plata(C.fondo)}</b></div>
            <div><span>Cobrado en efectivo</span><b>${plata(C.efectivo)}</b></div>
            <div><span>Debería haber en caja</span><b>${plata(C.esperado)}</b></div>
          </div>`}
        </div>
        <div class="rejillaPV">
          <div class="hoja2">
            <h2>🧾 Nueva venta</h2>
            <div class="tipos">
              <button data-para="mostrador" class="${para === "mostrador" ? "on" : ""}">🧍 Mostrador</button>
              <button data-para="llevar" class="${para === "llevar" ? "on" : ""}">🥡 Para llevar</button>
              <button data-para="mesa" class="${para === "mesa" ? "on" : ""}">🍽️ Mesa</button>
            </div>
            ${para === "mesa" ? `<select id="pvMesa"><option value="">Elige la mesa…</option>${Array.from({ length: datos.mesasTotal }, (_, i) => `<option value="${i + 1}" ${String(i + 1) === mesaSel ? "selected" : ""}>Mesa ${i + 1}</option>`).join("")}</select>
              <div style="font-size:13px;opacity:.7;margin:6px 2px 10px">Se suma a la cuenta de la mesa. Se cobra al final en 🔥 Pedidos ("Cobrar mesa").</div>` : ""}
            <input type="text" id="pvBuscar" class="buscarPV" placeholder="🔎 Buscar plato…" value="${esc(buscar)}">
            ${cats.map((c) => { const ps = datos.carta.filter((p) => p.categoria === c && (!q || p.nombre.toLowerCase().includes(q))); if (!ps.length) return "";
              return `<div class="catPV">${esc(c)}</div><div class="productos">${ps.map((p) => `<div class="prodW${ticket[p.id] ? " sel" : ""}"><button class="prod${p.agotado ? " ago" : ""}" data-add="${esc(p.id)}" ${p.agotado ? "disabled" : ""}>
                ${ticket[p.id] ? `<i class="q">${ticket[p.id]}</i>` : ""}<b>${esc(p.nombre)}</b><span>${p.agotado ? "Agotado" : plata(p.precio)}</span></button>
                ${ticket[p.id] ? `<button class="quitarP" data-menos="${esc(p.id)}">− Quitar uno</button>` : ""}</div>`).join("")}</div>`; }).join("")}
          </div>
          <div class="hoja2 pvTicket">
            <h2>🛒 Ticket</h2>
            ${n ? `<ul>${Object.entries(ticket).map(([id, q]) => { const p = datos.carta.find((x) => x.id === id); return `<li><span class="n"><b>${q} x</b> ${esc(p.nombre)}<br><small style="opacity:.65">${plata(p.precio * q)}</small></span>
              <button data-menos="${esc(id)}">−</button><button data-add="${esc(id)}">+</button></li>`; }).join("")}</ul>`
              : `<div class="vacioPV">Toca los platos para agregarlos</div>`}
            <div class="totalPV"><span>Total</span><span>${plata(t)}</span></div>
            <input type="text" id="pvNotas" placeholder="📝 Indicaciones para la cocina (opcional)" maxlength="300" value="${esc(notas)}">
            <div style="margin:12px 0 6px;font-weight:900">💳 ${necesitaPago ? "¿Cómo paga?" : "¿Cómo pagará? (opcional)"}</div>
            <div class="chipsPV tipos">${["Efectivo", "Transferencia", "Tarjeta"].map((m) => `<button data-pagoPV="${m}" class="${pago === m ? "on" : ""}">${ICON[m]} ${m}</button>`).join("")}</div>
            ${pago === "Efectivo" && necesitaPago && n ? `<input type="text" id="pvRecibido" inputmode="decimal" autocomplete="off" placeholder="¿Con cuánto paga? (opcional)" value="${esc(recibido)}">
              <div class="rapidos2">${[t, 5, 10, 20, 50].filter((v, i, a) => (i === 0 || v > t) && a.indexOf(v) === i).slice(0, 5).map((v, i) => `<button data-rec="${v}">${i === 0 ? "Exacto" : plata(v)}</button>`).join("")}</div>
              ${vuelto != null ? `<div class="vuelto${vuelto < 0 ? " falta" : ""}">${vuelto < 0 ? `Faltan ${plata(-vuelto)}` : `Vuelto: ${plata(vuelto)}`}</div>` : ""}` : ""}
            <button class="bPV" id="pvVender" ${listo ? "" : "disabled"}>${para === "mesa" ? "🍽️ Enviar a cocina (se cobra al final)" : `✅ Cobrar ${plata(t)} y enviar a cocina`}</button>
            ${n ? `<button class="bPV gris" id="pvVaciar">Vaciar ticket</button>` : ""}
          </div>
        </div>
        <div class="hoja2">
          <h2>🧮 Cerrar caja (arqueo)</h2>
          ${C.fondo == null ? `<div class="vacioPV">Primero abre la caja</div>` : `
            <div class="lineaA"><span>Fondo inicial</span><span>${plata(C.fondo)}</span></div>
            <div class="lineaA"><span>+ Cobrado en efectivo</span><span>${plata(C.efectivo)}</span></div>
            <div class="lineaA tot"><span>Debería haber</span><span>${plata(C.esperado)}</span></div>
            ${C.arqueo ? `<div class="difA ${C.arqueo.diferencia === 0 ? "ok" : C.arqueo.diferencia > 0 ? "mas" : "mal"}">Contado ${hora(C.arqueo.hora)}: ${plata(C.arqueo.contado)} · ${C.arqueo.diferencia === 0 ? "✅ Cuadra" : C.arqueo.diferencia > 0 ? `Sobra ${plata(C.arqueo.diferencia)}` : `⚠️ Falta ${plata(-C.arqueo.diferencia)}`}</div>` : ""}
            <div style="margin-top:12px;font-weight:900">Cuenta los billetes y monedas y escribe cuánto hay:</div>
            <input type="text" id="pvContado" inputmode="decimal" autocomplete="off" placeholder="Efectivo contado" style="margin-top:8px">
            <input type="text" id="pvNotaA" placeholder="Nota (opcional): ej. se pagó al proveedor" maxlength="200" style="margin-top:8px">
            <button class="bPV azul" id="pvArqueo">🧮 Guardar arqueo</button>
            <div style="font-size:13px;opacity:.7;margin-top:8px">El arqueo sale en el cierre de caja del día. Puedes hacerlo varias veces; queda el último.</div>`}
        </div>
        <div class="hoja2">
          <h2>📋 Ventas de caja de hoy (${datos.ventas.length})</h2>
          ${datos.ventas.length ? datos.ventas.map((v) => `<div class="ventaPV"><div><b>#${v.numero ?? "—"} · ${v.para === "llevar" ? "🥡 Para llevar" : v.para === "mostrador" ? "🧍 Mostrador" : `🍽️ Mesa ${v.mesa}`}</b>
            <small>${hora(v.creado)} · ${v.items.map((it) => `${it.cantidad} x ${esc(it.nombre)}`).join(", ")}</small></div>
            <div style="text-align:right"><b>${plata(v.total)}</b><small>${v.pago ? `${ICON[v.pago] || ""} ${esc(v.pago)}` : "Cuenta de mesa"}</small></div></div>`).join("")
          : `<div class="vacioPV">Todavía no hay ventas en caja</div>`}
        </div>
      </div>`;
      if (sel && document.getElementById(sel)) { const el = document.getElementById(sel); el.focus(); if (el.setSelectionRange && el.type === "text") el.setSelectionRange(el.value.length, el.value.length); }
    }

    function cobrarMesa(id) {
      const c = datos.mesas.find((x) => x.id === Number(id)); if (!c) return;
      const partes = (c.porPago || []).filter((x) => x.total > 0 && x.metodo !== "Sin elegir");
      abrirM(`<h3>💵 Cobrar mesa ${c.mesa}</h3><div class="grande">${plata(c.total)}</div>
        ${partes.length > 1 ? `<div>${partes.map((x) => `${ICON[x.metodo]} ${esc(x.metodo)}: <b>${plata(x.total)}</b>`).join("<br>")}</div>
          <button class="bM verde" data-metodoPV="Mixto" data-id="${c.id}">✅ Cobrar así</button><div style="margin-top:12px;font-size:14px">o todo de una forma:</div>` : ""}
        ${["Efectivo", "Transferencia", "Tarjeta"].map((m) => `<button class="bM${partes.length === 1 && partes[0].metodo === m ? " verde" : ""}" data-metodoPV="${m}" data-id="${c.id}">${ICON[m]} ${partes.length > 1 ? "Todo por" : "Cobrar por"} ${m}</button>`).join("")}
        <button class="bM gris" data-x>Cancelar</button>`);
    }
    function confirmarMesa(id, metodo) {
      const c = datos.mesas.find((x) => x.id === Number(id)); if (!c) return;
      const efectivo = metodo === "Efectivo" || (metodo === "Mixto" && (c.porPago || []).some((x) => x.metodo === "Efectivo"));
      const enEfectivo = metodo === "Efectivo" ? c.total : (c.porPago || []).filter((x) => x.metodo === "Efectivo").reduce((t, x) => t + x.total, 0);
      abrirM(`<h3>🏁 Mesa ${c.mesa}</h3><div class="grande">${plata(c.total)}</div>
        ${efectivo ? `<div>En efectivo: <b>${plata(enEfectivo)}</b>. ¿Con cuánto paga? (opcional)</div><input type="text" id="pvRecM" inputmode="decimal" autocomplete="off"><div id="pvVueltoM"></div>` : ""}
        <div style="margin-top:10px;font-size:14px">Al terminar, la mesa queda libre para los próximos clientes.</div>
        <button class="bM verde" data-terminarPV="${c.id}" data-metodo="${metodo}">✅ Cobrado · terminar mesa ${c.mesa}</button>
        <button class="bM gris" data-x>Volver</button>`);
      const inp = modal.querySelector("#pvRecM");
      if (inp) inp.addEventListener("input", () => { const r = num(inp.value), v = r - enEfectivo, o = modal.querySelector("#pvVueltoM");
        o.className = "vueltoM" + (v < 0 ? " falta" : ""); o.textContent = inp.value === "" || !Number.isFinite(r) ? "" : v < 0 ? `Faltan ${plata(-v)}` : `Vuelto: ${plata(v)}`; if (inp.value === "") o.className = ""; });
    }

    modal.addEventListener("click", async (e) => {
      const m = e.target.closest("[data-metodoPV]"); if (m) { confirmarMesa(m.dataset.id, m.dataset.metodopv); return; }
      const t = e.target.closest("[data-terminarPV]");
      if (t) { t.disabled = true; const j = await api("POST", { accion: "cobrar", id: Number(t.dataset.terminarpv), metodo: t.dataset.metodo });
        cerrarM(); toast(j.ok ? "✅ Mesa cobrada · lista para nuevos clientes" : (j.error || "No se pudo cobrar")); cargar(); }
    });

    raiz.addEventListener("click", async (e) => {
      const b = e.target.closest("button"); if (!b || !datos) return;
      if (b.dataset.para) { para = b.dataset.para; if (para !== "mesa") mesaSel = ""; pintar(); return; }
      if (b.dataset.add) { ticket[b.dataset.add] = (ticket[b.dataset.add] || 0) + 1; pintar(); return; }
      if (b.dataset.menos) { const k = b.dataset.menos; ticket[k]--; if (ticket[k] <= 0) delete ticket[k]; pintar(); return; }
      if (b.dataset.pagopv) { pago = pago === b.dataset.pagopv && para === "mesa" ? "" : b.dataset.pagopv; if (pago !== "Efectivo") recibido = ""; pintar(); return; }
      if (b.dataset.rec) { recibido = String(Number(b.dataset.rec).toFixed(2)); pintar(); return; }
      if (b.dataset.cobrarpv) { cobrarMesa(b.dataset.cobrarpv); return; }
      if (b.id === "pvVaciar") { ticket = {}; recibido = ""; notas = ""; pintar(); return; }
      if (b.id === "pvAbrir") {
        const f = num(raiz.querySelector("#pvFondo").value); if (!Number.isFinite(f) || f < 0) { toast("Escribe el monto con que abre la caja"); return; }
        const j = await api("POST", { accion: "abrir_caja", fondo: f }); toast(j.ok ? `✅ Caja abierta con ${plata(f)}` : j.error); cargar(); return;
      }
      if (b.id === "pvArqueo") {
        const c = num(raiz.querySelector("#pvContado").value); if (!Number.isFinite(c) || c < 0) { toast("Escribe cuánto efectivo contaste"); return; }
        const j = await api("POST", { accion: "arqueo", contado: c, nota: raiz.querySelector("#pvNotaA").value });
        if (j.ok) toast(j.arqueo.diferencia === 0 ? "✅ La caja cuadra" : j.arqueo.diferencia > 0 ? `Sobran ${plata(j.arqueo.diferencia)}` : `⚠️ Faltan ${plata(-j.arqueo.diferencia)}`);
        else toast(j.error); cargar(); return;
      }
      if (b.id === "pvVender") {
        b.disabled = true; b.textContent = "Enviando…";
        const items = Object.entries(ticket).map(([id, cantidad]) => ({ id, cantidad }));
        const j = await api("POST", { accion: "venta", para, mesa: Number(mesaSel) || null, items, notas, pago, recibido: num(recibido) || 0 });
        if (!j.ok) { toast(j.error || "No se pudo registrar"); pintar(); return; }
        toast(`✅ Pedido #${j.numero} enviado a cocina${j.vuelto != null ? ` · Vuelto ${plata(j.vuelto)}` : ""}`);
        ticket = {}; recibido = ""; pago = ""; notas = ""; cargar(); return;
      }
    });
    raiz.addEventListener("input", (e) => {
      if (e.target.id === "pvBuscar") { buscar = e.target.value; pintar(); }
      if (e.target.id === "pvNotas") { notas = e.target.value; }
      if (e.target.id === "pvRecibido") { recibido = e.target.value; pintar(); }
    });
    raiz.addEventListener("change", (e) => { if (e.target.id === "pvMesa") { mesaSel = e.target.value; pintar(); } });

    // Se actualiza solo (mesas por cobrar y efectivo), sin borrar lo que se está escribiendo
    setInterval(() => { if (raiz.offsetParent && !raiz.contains(document.activeElement) && !modal.classList.contains("ver")) cargar(); }, 8000);
    return { cargar };
  };
})();
