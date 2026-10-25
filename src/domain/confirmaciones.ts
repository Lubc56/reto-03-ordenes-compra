// Registro de confirmaciones humanas por sesión (CA3).
//
// El modelo puede pasar confirmado=true, pero eso no basta: oc_crear exige además
// que el *usuario* haya confirmado en el chat. Quien marca "otorgada" es el servidor
// al recibir el mensaje del usuario, nunca el modelo. Así la regla la impone el
// diseño y no solo el prompt.

type Pendiente = { caso: string; codigos: string[]; otorgada: boolean }

const porSesion = new Map<string, Map<string, Pendiente>>()

const delaSesion = (sessionId: string) => {
  let mapa = porSesion.get(sessionId)
  if (!mapa) {
    mapa = new Map()
    porSesion.set(sessionId, mapa)
  }
  return mapa
}

/** La herramienta registra que un caso necesita confirmación (no la otorga). */
export function registrarPendiente(sessionId: string, caso: string, codigos: string[]): void {
  const mapa = delaSesion(sessionId)
  const previa = mapa.get(caso)
  const mismas = previa && previa.codigos.join() === codigos.join()
  mapa.set(caso, { caso, codigos, otorgada: Boolean(mismas && previa.otorgada) })
}

export function pendientes(sessionId: string): Array<{ caso: string; codigos: string[] }> {
  return [...delaSesion(sessionId).values()].filter((p) => !p.otorgada).map(({ caso, codigos }) => ({ caso, codigos }))
}

/** Solo el servidor (o demo.ts simulando a la analista) llama esto, a partir de un mensaje humano. */
export function otorgar(sessionId: string, casos?: string[]): string[] {
  const otorgados: string[] = []
  for (const p of delaSesion(sessionId).values()) {
    if (!p.otorgada && (!casos || casos.includes(p.caso))) {
      p.otorgada = true
      otorgados.push(p.caso)
    }
  }
  return otorgados
}

export function rechazar(sessionId: string, casos?: string[]): string[] {
  const mapa = delaSesion(sessionId)
  const rechazados = [...mapa.keys()].filter((caso) => !casos || casos.includes(caso))
  rechazados.forEach((caso) => mapa.delete(caso))
  return rechazados
}

export function estaOtorgada(sessionId: string, caso: string): boolean {
  return delaSesion(sessionId).get(caso)?.otorgada === true
}

export function cerrar(sessionId: string, caso: string): void {
  delaSesion(sessionId).delete(caso)
}

/** Para integraciones sin servidor (módulo): OC_CONFIRMACION_ESTRICTA=false confía en confirmado=true. */
export const confirmacionEstricta = () => process.env.OC_CONFIRMACION_ESTRICTA !== "false"
