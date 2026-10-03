'use strict';

/* =========================================================
   Datos (se guardan en el teléfono con localStorage)
   ========================================================= */
const CLAVE = 'vendedora-datos-v1';
const TIPOS = { revista: 'Revista', mayoreo: 'Mayoreo', lociones: 'Lociones' };
// Nombre largo para las listas desplegables
const TIPOS_LARGO = { revista: 'De revista / catálogo', mayoreo: 'Mayoreo / otro lado', lociones: 'Lociones hechas a mano' };

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
    compras: d.compras || [],
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

/* ---------- Existencias (opcional por producto) ----------
   p.existencias es un número si se lleva la cuenta de piezas, o null/ausente si no. */
const tieneExistencias = (p) => p && typeof p.existencias === 'number';

function etiquetaExistencias(p) {
  if (!tieneExistencias(p)) return '';
  if (p.existencias <= 0) return `<span class="existencias agotado">Agotado</span>`;
  return `<span class="existencias ${p.existencias <= 2 ? 'pocas' : ''}">Quedan ${p.existencias}</span>`;
}

// Suma (+1) o resta (-1) las piezas de una venta al inventario de cada producto
function moverExistencias(items, signo) {
  for (const it of items) {
    const p = it.productoId && producto(it.productoId);
    if (tieneExistencias(p)) p.existencias = Math.max(0, p.existencias + signo * it.cant);
  }
}

const coincideProducto = (p, q) =>
  p.nombre.toLowerCase().includes(q) || (p.catalogo || '').toLowerCase().includes(q) || (p.codigo || '').toLowerCase().includes(q);

// Ícono del sprite de index.html
const ic = (nombre) => `<svg class="ico" aria-hidden="true"><use href="#i-${nombre}"/></svg>`;
const ICONO_TIPO = { revista: 'revista', mayoreo: 'mayoreo', lociones: 'locion' };
const opcionesTipo = (elegido) => Object.keys(TIPOS)
  .map((t) => `<option value="${t}" ${t === elegido ? 'selected' : ''}>${TIPOS_LARGO[t]}</option>`).join('');
// Si hay un filtro de categoría activo, lo nuevo nace en esa categoría
const tipoInicial = (filtro) => (filtro in TIPOS ? filtro : 'revista');

// Tarjeta con lo vendido por categoría: { revista: 123, mayoreo: 45, ... }
function tarjetaCategorias(porTipo) {
  const total = Object.values(porTipo).reduce((s, v) => s + v, 0) || 1;
  return `<div class="tarjeta categorias">
    <div class="etiqueta" style="margin-bottom:10px">Vendido por categoría</div>
    ${Object.keys(TIPOS).map((t) => `
      <div class="categoria ${t}">
        <div class="stat-ico ${t}">${ic(ICONO_TIPO[t])}</div>
        <div class="categoria-texto">
          <div class="categoria-fila"><span>${TIPOS_LARGO[t]}</span><b>${dinero(porTipo[t] || 0)}</b></div>
          <div class="categoria-barra"><span style="width:${((porTipo[t] || 0) / total) * 100}%"></span></div>
        </div>
      </div>`).join('')}
  </div>`;
}
const chipTipo = (tipo) => `<span class="chip ${tipo}">${ic(ICONO_TIPO[tipo])}${TIPOS[tipo]}</span>`;

const miniatura = (idProducto) => (fotos[idProducto]
  ? `<img class="miniatura" src="${fotos[idProducto]}" alt="">`
  : `<div class="miniatura vacia">${ic('etiqueta')}</div>`);

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

// Hora en que se registró un movimiento. Sale de "creado" (milisegundos), que
// todos los movimientos guardan desde el principio, así que los viejos también la tienen.
function horaDe(m) {
  if (!m.creado || m.creado < 1e12) return '';
  return new Date(m.creado).toLocaleTimeString('es-MX', { hour: 'numeric', minute: '2-digit' });
}

const fechaHora = (m) => fechaBonita(m.fecha) + (horaDe(m) ? ` · ${horaDe(m)}` : '');

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
const avatar = (c) => (c.anonimo ? ic('persona') : esc(iniciales(c.nombre)));
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
  productos: { q: '', tipo: 'todos', vista: leerPreferencia('vendedora-vista-productos', 'cuadricula') },
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
   Tema: automático (sigue al teléfono), claro u oscuro.
   Se guarda aparte de los datos para que no viaje en los respaldos.
   ========================================================= */
const CLAVE_TEMA = 'vendedora-tema';
const TEMAS = { auto: 'Automático', claro: 'Claro', oscuro: 'Oscuro' };
const ICONO_TEMA = { auto: 'auto', claro: 'sol', oscuro: 'luna' };
const sistemaOscuro = window.matchMedia('(prefers-color-scheme: dark)');

function leerPreferencia(clave, porDefecto) {
  try { return localStorage.getItem(clave) || porDefecto; } catch (e) { return porDefecto; }
}

function escribirPreferencia(clave, valor) {
  try { localStorage.setItem(clave, valor); } catch (e) { /* sin almacenamiento: solo dura esta sesión */ }
}

// Claro por defecto; Automático y Oscuro se eligen en Ajustes
let tema = leerPreferencia(CLAVE_TEMA, 'claro');

const temaOscuro = () => tema === 'oscuro' || (tema === 'auto' && sistemaOscuro.matches);

// Color de la barra de estado del teléfono
function colorBarraEstado(color) {
  document.querySelector('meta[name="theme-color"]').setAttribute('content', color);
  // En el APK la barra de estado la controla Android, no la etiqueta meta
  const barraNativa = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.StatusBar;
  if (barraNativa && window.Capacitor.isNativePlatform()) barraNativa.setBackgroundColor({ color }).catch(() => {});
}

const colorTema = (variable) => getComputedStyle(document.documentElement).getPropertyValue(variable).trim();

function aplicarTema() {
  const raiz = document.documentElement;
  if (tema === 'auto') delete raiz.dataset.theme;
  else raiz.dataset.theme = tema === 'oscuro' ? 'dark' : 'light';

  colorBarraEstado(colorTema('--relleno'));

  // El botón de la barra muestra a qué tema se cambia al tocarlo
  const boton = document.getElementById('cambiar-tema');
  boton.innerHTML = ic(temaOscuro() ? 'sol' : 'luna');
  boton.setAttribute('aria-label', temaOscuro() ? 'Cambiar a tema claro' : 'Cambiar a tema oscuro');
}

function elegirTema(nuevo) {
  tema = nuevo;
  escribirPreferencia(CLAVE_TEMA, tema);
  aplicarTema();
}

document.getElementById('cambiar-tema').addEventListener('click', () => {
  elegirTema(temaOscuro() ? 'claro' : 'oscuro');
  if (location.hash === '#/ajustes') render();
});

sistemaOscuro.addEventListener('change', () => { if (tema === 'auto') aplicarTema(); });

/* =========================================================
   Vista: Inicio
   ========================================================= */
// La app es para una sola persona: la saludamos por su nombre según la hora
const NOMBRE_DUENA = 'Yarledy';

function saludo() {
  const h = new Date().getHours();
  const [texto, icono] = h >= 5 && h < 12 ? ['Buenos días', 'sol']
    : h >= 12 && h < 19 ? ['Buenas tardes', 'sol']
    : ['Buenas noches', 'luna'];
  const fecha = new Date().toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' });
  return `<div class="saludo">
    <div class="saludo-texto">${ic(icono)} ${texto}, <b>${NOMBRE_DUENA}</b></div>
    <div class="etiqueta">${fecha.charAt(0).toUpperCase() + fecha.slice(1)}</div>
  </div>`;
}

function vistaInicio() {
  titulo.textContent = 'Mis Cuentas';

  if (!db.clientes.length && !db.movimientos.length && !db.compras.length) {
    vista.innerHTML = `
      ${saludo()}
      <div class="vacio">
        <div class="vacio-ico">${ic('bolsa')}</div>
        <p><b>¡Qué gusto verte por aquí!</b><br>Aquí vas a llevar las cuentas de tus clientes: lo que te compran y lo que te van pagando.</p>
        <button class="btn" data-accion="nuevo-cliente">${ic('mas')} Agregar mi primera clienta</button>
        <div style="height:10px"></div>
        <button class="btn sec" data-accion="nueva-venta" data-id="${ANONIMO.id}">${ic('persona')} Venta sin nombre</button>
      </div>`;
    return;
  }

  const mes = hoy().slice(0, 7);
  let vendidoMes = 0, cobradoMes = 0, gananciaMes = 0;
  const porTipoMes = {};
  for (const m of db.movimientos) {
    if (!m.fecha.startsWith(mes)) continue;
    if (m.tipo === 'abono') { cobradoMes += m.total; continue; }
    vendidoMes += m.total;
    for (const it of m.items) {
      const sub = it.cant * it.precio;
      porTipoMes[it.tipo] = (porTipoMes[it.tipo] || 0) + sub;
      if (it.costo) gananciaMes += it.cant * (it.precio - it.costo);
    }
  }

  const gastadoMes = r2(db.compras.filter((c) => c.fecha.startsWith(mes)).reduce((s, c) => s + c.total, 0));
  const balanceMes = r2(cobradoMes - gastadoMes);

  const deudores = todosLosClientes()
    .map((c) => ({ c, saldo: saldoDe(c.id) }))
    .filter((d) => d.saldo > 0.009)
    .sort((a, b) => b.saldo - a.saldo);
  const porCobrar = deudores.reduce((s, d) => s + d.saldo, 0);

  const nombreMes = new Date().toLocaleDateString('es-MX', { month: 'long' });
  const diasSinRespaldo = db.ultimoRespaldo ? Math.floor((Date.now() - db.ultimoRespaldo) / 86400000) : null;
  const pideRespaldo = db.movimientos.length > 0 && (diasSinRespaldo === null || diasSinRespaldo >= 7);

  vista.innerHTML = `
    ${saludo()}
    ${pideRespaldo ? `<div class="alerta"><span>${ic('alerta')} ${diasSinRespaldo === null ? 'Aún no has hecho un respaldo.' : `Tu último respaldo fue hace ${diasSinRespaldo} días.`}</span><a class="btn sec chico" href="#/ajustes">Respaldar</a></div>` : ''}

    <div class="tarjeta destacado">
      <div class="etiqueta">Te deben en total</div>
      <div class="monto-grande">${dinero(porCobrar)}</div>
      <div class="etiqueta">${deudores.length} ${deudores.length === 1 ? 'cliente' : 'clientes'} con saldo pendiente</div>
    </div>

    <div class="acciones">
      <button class="btn" data-accion="nueva-venta">${ic('bolsa')} Venta</button>
      <button class="btn verde" data-accion="abono">${ic('billete')} Abono</button>
      <button class="btn sec" data-accion="nueva-compra" style="grid-column:1/-1">${ic('carrito')} Registrar una compra</button>
    </div>

    <h2>Este mes (${nombreMes})</h2>
    <div class="cuadros">
      ${stat('bolsa', 'Vendido', dinero(vendidoMes))}
      ${stat('billete', 'Cobrado', dinero(cobradoMes), 'pagado', true)}
      ${stat('carrito', 'Gastado en compras', dinero(gastadoMes), gastadoMes ? 'debe' : '', 'compra')}
      ${stat('ganancia', 'Te quedó', dinero(balanceMes), balanceMes < -0.009 ? 'debe' : 'pagado', true, 'Cobrado − gastado')}
    </div>
    ${tarjetaCategorias(porTipoMes)}
    <div class="tarjeta">
      <div class="stat-cabeza"><div class="stat-ico verde">${ic('ganancia')}</div><div class="etiqueta">Ganancia estimada del mes</div></div>
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
    }).join('')}</div>` : `<div class="tarjeta vacio chico"><div class="vacio-ico verde">${ic('listo')}</div>Nadie te debe nada.</div>`}
  `;
}

// Cuadro de estadística con ícono
const stat = (icono, etiqueta, valor, claseValor = '', color = false, nota = '') => `
  <div class="tarjeta">
    <div class="stat-cabeza"><div class="stat-ico ${color === true ? 'verde' : color || ''}">${ic(icono)}</div><div class="etiqueta">${etiqueta}</div></div>
    <div class="valor ${claseValor}">${valor}</div>
    ${nota ? `<div class="etiqueta" style="margin-top:2px">${nota}</div>` : ''}
  </div>`;

const vacioChico = (icono, texto) => `<div class="tarjeta vacio chico"><div class="vacio-ico">${ic(icono)}</div>${texto}</div>`;

/* =========================================================
   Vista: Clientes
   ========================================================= */
function vistaClientes() {
  titulo.textContent = 'Clientes';
  const f = filtros.clientes;
  vista.innerHTML = `
    ${buscador('Buscar cliente…', f.q)}
    <div class="filtros">
      <button class="filtro ${!f.soloDeben ? 'activo' : ''}" data-accion="filtro-clientes" data-valor="todos">${ic('clientes')} Todos</button>
      <button class="filtro ${f.soloDeben ? 'activo' : ''}" data-accion="filtro-clientes" data-valor="deben">${ic('alerta')} Me deben</button>
    </div>
    <div id="resultados"></div>
    <button class="fab" data-accion="nuevo-cliente" aria-label="Nuevo cliente">${ic('mas')}</button>
  `;
  const pintar = () => (document.getElementById('resultados').innerHTML = listaClientes());
  document.getElementById('buscar').addEventListener('input', (e) => { f.q = e.target.value; pintar(); });
  pintar();
}

const buscador = (placeholder, valor, extra = '') => `
  <div class="buscador"><div class="campo-busqueda">${ic('buscar')}<input id="buscar" type="search" placeholder="${placeholder}" value="${esc(valor)}" autocomplete="off"></div>${extra}</div>`;

function listaClientes() {
  const f = filtros.clientes;
  const q = f.q.trim().toLowerCase();
  const todos = todosLosClientes();
  const lista = todos
    .map((c) => ({ c, saldo: saldoDe(c.id) }))
    .filter(({ c, saldo }) => (!q || c.nombre.toLowerCase().includes(q) || (c.telefono || '').includes(q)) && (!f.soloDeben || saldo > 0.009))
    .sort((a, b) => b.saldo - a.saldo || a.c.nombre.localeCompare(b.c.nombre));

  if (!todos.length) return `<div class="vacio"><div class="vacio-ico">${ic('clientes')}</div><p>Todavía no tienes clientes.</p><button class="btn" data-accion="nuevo-cliente">${ic('mas')} Agregar cliente</button></div>`;
  if (!lista.length) return `<div class="vacio"><div class="vacio-ico">${ic('buscar')}</div><p>No hay resultados.</p></div>`;

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
  // replace: si se regresa a un cliente borrado, no se queda atrapado entre las dos pantallas
  if (!c) { location.replace('#/clientes'); return; }
  titulo.textContent = c.nombre;

  const saldo = saldoDe(id);
  const movs = ordenarMovs(movsDe(id));
  const saldos = saldosDespues(movs);
  const tel = (c.telefono || '').replace(/\D/g, '');

  vista.innerHTML = `
    <div class="tarjeta ${saldo > 0.009 ? 'destacado' : ''}">
      <div class="etiqueta">${saldo < -0.009 ? 'Saldo a su favor' : 'Te debe'}</div>
      <div class="monto-grande">${dinero(Math.abs(saldo))}</div>
      ${c.notas ? `<div class="etiqueta" style="margin-top:6px">${esc(c.notas)}</div>` : ''}
    </div>

    <div class="acciones">
      <button class="btn" data-accion="nueva-venta" data-id="${c.id}">${ic('bolsa')} Venta</button>
      <button class="btn verde" data-accion="abono" data-id="${c.id}">${ic('billete')} Abono</button>
    </div>
    <div class="acciones">
      ${tel ? `<a class="btn sec" href="${enlaceWhatsApp(c, saldo, movs)}" target="_blank" rel="noopener">${ic('mensaje')} WhatsApp</a>
               <a class="btn sec" href="tel:${tel}">${ic('telefono')} Llamar</a>` : ''}
      ${c.anonimo ? '' : `<button class="btn sec" data-accion="editar-cliente" data-id="${c.id}" style="grid-column:1/-1">${ic('lapiz')} Editar datos</button>`}
    </div>

    <h2>Historial</h2>
    ${movs.length ? `<div class="lista">${unirPagos(movs).map(({ m, pago }) => movItem(m, false, pago, saldos.get(pago ? pago.id : m.id))).join('')}</div>` : vacioChico('nota', 'Sin movimientos todavía.')}
  `;
}

/* ---------- Venta + pago en la misma transacción ----------
   Cuando al vender se paga algo, se guardan dos movimientos (la venta y el abono)
   para que las cuentas sigan claras, pero en las listas se muestran en un solo renglón. */
const NOTA_PAGO_AL_MOMENTO = 'Pago al momento de la compra';

// Devuelve una función venta -> su pago al momento (o null).
// Los pagos nuevos guardan ventaId; los anteriores se reconocen por su nota
// y porque se registraron 1 ms después de la venta.
function indicePagos() {
  const porVenta = new Map();
  for (const m of db.movimientos) {
    if (m.tipo !== 'abono') continue;
    if (m.ventaId) porVenta.set(m.ventaId, m);
    else if (m.nota === NOTA_PAGO_AL_MOMENTO) porVenta.set(`${m.clienteId}|${m.creado - 1}`, m);
  }
  return (v) => (v.tipo === 'venta' && (porVenta.get(v.id) || porVenta.get(`${v.clienteId}|${v.creado}`))) || null;
}

// Convierte una lista de movimientos en renglones: cada venta lleva su pago y ese pago no sale aparte
function unirPagos(movs) {
  const pagoDe = indicePagos();
  const filas = movs.map((m) => ({ m, pago: pagoDe(m) }));
  const unidos = new Set(filas.filter((f) => f.pago).map((f) => f.pago.id));
  return filas.filter((f) => !unidos.has(f.m.id));
}

// Saldo de la clienta justo después de cada movimiento, como en un estado de cuenta: id -> saldo
function saldosDespues(movs) {
  const orden = [...movs].sort((a, b) => a.fecha.localeCompare(b.fecha) || a.creado - b.creado);
  const saldos = new Map();
  let s = 0;
  for (const m of orden) {
    s = r2(s + (m.tipo === 'venta' ? m.total : -m.total));
    saldos.set(m.id, s);
  }
  return saldos;
}

const textoSaldo = (s) => `Saldo después: <b>${s > 0.009 ? dinero(s) : s < -0.009 ? `a su favor ${dinero(-s)}` : 'al corriente'}</b>`;

// Un renglón del historial que dice con palabras qué pasó.
// pago: el pago hecho en la misma transacción (si hubo). saldo: lo que debía después (solo en la ficha del cliente).
function movItem(m, conCliente = false, pago = null, saldo = null) {
  const esVenta = m.tipo === 'venta';
  const quien = conCliente ? esc((cliente(m.clienteId) || { nombre: 'Cliente borrado' }).nombre) + ' · ' : '';

  let que, detalle, cifra, estado, claseEstado;
  if (esVenta) {
    const piezas = m.items.reduce((s, it) => s + it.cant, 0);
    que = 'Compró ' + m.items.map((it) => (it.cant > 1 ? `${it.cant}× ` : '') + it.nombre).join(', ');
    const pagado = pago ? pago.total : 0;
    const debe = r2(m.total - pagado);
    if (debe <= 0.009) {
      detalle = 'Pagó todo al comprar';
      estado = `${ic('check')} Pagado`; claseEstado = 'pagado';
    } else if (pagado > 0) {
      detalle = `Pagó ${dinero(pagado)} al comprar, quedó a deber ${dinero(debe)}`;
      estado = `Debe ${dinero(debe)}`; claseEstado = 'debe';
    } else {
      detalle = 'Fiado: no pagó nada al comprar';
      estado = 'Fiado'; claseEstado = 'debe';
    }
    if (piezas > 1) detalle = `${piezas} piezas · ${detalle}`;
    cifra = dinero(m.total);
  } else {
    const alComprar = m.nota === NOTA_PAGO_AL_MOMENTO;
    que = alComprar ? 'Pagó al momento de comprar' : 'Abonó a su cuenta';
    detalle = alComprar ? 'Pago hecho junto con una compra' : (m.nota ? `Nota: ${m.nota}` : 'Pago de lo que debía');
    estado = 'Abono'; claseEstado = 'pagado';
    cifra = `<span class="pagado">−${dinero(m.total)}</span>`;
  }

  return `<button class="item mov" data-accion="ver-mov" data-id="${m.id}">
    <div class="avatar ${esVenta ? '' : 'verde'}">${ic(esVenta ? 'bolsa' : 'billete')}</div>
    <div class="principal">
      <div class="nombre">${esc(que)}</div>
      <div class="sub">${quien}${fechaHora(m)}</div>
      <div class="detalle-mov">${esc(detalle)}</div>
      ${saldo !== null ? `<div class="saldo-mov">${textoSaldo(saldo)}</div>` : ''}
    </div>
    <div class="cifra-doble">
      <div class="cifra">${cifra}</div>
      <div class="estado-pago ${claseEstado}">${estado}</div>
    </div>
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
  const cuantos = (t) => (t === 'todos' ? db.productos.length : db.productos.filter((p) => p.tipo === t).length);
  vista.innerHTML = `
    ${buscador('Buscar producto…', f.q, `
      <div class="alternar" role="group" aria-label="Forma de ver los productos">
        <button class="${f.vista === 'cuadricula' ? 'activo' : ''}" data-accion="vista-productos" data-valor="cuadricula" aria-label="Ver en cuadrícula">${ic('cuadricula')}</button>
        <button class="${f.vista === 'lista' ? 'activo' : ''}" data-accion="vista-productos" data-valor="lista" aria-label="Ver en lista">${ic('lista')}</button>
      </div>`)}
    <div class="filtros">
      ${['todos', ...Object.keys(TIPOS)].map((t) => `<button class="filtro ${f.tipo === t ? 'activo' : ''}" data-accion="filtro-productos" data-valor="${t}">${t === 'todos' ? 'Todos' : ic(ICONO_TIPO[t]) + ' ' + TIPOS[t]} <span class="cuenta">${cuantos(t)}</span></button>`).join('')}
    </div>
    <div id="resultados"></div>
    <button class="fab" data-accion="nuevo-producto" aria-label="Nuevo producto">${ic('mas')}</button>
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

  if (!db.productos.length) {
    return `<div class="vacio">
      <div class="vacio-ico">${ic('etiqueta')}</div>
      <p><b>Aún no tienes productos guardados.</b><br>Guarda aquí tus productos frecuentes para que al registrar una venta se llene el precio solo. No es obligatorio.</p>
      <button class="btn" data-accion="nuevo-producto">${ic('mas')} Agregar producto</button>
    </div>`;
  }
  if (!lista.length) return `<div class="vacio"><div class="vacio-ico">${ic('buscar')}</div><p>No hay resultados.</p></div>`;

  const detalle = (p) => esc([p.codigo && '#' + p.codigo, p.catalogo].filter(Boolean).join(' · '));
  const ganancia = (p) => (p.costo ? `<span class="ganancia">${ic('ganancia')}${dinero(p.precio - p.costo)}</span>` : '');

  if (f.vista === 'lista') {
    return `<div class="lista">${lista.map((p) => `
      <button class="item" data-accion="editar-producto" data-id="${p.id}">
        ${miniatura(p.id)}
        <div class="principal">
          <div class="nombre">${esc(p.nombre)}</div>
          <div class="sub">${chipTipo(p.tipo)} ${etiquetaExistencias(p)} ${detalle(p)}</div>
        </div>
        <div style="text-align:right"><div class="cifra">${dinero(p.precio)}</div>${ganancia(p)}</div>
      </button>`).join('')}</div>`;
  }

  return `<div class="rejilla">${lista.map((p) => `
    <button class="prod" data-accion="editar-producto" data-id="${p.id}">
      <div class="prod-foto">
        ${fotos[p.id] ? `<img src="${fotos[p.id]}" alt="" loading="lazy">` : `<div class="prod-sinfoto ${p.tipo}">${ic(ICONO_TIPO[p.tipo])}</div>`}
        ${chipTipo(p.tipo)}
      </div>
      <div class="prod-info">
        <div class="prod-nombre">${esc(p.nombre)}</div>
        <div class="prod-sub">${detalle(p) || '&nbsp;'}</div>
        ${etiquetaExistencias(p)}
        <div class="prod-pie"><span class="prod-precio">${dinero(p.precio)}</span>${ganancia(p)}</div>
      </div>
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
  const r = { vendido: 0, cobrado: 0, ganancia: 0, porTipo: {}, ventas: 0, productos: {}, clientes: {} };
  for (const m of movs) {
    if (m.tipo === 'abono') { r.cobrado += m.total; continue; }
    r.vendido += m.total;
    r.ventas++;
    r.clientes[m.clienteId] = (r.clientes[m.clienteId] || 0) + m.total;
    for (const it of m.items) {
      const sub = it.cant * it.precio;
      r.porTipo[it.tipo] = (r.porTipo[it.tipo] || 0) + sub;
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
  const compras = comprasEntre(desde, hasta);
  const gastado = r2(compras.reduce((s, c) => s + c.total, 0));
  const gastadoMaterial = r2(compras.reduce((s, c) => s + c.items.filter((it) => it.tipo === MATERIAL).reduce((t, it) => t + it.cant * it.costo, 0), 0));
  const balance = r2(r.cobrado - gastado);

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

  // En "Abonos" se ven todos los pagos por separado; en "Todos" y "Ventas" cada venta lleva su pago.
  // Las compras salen en "Todos" y en "Compras".
  let visibles = f.tipoMov === 'abono'
    ? movs.filter((m) => m.tipo === 'abono').map((m) => ({ m, pago: null }))
    : f.tipoMov === 'compra' ? [] : unirPagos(movs.filter((m) => f.tipoMov === 'todos' || m.tipo === 'venta'));
  if (f.tipoMov === 'todos' || f.tipoMov === 'compra') {
    visibles = visibles.concat(compras.map((c) => ({ m: c, compra: true })))
      .sort((a, b) => b.m.fecha.localeCompare(a.m.fecha) || b.m.creado - a.m.creado);
  }

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
      ${stat('billete', 'Cobrado', dinero(r.cobrado), 'pagado', true)}
      ${stat('carrito', 'Gastado en compras', dinero(gastado), gastado ? 'debe' : '', 'compra')}
      ${stat('ganancia', 'Te quedó', dinero(balance), balance < -0.009 ? 'debe' : 'pagado', true, 'Cobrado − gastado')}
      ${stat('etiqueta', 'Ganancia estimada', dinero(r.ganancia))}
    </div>
    ${gastado ? `<p class="etiqueta" style="margin:-4px 2px 12px">${compras.length} ${compras.length === 1 ? 'compra' : 'compras'}${gastadoMaterial ? ` · ${dinero(gastadoMaterial)} en materiales` : ''}. "Te quedó" es el dinero que entró menos el que salió; la ganancia estimada es lo que ganas por pieza vendida según su costo.</p>` : ''}
    ${tarjetaCategorias(r.porTipo)}

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
        <div class="principal"><div class="nombre">${esc(p.nombre)}</div><div class="sub">${chipTipo(p.tipo)} ${p.cant} ${p.cant === 1 ? 'pieza' : 'piezas'}</div></div>
        <div class="cifra">${dinero(p.importe)}</div>
      </div>`).join('')}</div>` : vacioChico('grafica', 'Sin ventas en este periodo.')}

    <h2>Clientes que más compraron</h2>
    ${topClientes.length ? `<div class="lista">${topClientes.map(([id, total]) => {
      const c = cliente(id) || { nombre: 'Cliente borrado' };
      return `<a class="item" ${cliente(id) ? `href="#/cliente/${id}"` : ''}>
        <div class="avatar">${cliente(id) ? avatar(c) : '?'}</div>
        <div class="principal"><div class="nombre">${esc(c.nombre)}</div></div>
        <div class="cifra">${dinero(total)}</div>
      </a>`;
    }).join('')}</div>` : vacioChico('grafica', 'Sin ventas en este periodo.')}

    <h2>Movimientos (${visibles.length})</h2>
    <div class="filtros">
      ${[['todos', 'Todos'], ['venta', 'Ventas'], ['abono', 'Abonos'], ['compra', 'Compras']].map(([k, t]) => `<button class="filtro ${f.tipoMov === k ? 'activo' : ''}" data-accion="tipo-mov" data-valor="${k}">${t}</button>`).join('')}
    </div>
    ${visibles.length ? `<div class="lista">${visibles.slice(0, f.limite).map(({ m, pago, compra }) => (compra ? compraItem(m) : movItem(m, true, pago))).join('')}</div>
      ${visibles.length > f.limite ? `<button class="btn sec ancho" style="margin-top:10px" data-accion="ver-mas-movs">Ver más (${visibles.length - f.limite} restantes)</button>` : ''}`
      : vacioChico('nota', 'No hay movimientos en este periodo.')}
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
  titulo.textContent = 'Ajustes';
  vista.innerHTML = `
    <div class="tarjeta">
      <div class="tarjeta-titulo">${ic('paleta')} Apariencia</div>
      <div class="segmentos" role="radiogroup" aria-label="Tema">
        ${Object.entries(TEMAS).map(([k, t]) => `<button class="${tema === k ? 'activo' : ''}" role="radio" aria-checked="${tema === k}" data-accion="tema" data-valor="${k}">${ic(ICONO_TEMA[k])}${t}</button>`).join('')}
      </div>
      <p class="texto-tenue" style="margin:10px 0 0">${tema === 'auto' ? 'Cambia sola entre claro y oscuro según la configuración del teléfono.' : `Siempre en tema ${TEMAS[tema].toLowerCase()}.`}</p>
    </div>

    <div class="tarjeta">
      <div class="tarjeta-titulo">${ic('escudo')} Respaldo de tus datos</div>
      <p class="texto-tenue">Toda la información vive solo en este teléfono. Haz un respaldo seguido y guárdalo en WhatsApp, Drive o tu correo. Si cambias de celular o se borra la app, podrás recuperar todo.</p>
      <p class="texto-tenue">Último respaldo: <b>${db.ultimoRespaldo ? new Date(db.ultimoRespaldo).toLocaleString('es-MX') : 'nunca'}</b></p>
      <button class="btn ancho" data-accion="exportar">${ic('descargar')} Hacer respaldo</button>
      <div style="height:10px"></div>
      <button class="btn sec ancho" data-accion="importar">${ic('subir')} Restaurar desde un respaldo</button>
    </div>

    ${eventoInstalar ? `<div class="tarjeta"><div class="tarjeta-titulo">${ic('celular')} Instalar en el teléfono</div><p class="texto-tenue">Agrega la app a tu pantalla de inicio para abrirla como cualquier otra app, aun sin internet.</p><button class="btn ancho" data-accion="instalar">Instalar app</button></div>` : ''}

    <div class="tarjeta">
      <div class="tarjeta-titulo">${ic('info')} Resumen</div>
      <p class="texto-tenue" style="margin-bottom:0">${db.clientes.length} clientes · ${db.productos.length} productos · ${db.movimientos.length} movimientos · ${db.compras.length} compras</p>
    </div>

    <div class="tarjeta">
      <div class="tarjeta-titulo peligro">${ic('alerta')} Zona de peligro</div>
      <p class="texto-tenue">Borra toda la información de este teléfono. No se puede deshacer.</p>
      <button class="btn peligro ancho" data-accion="borrar-todo">${ic('basura')} Borrar todo</button>
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

// opciones.alAtras: función que maneja el botón "atrás" del celular (devuelve true si lo usó)
// opciones.sinCerrarAfuera: no cerrar al tocar fuera (para no perder lo capturado en el asistente)
function abrirModal(html, alGuardar, opciones = {}) {
  modal.alAtras = opciones.alAtras || null;
  modal.sinCerrarAfuera = !!opciones.sinCerrarAfuera;
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

modal.addEventListener('click', (e) => { if (e.target === modal && !modal.sinCerrarAfuera) modal.close(); });

const botonesForm = (texto = 'Guardar') => `
  <div class="botones">
    <button type="button" class="btn sec" data-accion="cerrar">Cancelar</button>
    <button type="submit" class="btn">${texto}</button>
  </div>`;

/* ---------- Cliente ---------- */
function formCliente(id) {
  const c = id ? cliente(id) : { nombre: '', telefono: '', notas: '' };
  abrirModal(`
    <h3>${ic(id ? 'lapiz' : 'persona')} ${id ? 'Editar cliente' : 'Nuevo cliente'}</h3>
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

/* ---------- Animación al vender ----------
   Un círculo verde crece desde el centro hasta llenar la pantalla y muestra
   "¡Vendido!". Se quita sola a los 2.2 s o al tocarla. */
function celebrarVenta({ total, nombre, debe }) {
  const capa = document.createElement('div');
  capa.className = 'exito';
  capa.setAttribute('role', 'status');
  capa.innerHTML = `
    <div class="exito-circulo"></div>
    <div class="exito-contenido">
      <svg class="exito-check" viewBox="0 0 52 52" aria-hidden="true"><circle cx="26" cy="26" r="24"/><path d="M15 27l7 7 15-16"/></svg>
      <div class="exito-titulo">¡Vendido!</div>
      <div class="exito-monto">${dinero(total)}</div>
      <div class="exito-detalle">${esc(nombre)} · ${debe > 0.009 ? `queda debiendo ${dinero(debe)}` : 'pagado completo'}</div>
    </div>`;
  document.body.appendChild(capa);
  colorBarraEstado(colorTema('--relleno-verde'));
  // Dos cuadros de espera para que el navegador pinte el círculo en tamaño 0 antes de crecer
  requestAnimationFrame(() => requestAnimationFrame(() => capa.classList.add('activa')));

  let quitada = false;
  const quitar = () => {
    if (quitada) return;
    quitada = true;
    capa.classList.add('saliendo');
    colorBarraEstado(colorTema('--relleno'));
    setTimeout(() => capa.remove(), 350);
  };
  setTimeout(quitar, 2200);
  capa.addEventListener('click', quitar);
}

/* ---------- Venta ---------- */
function selectorCliente(idElegido) {
  const ordenados = [...db.clientes].sort((a, b) => a.nombre.localeCompare(b.nombre));
  return `<label class="campo">Cliente<select name="cliente" required>
    <option value="">— Elige —</option>
    <option value="${ANONIMO.id}" ${idElegido === ANONIMO.id ? 'selected' : ''}>Sin nombre</option>
    ${ordenados.map((c) => `<option value="${c.id}" ${c.id === idElegido ? 'selected' : ''}>${esc(c.nombre)}</option>`).join('')}
  </select></label>`;
}

function formVenta(clienteId) {
  const c = clienteId && cliente(clienteId);

  // Productos elegidos: { productoId, nombre, codigo, tipo, costo, precio, cant, guardarEnLista }
  const carrito = [];
  const busqueda = { q: '', tipo: 'todos' };

  const form = abrirModal(`
    <h3>${ic('bolsa')} Nueva venta${c ? ' · ' + esc(c.nombre) : ''}</h3>
    ${c ? '' : selectorCliente()}
    <label class="campo">Fecha<input name="fecha" type="date" required value="${hoy()}"></label>

    <div class="etiqueta" style="margin-bottom:6px">Elige los productos</div>
    <div class="campo-busqueda">${ic('buscar')}<input id="buscar-prod" type="search" placeholder="Buscar por nombre, código o revista…" autocomplete="off"></div>
    <div class="filtros" style="margin:8px 0">
      ${['todos', ...Object.keys(TIPOS)].map((t) => `<button type="button" class="filtro ${t === 'todos' ? 'activo' : ''}" data-filtro="${t}">${t === 'todos' ? 'Todos' : ic(ICONO_TIPO[t]) + ' ' + TIPOS[t]}</button>`).join('')}
    </div>
    <div id="catalogo" class="lista catalogo"></div>
    <button type="button" class="btn sec ancho" data-libre style="margin-top:8px">${ic('mas')} Producto que no está en la lista</button>

    <div id="carrito" style="margin-top:16px"></div>
    <div class="total-venta"><span>Total</span><span id="total">${dinero(0)}</span></div>
    <label class="casilla abono-casilla"><input type="checkbox" name="esAbono"> Es abono (no paga todo ahora)</label>
    <label class="campo" id="campo-abono" hidden>¿Cuánto pagó ahora?<input name="pago" type="number" inputmode="decimal" min="0" step="0.01" placeholder="$0.00"></label>
    <div class="etiqueta resumen-pago" id="resumen-pago"></div>
    <label class="campo">Nota<input name="nota" placeholder="Opcional (ej. campaña 15)"></label>
    ${botonesForm('Guardar venta')}
  `, (form) => {
    const cid = c ? c.id : form.cliente.value;
    const items = carrito
      .filter((it) => it.nombre.trim())
      .map((it) => ({ productoId: it.productoId || null, nombre: it.nombre.trim(), codigo: (it.codigo || '').trim(), cant: it.cant, precio: r2(it.precio), costo: r2(it.costo), tipo: it.tipo }));
    if (!items.length) { aviso('Elige al menos un producto'); return false; }

    // Se valida todo antes de tocar los datos
    const total = r2(items.reduce((s, it) => s + it.cant * it.precio, 0));
    // Sin la casilla de abono, la compra se paga completa
    const pago = form.esAbono.checked ? r2(num(form.pago.value)) : total;
    if (pago > total) { aviso('El abono no puede ser mayor que el total'); return false; }

    // Productos nuevos que se pidieron guardar en "Mis productos"
    for (const it of carrito) {
      if (it.productoId || !it.guardarEnLista || !it.nombre.trim()) continue;
      const nombre = it.nombre.trim();
      if (db.productos.some((p) => p.nombre.toLowerCase() === nombre.toLowerCase())) continue;
      db.productos.push({ id: uid(), nombre, codigo: (it.codigo || '').trim(), tipo: it.tipo, catalogo: '', precio: r2(it.precio), costo: r2(it.costo) });
    }

    const fecha = form.fecha.value || hoy();
    const ventaId = uid();
    db.movimientos.push({ id: ventaId, creado: Date.now(), clienteId: cid, tipo: 'venta', fecha, items, total, nota: form.nota.value.trim() });
    moverExistencias(items, -1);
    if (pago > 0) {
      db.movimientos.push({ id: uid(), creado: Date.now() + 1, clienteId: cid, tipo: 'abono', fecha, total: pago, nota: NOTA_PAGO_AL_MOMENTO, ventaId });
    }
    guardar();
    celebrarVenta({ total, nombre: (cliente(cid) || ANONIMO).nombre, debe: r2(total - pago) });
    if (!c) { modal.close(); location.hash = `#/cliente/${cid}`; return false; }
  });

  const catalogo = form.querySelector('#catalogo');
  const zonaCarrito = form.querySelector('#carrito');

  const pintarCatalogo = () => {
    const q = busqueda.q.trim().toLowerCase();
    // La lista solo aparece cuando se busca algo o se elige una categoría
    if (!q && busqueda.tipo === 'todos') { catalogo.hidden = true; return; }
    catalogo.hidden = false;
    const lista = db.productos
      .filter((p) => (busqueda.tipo === 'todos' || p.tipo === busqueda.tipo) && (!q || coincideProducto(p, q)))
      .sort((a, b) => a.nombre.localeCompare(b.nombre));
    catalogo.innerHTML = lista.length
      ? lista.map((p) => {
          const enCarrito = carrito.find((it) => it.productoId === p.id);
          return `<button type="button" class="item ${enCarrito ? 'seleccionado' : ''}" data-elegir="${p.id}" aria-pressed="${!!enCarrito}">
            ${miniatura(p.id)}
            <div class="principal"><div class="nombre">${esc(p.nombre)}</div><div class="sub">${chipTipo(p.tipo)} ${etiquetaExistencias(p)} ${esc([p.codigo && '#' + p.codigo, p.catalogo].filter(Boolean).join(' · '))}</div></div>
            <div class="cifra">${dinero(p.precio)}</div>
            <span class="agregar ${enCarrito ? 'elegido' : ''}">${ic(enCarrito ? 'check' : 'mas')}</span>
          </button>`;
        }).join('')
      : `<div class="vacio" style="padding:16px">${db.productos.length ? 'No se encontró. Usa el botón de abajo para agregarlo.' : 'Aún no tienes productos guardados.'}</div>`;
  };

  const campoAbono = form.querySelector('#campo-abono');
  const resumenPago = form.querySelector('#resumen-pago');

  const recalcular = () => {
    const total = r2(carrito.reduce((s, it) => s + it.cant * it.precio, 0));
    form.querySelector('#total').textContent = dinero(total);
    if (!form.esAbono.checked) {
      resumenPago.innerHTML = total ? `${ic('check')} Paga completo: <b>${dinero(total)}</b>` : '';
    } else {
      const debe = Math.max(0, total - num(form.pago.value));
      resumenPago.innerHTML = `Queda debiendo: <b class="debe">${dinero(debe)}</b>`;
    }
  };

  const controlCantidad = (it, i) => `
    <div class="cantidad">
      <button type="button" data-menos="${i}" aria-label="Menos">${ic(it.cant > 1 ? 'menos' : 'basura')}</button>
      <span>${it.cant}</span>
      <button type="button" data-mas="${i}" aria-label="Más">${ic('mas')}</button>
    </div>`;

  // Aviso si se venden más piezas de las que hay (se permite, por si no se anotaron todas)
  const avisoExistencias = (it) => {
    const p = producto(it.productoId);
    if (!tieneExistencias(p) || it.cant <= p.existencias) return '';
    return `<div class="falta">${ic('alerta')} ${p.existencias ? `Solo tienes ${p.existencias}` : 'No te quedan piezas'}</div>`;
  };

  const renglonGuardado = (it, i) => `
    <div class="linea renglon">
      <div class="principal">
        <div class="nombre">${esc(it.nombre)}</div>
        ${controlCantidad(it, i)}
        ${avisoExistencias(it)}
      </div>
      <label class="precio">Precio c/u<input data-precio="${i}" type="number" inputmode="decimal" min="0" step="0.01" value="${it.precio || ''}"></label>
    </div>`;

  const renglonNuevo = (it, i) => `
    <div class="linea">
      <div class="etiqueta" style="margin-bottom:6px">Producto nuevo</div>
      <input data-nombre="${i}" value="${esc(it.nombre)}" placeholder="Nombre del producto" autocomplete="off">
      <div class="dos">
        <label>Código / ID<input data-codigo="${i}" value="${esc(it.codigo)}" placeholder="opcional" autocomplete="off"></label>
        <label>Categoría<select data-tipo="${i}">${opcionesTipo(it.tipo)}</select></label>
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

  const alCambiar = (e) => {
    if (e.target.name === 'esAbono') {
      campoAbono.hidden = !e.target.checked;
      if (e.target.checked) { form.pago.value = ''; form.pago.focus(); }
    }
    if (e.target.name === 'pago' || e.target.name === 'esAbono') recalcular();
    const d = e.target.dataset;
    if (d.precio !== undefined) { carrito[d.precio].precio = num(e.target.value); recalcular(); }
    if (d.nombre !== undefined) carrito[d.nombre].nombre = e.target.value;
    if (d.codigo !== undefined) carrito[d.codigo].codigo = e.target.value;
    if (d.costo !== undefined) carrito[d.costo].costo = num(e.target.value);
    if (d.tipo !== undefined) carrito[d.tipo].tipo = e.target.value; // las listas también avisan con "change"
    if (d.guardar !== undefined) carrito[d.guardar].guardarEnLista = e.target.checked;
  };
  form.addEventListener('input', alCambiar);
  form.addEventListener('change', alCambiar);

  form.addEventListener('click', (e) => {
    const el = e.target.closest('[data-filtro], [data-elegir], [data-libre], [data-mas], [data-menos]');
    if (!el) return;
    const d = el.dataset;

    if (d.filtro) {
      busqueda.tipo = d.filtro;
      form.querySelectorAll('[data-filtro]').forEach((b) => b.classList.toggle('activo', b === el));
      pintarCatalogo();
    } else if (d.elegir) {
      // Tocar selecciona o quita el producto; la cantidad se cambia con − y +
      const ya = carrito.findIndex((it) => it.productoId === d.elegir);
      if (ya >= 0) carrito.splice(ya, 1);
      else {
        const p = producto(d.elegir);
        carrito.push({ productoId: p.id, nombre: p.nombre, codigo: p.codigo || '', tipo: p.tipo, costo: p.costo || 0, precio: p.precio, cant: 1 });
      }
      pintarCatalogo(); pintarCarrito();
    } else if (d.libre !== undefined) {
      // Si ya escribió algo en el buscador, se usa como nombre del producto nuevo
      carrito.push({ productoId: null, nombre: busqueda.q.trim(), codigo: '', tipo: tipoInicial(busqueda.tipo), costo: 0, precio: 0, cant: 1, guardarEnLista: false });
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

/* =========================================================
   Compras (egresos): mercancía para vender y materiales
   =========================================================
   Siempre se pagan al momento. Los productos de la lista suben su inventario
   y quedan con el costo de esta compra; los materiales (esencias, frascos…)
   solo cuentan como gasto. Anotar los pedidos de revista es opcional. */
const MATERIAL = 'material';

const chipItem = (tipo) => (tipo === MATERIAL
  ? `<span class="chip material">${ic('gota')}Material</span>`
  : chipTipo(tipo));

const textoArticulos = (items) => items.map((it) => (it.cant > 1 ? `${it.cant}× ` : '') + it.nombre).join(', ');

function comprasEntre(desde, hasta) {
  return db.compras.filter((c) => c.fecha >= desde && c.fecha <= hasta);
}

// Renglón de una compra en Informes
function compraItem(c) {
  const piezas = c.items.filter((it) => it.tipo !== MATERIAL).reduce((s, it) => s + it.cant, 0);
  const materiales = c.items.filter((it) => it.tipo === MATERIAL).length;
  const partes = [];
  if (piezas) partes.push(`${piezas} ${piezas === 1 ? 'pieza para vender' : 'piezas para vender'}`);
  if (materiales) partes.push(`${materiales} ${materiales === 1 ? 'material' : 'materiales'}`);
  return `<button class="item mov" data-accion="ver-compra" data-id="${c.id}">
    <div class="avatar compra">${ic('carrito')}</div>
    <div class="principal">
      <div class="nombre">Compraste ${esc(textoArticulos(c.items))}</div>
      <div class="sub">${c.proveedor ? esc(c.proveedor) + ' · ' : ''}${fechaHora(c)}</div>
      <div class="detalle-mov">${partes.join(' y ')}${c.nota ? ` · Nota: ${esc(c.nota)}` : ''}</div>
    </div>
    <div class="cifra-doble">
      <div class="cifra debe">−${dinero(c.total)}</div>
      <div class="estado-pago compra">Compra</div>
    </div>
  </button>`;
}

// Registrar una compra paso a paso: una sola pregunta por pantalla para no abrumar.
//   1) ¿Qué compraste?   2) ¿Cuántas y a cuánto?   3) ¿Dónde y cuándo?   4) Revisa y guarda
function formCompra() {
  // Renglones: { productoId|null, nombre, tipo, cant, costo, precio, guardarEnLista }
  // tipo MATERIAL = insumo que no se revende (esencias, alcohol, frascos…)
  const carrito = [];
  const busqueda = { q: '', tipo: 'todos' };
  const datos = { fecha: hoy(), proveedor: '', nota: '' };
  const proveedores = [...new Set(db.compras.slice().reverse().map((c) => c.proveedor).filter(Boolean))].slice(0, 6);
  let paso = 1;

  const PASOS = [
    { titulo: '¿Qué compraste?', ayuda: 'Busca en tus productos o agrega algo nuevo. Puedes elegir varias cosas.' },
    { titulo: '¿Cuántas y a cuánto?', ayuda: 'Anota cuántas piezas compraste y lo que te costó cada una.' },
    { titulo: '¿Dónde y cuándo?', ayuda: 'Esto es opcional, te ayuda a recordar.' },
    { titulo: 'Revisa y guarda', ayuda: 'Si algo está mal, regresa con "Atrás".' },
  ];

  const form = abrirModal(`
    <h3>${ic('carrito')} Nueva compra</h3>
    <div class="wizard-progreso" aria-hidden="true">${PASOS.map(() => '<span></span>').join('')}</div>
    <div class="wizard-cabeza">
      <div class="etiqueta" id="paso-numero"></div>
      <div class="paso-titulo" id="paso-titulo"></div>
      <div class="texto-tenue" id="paso-ayuda"></div>
    </div>
    <div id="paso"></div>
    <div class="pie-wizard">
      <button type="button" class="btn sec" data-atras></button>
      <button type="submit" class="btn" id="siguiente"></button>
    </div>
  `, () => {
    // "Siguiente" es el botón de enviar: solo guarda en el último paso
    if (paso < PASOS.length) { if (validar()) irA(paso + 1); return false; }
    guardarCompra();
  }, { sinCerrarAfuera: true, alAtras: () => { if (paso === 1) return false; irA(paso - 1); return true; } });

  form.classList.add('wizard'); // alto fijo: los botones no cambian de lugar entre pasos
  const zona = form.querySelector('#paso');
  const total = () => r2(carrito.reduce((s, it) => s + it.cant * it.costo, 0));

  /* ---------- Paso 1: elegir ---------- */
  const listaCatalogo = () => {
    const q = busqueda.q.trim().toLowerCase();
    if (!q && busqueda.tipo === 'todos') return '';
    const lista = db.productos
      .filter((p) => (busqueda.tipo === 'todos' || p.tipo === busqueda.tipo) && (!q || coincideProducto(p, q)))
      .sort((a, b) => a.nombre.localeCompare(b.nombre));
    if (!lista.length) return `<div class="vacio" style="padding:16px">No está en tu lista. Usa el botón de abajo.</div>`;
    return lista.map((p) => {
      const elegido = carrito.some((it) => it.productoId === p.id);
      return `<button type="button" class="item ${elegido ? 'seleccionado' : ''}" data-elegir="${p.id}" aria-pressed="${elegido}">
        ${miniatura(p.id)}
        <div class="principal"><div class="nombre">${esc(p.nombre)}</div><div class="sub">${chipTipo(p.tipo)} ${etiquetaExistencias(p)}</div></div>
        <span class="agregar ${elegido ? 'elegido' : ''}">${ic(elegido ? 'check' : 'mas')}</span>
      </button>`;
    }).join('');
  };

  const resumenElegidos = () => (carrito.length
    ? `<div class="elegidos">${ic('check')} <span>Elegiste <b>${carrito.length}</b>: ${esc(carrito.map((it) => it.nombre || (it.tipo === MATERIAL ? 'material' : 'producto nuevo')).join(', '))}</span></div>`
    : '');

  const paso1 = () => `
    <div class="campo-busqueda">${ic('buscar')}<input id="buscar-prod" type="search" placeholder="Buscar en mis productos…" autocomplete="off" value="${esc(busqueda.q)}"></div>
    <div class="filtros" style="margin:8px 0">
      ${['todos', ...Object.keys(TIPOS)].map((t) => `<button type="button" class="filtro ${busqueda.tipo === t ? 'activo' : ''}" data-filtro="${t}">${t === 'todos' ? 'Todos' : ic(ICONO_TIPO[t]) + ' ' + TIPOS[t]}</button>`).join('')}
    </div>
    <div id="catalogo" class="lista catalogo" ${listaCatalogo() ? '' : 'hidden'}>${listaCatalogo()}</div>
    <div class="opciones-grandes">
      <button type="button" class="opcion-grande" data-nuevo>
        <span class="opcion-ico">${ic('etiqueta')}</span>
        <span><b>Algo que no está en mi lista</b><br><span class="texto-tenue">Mercancía nueva para vender</span></span>
      </button>
      <button type="button" class="opcion-grande" data-material>
        <span class="opcion-ico material">${ic('gota')}</span>
        <span><b>Material para lociones</b><br><span class="texto-tenue">Esencias, alcohol, frascos… (no se vende)</span></span>
      </button>
    </div>
    <div id="elegidos">${resumenElegidos()}</div>`;

  /* ---------- Paso 2: cantidades y costos ---------- */
  const tarjetaRenglon = (it, i) => {
    const esNuevo = !it.productoId && it.tipo !== MATERIAL;
    return `<div class="linea tarjeta-paso">
      <div class="tarjeta-paso-cabeza">
        ${it.productoId ? `<b>${esc(it.nombre)}</b> ${chipItem(it.tipo)}` : `<span>${chipItem(esNuevo ? it.tipo : MATERIAL)} ${esNuevo ? 'Producto nuevo' : 'Material'}</span>`}
        <button type="button" class="quitar" data-quitar="${i}" aria-label="Quitar">${ic('basura')}</button>
      </div>
      ${it.productoId ? '' : `<label class="campo">${esNuevo ? '¿Cómo se llama?' : '¿Qué material?'}<input data-nombre="${i}" value="${esc(it.nombre)}" placeholder="${esNuevo ? 'Ej. Bolsa de mano' : 'Ej. Esencia de lavanda 100 ml'}" autocomplete="off"></label>`}
      ${esNuevo ? `<label class="campo">Categoría<select data-tipo="${i}">${opcionesTipo(it.tipo)}</select></label>` : ''}
      <div class="campo">¿Cuántas compraste?
        <div class="stepper">
          <button type="button" data-menos="${i}" aria-label="Una menos">${ic('menos')}</button>
          <input data-cant="${i}" type="number" inputmode="numeric" min="1" step="1" value="${it.cant}" aria-label="Cantidad">
          <button type="button" data-mas="${i}" aria-label="Una más">${ic('mas')}</button>
        </div>
      </div>
      <label class="campo">¿Cuánto te costó cada una?<input data-costo="${i}" type="number" inputmode="decimal" min="0" step="0.01" value="${it.costo || ''}" placeholder="$0.00"></label>
      ${esNuevo ? `<label class="campo">¿A cuánto la vas a vender? <span class="texto-tenue">(opcional)</span><input data-precio="${i}" type="number" inputmode="decimal" min="0" step="0.01" value="${it.precio || ''}" placeholder="$0.00"></label>
        <label class="casilla"><input type="checkbox" data-guardar="${i}" ${it.guardarEnLista ? 'checked' : ''}> Guardar en mis productos</label>` : ''}
      <div class="subtotal">Subtotal: <b data-subtotal="${i}">${dinero(it.cant * it.costo)}</b></div>
    </div>`;
  };

  const paso2 = () => carrito.map(tarjetaRenglon).join('') +
    `<div class="total-venta"><span>Total</span><span id="total">${dinero(total())}</span></div>`;

  /* ---------- Paso 3: dónde y cuándo ---------- */
  const paso3 = () => `
    <label class="campo">¿Dónde compraste?<input name="proveedor" value="${esc(datos.proveedor)}" placeholder="Ej. Price Shoes, tienda de esencias" autocomplete="off"></label>
    ${proveedores.length ? `<div class="filtros" style="margin:-4px 0 14px">${proveedores.map((x) => `<button type="button" class="filtro ${datos.proveedor === x ? 'activo' : ''}" data-proveedor="${esc(x)}">${esc(x)}</button>`).join('')}</div>` : ''}
    <label class="campo">¿Qué día?<input name="fecha" type="date" required value="${datos.fecha}"></label>
    <label class="campo">Nota<input name="nota" value="${esc(datos.nota)}" placeholder="Opcional"></label>`;

  /* ---------- Paso 4: resumen ---------- */
  const paso4 = () => `
    <div class="tarjeta resumen-compra">
      ${carrito.map((it) => `
        <div class="resumen-fila">
          <span>${it.cant}× ${esc(it.nombre)} ${chipItem(it.tipo)}<br><span class="texto-tenue">${dinero(it.costo)} c/u</span></span>
          <b>${dinero(it.cant * it.costo)}</b>
        </div>`).join('')}
      <div class="resumen-total"><span>Total pagado</span><span>${dinero(total())}</span></div>
    </div>
    <div class="resumen-datos">
      <div>${ic('etiqueta')} ${datos.proveedor ? esc(datos.proveedor) : '<span class="texto-tenue">Sin lugar</span>'}</div>
      <div>${ic('nota')} ${fechaBonita(datos.fecha)}${datos.nota ? ` · ${esc(datos.nota)}` : ''}</div>
    </div>
    ${carrito.some((it) => it.productoId || it.guardarEnLista) && carrito.some((it) => it.tipo !== MATERIAL)
      ? `<p class="texto-tenue" style="margin-top:12px">${ic('info')} Las piezas se suman a tu inventario.</p>` : ''}`;

  /* ---------- Navegación entre pasos ---------- */
  function validar() {
    if (paso === 1 && !carrito.length) { aviso('Elige al menos una cosa'); return false; }
    if (paso === 2) {
      const i = carrito.findIndex((it) => !it.nombre.trim());
      if (i >= 0) { aviso('Escribe el nombre'); zona.querySelector(`[data-nombre="${i}"]`)?.focus(); return false; }
      const j = carrito.findIndex((it) => !(it.cant > 0));
      if (j >= 0) { aviso('La cantidad debe ser al menos 1'); zona.querySelector(`[data-cant="${j}"]`)?.focus(); return false; }
      const k = carrito.findIndex((it) => !(it.costo > 0));
      if (k >= 0) { aviso('Anota cuánto te costó'); zona.querySelector(`[data-costo="${k}"]`)?.focus(); return false; }
    }
    return true;
  }

  function irA(n) {
    paso = n;
    const p = PASOS[paso - 1];
    form.querySelector('#paso-numero').textContent = `Paso ${paso} de ${PASOS.length}`;
    form.querySelector('#paso-titulo').textContent = p.titulo;
    form.querySelector('#paso-ayuda').textContent = p.ayuda;
    form.querySelectorAll('.wizard-progreso span').forEach((s, i) => s.classList.toggle('hecho', i < paso));
    form.querySelector('[data-atras]').innerHTML = paso === 1 ? 'Cancelar' : `${ic('atras')} Atrás`;
    form.querySelector('#siguiente').innerHTML = paso === PASOS.length ? `${ic('check')} Guardar compra` : `Siguiente ${ic('adelante')}`;
    form.querySelector('#siguiente').classList.toggle('verde', paso === PASOS.length);
    zona.innerHTML = [paso1, paso2, paso3, paso4][paso - 1]();
    modal.scrollTop = 0;
  }

  const repintarCatalogo = () => {
    const html = listaCatalogo();
    const cat = zona.querySelector('#catalogo');
    cat.innerHTML = html;
    cat.hidden = !html;
    zona.querySelector('#elegidos').innerHTML = resumenElegidos();
  };

  const agregarLibre = (tipo) => {
    carrito.push({ productoId: null, nombre: busqueda.q.trim(), tipo, cant: 1, costo: 0, precio: 0, guardarEnLista: true });
    busqueda.q = '';
    zona.querySelector('#buscar-prod').value = '';
    repintarCatalogo();
    aviso(tipo === MATERIAL ? 'Material agregado. Lo describes en el siguiente paso.' : 'Agregado. Le pones nombre y precio en el siguiente paso.');
  };

  const recalcular = () => {
    carrito.forEach((it, i) => {
      const sub = zona.querySelector(`[data-subtotal="${i}"]`);
      if (sub) sub.textContent = dinero(it.cant * it.costo);
    });
    const t = zona.querySelector('#total');
    if (t) t.textContent = dinero(total());
  };

  const alCambiar = (e) => {
    const d = e.target.dataset;
    // El buscador solo reacciona al escribir: su "change" llega al tocar un producto
    // (pierde el foco) y repintar la lista en ese momento haría que el toque se pierda
    if (e.target.id === 'buscar-prod') { if (e.type === 'input') { busqueda.q = e.target.value; repintarCatalogo(); } return; }
    if (d.cant !== undefined) { carrito[d.cant].cant = Math.max(0, Math.round(num(e.target.value))); recalcular(); }
    if (d.costo !== undefined) { carrito[d.costo].costo = num(e.target.value); recalcular(); }
    if (d.precio !== undefined) carrito[d.precio].precio = num(e.target.value);
    if (d.nombre !== undefined) carrito[d.nombre].nombre = e.target.value;
    if (d.tipo !== undefined) carrito[d.tipo].tipo = e.target.value;
    if (d.guardar !== undefined) carrito[d.guardar].guardarEnLista = e.target.checked;
    if (['proveedor', 'fecha', 'nota'].includes(e.target.name)) {
      datos[e.target.name] = e.target.value;
      if (e.target.name === 'proveedor') zona.querySelectorAll('[data-proveedor]').forEach((b) => b.classList.toggle('activo', b.dataset.proveedor === e.target.value));
    }
  };
  form.addEventListener('input', alCambiar);
  form.addEventListener('change', alCambiar);

  form.addEventListener('click', (e) => {
    const el = e.target.closest('[data-atras], [data-filtro], [data-elegir], [data-nuevo], [data-material], [data-quitar], [data-mas], [data-menos], [data-proveedor]');
    if (!el) return;
    const d = el.dataset;
    if (d.atras !== undefined) {
      if (paso === 1) modal.close(); else irA(paso - 1);
    } else if (d.filtro) {
      busqueda.tipo = d.filtro;
      zona.querySelectorAll('[data-filtro]').forEach((b) => b.classList.toggle('activo', b === el));
      repintarCatalogo();
    } else if (d.elegir) {
      const ya = carrito.findIndex((it) => it.productoId === d.elegir);
      if (ya >= 0) carrito.splice(ya, 1);
      else {
        const p = producto(d.elegir);
        carrito.push({ productoId: p.id, nombre: p.nombre, tipo: p.tipo, cant: 1, costo: p.costo || 0, precio: p.precio });
      }
      repintarCatalogo();
    } else if (d.nuevo !== undefined) {
      agregarLibre(tipoInicial(busqueda.tipo));
    } else if (d.material !== undefined) {
      agregarLibre(MATERIAL);
    } else if (d.quitar !== undefined) {
      carrito.splice(d.quitar, 1);
      irA(carrito.length ? 2 : 1);
    } else if (d.mas !== undefined || d.menos !== undefined) {
      const i = d.mas !== undefined ? d.mas : d.menos;
      carrito[i].cant = Math.max(1, carrito[i].cant + (d.mas !== undefined ? 1 : -1));
      zona.querySelector(`[data-cant="${i}"]`).value = carrito[i].cant;
      recalcular();
    } else if (d.proveedor !== undefined) {
      datos.proveedor = d.proveedor;
      form.proveedor.value = d.proveedor;
      zona.querySelectorAll('[data-proveedor]').forEach((b) => b.classList.toggle('activo', b === el));
    }
  });

  function guardarCompra() {
    const items = carrito.map((it) => {
      let productoId = it.productoId;
      // Producto nuevo que se pidió guardar: nace con las piezas que se compraron
      if (!productoId && it.tipo !== MATERIAL && it.guardarEnLista) {
        const nombre = it.nombre.trim();
        const existente = db.productos.find((p) => p.nombre.toLowerCase() === nombre.toLowerCase());
        if (existente) productoId = existente.id;
        else {
          productoId = uid();
          db.productos.push({ id: productoId, nombre, codigo: '', tipo: it.tipo, catalogo: datos.proveedor.trim(), precio: r2(it.precio), costo: r2(it.costo), existencias: 0 });
        }
      }
      return { productoId: productoId || null, nombre: it.nombre.trim(), tipo: it.tipo, cant: it.cant, costo: r2(it.costo) };
    });

    // Inventario y costo: el producto queda con lo que costó en esta compra
    for (const it of items) {
      const p = it.productoId && producto(it.productoId);
      if (!p) continue;
      if (it.costo > 0) p.costo = it.costo;
      p.existencias = (tieneExistencias(p) ? p.existencias : 0) + it.cant; // si no se contaban piezas, empieza a contarlas
    }

    db.compras.push({ id: uid(), creado: Date.now(), fecha: datos.fecha || hoy(), proveedor: datos.proveedor.trim(), items, total: total(), nota: datos.nota.trim() });
    guardar();
    aviso(`Compra guardada: ${dinero(total())}`);
  }

  irA(1);
}

function verCompra(id) {
  const c = db.compras.find((x) => x.id === id);
  if (!c) return;
  abrirModal(`
    <h3>${ic('carrito')} Compra</h3>
    <p class="texto-tenue" style="margin:-8px 0 12px">${c.proveedor ? esc(c.proveedor) + ' · ' : ''}${fechaBonita(c.fecha)}${horaDe(c) ? ` · registrada a las ${horaDe(c)}` : ''}</p>
    <table class="detalle-items">${c.items.map((it) => `
      <tr><td>${it.cant}× ${esc(it.nombre)} ${chipItem(it.tipo)}<br><span class="texto-tenue">${dinero(it.costo)} c/u</span></td><td>${dinero(it.cant * it.costo)}</td></tr>`).join('')}
    </table>
    <div class="total-venta"><span>Total pagado</span><span>${dinero(c.total)}</span></div>
    ${c.nota ? `<p class="texto-tenue nota">${ic('nota')} ${esc(c.nota)}</p>` : ''}
    <div class="botones">
      <button type="button" class="btn peligro" data-accion="borrar-compra" data-id="${c.id}">Eliminar</button>
      <button type="button" class="btn sec" data-accion="cerrar">Cerrar</button>
    </div>
  `, () => {});
}

/* ---------- Abono ---------- */
function formAbono(clienteId) {
  const c = clienteId && cliente(clienteId);
  const saldo = c ? saldoDe(c.id) : 0;

  const form = abrirModal(`
    <h3>${ic('billete')} Registrar abono${c ? ' · ' + esc(c.nombre) : ''}</h3>
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
  const pago = indicePagos()(m);
  abrirModal(`
    <h3>${ic(esVenta ? 'bolsa' : 'billete')} ${esVenta ? 'Venta' : 'Abono'}</h3>
    <p class="texto-tenue" style="margin:-8px 0 12px">${fechaBonita(m.fecha)}${horaDe(m) ? ` · registrado a las ${horaDe(m)}` : ''}</p>
    ${esVenta ? `<table class="detalle-items">${m.items.map((it) => `
      <tr><td>${it.cant}× ${esc(it.nombre)}${it.codigo ? ` <span class="texto-tenue">#${esc(it.codigo)}</span>` : ''} ${chipTipo(it.tipo)}<br><span class="texto-tenue">${dinero(it.precio)} c/u${it.costo ? ` · costo ${dinero(it.costo)}` : ''}</span></td><td>${dinero(it.cant * it.precio)}</td></tr>`).join('')}
    </table>` : ''}
    <div class="total-venta"><span>Total</span><span>${dinero(m.total)}</span></div>
    ${pago ? `
      <div class="fila-pago"><span>Pagó al momento</span><span class="pagado">${dinero(pago.total)}</span></div>
      <div class="fila-pago"><span>Quedó debiendo</span><span class="${m.total - pago.total > 0.009 ? 'debe' : ''}">${dinero(Math.max(0, m.total - pago.total))}</span></div>` : ''}
    ${m.nota ? `<p class="texto-tenue nota">${ic('nota')} ${esc(m.nota)}</p>` : ''}
    <div class="botones">
      <button type="button" class="btn peligro" data-accion="borrar-mov" data-id="${m.id}">Eliminar</button>
      <button type="button" class="btn sec" data-accion="cerrar">Cerrar</button>
    </div>
  `, () => {});
}

/* ---------- Producto ---------- */
function formProducto(id) {
  const p = id ? producto(id) : { nombre: '', tipo: tipoInicial(filtros.productos.tipo), catalogo: '', precio: '', costo: '' };
  const catalogos = [...new Set(db.productos.map((x) => x.catalogo).filter(Boolean))];
  // undefined = sin cambios, null = quitar la foto, texto = foto nueva
  let fotoNueva;

  const sinFoto = `<span>${ic('camara')}Sin foto</span>`;
  const form = abrirModal(`
    <h3>${ic(id ? 'lapiz' : 'etiqueta')} ${id ? 'Editar producto' : 'Nuevo producto'}</h3>
    <div class="foto-producto" id="vista-foto">${id && fotos[id] ? `<img src="${fotos[id]}" alt="">` : sinFoto}</div>
    <div class="acciones">
      <label class="btn sec">${ic('camara')} Tomar foto<input type="file" accept="image/*" capture="environment" data-foto hidden></label>
      <label class="btn sec">${ic('imagen')} Galería<input type="file" accept="image/*" data-foto hidden></label>
    </div>
    <button type="button" class="quitar" data-quitar-foto ${id && fotos[id] ? '' : 'hidden'} style="margin:-4px 0 8px">${ic('basura')} Quitar foto</button>
    <label class="campo">Nombre<input name="nombre" required value="${esc(p.nombre)}" autocomplete="off"></label>
    <label class="campo">Categoría<select name="tipo">${opcionesTipo(p.tipo)}</select></label>
    <label class="campo">Código / ID<input name="codigo" value="${esc(p.codigo || '')}" placeholder="Opcional (el de la revista o etiqueta)" autocomplete="off"></label>
    <label class="campo">Revista o proveedor<input name="catalogo" list="dl-catalogos" value="${esc(p.catalogo)}" placeholder="Ej. Avon, Jafra, Price Shoes…"></label>
    <datalist id="dl-catalogos">${catalogos.map((x) => `<option value="${esc(x)}">`).join('')}</datalist>
    <div class="cuadros" style="margin:0">
      <label class="campo">Precio de venta<input name="precio" type="number" inputmode="decimal" min="0" step="0.01" required value="${p.precio}"></label>
      <label class="campo">Lo que te cuesta<input name="costo" type="number" inputmode="decimal" min="0" step="0.01" value="${p.costo || ''}" placeholder="opcional"></label>
    </div>
    <label class="campo">Cantidad que tienes<input name="existencias" type="number" inputmode="numeric" min="0" step="1" value="${tieneExistencias(p) ? p.existencias : ''}" placeholder="Opcional: déjalo vacío si no quieres llevar la cuenta"></label>
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
      // Vacío = no se lleva la cuenta de cuántas piezas hay
      existencias: form.existencias.value.trim() === '' ? null : Math.max(0, Math.round(num(form.existencias.value))),
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
    vistaFoto.innerHTML = sinFoto;
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
    case 'nueva-compra': formCompra(); break;
    case 'ver-compra': verCompra(id); break;
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
    case 'vista-productos':
      filtros.productos.vista = valor;
      escribirPreferencia('vendedora-vista-productos', valor);
      render();
      break;
    case 'tema':
      elegirTema(valor);
      render();
      break;

    case 'borrar-mov': {
      const m = db.movimientos.find((x) => x.id === id);
      const devuelve = m && m.tipo === 'venta' && m.items.some((it) => tieneExistencias(it.productoId && producto(it.productoId)));
      // El pago hecho al momento de la venta se borra junto con ella
      const pago = m && indicePagos()(m);
      const texto = pago ? '¿Eliminar esta venta y su pago?' : '¿Eliminar este movimiento?';
      if (!confirm(`${texto} El saldo del cliente se ajustará.${devuelve ? '\nLas piezas vuelven a tu inventario.' : ''}`)) return;
      if (m && m.tipo === 'venta') moverExistencias(m.items, +1);
      db.movimientos = db.movimientos.filter((x) => x.id !== id && (!pago || x.id !== pago.id));
      guardar();
      cerrarModal();
      aviso('Movimiento eliminado');
      break;
    }

    case 'borrar-compra': {
      const c = db.compras.find((x) => x.id === id);
      if (!c) break;
      const conPiezas = c.items.some((it) => tieneExistencias(it.productoId && producto(it.productoId)));
      if (!confirm(`¿Eliminar esta compra de ${dinero(c.total)}?${conPiezas ? '\nLas piezas que compraste se descuentan de tu inventario.' : ''}`)) return;
      moverExistencias(c.items, -1);
      db.compras = db.compras.filter((x) => x.id !== id);
      guardar();
      cerrarModal();
      aviso('Compra eliminada');
      break;
    }

    case 'borrar-cliente': {
      const c = cliente(id);
      const n = movsDe(id).length;
      if (!confirm(`¿Eliminar a ${c.nombre}${n ? ` y sus ${n} movimientos` : ''}? No se puede deshacer.`)) return;
      db.clientes = db.clientes.filter((x) => x.id !== id);
      db.movimientos = db.movimientos.filter((m) => m.clienteId !== id);
      guardar();
      modal.close();
      location.replace('#/clientes'); // la ficha borrada sale del historial de "atrás"
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

/* ---------- Botón "atrás" del celular (solo en el APK) ----------
   1) cierra la ventana abierta, 2) regresa a la pantalla anterior,
   3) en Inicio sale de la app. En el navegador lo maneja el propio navegador. */
function botonAtras({ canGoBack }) {
  const exito = document.querySelector('.exito');
  if (exito) { exito.click(); return; }
  if (modal.open) { if (!(modal.alAtras && modal.alAtras())) modal.close(); return; }
  const ruta = location.hash.split('/')[1] || 'inicio';
  if (ruta === 'inicio') { window.Capacitor.Plugins.App.exitApp(); return; }
  if (canGoBack) history.back();
  else location.replace('#/inicio');
}

if (esApp() && window.Capacitor.Plugins.App) {
  window.Capacitor.Plugins.App.addListener('backButton', botonAtras);
}

aplicarTema();
render();
// Las fotos se cargan aparte; al terminar se vuelve a pintar para mostrarlas
cargarFotos().then(render).catch(() => {});
