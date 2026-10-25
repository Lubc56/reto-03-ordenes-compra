import * as confirmaciones from "../domain/confirmaciones"

// CA3: el servidor (no el modelo) decide si el mensaje del usuario confirma.
// Vale el botón "Confirmar" del front o un texto afirmativo inequívoco.

export type Decision = "confirmar" | "cancelar"

const AFIRMATIVO = /^\s*(s[ií]\b|confirmo|confirmad[oa]s?|confirmar|adelante|procede|proceder|dale|ok\b|okay|de acuerdo|cr[ée]al[ao]s?|hazlo|aprobado)/i
const NEGATIVO = /^\s*(no\b|cancela|cancelar|rechaz|det[ée]n|espera|todav[ií]a no)/i

function casosMencionados(texto: string): string[] | undefined {
  const casos = texto.match(/sol-\d{3}/gi)?.map((c) => c.toLowerCase())
  return casos?.length ? casos : undefined
}

/** Devuelve una nota para el modelo si el mensaje resolvió confirmaciones pendientes. */
export function interpretarConfirmacion(sessionId: string, texto: string, decision?: Decision): string | null {
  if (confirmaciones.pendientes(sessionId).length === 0) return null
  const casos = casosMencionados(texto)

  if (decision === "confirmar" || (!decision && AFIRMATIVO.test(texto) && !NEGATIVO.test(texto))) {
    const otorgados = confirmaciones.otorgar(sessionId, casos)
    return otorgados.length
      ? `El usuario confirmó explícitamente las excepciones de: ${otorgados.join(", ")}. Puedes llamar oc_crear con confirmado=true para esos casos.`
      : null
  }
  if (decision === "cancelar" || NEGATIVO.test(texto)) {
    const rechazados = confirmaciones.rechazar(sessionId, casos)
    return rechazados.length ? `El usuario NO confirmó: ${rechazados.join(", ")}. No crees esas OC.` : null
  }
  return null
}

export const hayPendientes = (sessionId: string) => confirmaciones.pendientes(sessionId).length > 0
export const pendientesDe = (sessionId: string) => confirmaciones.pendientes(sessionId)
