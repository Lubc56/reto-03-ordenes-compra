import type { Config } from "../config"
import { ErrorLLM, type ProveedorLLM } from "./adapter"
import { ProveedorAnthropic } from "./anthropic"
import { ProveedorSimulado } from "./simulado"

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
  if (llm.proveedor === "simulado") return new ProveedorSimulado()
  return new ProveedorNoConfigurado(llm.proveedor, llm.modelo, `Proveedor LLM no soportado: ${llm.proveedor}.`)
}
