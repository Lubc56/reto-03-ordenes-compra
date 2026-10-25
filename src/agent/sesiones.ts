import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { rutaSalida } from "../domain/rutas"
import { leerTextoOpcional } from "../domain/util"
import type { MensajeLLM } from "../llm/adapter"

export type LlamadaVisible = { nombre: string; argumentos: unknown; ok: boolean; resumen: string; resultado: unknown; ms: number }

export type EventoVisible =
  | { tipo: "usuario"; texto: string; ts: string }
  | { tipo: "asistente"; texto: string; ts: string; toolCalls: LlamadaVisible[]; needsConfirmation: boolean; error?: string }

export type Sesion = {
  id: string
  creada: string
  historial: MensajeLLM[] // lo que ve el modelo
  eventos: EventoVisible[] // lo que ve la persona
  uso: { entrada: number; salida: number }
  ocupada: boolean
}

const sesiones = new Map<string, Sesion>()
let tokensGlobales = 0

export const idSesionValido = (id: string) => /^[A-Za-z0-9_-]{1,64}$/.test(id)
const rutaSesion = (raiz: string, id: string) => path.join(rutaSalida(raiz), "sessions", `${id}.json`)

/** Memoria primero; si el servidor se reinició, se recupera desde out/sessions/<id>.json. */
export async function obtenerSesion(raiz: string, id: string): Promise<Sesion> {
  const enMemoria = sesiones.get(id)
  if (enMemoria) return enMemoria
  const guardada = await leerTextoOpcional(rutaSesion(raiz, id))
  const sesion: Sesion = guardada
    ? { ...(JSON.parse(guardada) as Omit<Sesion, "ocupada">), ocupada: false }
    : { id, creada: new Date().toISOString(), historial: [], eventos: [], uso: { entrada: 0, salida: 0 }, ocupada: false }
  sesiones.set(id, sesion)
  return sesion
}

export async function consultarSesion(raiz: string, id: string): Promise<Sesion | null> {
  if (sesiones.has(id)) return sesiones.get(id) ?? null
  const guardada = await leerTextoOpcional(rutaSesion(raiz, id))
  return guardada ? obtenerSesion(raiz, id) : null
}

export async function guardarSesion(raiz: string, sesion: Sesion): Promise<void> {
  const { ocupada: _omitida, ...persistible } = sesion
  await mkdir(path.dirname(rutaSesion(raiz, sesion.id)), { recursive: true })
  await writeFile(rutaSesion(raiz, sesion.id), JSON.stringify(persistible), "utf8")
}

export function sumarUso(sesion: Sesion, uso: { entrada: number; salida: number }): void {
  sesion.uso.entrada += uso.entrada
  sesion.uso.salida += uso.salida
  tokensGlobales += uso.entrada + uso.salida
}

export const tokensSesion = (sesion: Sesion) => sesion.uso.entrada + sesion.uso.salida
export const tokensDelProceso = () => tokensGlobales
