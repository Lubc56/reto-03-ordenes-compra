import type { Config } from "../config"
import { mensajeDe } from "../domain/util"
import { ErrorLLM, type MensajeLLM, type ProveedorLLM, type ResultadoHerramienta } from "../llm/adapter"
import { interpretarConfirmacion, hayPendientes, pendientesDe, type Decision } from "./confirmacion-humana"
import { definiciones, ejecutarHerramienta } from "./herramientas"
import { resumirResultado } from "./resumen"
import { sumarUso, tokensDelProceso, tokensSesion, type LlamadaVisible, type Sesion } from "./sesiones"

export type Dependencias = { proveedor: ProveedorLLM; sistema: string; raiz: string; config: Config }

export type ResultadoTurno = {
  reply: string
  toolCalls: LlamadaVisible[]
  needsConfirmation: boolean
  pendientes: Array<{ caso: string; codigos: string[] }>
  iteraciones: number
  uso: { entrada: number; salida: number }
  error?: string
}

function presupuestoAgotado(sesion: Sesion, { agente }: Config): string | null {
  if (tokensSesion(sesion) >= agente.maxTokensSesion)
    return `Esta sesión alcanzó su tope de ${agente.maxTokensSesion.toLocaleString("es-CO")} tokens. Abre una sesión nueva para continuar.`
  if (tokensDelProceso() >= agente.maxTokensGlobal)
    return "El servidor alcanzó su tope global de tokens. Intenta más tarde."
  return null
}

async function ejecutarLlamadas(
  llamadas: Array<{ id: string; nombre: string; argumentos: unknown }>,
  sesion: Sesion,
  raiz: string,
  visibles: LlamadaVisible[],
): Promise<ResultadoHerramienta[]> {
  const resultados: ResultadoHerramienta[] = []
  // En serie: el orden del log y del chat refleja el orden de ejecución
  for (const llamada of llamadas) {
    const ejecucion = await ejecutarHerramienta(llamada.nombre, llamada.argumentos, { directory: raiz, sessionId: sesion.id })
    const { ok, resumen, datos } = resumirResultado(llamada.nombre, ejecucion.resultado)
    visibles.push({ nombre: llamada.nombre, argumentos: llamada.argumentos, ok, resumen, resultado: datos, ms: ejecucion.ms })
    resultados.push({ id: llamada.id, contenido: ejecucion.resultado, esError: !ejecucion.ok })
  }
  return resultados
}

/** CA1: al llegar al tope, una última vuelta sin herramientas para que diga qué tiene y qué falta. */
async function cerrarPorTope(sesion: Sesion, deps: Dependencias, visibles: LlamadaVisible[]): Promise<string> {
  const tope = deps.config.agente.maxIteraciones
  const aviso = `Alcancé el tope de ${tope} iteraciones de herramientas en este turno.`
  sesion.historial.push({ rol: "usuario", texto: `[Sistema] ${aviso} Responde con lo que tienes y lo que falta, sin llamar herramientas.` })
  try {
    const respuesta = await deps.proveedor.enviar(sesion.historial, definiciones(), { sistema: deps.sistema, sinHerramientas: true })
    sumarUso(sesion, respuesta.uso)
    sesion.historial.push({ rol: "asistente", texto: respuesta.texto, llamadas: [], nativo: respuesta.nativo })
    return respuesta.texto || aviso
  } catch {
    const hechas = visibles.map((v) => `${v.nombre}: ${v.resumen}`).join("\n- ")
    return `${aviso}\nLo que alcancé a hacer:\n- ${hechas}`
  }
}

/** Un turno: mensaje del usuario → (modelo → herramientas)* → respuesta. Nunca lanza. */
export async function ejecutarTurno(sesion: Sesion, mensaje: string, deps: Dependencias, decision?: Decision): Promise<ResultadoTurno> {
  const visibles: LlamadaVisible[] = []
  const usoInicial = { ...sesion.uso }
  let iteraciones = 0
  let reply = ""
  let error: string | undefined

  const nota = interpretarConfirmacion(sesion.id, mensaje, decision)
  const agotado = presupuestoAgotado(sesion, deps.config)

  if (agotado) {
    reply = agotado
    error = agotado
  } else {
    const usuario: MensajeLLM = { rol: "usuario", texto: nota ? `${mensaje}\n\n[Sistema] ${nota}` : mensaje }
    sesion.historial.push(usuario)
    try {
      while (true) {
        if (iteraciones >= deps.config.agente.maxIteraciones) {
          reply = await cerrarPorTope(sesion, deps, visibles)
          break
        }
        iteraciones++
        const respuesta = await deps.proveedor.enviar(sesion.historial, definiciones(), { sistema: deps.sistema })
        sumarUso(sesion, respuesta.uso)
        sesion.historial.push({ rol: "asistente", texto: respuesta.texto, llamadas: respuesta.llamadas, nativo: respuesta.nativo })

        if (respuesta.fin === "rechazo") {
          reply = "El modelo declinó responder esta solicitud. Reformúlala o procesa el caso con demo.ts."
          break
        }
        if (respuesta.llamadas.length === 0) {
          reply = respuesta.texto || "(el modelo no devolvió texto)"
          if (respuesta.fin === "limite_tokens") reply += "\n\n_(respuesta truncada por el límite de tokens)_"
          break
        }
        const resultados = await ejecutarLlamadas(respuesta.llamadas, sesion, deps.raiz, visibles)
        sesion.historial.push({ rol: "herramientas", resultados })
        if (presupuestoAgotado(sesion, deps.config)) {
          reply = await cerrarPorTope(sesion, deps, visibles)
          break
        }
      }
    } catch (causa) {
      // CA5: el error se explica en el chat y la sesión sigue viva
      error = causa instanceof ErrorLLM ? causa.message : `Error inesperado: ${mensajeDe(causa)}`
      reply = `⚠️ ${error}`
    }
  }

  return {
    reply,
    toolCalls: visibles,
    needsConfirmation: hayPendientes(sesion.id),
    pendientes: pendientesDe(sesion.id),
    iteraciones,
    uso: { entrada: sesion.uso.entrada - usoInicial.entrada, salida: sesion.uso.salida - usoInicial.salida },
    ...(error ? { error } : {}),
  }
}
