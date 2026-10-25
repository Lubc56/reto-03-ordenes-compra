import { readFile } from "node:fs/promises"
import { z } from "zod"

export type Resultado<T> = { ok: true; data: T } | { ok: false; error: string; detalle?: unknown }

export const exito = <T>(data: T): Resultado<T> => ({ ok: true, data })
export const fallo = (error: string, detalle?: unknown): Resultado<never> =>
  detalle === undefined ? { ok: false, error } : { ok: false, error, detalle }

export function esNoEncontrado(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}

export function mensajeDe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Lee un archivo de texto; devuelve null si no existe (un adjunto ausente no es excepción). */
export async function leerTextoOpcional(ruta: string): Promise<string | null> {
  try {
    return await readFile(ruta, "utf8")
  } catch (error) {
    if (esNoEncontrado(error)) return null
    throw error
  }
}

/** Parsea JSON y valida con zod, con mensajes legibles que nombran el archivo. */
export function parsearJson<T>(texto: string, esquema: z.ZodType<T>, archivo: string): Resultado<T> {
  let crudo: unknown
  try {
    crudo = JSON.parse(texto)
  } catch (error) {
    return fallo(`JSON malformado en ${archivo}: ${mensajeDe(error)}`)
  }
  const parsed = esquema.safeParse(crudo)
  if (!parsed.success) return fallo(`Datos inválidos en ${archivo}:\n${z.prettifyError(parsed.error)}`)
  return exito(parsed.data)
}

/** "11.400.000" → 11400000 · "1.234,56" → 1234.56 (formato colombiano). */
export function parsearMonto(texto: string): number {
  return Number(texto.replace(/\./g, "").replace(",", "."))
}

/** Solo dígitos del NIT, sin dígito de verificación: "900.555.111-2" → "900555111". */
export function normalizarNit(nit: string): string {
  return nit.split("-")[0]!.replace(/\D/g, "")
}

/** Minúsculas, sin tildes ni puntuación: "TecnoSuministros S.A.S." → "tecnosuministros sas". */
export function normalizarTexto(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[.,]/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

const formatoCO = new Intl.NumberFormat("es-CO", { maximumFractionDigits: 2 })
export function formatearMonto(valor: number, moneda = "COP"): string {
  return `${moneda} ${formatoCO.format(valor)}`
}

export function sumarDias(fechaISO: string, dias: number): string {
  const fecha = new Date(`${fechaISO}T00:00:00Z`)
  fecha.setUTCDate(fecha.getUTCDate() + dias)
  return fecha.toISOString().slice(0, 10)
}

/** Fecha (AAAA-MM-DD) tal como está escrita en un ISO con zona: "2026-08-21T10:02:00-05:00" → "2026-08-21". */
export function soloFecha(iso: string): string {
  return iso.slice(0, 10)
}
