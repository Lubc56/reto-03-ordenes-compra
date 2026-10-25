import { z } from "zod"
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

// Proveedor para APIs compatibles con OpenAI Chat Completions: Gemini (plan gratuito),
// Groq, Ollama… Sin SDK: un fetch y esquemas zod para la respuesta.
//
// El mensaje del asistente se guarda y reenvía tal cual (nativo): Gemini 3 exige devolver
// sin cambios la thought_signature que llega en tool_calls[].extra_content.

const LlamadaSchema = z.looseObject({
  id: z.string().optional(),
  type: z.string().optional(),
  function: z.looseObject({ name: z.string(), arguments: z.string().optional() }),
})

const MensajeAsistenteSchema = z.looseObject({
  role: z.literal("assistant"),
  content: z.string().nullable().optional(),
  tool_calls: z.array(LlamadaSchema).optional(),
})
type MensajeAsistente = z.infer<typeof MensajeAsistenteSchema>

const RespuestaSchema = z.object({
  choices: z.array(z.object({ message: MensajeAsistenteSchema, finish_reason: z.string().nullable().optional() })).min(1),
  usage: z.object({ prompt_tokens: z.number().optional(), completion_tokens: z.number().optional() }).optional(),
})

type MensajeChat =
  | { role: "system" | "user"; content: string }
  | { role: "tool"; tool_call_id: string; content: string }
  | MensajeAsistente

const MOTIVOS: Record<string, MotivoFin> = {
  stop: "fin_turno",
  tool_calls: "herramientas",
  length: "limite_tokens",
  content_filter: "rechazo",
}

/** Quita claves de JSON Schema que algunos proveedores rechazan; zod valida igual en el servidor. */
function esquemaPortable(valor: unknown): unknown {
  if (Array.isArray(valor)) return valor.map(esquemaPortable)
  if (typeof valor !== "object" || valor === null) return valor
  return Object.fromEntries(
    Object.entries(valor)
      .filter(([clave]) => clave !== "additionalProperties" && clave !== "propertyNames" && clave !== "$schema")
      .map(([clave, v]) => [clave, esquemaPortable(v)]),
  )
}

function parsearArgumentos(texto: string | undefined): unknown {
  try {
    return JSON.parse(texto || "{}")
  } catch {
    return texto // JSON inválido: zod lo rechaza y el error vuelve al modelo
  }
}

/** Mensaje de error del cuerpo HTTP (formato OpenAI o Google), sin exponer cabeceras ni claves. */
function detalleError(texto: string): string {
  try {
    const parsed: unknown = JSON.parse(texto)
    const cuerpo = Array.isArray(parsed) ? parsed[0] : parsed
    const mensaje = z.object({ error: z.object({ message: z.string() }) }).safeParse(cuerpo)
    if (mensaje.success) return mensaje.data.error.message.slice(0, 300)
  } catch {
    // cuerpo no JSON
  }
  return texto.slice(0, 300)
}

const esperar = (ms: number) => new Promise((resolver) => setTimeout(resolver, ms))

export type OpcionesCompatible = {
  nombre: string
  baseUrl: string
  apiKey: string
  modelo: string
  maxTokens: number
  timeoutMs: number
}

export class ProveedorCompatibleOpenAI implements ProveedorLLM {
  readonly nombre: string
  readonly modelo: string
  readonly configurado = true

  constructor(private readonly opciones: OpcionesCompatible) {
    this.nombre = opciones.nombre
    this.modelo = opciones.modelo
  }

  private mensajeAsistente(m: Extract<MensajeLLM, { rol: "asistente" }>): MensajeAsistente {
    if (m.nativo?.proveedor === this.nombre) {
      const nativo = MensajeAsistenteSchema.safeParse(m.nativo.contenido)
      if (nativo.success) return nativo.data
    }
    return {
      role: "assistant",
      content: m.texto || null,
      ...(m.llamadas.length
        ? {
            tool_calls: m.llamadas.map((l) => ({
              id: l.id,
              type: "function",
              function: { name: l.nombre, arguments: JSON.stringify(l.argumentos ?? {}) },
            })),
          }
        : {}),
    }
  }

  private convertir(mensajes: MensajeLLM[], sistema: string): MensajeChat[] {
    const salida: MensajeChat[] = [{ role: "system", content: sistema }]
    for (const m of mensajes) {
      if (m.rol === "usuario") salida.push({ role: "user", content: m.texto })
      else if (m.rol === "asistente") salida.push(this.mensajeAsistente(m))
      else salida.push(...m.resultados.map((r) => ({ role: "tool" as const, tool_call_id: r.id, content: r.contenido })))
    }
    return salida
  }

  /** POST con hasta 2 reintentos ante 429/503 (límites del plan gratuito). */
  private async publicar(cuerpo: unknown): Promise<string> {
    const { baseUrl, apiKey, timeoutMs } = this.opciones
    for (let intento = 0; ; intento++) {
      let respuesta: Response
      try {
        respuesta = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(cuerpo),
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (error) {
        if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"))
          throw new ErrorLLM(`El modelo no respondió en ${Math.round(timeoutMs / 1000)} s. Intenta de nuevo.`, true)
        throw new ErrorLLM(`No hay conexión con el proveedor LLM: ${mensajeDe(error)}`, true)
      }
      const texto = await respuesta.text()
      if (respuesta.ok) return texto

      const reintentable = respuesta.status === 429 || respuesta.status === 503
      if (reintentable && intento < 2) {
        const segundos = Math.min(Number(respuesta.headers.get("retry-after")) || 5, 20)
        await esperar(segundos * 1000)
        continue
      }
      if (respuesta.status === 401 || respuesta.status === 403)
        throw new ErrorLLM("La clave del proveedor LLM es inválida o no tiene permisos. Revisa la configuración del servidor.", false)
      if (respuesta.status === 429)
        throw new ErrorLLM("Se alcanzó el límite de solicitudes del plan del proveedor (en el gratuito, unas 10 por minuto). Espera un minuto y reintenta.", true)
      if (respuesta.status >= 500)
        throw new ErrorLLM("El proveedor LLM tuvo un error interno o está sobrecargado. Reintenta en un momento.", true)
      throw new ErrorLLM(`El proveedor rechazó la solicitud (HTTP ${respuesta.status}): ${detalleError(texto)}`, false)
    }
  }

  async enviar(mensajes: MensajeLLM[], herramientas: DefinicionHerramienta[], opciones: OpcionesEnvio): Promise<RespuestaLLM> {
    const texto = await this.publicar({
      model: this.modelo,
      max_tokens: this.opciones.maxTokens,
      messages: this.convertir(mensajes, opciones.sistema),
      tools: herramientas.map((h) => ({
        type: "function",
        function: { name: h.nombre, description: h.descripcion, parameters: esquemaPortable(h.parametros) },
      })),
      tool_choice: opciones.sinHerramientas ? "none" : "auto",
    })

    let crudo: unknown
    try {
      crudo = JSON.parse(texto)
    } catch {
      throw new ErrorLLM("El proveedor LLM devolvió una respuesta que no es JSON.", true)
    }
    const parsed = RespuestaSchema.safeParse(crudo)
    if (!parsed.success) throw new ErrorLLM("El proveedor LLM devolvió una respuesta con un formato inesperado.", true)

    const [opcion] = parsed.data.choices
    if (!opcion) throw new ErrorLLM("El proveedor LLM no devolvió ninguna respuesta.", true)
    const mensaje = opcion.message
    // Si el proveedor no asigna id a una llamada, se genera uno y se guarda en el nativo para que coincida
    const llamadasCrudas = (mensaje.tool_calls ?? []).map((tc, i) => ({ ...tc, id: tc.id || `llamada_${Date.now()}_${i}` }))
    const llamadas = llamadasCrudas.map((tc) => ({ id: tc.id, nombre: tc.function.name, argumentos: parsearArgumentos(tc.function.arguments) }))
    const uso = parsed.data.usage

    return {
      texto: (mensaje.content ?? "").trim(),
      llamadas,
      fin: MOTIVOS[opcion.finish_reason ?? ""] ?? (llamadas.length ? "herramientas" : "fin_turno"),
      uso: { entrada: uso?.prompt_tokens ?? 0, salida: uso?.completion_tokens ?? 0 },
      nativo: {
        proveedor: this.nombre,
        contenido: llamadasCrudas.length ? { ...mensaje, tool_calls: llamadasCrudas } : mensaje,
      },
    }
  }
}
