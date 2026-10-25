import type { Config } from "../config"
import { ErrorLLM, type ProveedorLLM } from "./adapter"
import { ProveedorAnthropic } from "./anthropic"
import { ProveedorCompatibleOpenAI } from "./compatible-openai"
import { ProveedorSimulado } from "./simulado"

const URL_GEMINI = "https://generativelanguage.googleapis.com/v1beta/openai"

const comunes = (llm: Config["llm"]) => ({ modelo: llm.modelo, maxTokens: llm.maxTokensRespuesta, timeoutMs: llm.timeoutMs })

/** Sin clave el servidor igual arranca: health lo informa y el chat explica qué falta. */
class ProveedorNoConfigurado implements ProveedorLLM {
  readonly configurado = false
  constructor(
    readonly nombre: string,
    readonly modelo: string,
    private readonly motivo: string,
  ) {}

  async enviar(): Promise<never> {
    throw new ErrorLLM(this.motivo, false)
  }
}

/** Elegir otro proveedor = agregar un caso aquí con su implementación de ProveedorLLM. */
export function crearProveedor({ llm }: Config): ProveedorLLM {
  if (llm.proveedor === "anthropic") {
    return llm.claveAnthropic
      ? new ProveedorAnthropic(llm.claveAnthropic, llm.modelo, llm.esfuerzo, llm.maxTokensRespuesta, llm.timeoutMs)
      : new ProveedorNoConfigurado(
          "anthropic",
          llm.modelo,
          "El servidor no tiene ANTHROPIC_API_KEY configurada. Las herramientas funcionan sin modelo: npm run demo.",
        )
  }
  if (llm.proveedor === "gemini") {
    return llm.claveGemini
      ? new ProveedorCompatibleOpenAI({ ...comunes(llm), nombre: "gemini", baseUrl: llm.urlBase ?? URL_GEMINI, apiKey: llm.claveGemini })
      : new ProveedorNoConfigurado(
          "gemini",
          llm.modelo,
          "El servidor no tiene GEMINI_API_KEY configurada (se obtiene gratis en aistudio.google.com).",
        )
  }
  if (llm.proveedor === "compatible") {
    return llm.urlBase && llm.modelo
      ? new ProveedorCompatibleOpenAI({ ...comunes(llm), nombre: "compatible", baseUrl: llm.urlBase, apiKey: llm.claveCompatible ?? "" })
      : new ProveedorNoConfigurado("compatible", llm.modelo, "Faltan LLM_BASE_URL y LLM_MODEL para el proveedor compatible.")
  }
  if (llm.proveedor === "simulado") return new ProveedorSimulado()
  return new ProveedorNoConfigurado(llm.proveedor, llm.modelo, `Proveedor LLM no soportado: ${llm.proveedor}.`)
}
