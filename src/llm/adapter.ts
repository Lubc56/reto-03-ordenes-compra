// Interfaz propia del proveedor LLM. El ciclo del agente solo conoce estos tipos:
// cambiar de proveedor = nueva implementación de ProveedorLLM, sin tocar el ciclo.

export type LlamadaHerramienta = { id: string; nombre: string; argumentos: unknown }
export type ResultadoHerramienta = { id: string; contenido: string; esError: boolean }

/** Contenido crudo del proveedor (p. ej. bloques de razonamiento) para reenviarlo sin modificar. */
export type Nativo = { proveedor: string; contenido: unknown }

export type MensajeLLM =
  | { rol: "usuario"; texto: string }
  | { rol: "asistente"; texto: string; llamadas: LlamadaHerramienta[]; nativo?: Nativo }
  | { rol: "herramientas"; resultados: ResultadoHerramienta[] }

export type DefinicionHerramienta = {
  nombre: string
  descripcion: string
  parametros: { type: "object"; [clave: string]: unknown }
}

export type MotivoFin = "fin_turno" | "herramientas" | "limite_tokens" | "rechazo" | "otro"

export type RespuestaLLM = {
  texto: string
  llamadas: LlamadaHerramienta[]
  fin: MotivoFin
  uso: { entrada: number; salida: number }
  nativo?: Nativo
}

export type OpcionesEnvio = {
  sistema: string
  /** true en la última vuelta tras el tope de iteraciones: el modelo solo puede responder. */
  sinHerramientas?: boolean
}

export interface ProveedorLLM {
  readonly nombre: string
  readonly modelo: string
  readonly configurado: boolean
  enviar(mensajes: MensajeLLM[], herramientas: DefinicionHerramienta[], opciones: OpcionesEnvio): Promise<RespuestaLLM>
}

/** Error del proveedor con mensaje apto para mostrar en el chat (sin claves ni trazas). */
export class ErrorLLM extends Error {
  constructor(
    message: string,
    readonly reintentable: boolean,
  ) {
    super(message)
    this.name = "ErrorLLM"
  }
}
