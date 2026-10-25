// Front de chat sin build. Habla con /api/chat, /api/sessions/:id y /api/health.

const $ = (selector) => document.querySelector(selector)
const chat = $("#chat")
const entrada = $("#mensaje")
const botonEnviar = $("#enviar")
const panelConfirmacion = $("#confirmacion")

const nuevoId = () => (crypto.randomUUID ? crypto.randomUUID() : `s-${Date.now()}-${Math.random().toString(36).slice(2)}`)
const guardado = (clave) => { try { return localStorage.getItem(clave) } catch { return null } }
const guardar = (clave, valor) => { try { localStorage.setItem(clave, valor) } catch { /* modo privado */ } }

const estado = {
  sessionId: guardado("oc.sessionId") || nuevoId(),
  clave: guardado("oc.clave") || "",
  ocupado: false,
}
guardar("oc.sessionId", estado.sessionId)

function markdown(texto) {
  if (window.marked && window.DOMPurify) return window.DOMPurify.sanitize(window.marked.parse(texto))
  const div = document.createElement("div")
  div.textContent = texto
  return `<p style="white-space:pre-wrap">${div.innerHTML}</p>`
}

const json = (valor) => JSON.stringify(valor, null, 2)

function tarjetaHerramienta(llamada) {
  const detalle = document.createElement("details")
  detalle.className = `tool ${llamada.ok ? "" : "fallida"}`
  const resumen = document.createElement("summary")
  resumen.innerHTML = `${llamada.ok ? "🔧" : "⚠️"} <span class="nombre"></span> · <span class="texto"></span> <span class="ms">· ${llamada.ms} ms</span>`
  resumen.querySelector(".nombre").textContent = llamada.nombre
  resumen.querySelector(".texto").textContent = llamada.resumen
  detalle.append(resumen)
  for (const [titulo, valor] of [["Argumentos", llamada.argumentos], ["Resultado", llamada.resultado]]) {
    const h = document.createElement("h4")
    h.textContent = titulo
    const pre = document.createElement("pre")
    pre.textContent = json(valor)
    detalle.append(h, pre)
  }
  return detalle
}

function agregarMensaje(evento) {
  $("#bienvenida")?.remove()
  const burbuja = document.createElement("article")
  if (evento.tipo === "usuario") {
    burbuja.className = "mensaje usuario"
    burbuja.textContent = evento.texto
  } else {
    burbuja.className = `mensaje asistente${evento.needsConfirmation ? " pide-confirmacion" : ""}${evento.error ? " error" : ""}`
    if (evento.toolCalls?.length) {
      const lista = document.createElement("div")
      lista.className = "herramientas"
      evento.toolCalls.forEach((llamada) => lista.append(tarjetaHerramienta(llamada)))
      burbuja.append(lista)
    }
    const cuerpo = document.createElement("div")
    cuerpo.innerHTML = markdown(evento.texto || "")
    burbuja.append(cuerpo)
  }
  chat.append(burbuja)
  burbuja.scrollIntoView({ behavior: "smooth", block: "end" })
  return burbuja
}

function mostrarConfirmacion(pendientes) {
  panelConfirmacion.hidden = !pendientes?.length
  if (!pendientes?.length) return
  $("#confirmacion-detalle").textContent = pendientes.map((p) => `${p.caso}: ${p.codigos.join(", ")}`).join(" · ")
}

function indicadorPensando() {
  const nodo = document.createElement("article")
  nodo.className = "mensaje asistente pensando"
  const inicio = Date.now()
  nodo.textContent = "Pensando y ejecutando herramientas"
  const reloj = setInterval(() => {
    nodo.textContent = `Pensando y ejecutando herramientas (${Math.round((Date.now() - inicio) / 1000)} s)`
  }, 1000)
  chat.append(nodo)
  nodo.scrollIntoView({ behavior: "smooth", block: "end" })
  return () => { clearInterval(reloj); nodo.remove() }
}

async function api(ruta, opciones = {}) {
  const respuesta = await fetch(ruta, {
    ...opciones,
    headers: { "content-type": "application/json", ...(estado.clave ? { "x-access-key": estado.clave } : {}) },
  })
  if (respuesta.status === 401) {
    const clave = prompt("Este agente está protegido. Ingresa la clave de acceso (ver README):")
    if (clave) { estado.clave = clave; guardar("oc.clave", clave); return api(ruta, opciones) }
  }
  return respuesta.json()
}

function ocupar(ocupado) {
  estado.ocupado = ocupado
  botonEnviar.disabled = ocupado
  $("#confirmar").disabled = ocupado
  $("#cancelar").disabled = ocupado
}

async function enviar(texto, decision) {
  if (estado.ocupado || !texto.trim()) return
  ocupar(true)
  mostrarConfirmacion([])
  agregarMensaje({ tipo: "usuario", texto })
  const quitarIndicador = indicadorPensando()
  try {
    const r = await api("/api/chat", { method: "POST", body: JSON.stringify({ sessionId: estado.sessionId, message: texto, decision }) })
    quitarIndicador()
    if (!r.ok) {
      agregarMensaje({ tipo: "asistente", texto: `⚠️ ${r.error}`, error: r.error })
      return
    }
    agregarMensaje({ tipo: "asistente", texto: r.reply, toolCalls: r.toolCalls, needsConfirmation: r.needsConfirmation, error: r.error })
    mostrarConfirmacion(r.pendientes)
  } catch (error) {
    quitarIndicador()
    agregarMensaje({ tipo: "asistente", texto: `⚠️ No se pudo contactar al servidor: ${error.message}`, error: true })
  } finally {
    ocupar(false)
    entrada.focus()
  }
}

async function iniciar() {
  try {
    const salud = await fetch("/api/health").then((r) => r.json())
    $("#estado").textContent = `${salud.provider} · ${salud.model}${salud.configurado ? "" : " · ⚠️ sin clave configurada"} · sesión ${estado.sessionId.slice(0, 8)}`
  } catch {
    $("#estado").textContent = "Servidor no disponible"
  }
  const sesion = await api(`/api/sessions/${estado.sessionId}`).catch(() => null)
  if (sesion?.ok && sesion.eventos.length) {
    sesion.eventos.forEach(agregarMensaje)
    mostrarConfirmacion(sesion.pendientes)
  }
}

$("#formulario").addEventListener("submit", (e) => {
  e.preventDefault()
  const texto = entrada.value
  entrada.value = ""
  enviar(texto)
})
entrada.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#formulario").requestSubmit() }
})
chat.addEventListener("click", (e) => {
  const ejemplo = e.target.closest("[data-ejemplo]")
  if (ejemplo) enviar(ejemplo.dataset.ejemplo)
})
$("#confirmar").addEventListener("click", () => enviar("Confirmo, crea la OC.", "confirmar"))
$("#cancelar").addEventListener("click", () => enviar("Cancelar, no la crees.", "cancelar"))
$("#nueva").addEventListener("click", () => {
  estado.sessionId = nuevoId()
  guardar("oc.sessionId", estado.sessionId)
  location.reload()
})

iniciar()
