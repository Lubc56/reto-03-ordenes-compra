import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import { ejecutarTurno } from "./agent/ciclo"
import { pendientesDe } from "./agent/confirmacion-humana"
import { definiciones } from "./agent/herramientas"
import { construirSistema } from "./agent/prompt"
import { consultarSesion, guardarSesion, idSesionValido, obtenerSesion } from "./agent/sesiones"
import { config } from "./config"
import { mensajeDe } from "./domain/util"
import { crearProveedor } from "./llm"

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const proveedor = crearProveedor(config)

const ESTATICOS: Record<string, { archivo: string; tipo: string }> = {
  "/": { archivo: "index.html", tipo: "text/html; charset=utf-8" },
  "/app.js": { archivo: "app.js", tipo: "text/javascript; charset=utf-8" },
  "/styles.css": { archivo: "styles.css", tipo: "text/css; charset=utf-8" },
}

const ChatSchema = z.object({
  sessionId: z.string().refine(idSesionValido, "sessionId inválido").optional(),
  message: z.string().trim().min(1, "El mensaje está vacío").max(config.agente.maxLongitudMensaje),
  decision: z.enum(["confirmar", "cancelar"]).optional(),
})

function json(res: ServerResponse, estado: number, cuerpo: unknown) {
  res.writeHead(estado, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
  res.end(JSON.stringify(cuerpo))
}

async function leerCuerpo(req: IncomingMessage, limite = 32_000): Promise<unknown> {
  let texto = ""
  for await (const trozo of req) {
    texto += String(trozo)
    if (texto.length > limite) throw new Error("Cuerpo demasiado grande")
  }
  return texto ? JSON.parse(texto) : {}
}

const autorizado = (req: IncomingMessage) => !config.claveAcceso || req.headers["x-access-key"] === config.claveAcceso

async function chat(req: IncomingMessage, res: ServerResponse) {
  const parsed = ChatSchema.safeParse(await leerCuerpo(req))
  if (!parsed.success) return json(res, 400, { ok: false, error: z.prettifyError(parsed.error) })

  const { message, decision } = parsed.data
  const sesion = await obtenerSesion(raiz, parsed.data.sessionId ?? randomUUID())
  if (sesion.ocupada) return json(res, 409, { ok: false, error: "Esta sesión todavía está procesando el mensaje anterior." })

  sesion.ocupada = true
  try {
    sesion.eventos.push({ tipo: "usuario", texto: message, ts: new Date().toISOString() })
    const sistema = await construirSistema(raiz)
    const turno = await ejecutarTurno(sesion, message, { proveedor, sistema, raiz, config }, decision)
    sesion.eventos.push({
      tipo: "asistente",
      texto: turno.reply,
      ts: new Date().toISOString(),
      toolCalls: turno.toolCalls,
      needsConfirmation: turno.needsConfirmation,
      ...(turno.error ? { error: turno.error } : {}),
    })
    await guardarSesion(raiz, sesion)
    json(res, 200, { ok: true, sessionId: sesion.id, ...turno, usoSesion: sesion.uso })
  } finally {
    sesion.ocupada = false
  }
}

async function historial(res: ServerResponse, id: string) {
  if (!idSesionValido(id)) return json(res, 400, { ok: false, error: "sessionId inválido" })
  const sesion = await consultarSesion(raiz, id)
  if (!sesion) return json(res, 404, { ok: false, error: "Sesión no encontrada" })
  json(res, 200, { ok: true, id: sesion.id, creada: sesion.creada, eventos: sesion.eventos, uso: sesion.uso, pendientes: pendientesDe(id) })
}

async function estatico(res: ServerResponse, ruta: string) {
  const recurso = ESTATICOS[ruta]
  if (!recurso) return json(res, 404, { ok: false, error: "No encontrado" })
  res.writeHead(200, { "content-type": recurso.tipo })
  res.end(await readFile(path.join(raiz, "web", recurso.archivo)))
}

async function enrutar(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://localhost")
  const ruta = url.pathname

  if (req.method === "GET" && ruta === "/api/health") {
    return json(res, 200, {
      ok: true,
      provider: proveedor.nombre,
      model: proveedor.modelo,
      configurado: proveedor.configurado,
      accesoProtegido: Boolean(config.claveAcceso),
      herramientas: definiciones().map((d) => d.nombre),
    })
  }
  if (ruta.startsWith("/api/") && !autorizado(req)) return json(res, 401, { ok: false, error: "Clave de acceso requerida" })
  if (req.method === "POST" && ruta === "/api/chat") return chat(req, res)

  const sesion = /^\/api\/sessions\/([^/]+)$/.exec(ruta)
  if (req.method === "GET" && sesion) return historial(res, decodeURIComponent(sesion[1] ?? ""))
  if (req.method === "GET") return estatico(res, ruta)
  json(res, 405, { ok: false, error: "Método no permitido" })
}

const servidor = createServer((req, res) => {
  enrutar(req, res).catch((error) => {
    console.error(`[error] ${req.method} ${req.url}: ${mensajeDe(error)}`)
    if (!res.headersSent) json(res, 500, { ok: false, error: "Error interno del servidor" })
  })
})

servidor.listen(config.puerto, () => {
  console.log(`Agente OC escuchando en http://localhost:${config.puerto}`)
  console.log(`Proveedor: ${proveedor.nombre} · modelo: ${proveedor.modelo} · configurado: ${proveedor.configurado ? "sí" : "NO (falta clave)"}`)
})
