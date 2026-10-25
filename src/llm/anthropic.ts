import Anthropic from "@anthropic-ai/sdk"
import type { Esfuerzo } from "../config"
import { mensajeDe } from "../domain/util"
import {
  ErrorLLM,
  type DefinicionHerramienta,
  type MensajeLLM,
  type MotivoFin,
  type OpcionesEnvio,
  type ProveedorLLM,
  type RespuestaLLM,
} from "./adapter"

type Bloque = Anthropic.Beta.Messages.BetaContentBlockParam
type Mensaje = Anthropic.Beta.Messages.BetaMessageParam

const PROVEEDOR = "anthropic"

function esContenidoNativo(contenido: unknown): contenido is Bloque[] {
  return Array.isArray(contenido) && contenido.every((b) => typeof b === "object" && b !== null && "type" in b)
}

/** El turno del asistente se reenvía tal como llegó (incluye bloques de razonamiento sin modificar). */
function bloquesAsistente(m: Extract<MensajeLLM, { rol: "asistente" }>): Bloque[] {
  if (m.nativo?.proveedor === PROVEEDOR && esContenidoNativo(m.nativo.contenido)) return m.nativo.contenido
  const texto: Bloque[] = m.texto ? [{ type: "text", text: m.texto }] : []
  return [...texto, ...m.llamadas.map((l): Bloque => ({ type: "tool_use", id: l.id, name: l.nombre, input: l.argumentos }))]
}

function bloquesDe(m: MensajeLLM): Bloque[] {
  if (m.rol === "asistente") return bloquesAsistente(m)
  if (m.rol === "usuario") return [{ type: "text", text: m.texto }]
  return m.resultados.map((r) => ({ type: "tool_result", tool_use_id: r.id, content: r.contenido, is_error: r.esError }))
}

/** Une mensajes consecutivos del mismo rol (p. ej. resultados de herramientas + nuevo mensaje del usuario). */
function convertir(mensajes: MensajeLLM[]): Mensaje[] {
  const salida: Array<{ role: "user" | "assistant"; content: Bloque[] }> = []
  for (const m of mensajes) {
    const role = m.rol === "asistente" ? "assistant" : "user"
    const previo = salida.at(-1)
    if (previo && previo.role === role) previo.content = [...previo.content, ...bloquesDe(m)]
    else salida.push({ role, content: [...bloquesDe(m)] })
  }
  return salida
}

const MOTIVOS: Record<string, MotivoFin> = {
  end_turn: "fin_turno",
  tool_use: "herramientas",
  max_tokens: "limite_tokens",
  refusal: "rechazo",
}

function traducirError(error: unknown, timeoutMs: number): ErrorLLM {
  if (error instanceof Anthropic.APIConnectionTimeoutError)
    return new ErrorLLM(`El modelo no respondió en ${Math.round(timeoutMs / 1000)} s. Intenta de nuevo.`, true)
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError)
    return new ErrorLLM("La clave del proveedor LLM es inválida o no tiene permisos. Revisa la configuración del servidor.", false)
  if (error instanceof Anthropic.RateLimitError)
    return new ErrorLLM("El proveedor LLM está limitando solicitudes. Espera unos segundos y reintenta.", true)
  if (error instanceof Anthropic.BadRequestError)
    return new ErrorLLM(`El proveedor rechazó la solicitud: ${error.message}`, false)
  if (error instanceof Anthropic.InternalServerError)
    return new ErrorLLM("El proveedor LLM tuvo un error interno o está sobrecargado. Reintenta en un momento.", true)
  if (error instanceof Anthropic.APIConnectionError)
    return new ErrorLLM("No hay conexión con el proveedor LLM.", true)
  if (error instanceof Anthropic.APIError) return new ErrorLLM(`Error del proveedor LLM (HTTP ${error.status}).`, true)
  return new ErrorLLM(`Error inesperado del proveedor LLM: ${mensajeDe(error)}`, false)
}

export class ProveedorAnthropic implements ProveedorLLM {
  readonly nombre = PROVEEDOR
  readonly configurado = true
  private readonly cliente: Anthropic

  constructor(
    apiKey: string,
    readonly modelo: string,
    private readonly esfuerzo: Esfuerzo,
    private readonly maxTokens: number,
    private readonly timeoutMs: number,
  ) {
    this.cliente = new Anthropic({ apiKey, timeout: timeoutMs, maxRetries: 2 })
  }

  async enviar(mensajes: MensajeLLM[], herramientas: DefinicionHerramienta[], opciones: OpcionesEnvio): Promise<RespuestaLLM> {
    try {
      const respuesta = await this.cliente.beta.messages.create({
        model: this.modelo,
        max_tokens: this.maxTokens,
        system: opciones.sistema,
        messages: convertir(mensajes),
        tools: herramientas.map((h) => ({ name: h.nombre, description: h.descripcion, input_schema: h.parametros })),
        ...(opciones.sinHerramientas ? { tool_choice: { type: "none" as const } } : {}),
        output_config: { effort: this.esfuerzo },
        cache_control: { type: "ephemeral" }, // system + tools + historial se reutilizan entre vueltas
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default", // si el modelo declina por política, el API reintenta en el modelo recomendado
      })

      const texto = respuesta.content
        .flatMap((b) => (b.type === "text" ? [b.text] : []))
        .join("\n")
        .trim()
      const llamadas = respuesta.content.flatMap((b) =>
        b.type === "tool_use" ? [{ id: b.id, nombre: b.name, argumentos: b.input }] : [],
      )
      const u = respuesta.usage
      return {
        texto,
        llamadas,
        fin: MOTIVOS[respuesta.stop_reason ?? ""] ?? "otro",
        uso: {
          entrada: u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
          salida: u.output_tokens,
        },
        nativo: { proveedor: PROVEEDOR, contenido: respuesta.content },
      }
    } catch (error) {
      throw traducirError(error, this.timeoutMs)
    }
  }
}
