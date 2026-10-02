'use strict';

/* =========================================================
   Datos (se guardan en el teléfono con localStorage)
   ========================================================= */
const CLAVE = 'vendedora-datos-v1';
const TIPOS = { revista: 'Revista', mayoreo: 'Mayoreo' };

let db = cargar();

function cargar() {
  try {
    const d = JSON.parse(localStorage.getItem(CLAVE));
    if (d && Array.isArray(d.clientes)) return normalizar(d);
  } catch (e) { /* datos dañados: empezamos vacío */ }
  return normalizar({});
}

function normalizar(d) {
  return {
    clientes: d.clientes || [],
    productos: d.productos || [],
    movimientos: d.movimientos || [],
    ultimoRespaldo: d.ultimoRespaldo || null,
  };
}

function guardar() {
  localStorage.setItem(CLAVE, JSON.stringify(db));
}

/* ---------- Fotos de productos ----------
   Van en IndexedDB porque en localStorage no caben muchas imágenes.
   Se tienen todas en memoria (fotos[idProducto] = dataURL) para pintar rápido. */
const fotos = {};
let baseFotos = null;

function abrirBaseFotos() {
  if (!baseFotos) {
    baseFotos = new Promise((ok, mal) => {
      const r = indexedDB.open('vendedora-fotos', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('fotos');
      r.onsuccess = () => ok(r.result);
      r.onerror = () => mal(r.error);
    });
  }
  return baseFotos;
}

async function operarFotos(modo, accion) {
  const base = await abrirBaseFotos();
  return new Promise((ok, mal) => {
    const tx = base.transaction('fotos', modo);
    const r = accion(tx.objectStore('fotos'));
    tx.oncomplete = () => ok(r && r.result);
    tx.onerror = () => mal(tx.error);
  });
}

async function cargarFotos() {
  const base = await abrirBaseFotos();
  await new Promise((ok) => {
    const cursor = base.transaction('fotos').objectStore('fotos').openCursor();
    cursor.onsuccess = () => {
      const c = cursor.result;
      if (!c) return ok();
      fotos[c.key] = c.value;
      c.continue();
    };
    cursor.onerror = () => ok();
  });
}

function guardarFoto(id, dataURL) {
  fotos[id] = dataURL;
  return operarFotos('readwrite', (s) => s.put(dataURL, id));
}

function borrarFoto(id) {
  delete fotos[id];
  return operarFotos('readwrite', (s) => s.delete(id));
}

async function reemplazarFotos(nuevas) {
  for (const k of Object.keys(fotos)) delete fotos[k];
  Object.assign(fotos, nuevas);
  await operarFotos('readwrite', (s) => {
    s.clear();
    for (const [id, dataURL] of Object.entries(nuevas)) s.put(dataURL, id);
  });
}

// Reduce la foto de la cámara (varios MB) a ~640 px en JPEG (~50 KB)
function reducirImagen(archivo, max = 640) {
  return new Promise((ok, mal) => {
    const url = URL.createObjectURL(archivo);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const lienzo = document.createElement('canvas');
      lienzo.width = Math.round(img.width * k);
      lienzo.height = Math.round(img.height * k);
      lienzo.getContext('2d').drawImage(img, 0, 0, lienzo.width, lienzo.height);
      URL.revokeObjectURL(url);
      ok(lienzo.toDataURL('image/jpeg', 0.75));
    };
    img.onerror = () => { URL.revokeObjectURL(url); mal(new Error('imagen')); };
    img.src = url;
  });
}

const coincideProducto = (p, q) =>
  p.nombre.toLowerCase().includes(q) || (p.catalogo || '').toLowerCase().includes(q) || (p.codigo || '').toLowerCase().includes(q);

const miniatura = (idProducto) => (fotos[idProducto]
  ? `<img class="miniatura" src="${fotos[idProducto]}" alt="">`
  : `<div class="miniatura vacia">🛍️</div>`);

// Pide al navegador no borrar los datos aunque falte espacio
if (navigator.storage && navigator.storage.persist) navigator.storage.persist();

/* =========================================================
   Utilidades
   ========================================================= */
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const r2 = (n) => Math.round(n * 100) / 100;
const num = (v) => parseFloat(v) || 0;
const fmt = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });
const dinero = (n) => fmt.format(n || 0);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function hoy() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}

function fechaBonita(f) {
  return new Date(f + 'T12:00').toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric' });
}

function haceDias(f) {
  const dias = Math.round((new Date(hoy() + 'T12:00') - new Date(f + 'T12:00')) / 86400000);
  if (dias <= 0) return 'hoy';
  if (dias === 1) return 'ayer';
  return `hace ${dias} días`;
}

const iniciales = (nombre) => nombre.trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase();

// Cliente fijo para ventas en las que no se guarda el nombre
const ANONIMO = { id: 'anonimo', nombre: 'Sin nombre', telefono: '', notas: 'Ventas a clientes que no registraste.', anonimo: true };

const cliente = (id) => (id === ANONIMO.id ? ANONIMO : db.clientes.find((c) => c.id === id));
// Clientes con nombre, más "Sin nombre" en cuanto tenga alguna venta
const todosLosClientes = () => (movsDe(ANONIMO.id).length ? [ANONIMO, ...db.clientes] : db.clientes);
const avatar = (c) => (c.anonimo ? '👤' : esc(iniciales(c.nombre)));
const producto = (id) => db.productos.find((p) => p.id === id);
const movsDe = (id) => db.movimientos.filter((m) => m.clienteId === id);

function saldoDe(id) {
  let s = 0;
  for (const m of db.movimientos) {
    if (m.clienteId === id) s += m.tipo === 'venta' ? m.total : -m.total;
  }
  return r2(s);
}

function ordenarMovs(lista) {
  return lista.sort((a, b) => b.fecha.localeCompare(a.fecha) || b.creado - a.creado);
}

function aviso(texto) {
  const el = document.getElementById('aviso');
  el.textContent = texto;
  el.hidden = false;
  clearTimeout(aviso.t);
  aviso.t = setTimeout(() => (el.hidden = true), 2200);
}

/* =========================================================
   Navegación
   ========================================================= */
const vista = document.getElementById('vista');
const titulo = document.getElementById('titulo');
const atras = document.getElementById('atras');

const filtros = {
  clientes: { q: '', soloDeben: false },
  productos: { q: '', tipo: 'todos' },
  informes: { periodo: 'mes', desde: '', hasta: '', tipoMov: 'todos', limite: 40 },
};

function render() {
  const [, ruta = 'inicio', id] = location.hash.split('/');
  atras.hidden = ruta !== 'cliente';

  const vistas = { inicio: vistaInicio, clientes: vistaClientes, cliente: vistaCliente, productos: vistaProductos, informes: vistaInformes, ajustes: vistaAjustes };
  (vistas[ruta] || vistaInicio)(id);

  const tabActiva = ruta === 'cliente' ? 'clientes' : ruta;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('activa', t.dataset.ruta === tabActiva));
}

window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });

/* =========================================================
   Vista: Inicio
   ========================================================= */
function vistaInicio() {
  titulo.textContent = 'Mis Cuentas';

  if (!db.clientes.length && !db.movimientos.length) {
    vista.innerHTML = `
      <div class="vacio">
        <p style="font-size:3rem;margin:0">👋</p>
        <p><b>¡Bienvenida!</b><br>Aquí vas a llevar las cuentas de tus clientes: lo que te compran y lo que te van pagando.</p>
        <button class="btn" data-accion="nuevo-cliente">Agregar mi primera clienta</button>
        <div style="height:10px"></div>
        <button class="btn sec" data-accion="nueva-venta" data-id="${ANONIMO.id}">Venta sin nombre</button>
      </div>`;
    return;
  }

  const mes = hoy().slice(0, 7);
  let vendidoMes = 0, cobradoMes = 0, gananciaMes = 0, revistaMes = 0, mayoreoMes = 0;
  for (const m of db.movimientos) {
    if (!m.fecha.startsWith(mes)) continue;
    if (m.tipo === 'abono') { cobradoMes += m.total; continue; }
    vendidoMes += m.total;
    for (const it of m.items) {
      const sub = it.cant * it.precio;
      if (it.tipo === 'mayoreo') mayoreoMes += sub; else revistaMes += sub;
      if (it.costo) gananciaMes += it.cant * (it.precio - it.costo);
    }
  }

  const deudores = todosLosClientes()
    .map((c) => ({ c, saldo: saldoDe(c.id) }))
    .filter((d) => d.saldo > 0.009)
    .sort((a, b) => b.saldo - a.saldo);
  const porCobrar = deudores.reduce((s, d) => s + d.saldo, 0);

  const nombreMes = new Date().toLocaleDateString('es-MX', { month: 'long' });
  const diasSinRespaldo = db.ultimoRespaldo ? Math.floor((Date.now() - db.ultimoRespaldo) / 86400000) : null;
  const pideRespaldo = db.movimientos.length > 0 && (diasSinRespaldo === null || diasSinRespaldo >= 7);

  vista.innerHTML = `
    ${pideRespaldo ? `<div class="alerta"><span>💾 ${diasSinRespaldo === null ? 'Aún no has hecho un respaldo.' : `Tu último respaldo fue hace ${diasSinRespaldo} días.`}</span><a class="btn sec" href="#/ajustes" style="min-height:36px;padding:6px 12px">Respaldar</a></div>` : ''}

    <div class="tarjeta destacado">
      <div class="etiqueta">Te deben en total</div>
      <div class="monto-grande">${dinero(porCobrar)}</div>
      <div class="etiqueta">${deudores.length} ${deudores.length === 1 ? 'cliente' : 'clientes'} con saldo pendiente</div>
    </div>

    <div class="acciones">
      <button class="btn" data-accion="nueva-venta">＋ Venta</button>
      <button class="btn verde" data-accion="abono">＋ Abono</button>
    </div>

    <h2>Este mes (${nombreMes})</h2>
    <div class="cuadros">
      <div class="tarjeta"><div class="etiqueta">Vendido</div><div class="valor">${dinero(vendidoMes)}</div></div>
      <div class="tarjeta"><div class="etiqueta">Cobrado</div><div class="valor pagado">${dinero(cobradoMes)}</div></div>
      <div class="tarjeta"><div class="etiqueta">De revista</div><div class="valor">${dinero(revistaMes)}</div></div>
      <div class="tarjeta"><div class="etiqueta">De mayoreo</div><div class="valor">${dinero(mayoreoMes)}</div></div>
    </div>
    <div class="tarjeta">
      <div class="etiqueta">Ganancia estimada del mes</div>
      <div class="valor" style="font-size:1.3rem;font-weight:700;margin-top:4px">${dinero(gananciaMes)}</div>
      <div class="etiqueta" style="margin-top:4px">Solo cuenta productos donde anotaste el costo.</div>
    </div>

    <h2>Quién te debe</h2>
    ${deudores.length ? `<div class="lista">${deudores.map(({ c, saldo }) => {
      const ult = ordenarMovs(movsDe(c.id))[0];
      return `<a class="item" href="#/cliente/${c.id}">
        <div class="avatar">${avatar(c)}</div>
        <div class="principal"><div class="nombre">${esc(c.nombre)}</div><div class="sub">Último movimiento ${ult ? haceDias(ult.fecha) : '—'}</div></div>
        <div class="cifra debe">${dinero(saldo)}</div>
      </a>`;
    }).join('')}</div>` : `<div class="tarjeta vacio" style="padding:20px">🎉 Nadie te debe nada.</div>`}
  `;
}

/* =========================================================
   Vista: Clientes
   ========================================================= */
function vistaClientes() {
  titulo.textContent = 'Clientes';
  const f = filtros.clientes;
  vista.innerHTML = `
    <div class="buscador"><input id="buscar" type="search" placeholder="Buscar cliente…" value="${esc(f.q)}"></div>
    <div class="filtros">
      <button class="filtro ${!f.soloDeben ? 'activo' : ''}" data-accion="filtro-clientes" data-valor="todos">Todos</button>
      <button class="filtro ${f.soloDeben ? 'activo' : ''}" data-accion="filtro-clientes" data-valor="deben">Me deben</button>
    </div>
    <div id="resultados"></div>
    <button class="fab" data-accion="nuevo-cliente" aria-label="Nuevo cliente">＋</button>
  `;
  const pintar = () => (document.getElementById('resultados').innerHTML = listaClientes());
  document.getElementById('buscar').addEventListener('input', (e) => { f.q = e.target.value; pintar(); });
  pintar();
}

function listaClientes() {
  const f = filtros.clientes;
  const q = f.q.trim().toLowerCase();
  const todos = todosLosClientes();
  const lista = todos
    .map((c) => ({ c, saldo: saldoDe(c.id) }))
    .filter(({ c, saldo }) => (!q || c.nombre.toLowerCase().includes(q) || (c.telefono || '').includes(q)) && (!f.soloDeben || saldo > 0.009))
    .sort((a, b) => b.saldo - a.saldo || a.c.nombre.localeCompare(b.c.nombre));

  if (!todos.length) return `<div class="vacio"><p>Todavía no tienes clientes.</p><button class="btn" data-accion="nuevo-cliente">Agregar cliente</button></div>`;
  if (!lista.length) return `<div class="vacio"><p>No hay resultados.</p></div>`;

  return `<div class="lista">${lista.map(({ c, saldo }) => `
    <a class="item" href="#/cliente/${c.id}">
      <div class="avatar">${avatar(c)}</div>
      <div class="principal"><div class="nombre">${esc(c.nombre)}</div><div class="sub">${c.anonimo ? 'Ventas sin registrar nombre' : esc(c.telefono || 'Sin teléfono')}</div></div>
      <div class="cifra ${saldo > 0.009 ? 'debe' : saldo < -0.009 ? 'pagado' : 'texto-tenue'}">${saldo > 0.009 ? dinero(saldo) : saldo < -0.009 ? 'A favor ' + dinero(-saldo) : 'Al corriente'}</div>
    </a>`).join('')}</div>`;
}

/* =========================================================
   Vista: Detalle de cliente
   ========================================================= */
function vistaCliente(id) {
  const c = cliente(id);
  if (!c) { location.hash = '#/clientes'; return; }
  titulo.textContent = c.nombre;

  const saldo = saldoDe(id);
  const movs = ordenarMovs(movsDe(id));
  const tel = (c.telefono || '').replace(/\D/g, '');

  vista.innerHTML = `
    <div class="tarjeta ${saldo > 0.009 ? 'destacado' : ''}">
      <div class="etiqueta">${saldo < -0.009 ? 'Saldo a su favor' : 'Te debe'}</div>
      <div class="monto-grande">${dinero(Math.abs(saldo))}</div>
      ${c.notas ? `<div class="etiqueta" style="margin-top:6px">${esc(c.notas)}</div>` : ''}
    </div>

    <div class="acciones">
      <button class="btn" data-accion="nueva-venta" data-id="${c.id}">＋ Venta</button>
      <button class="btn verde" data-accion="abono" data-id="${c.id}">＋ Abono</button>
    </div>
    <div class="acciones">
      ${tel ? `<a class="btn sec" href="${enlaceWhatsApp(c, saldo, movs)}" target="_blank" rel="noopener">💬 WhatsApp</a>
               <a class="btn sec" href="tel:${tel}">📞 Llamar</a>` : ''}
      ${c.anonimo ? '' : `<button class="btn sec" data-accion="editar-cliente" data-id="${c.id}" style="grid-column:1/-1">✏️ Editar datos</button>`}
    </div>

    <h2>Historial</h2>
    ${movs.length ? `<div class="lista">${movs.map((m) => movItem(m)).join('')}</div>` : `<div class="tarjeta vacio" style="padding:20px">Sin movimientos todavía.</div>`}
  `;
}

function movItem(m, conCliente = false) {
  const esVenta = m.tipo === 'venta';
  const desc = esVenta
    ? m.items.map((it) => (it.cant > 1 ? `${it.cant}× ` : '') + it.nombre).join(', ')
    : (m.nota || 'Abono');
  return `<button class="item" data-accion="ver-mov" data-id="${m.id}">
    <div class="avatar" style="${esVenta ? '' : 'background:var(--verde-suave);color:var(--verde)'}">${esVenta ? '🛍️' : '💵'}</div>
    <div class="principal"><div class="nombre">${esc(desc)}</div><div class="sub">${conCliente ? esc((cliente(m.clienteId) || { nombre: 'Cliente borrado' }).nombre) + ' · ' : ''}${fechaBonita(m.fecha)}${esVenta ? ' · Venta' : ' · Abono'}</div></div>
    <div class="cifra ${esVenta ? 'debe' : 'pagado'}">${esVenta ? '+' : '−'}${dinero(m.total)}</div>
  </button>`;
}

function enlaceWhatsApp(c, saldo, movs) {
  let tel = c.telefono.replace(/\D/g, '');
  if (tel.length === 10) tel = '52' + tel; // número mexicano sin lada de país
  const nombre = c.nombre.split(' ')[0];
  let texto;
  if (saldo > 0.009) {
    const ultimas = movs.slice(0, 5).map((m) => `• ${fechaBonita(m.fecha)}: ${m.tipo === 'venta' ? 'compra' : 'abono'} ${dinero(m.total)}`).join('\n');
    texto = `Hola ${nombre} 😊, te comparto tu estado de cuenta:\n\n${ultimas}\n\n*Saldo pendiente: ${dinero(saldo)}*\n\n¡Gracias por tu preferencia!`;
  } else {
    texto = `Hola ${nombre} 😊`;
  }
  return `https://wa.me/${tel}?text=${encodeURIComponent(texto)}`;
}

/* =========================================================
   Vista: Productos
   ========================================================= */
function vistaProductos() {
  titulo.textContent = 'Productos';
  const f = filtros.productos;
  vista.innerHTML = `
    <div class="buscador"><input id="buscar" type="search" placeholder="Buscar producto…" value="${esc(f.q)}"></div>
    <div class="filtros">
      ${['todos', 'revista', 'mayoreo'].map((t) => `<button class="filtro ${f.tipo === t ? 'activo' : ''}" data-accion="filtro-productos" data-valor="${t}">${t === 'todos' ? 'Todos' : TIPOS[t]}</button>`).join('')}
    </div>
    <p class="texto-tenue" style="margin:0 0 12px">Guarda aquí tus productos frecuentes para que al registrar una venta se llene el precio solo. No es obligatorio.</p>
    <div id="resultados"></div>
    <button class="fab" data-accion="nuevo-producto" aria-label="Nuevo producto">＋</button>
  `;
  const pintar = () => (document.getElementById('resultados').innerHTML = listaProductos());
  document.getElementById('buscar').addEventListener('input', (e) => { f.q = e.target.value; pintar(); });
  pintar();
}

function listaProductos() {
  const f = filtros.productos;
  const q = f.q.trim().toLowerCase();
  const lista = db.productos
    .filter((p) => (f.tipo === 'todos' || p.tipo === f.tipo) && (!q || coincideProducto(p, q)))
    .sort((a, b) => a.nombre.localeCompare(b.nombre));

  if (!lista.length) return `<div class="vacio"><p>${db.productos.length ? 'No hay resultados.' : 'Aún no tienes productos guardados.'}</p></div>`;

  return `<div class="lista">${lista.map((p) => `
    <button class="item" data-accion="editar-producto" data-id="${p.id}">
      ${miniatura(p.id)}
      <div class="principal">
        <div class="nombre">${esc(p.nombre)}</div>
        <div class="sub"><span class="chip ${p.tipo}">${TIPOS[p.tipo]}</span> ${esc([p.codigo && '#' + p.codigo, p.catalogo].filter(Boolean).join(' · '))}${p.costo ? ` · ganas ${dinero(p.precio - p.costo)}` : ''}</div>
      </div>
      <div class="cifra">${dinero(p.precio)}</div>
    </button>`).join('')}</div>`;
}

/* =========================================================
   Vista: Informes
   ========================================================= */
const PERIODOS = { mes: 'Este mes', mespasado: 'Mes pasado', anio: 'Este año', todo: 'Todo', rango: 'Elegir fechas' };

const nombreDeMes = (ym, largo = true) =>
  new Date(ym + '-15T12:00').toLocaleDateString('es-MX', largo ? { month: 'long', year: 'numeric' } : { month: 'short' });

function sumarMeses(ym, n) {
  const d = new Date(ym + '-15T12:00');
  d.setMonth(d.getMonth() + n);
  return d.toISOString().slice(0, 7);
}

// Devuelve [desde, hasta] como textos AAAA-MM-DD (se comparan como texto)
function rangoInforme() {
  const f = filtros.informes;
  const mes = hoy().slice(0, 7);
  switch (f.periodo) {
    case 'mespasado': { const m = sumarMeses(mes, -1); return [m + '-01', m + '-31']; }
    case 'anio': return [mes.slice(0, 4) + '-01-01', mes.slice(0, 4) + '-12-31'];
    case 'todo': return ['0000-00-00', '9999-99-99'];
    case 'rango': return [f.desde || '0000-00-00', f.hasta || '9999-99-99'];
    default: return [mes + '-01', mes + '-31'];
  }
}

function textoRango() {
  const f = filtros.informes;
  if (f.periodo !== 'rango') return PERIODOS[f.periodo];
  if (f.desde && f.hasta && f.desde.slice(0, 7) === f.hasta.slice(0, 7) && f.desde.endsWith('-01') && f.hasta.endsWith('-31')) {
    return nombreDeMes(f.desde.slice(0, 7));
  }
  return `${f.desde ? fechaBonita(f.desde) : 'el inicio'} – ${f.hasta ? fechaBonita(f.hasta) : 'hoy'}`;
}

function resumir(movs) {
  const r = { vendido: 0, cobrado: 0, ganancia: 0, revista: 0, mayoreo: 0, ventas: 0, productos: {}, clientes: {} };
  for (const m of movs) {
    if (m.tipo === 'abono') { r.cobrado += m.total; continue; }
    r.vendido += m.total;
    r.ventas++;
    r.clientes[m.clienteId] = (r.clientes[m.clienteId] || 0) + m.total;
    for (const it of m.items) {
      const sub = it.cant * it.precio;
      if (it.tipo === 'mayoreo') r.mayoreo += sub; else r.revista += sub;
      if (it.costo) r.ganancia += it.cant * (it.precio - it.costo);
      const p = (r.productos[it.nombre] ||= { nombre: it.nombre, tipo: it.tipo, cant: 0, importe: 0 });
      p.cant += it.cant;
      p.importe += sub;
    }
  }
  return r;
}

function vistaInformes() {
  titulo.textContent = 'Informes';
  const f = filtros.informes;
  const [desde, hasta] = rangoInforme();
  const movs = ordenarMovs(db.movimientos.filter((m) => m.fecha >= desde && m.fecha <= hasta));
  const r = resumir(movs);

  // Gráfica: lo vendido en los últimos 12 meses
  const mesActual = hoy().slice(0, 7);
  const meses = Array.from({ length: 12 }, (_, i) => sumarMeses(mesActual, i - 11));
  const porMes = Object.fromEntries(meses.map((m) => [m, 0]));
  for (const m of db.movimientos) {
    const ym = m.fecha.slice(0, 7);
    if (m.tipo === 'venta' && ym in porMes) porMes[ym] += m.total;
  }
  const mayor = Math.max(...Object.values(porMes));
  const maximo = mayor || 1;

  const topProductos = Object.values(r.productos).sort((a, b) => b.importe - a.importe).slice(0, 10);
  const topClientes = Object.entries(r.clientes).sort((a, b) => b[1] - a[1]).slice(0, 10);

  const visibles = movs.filter((m) => f.tipoMov === 'todos' || m.tipo === f.tipoMov);

  vista.innerHTML = `
    <div class="filtros">
      ${Object.entries(PERIODOS).map(([k, t]) => `<button class="filtro ${f.periodo === k ? 'activo' : ''}" data-accion="periodo" data-valor="${k}">${t}</button>`).join('')}
    </div>
    ${f.periodo === 'rango' ? `
      <div class="cuadros" style="margin-bottom:12px">
        <label class="campo" style="margin:0">Desde<input type="date" data-rango="desde" value="${f.desde}"></label>
        <label class="campo" style="margin:0">Hasta<input type="date" data-rango="hasta" value="${f.hasta}"></label>
      </div>` : ''}

    <div class="tarjeta destacado">
      <div class="etiqueta">Vendido · ${esc(textoRango())}</div>
      <div class="monto-grande">${dinero(r.vendido)}</div>
      <div class="etiqueta">${r.ventas} ${r.ventas === 1 ? 'venta' : 'ventas'}${r.ventas ? ` · promedio ${dinero(r.vendido / r.ventas)}` : ''}</div>
    </div>
    <div class="cuadros">
      <div class="tarjeta"><div class="etiqueta">Cobrado</div><div class="valor pagado">${dinero(r.cobrado)}</div></div>
      <div class="tarjeta"><div class="etiqueta">Ganancia estimada</div><div class="valor">${dinero(r.ganancia)}</div></div>
      <div class="tarjeta"><div class="etiqueta">De revista</div><div class="valor">${dinero(r.revista)}</div></div>
      <div class="tarjeta"><div class="etiqueta">De mayoreo</div><div class="valor">${dinero(r.mayoreo)}</div></div>
    </div>

    <h2>Ventas de los últimos 12 meses</h2>
    <div class="tarjeta">
      <div class="grafica" role="img" aria-label="Ventas por mes">
        ${meses.map((m) => {
          const elegido = `${m}-01` >= desde && `${m}-31` <= hasta;
          return `<button class="barra-mes ${elegido ? 'elegida' : ''}" data-accion="ver-mes" data-valor="${m}" title="${nombreDeMes(m)}: ${dinero(porMes[m])}">
            <span class="columna"><span style="height:${porMes[m] ? Math.max(3, (porMes[m] / maximo) * 100) : 0}%"></span></span>
            <span class="mes">${nombreDeMes(m, false).replace('.', '')}</span>
          </button>`;
        }).join('')}
      </div>
      <div class="etiqueta" style="margin-top:8px">Mes más alto: ${dinero(mayor)} · Toca una barra para ver ese mes.</div>
    </div>

    <h2>Productos más vendidos</h2>
    ${topProductos.length ? `<div class="lista">${topProductos.map((p) => `
      <div class="item" style="cursor:default">
        <div class="principal"><div class="nombre">${esc(p.nombre)}</div><div class="sub"><span class="chip ${p.tipo}">${TIPOS[p.tipo]}</span> ${p.cant} ${p.cant === 1 ? 'pieza' : 'piezas'}</div></div>
        <div class="cifra">${dinero(p.importe)}</div>
      </div>`).join('')}</div>` : `<div class="tarjeta vacio" style="padding:20px">Sin ventas en este periodo.</div>`}

    <h2>Clientes que más compraron</h2>
    ${topClientes.length ? `<div class="lista">${topClientes.map(([id, total]) => {
      const c = cliente(id) || { nombre: 'Cliente borrado' };
      return `<a class="item" ${cliente(id) ? `href="#/cliente/${id}"` : ''}>
        <div class="avatar">${cliente(id) ? avatar(c) : '?'}</div>
        <div class="principal"><div class="nombre">${esc(c.nombre)}</div></div>
        <div class="cifra">${dinero(total)}</div>
      </a>`;
    }).join('')}</div>` : `<div class="tarjeta vacio" style="padding:20px">Sin ventas en este periodo.</div>`}

    <h2>Movimientos (${visibles.length})</h2>
    <div class="filtros">
      ${[['todos', 'Todos'], ['venta', 'Ventas'], ['abono', 'Abonos']].map(([k, t]) => `<button class="filtro ${f.tipoMov === k ? 'activo' : ''}" data-accion="tipo-mov" data-valor="${k}">${t}</button>`).join('')}
    </div>
    ${visibles.length ? `<div class="lista">${visibles.slice(0, f.limite).map((m) => movItem(m, true)).join('')}</div>
      ${visibles.length > f.limite ? `<button class="btn sec ancho" style="margin-top:10px" data-accion="ver-mas-movs">Ver más (${visibles.length - f.limite} restantes)</button>` : ''}`
      : `<div class="tarjeta vacio" style="padding:20px">No hay movimientos en este periodo.</div>`}
  `;

  vista.querySelectorAll('[data-rango]').forEach((el) => el.addEventListener('change', () => {
    f[el.dataset.rango] = el.value;
    f.limite = 40;
    render();
  }));
}

/* =========================================================
   Vista: Respaldo / Ajustes
   ========================================================= */
let eventoInstalar = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); eventoInstalar = e; if (location.hash === '#/ajustes') render(); });

function vistaAjustes() {
  titulo.textContent = 'Respaldo';
  vista.innerHTML = `
    <div class="tarjeta">
      <b>💾 Respaldo de tus datos</b>
      <p class="texto-tenue">Toda la información vive solo en este teléfono. Haz un respaldo seguido y guárdalo en WhatsApp, Drive o tu correo. Si cambias de celular o se borra la app, podrás recuperar todo.</p>
      <p class="texto-tenue">Último respaldo: <b>${db.ultimoRespaldo ? new Date(db.ultimoRespaldo).toLocaleString('es-MX') : 'nunca'}</b></p>
      <button class="btn ancho" data-accion="exportar">Hacer respaldo</button>
      <div style="height:10px"></div>
      <button class="btn sec ancho" data-accion="importar">Restaurar desde un respaldo</button>
    </div>

    ${eventoInstalar ? `<div class="tarjeta"><b>📲 Instalar en el teléfono</b><p class="texto-tenue">Agrega la app a tu pantalla de inicio para abrirla como cualquier otra app, aun sin internet.</p><button class="btn ancho" data-accion="instalar">Instalar app</button></div>` : ''}

    <div class="tarjeta">
      <b>Resumen</b>
      <p class="texto-tenue" style="margin-bottom:0">${db.clientes.length} clientes · ${db.productos.length} productos · ${db.movimientos.length} movimientos</p>
    </div>

    <div class="tarjeta">
      <b>Zona de peligro</b>
      <p class="texto-tenue">Borra toda la información de este teléfono. No se puede deshacer.</p>
      <button class="btn peligro ancho" data-accion="borrar-todo">Borrar todo</button>
    </div>
  `;
}

// true cuando la app corre como APK (Capacitor) y no en el navegador
const esApp = () => !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());

function marcarRespaldo(texto) {
  db.ultimoRespaldo = Date.now();
  guardar();
  aviso(texto);
  render();
}

async function exportar() {
  const nombre = `respaldo-cuentas-${hoy()}.json`;
  const contenido = JSON.stringify({ ...db, ultimoRespaldo: Date.now(), fotos });

  // En el APK: se guarda en el teléfono y se abre el menú de compartir de Android
  if (esApp()) {
    const { Filesystem, Share } = window.Capacitor.Plugins;
    try {
      const { uri } = await Filesystem.writeFile({ path: nombre, data: contenido, directory: 'CACHE', encoding: 'utf8' });
      await Share.share({ title: 'Respaldo Mis Cuentas', files: [uri] });
      marcarRespaldo('Respaldo listo');
    } catch (e) {
      // Cerró el menú sin elegir dónde guardarlo: no cuenta como respaldo
      if (!/cancel/i.test(e.message || '')) alert('No se pudo hacer el respaldo: ' + (e.message || e));
    }
    return;
  }

  const archivo = new File([contenido], nombre, { type: 'application/json' });

  // En el navegador del celular: menú de compartir (WhatsApp, Drive, correo…)
  if (navigator.canShare && navigator.canShare({ files: [archivo] })) {
    try {
      await navigator.share({ files: [archivo], title: 'Respaldo Mis Cuentas' });
      marcarRespaldo('Respaldo listo');
      return;
    } catch (e) {
      if (e.name === 'AbortError') return; // lo canceló: no cuenta como respaldo
    }
  }

  // En la computadora: se descarga el archivo
  const a = document.createElement('a');
  a.href = URL.createObjectURL(archivo);
  a.download = nombre;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  marcarRespaldo('Respaldo descargado');
}

document.getElementById('archivo').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const d = JSON.parse(await f.text());
    if (!Array.isArray(d.clientes) || !Array.isArray(d.movimientos)) throw new Error('formato');
    if (!confirm(`Este respaldo tiene ${d.clientes.length} clientes y ${d.movimientos.length} movimientos.\n\nSe reemplazará todo lo que hay ahora en el teléfono. ¿Continuar?`)) return;
    db = normalizar(d);
    guardar();
    await reemplazarFotos(d.fotos || {});
    aviso('Datos restaurados');
    location.hash = '#/inicio';
    render();
  } catch (err) {
    alert('Ese archivo no es un respaldo válido.');
  }
});

/* =========================================================
   Formularios (hoja inferior)
   ========================================================= */
const modal = document.getElementById('modal');

function abrirModal(html, alGuardar) {
  modal.innerHTML = `<form class="hoja" novalidate>${html}</form>`;
  const form = modal.querySelector('form');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!form.checkValidity()) { form.reportValidity(); return; }
    if (alGuardar(form) !== false) cerrarModal();
  });
  modal.showModal();
  const primero = form.querySelector('[autofocus]');
  if (primero) primero.focus();
  return form;
}

function cerrarModal() {
  modal.close();
  render();
}

modal.addEventListener('click', (e) => { if (e.target === modal) modal.close(); });

const botonesForm = (texto = 'Guardar') => `
  <div class="botones">
    <button type="button" class="btn sec" data-accion="cerrar">Cancelar</button>
    <button type="submit" class="btn">${texto}</button>
  </div>`;

/* ---------- Cliente ---------- */
function formCliente(id) {
  const c = id ? cliente(id) : { nombre: '', telefono: '', notas: '' };
  abrirModal(`
    <h3>${id ? 'Editar cliente' : 'Nuevo cliente'}</h3>
    <label class="campo">Nombre<input name="nombre" required value="${esc(c.nombre)}" autocomplete="off" ${id ? '' : 'autofocus'}></label>
    <label class="campo">Teléfono (WhatsApp)<input name="telefono" type="tel" inputmode="tel" value="${esc(c.telefono)}" placeholder="10 dígitos"></label>
    <label class="campo">Notas<textarea name="notas" placeholder="Dirección, día de cobro, etc.">${esc(c.notas)}</textarea></label>
    ${botonesForm()}
    ${id ? `<button type="button" class="btn peligro ancho" style="margin-top:20px" data-accion="borrar-cliente" data-id="${id}">Eliminar cliente</button>` : ''}
  `, (form) => {
    const datos = { nombre: form.nombre.value.trim(), telefono: form.telefono.value.trim(), notas: form.notas.value.trim() };
    if (!datos.nombre) return false;
    if (id) {
      Object.assign(c, datos);
      aviso('Cliente actualizado');
    } else {
      const nuevo = { id: uid(), creado: Date.now(), ...datos };
      db.clientes.push(nuevo);
      guardar();
      modal.close();
      location.hash = `#/cliente/${nuevo.id}`;
      aviso('Cliente agregado');
      return false;
    }
    guardar();
  });
}

/* ---------- Venta ---------- */
function selectorCliente(idElegido) {
  const ordenados = [...db.clientes].sort((a, b) => a.nombre.localeCompare(b.nombre));
  return `<label class="campo">Cliente<select name="cliente" required>
    <option value="">— Elige —</option>
    <option value="${ANONIMO.id}" ${idElegido === ANONIMO.id ? 'selected' : ''}>👤 Sin nombre</option>
    ${ordenados.map((c) => `<option value="${c.id}" ${c.id === idElegido ? 'selected' : ''}>${esc(c.nombre)}</option>`).join('')}
  </select></label>`;
}

function formVenta(clienteId) {
  const c = clienteId && cliente(clienteId);

  // Productos elegidos: { productoId, nombre, codigo, tipo, costo, precio, cant, guardarEnLista }
  const carrito = [];
  const busqueda = { q: '', tipo: 'todos' };

  const form = abrirModal(`
    <h3>Nueva venta${c ? ' · ' + esc(c.nombre) : ''}</h3>
    ${c ? '' : selectorCliente()}
    <label class="campo">Fecha<input name="fecha" type="date" required value="${hoy()}"></label>

    <div class="etiqueta" style="margin-bottom:6px">Elige los productos</div>
    <input id="buscar-prod" type="search" placeholder="Buscar por nombre, código o revista…" autocomplete="off">
    <div class="filtros" style="margin:8px 0">
      ${['todos', 'revista', 'mayoreo'].map((t) => `<button type="button" class="filtro ${t === 'todos' ? 'activo' : ''}" data-filtro="${t}">${t === 'todos' ? 'Todos' : TIPOS[t]}</button>`).join('')}
    </div>
    <div id="catalogo" class="lista catalogo"></div>
    <button type="button" class="btn sec ancho" data-libre style="margin-top:8px">＋ Producto que no está en la lista</button>

    <div id="carrito" style="margin-top:16px"></div>
    <div class="total-venta"><span>Total</span><span id="total">${dinero(0)}</span></div>
    <label class="campo">¿Pagó algo en este momento?<input name="pago" type="number" inputmode="decimal" min="0" step="0.01" placeholder="$0.00"></label>
    <label class="campo">Nota<input name="nota" placeholder="Opcional (ej. campaña 15)"></label>
    ${botonesForm('Guardar venta')}
  `, (form) => {
    const cid = c ? c.id : form.cliente.value;
    const items = carrito
      .filter((it) => it.nombre.trim())
      .map((it) => ({ nombre: it.nombre.trim(), codigo: (it.codigo || '').trim(), cant: it.cant, precio: r2(it.precio), costo: r2(it.costo), tipo: it.tipo }));
    if (!items.length) { aviso('Elige al menos un producto'); return false; }

    // Productos nuevos que se pidieron guardar en "Mis productos"
    for (const it of carrito) {
      if (it.productoId || !it.guardarEnLista || !it.nombre.trim()) continue;
      const nombre = it.nombre.trim();
      if (db.productos.some((p) => p.nombre.toLowerCase() === nombre.toLowerCase())) continue;
      db.productos.push({ id: uid(), nombre, codigo: (it.codigo || '').trim(), tipo: it.tipo, catalogo: '', precio: r2(it.precio), costo: r2(it.costo) });
    }

    const total = r2(items.reduce((s, it) => s + it.cant * it.precio, 0));
    const fecha = form.fecha.value || hoy();
    db.movimientos.push({ id: uid(), creado: Date.now(), clienteId: cid, tipo: 'venta', fecha, items, total, nota: form.nota.value.trim() });

    const pago = r2(num(form.pago.value));
    if (pago > 0) {
      db.movimientos.push({ id: uid(), creado: Date.now() + 1, clienteId: cid, tipo: 'abono', fecha, total: pago, nota: 'Pago al momento de la compra' });
    }
    guardar();
    aviso('Venta guardada');
    if (!c) { modal.close(); location.hash = `#/cliente/${cid}`; return false; }
  });

  const catalogo = form.querySelector('#catalogo');
  const zonaCarrito = form.querySelector('#carrito');

  const pintarCatalogo = () => {
    const q = busqueda.q.trim().toLowerCase();
    // La lista solo aparece cuando se busca algo o se elige Revista/Mayoreo
    if (!q && busqueda.tipo === 'todos') { catalogo.hidden = true; return; }
    catalogo.hidden = false;
    const lista = db.productos
      .filter((p) => (busqueda.tipo === 'todos' || p.tipo === busqueda.tipo) && (!q || coincideProducto(p, q)))
      .sort((a, b) => a.nombre.localeCompare(b.nombre));
    catalogo.innerHTML = lista.length
      ? lista.map((p) => {
          const enCarrito = carrito.find((it) => it.productoId === p.id);
          return `<button type="button" class="item" data-elegir="${p.id}">
            ${miniatura(p.id)}
            <div class="principal"><div class="nombre">${esc(p.nombre)}</div><div class="sub"><span class="chip ${p.tipo}">${TIPOS[p.tipo]}</span> ${esc([p.codigo && '#' + p.codigo, p.catalogo].filter(Boolean).join(' · '))}</div></div>
            <div class="cifra">${dinero(p.precio)}</div>
            <span class="agregar">${enCarrito ? enCarrito.cant + '✓' : '＋'}</span>
          </button>`;
        }).join('')
      : `<div class="vacio" style="padding:16px">${db.productos.length ? 'No se encontró. Usa el botón de abajo para agregarlo.' : 'Aún no tienes productos guardados.'}</div>`;
  };

  // En ventas sin nombre lo normal es que paguen al momento: el pago sigue al total
  // hasta que lo cambies a mano.
  let pagoEditado = false;
  const esAnonimo = () => (c ? c.anonimo : form.cliente.value === ANONIMO.id);

  const recalcular = () => {
    const total = r2(carrito.reduce((s, it) => s + it.cant * it.precio, 0));
    form.querySelector('#total').textContent = dinero(total);
    if (esAnonimo() && !pagoEditado) form.pago.value = total || '';
  };

  const controlCantidad = (it, i) => `
    <div class="cantidad">
      <button type="button" data-menos="${i}" aria-label="Menos">−</button>
      <span>${it.cant}</span>
      <button type="button" data-mas="${i}" aria-label="Más">＋</button>
    </div>`;

  const renglonGuardado = (it, i) => `
    <div class="linea renglon">
      <div class="principal">
        <div class="nombre">${esc(it.nombre)}</div>
        ${controlCantidad(it, i)}
      </div>
      <label class="precio">Precio c/u<input data-precio="${i}" type="number" inputmode="decimal" min="0" step="0.01" value="${it.precio || ''}"></label>
    </div>`;

  const renglonNuevo = (it, i) => `
    <div class="linea">
      <div class="etiqueta" style="margin-bottom:6px">Producto nuevo</div>
      <input data-nombre="${i}" value="${esc(it.nombre)}" placeholder="Nombre del producto" autocomplete="off">
      <div class="dos">
        <label>Código / ID<input data-codigo="${i}" value="${esc(it.codigo)}" placeholder="opcional" autocomplete="off"></label>
        <label>¿De dónde es?<select data-tipo="${i}">
          <option value="revista" ${it.tipo === 'revista' ? 'selected' : ''}>De revista</option>
          <option value="mayoreo" ${it.tipo === 'mayoreo' ? 'selected' : ''}>Mayoreo / otro lado</option>
        </select></label>
        <label>Precio de venta<input data-precio="${i}" type="number" inputmode="decimal" min="0" step="0.01" value="${it.precio || ''}"></label>
        <label>Precio de compra<input data-costo="${i}" type="number" inputmode="decimal" min="0" step="0.01" value="${it.costo || ''}" placeholder="opcional"></label>
      </div>
      <div class="pie-nuevo">
        ${controlCantidad(it, i)}
        <label class="casilla"><input type="checkbox" data-guardar="${i}" ${it.guardarEnLista ? 'checked' : ''}> Guardar en mis productos</label>
      </div>
    </div>`;

  const pintarCarrito = () => {
    zonaCarrito.innerHTML = carrito.length
      ? `<div class="etiqueta" style="margin-bottom:6px">En esta venta</div>` +
        carrito.map((it, i) => (it.productoId ? renglonGuardado(it, i) : renglonNuevo(it, i))).join('')
      : '';
    recalcular();
  };

  form.querySelector('#buscar-prod').addEventListener('input', (e) => { busqueda.q = e.target.value; pintarCatalogo(); });

  form.addEventListener('input', (e) => {
    if (e.target.name === 'pago') pagoEditado = true;
    if (e.target.name === 'cliente') { pagoEditado = false; if (!esAnonimo()) form.pago.value = ''; recalcular(); }
    const d = e.target.dataset;
    if (d.precio !== undefined) { carrito[d.precio].precio = num(e.target.value); recalcular(); }
    if (d.nombre !== undefined) carrito[d.nombre].nombre = e.target.value;
    if (d.codigo !== undefined) carrito[d.codigo].codigo = e.target.value;
    if (d.costo !== undefined) carrito[d.costo].costo = num(e.target.value);
    if (d.tipo !== undefined) carrito[d.tipo].tipo = e.target.value;
    if (d.guardar !== undefined) carrito[d.guardar].guardarEnLista = e.target.checked;
  });

  form.addEventListener('click', (e) => {
    const el = e.target.closest('[data-filtro], [data-elegir], [data-libre], [data-mas], [data-menos]');
    if (!el) return;
    const d = el.dataset;

    if (d.filtro) {
      busqueda.tipo = d.filtro;
      form.querySelectorAll('[data-filtro]').forEach((b) => b.classList.toggle('activo', b === el));
      pintarCatalogo();
    } else if (d.elegir) {
      const ya = carrito.find((it) => it.productoId === d.elegir);
      if (ya) ya.cant++;
      else {
        const p = producto(d.elegir);
        carrito.push({ productoId: p.id, nombre: p.nombre, codigo: p.codigo || '', tipo: p.tipo, costo: p.costo || 0, precio: p.precio, cant: 1 });
      }
      pintarCatalogo(); pintarCarrito();
    } else if (d.libre !== undefined) {
      // Si ya escribió algo en el buscador, se usa como nombre del producto nuevo
      carrito.push({ productoId: null, nombre: busqueda.q.trim(), codigo: '', tipo: busqueda.tipo === 'mayoreo' ? 'mayoreo' : 'revista', costo: 0, precio: 0, cant: 1, guardarEnLista: false });
      pintarCarrito();
      busqueda.q = '';
      form.querySelector('#buscar-prod').value = '';
      pintarCatalogo();
      const nuevo = zonaCarrito.querySelector(`[data-nombre="${carrito.length - 1}"]`);
      (nuevo.value ? zonaCarrito.querySelector(`[data-precio="${carrito.length - 1}"]`) : nuevo).focus();
    } else if (d.mas) {
      carrito[d.mas].cant++;
      pintarCatalogo(); pintarCarrito();
    } else if (d.menos) {
      if (--carrito[d.menos].cant < 1) carrito.splice(d.menos, 1);
      pintarCatalogo(); pintarCarrito();
    }
  });

  pintarCatalogo();
}

/* ---------- Abono ---------- */
function formAbono(clienteId) {
  const c = clienteId && cliente(clienteId);
  const saldo = c ? saldoDe(c.id) : 0;

  const form = abrirModal(`
    <h3>Registrar abono${c ? ' · ' + esc(c.nombre) : ''}</h3>
    ${c ? `<p class="texto-tenue" style="margin-top:-8px">Saldo actual: <b>${dinero(saldo)}</b></p>` : selectorCliente()}
    <label class="campo">¿Cuánto te pagó?<input name="monto" type="number" inputmode="decimal" min="0.01" step="0.01" required autofocus></label>
    ${c && saldo > 0.009 ? `<button type="button" class="btn sec ancho" data-liquidar style="margin-bottom:12px">Liquidó todo (${dinero(saldo)})</button>` : ''}
    <label class="campo">Fecha<input name="fecha" type="date" required value="${hoy()}"></label>
    <label class="campo">Nota<input name="nota" placeholder="Opcional (ej. transferencia)"></label>
    ${botonesForm('Guardar abono')}
  `, (form) => {
    const cid = c ? c.id : form.cliente.value;
    const monto = r2(num(form.monto.value));
    if (monto <= 0) return false;
    db.movimientos.push({ id: uid(), creado: Date.now(), clienteId: cid, tipo: 'abono', fecha: form.fecha.value || hoy(), total: monto, nota: form.nota.value.trim() });
    guardar();
    const restante = saldoDe(cid);
    aviso(restante > 0.009 ? `Abono guardado. Resta ${dinero(restante)}` : '¡Cuenta liquidada! 🎉');
    if (!c) { modal.close(); location.hash = `#/cliente/${cid}`; return false; }
  });

  const liquidar = form.querySelector('[data-liquidar]');
  if (liquidar) liquidar.addEventListener('click', () => { form.monto.value = saldo; });
}

/* ---------- Detalle de movimiento ---------- */
function verMovimiento(id) {
  const m = db.movimientos.find((x) => x.id === id);
  if (!m) return;
  const esVenta = m.tipo === 'venta';
  abrirModal(`
    <h3>${esVenta ? '🛍️ Venta' : '💵 Abono'} · ${fechaBonita(m.fecha)}</h3>
    ${esVenta ? `<table class="detalle-items">${m.items.map((it) => `
      <tr><td>${it.cant}× ${esc(it.nombre)}${it.codigo ? ` <span class="texto-tenue">#${esc(it.codigo)}</span>` : ''} <span class="chip ${it.tipo}">${TIPOS[it.tipo]}</span><br><span class="texto-tenue">${dinero(it.precio)} c/u${it.costo ? ` · costo ${dinero(it.costo)}` : ''}</span></td><td>${dinero(it.cant * it.precio)}</td></tr>`).join('')}
    </table>` : ''}
    <div class="total-venta"><span>Total</span><span>${dinero(m.total)}</span></div>
    ${m.nota ? `<p class="texto-tenue">📝 ${esc(m.nota)}</p>` : ''}
    <div class="botones">
      <button type="button" class="btn peligro" data-accion="borrar-mov" data-id="${m.id}">Eliminar</button>
      <button type="button" class="btn sec" data-accion="cerrar">Cerrar</button>
    </div>
  `, () => {});
}

/* ---------- Producto ---------- */
function formProducto(id) {
  const p = id ? producto(id) : { nombre: '', tipo: filtros.productos.tipo === 'mayoreo' ? 'mayoreo' : 'revista', catalogo: '', precio: '', costo: '' };
  const catalogos = [...new Set(db.productos.map((x) => x.catalogo).filter(Boolean))];
  // undefined = sin cambios, null = quitar la foto, texto = foto nueva
  let fotoNueva;

  const form = abrirModal(`
    <h3>${id ? 'Editar producto' : 'Nuevo producto'}</h3>
    <div class="foto-producto" id="vista-foto">${id && fotos[id] ? `<img src="${fotos[id]}" alt="">` : '<span>📷<br>Sin foto</span>'}</div>
    <div class="acciones">
      <label class="btn sec">📷 Tomar foto<input type="file" accept="image/*" capture="environment" data-foto hidden></label>
      <label class="btn sec">🖼️ Galería<input type="file" accept="image/*" data-foto hidden></label>
    </div>
    <button type="button" class="quitar" data-quitar-foto ${id && fotos[id] ? '' : 'hidden'} style="margin:-4px 0 8px">Quitar foto</button>
    <label class="campo">Nombre<input name="nombre" required value="${esc(p.nombre)}" autocomplete="off"></label>
    <label class="campo">Tipo<select name="tipo">
      <option value="revista" ${p.tipo === 'revista' ? 'selected' : ''}>De revista / catálogo</option>
      <option value="mayoreo" ${p.tipo === 'mayoreo' ? 'selected' : ''}>Comprado al mayoreo</option>
    </select></label>
    <label class="campo">Código / ID<input name="codigo" value="${esc(p.codigo || '')}" placeholder="Opcional (el de la revista o etiqueta)" autocomplete="off"></label>
    <label class="campo">Revista o proveedor<input name="catalogo" list="dl-catalogos" value="${esc(p.catalogo)}" placeholder="Ej. Avon, Jafra, Price Shoes…"></label>
    <datalist id="dl-catalogos">${catalogos.map((x) => `<option value="${esc(x)}">`).join('')}</datalist>
    <div class="cuadros" style="margin:0">
      <label class="campo">Precio de venta<input name="precio" type="number" inputmode="decimal" min="0" step="0.01" required value="${p.precio}"></label>
      <label class="campo">Lo que te cuesta<input name="costo" type="number" inputmode="decimal" min="0" step="0.01" value="${p.costo || ''}" placeholder="opcional"></label>
    </div>
    ${botonesForm()}
    ${id ? `<button type="button" class="btn peligro ancho" style="margin-top:20px" data-accion="borrar-producto" data-id="${id}">Eliminar producto</button>` : ''}
  `, (form) => {
    const datos = {
      nombre: form.nombre.value.trim(),
      tipo: form.tipo.value,
      codigo: form.codigo.value.trim(),
      catalogo: form.catalogo.value.trim(),
      precio: r2(num(form.precio.value)),
      costo: r2(num(form.costo.value)),
    };
    if (!datos.nombre) return false;
    const idFinal = id || uid();
    if (id) Object.assign(p, datos);
    else db.productos.push({ id: idFinal, ...datos });
    guardar();
    if (fotoNueva === null) borrarFoto(idFinal);
    else if (fotoNueva) guardarFoto(idFinal, fotoNueva);
    aviso(id ? 'Producto actualizado' : 'Producto guardado');
  });

  const vistaFoto = form.querySelector('#vista-foto');
  const quitarFoto = form.querySelector('[data-quitar-foto]');

  form.addEventListener('change', async (e) => {
    if (!e.target.matches('[data-foto]')) return;
    const archivo = e.target.files[0];
    e.target.value = '';
    if (!archivo) return;
    try {
      fotoNueva = await reducirImagen(archivo);
      vistaFoto.innerHTML = `<img src="${fotoNueva}" alt="">`;
      quitarFoto.hidden = false;
    } catch (err) {
      aviso('No se pudo leer la foto');
    }
  });

  quitarFoto.addEventListener('click', () => {
    fotoNueva = null;
    vistaFoto.innerHTML = '<span>📷<br>Sin foto</span>';
    quitarFoto.hidden = true;
  });
}

/* =========================================================
   Acciones (un solo manejador para todos los botones)
   ========================================================= */
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-accion]');
  if (!el) return;
  const { accion, id, valor } = el.dataset;

  switch (accion) {
    case 'cerrar': modal.close(); break;
    case 'nuevo-cliente': formCliente(); break;
    case 'editar-cliente': formCliente(id); break;
    case 'nueva-venta': formVenta(id); break;
    case 'abono': formAbono(id); break;
    case 'ver-mov': verMovimiento(id); break;
    case 'nuevo-producto': formProducto(); break;
    case 'editar-producto': formProducto(id); break;
    case 'exportar': exportar(); break;
    case 'importar': document.getElementById('archivo').click(); break;

    case 'filtro-clientes':
      filtros.clientes.soloDeben = valor === 'deben';
      render();
      break;
    case 'periodo':
      filtros.informes.periodo = valor;
      filtros.informes.limite = 40;
      render();
      break;
    case 'ver-mes':
      Object.assign(filtros.informes, { periodo: 'rango', desde: valor + '-01', hasta: valor + '-31', limite: 40 });
      render();
      break;
    case 'tipo-mov':
      filtros.informes.tipoMov = valor;
      filtros.informes.limite = 40;
      render();
      break;
    case 'ver-mas-movs':
      filtros.informes.limite += 40;
      render();
      break;
    case 'filtro-productos':
      filtros.productos.tipo = valor;
      render();
      break;

    case 'borrar-mov':
      if (!confirm('¿Eliminar este movimiento? El saldo del cliente se ajustará.')) return;
      db.movimientos = db.movimientos.filter((m) => m.id !== id);
      guardar();
      cerrarModal();
      aviso('Movimiento eliminado');
      break;

    case 'borrar-cliente': {
      const c = cliente(id);
      const n = movsDe(id).length;
      if (!confirm(`¿Eliminar a ${c.nombre}${n ? ` y sus ${n} movimientos` : ''}? No se puede deshacer.`)) return;
      db.clientes = db.clientes.filter((x) => x.id !== id);
      db.movimientos = db.movimientos.filter((m) => m.clienteId !== id);
      guardar();
      modal.close();
      location.hash = '#/clientes';
      aviso('Cliente eliminado');
      break;
    }

    case 'borrar-producto':
      if (!confirm('¿Eliminar este producto del catálogo? Las ventas ya registradas no cambian.')) return;
      db.productos = db.productos.filter((p) => p.id !== id);
      guardar();
      borrarFoto(id);
      cerrarModal();
      break;

    case 'borrar-todo':
      if (!confirm('¿Seguro que quieres BORRAR TODO? Te recomiendo hacer un respaldo antes.')) return;
      if (prompt('Escribe BORRAR para confirmar') !== 'BORRAR') return;
      db = normalizar({});
      guardar();
      reemplazarFotos({});
      aviso('Se borró todo');
      location.hash = '#/inicio';
      render();
      break;

    case 'instalar':
      if (eventoInstalar) {
        eventoInstalar.prompt();
        eventoInstalar.userChoice.finally(() => { eventoInstalar = null; render(); });
      }
      break;
  }
});

/* =========================================================
   Arranque
   ========================================================= */
// En el APK los archivos ya vienen dentro de la app: no hace falta el service worker
if ('serviceWorker' in navigator && location.protocol !== 'file:' && !esApp()) {
  navigator.serviceWorker.register('sw.js');
}

render();
// Las fotos se cargan aparte; al terminar se vuelve a pintar para mostrarlas
cargarFotos().then(render).catch(() => {});
