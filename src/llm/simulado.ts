import { casosEnTexto } from "../domain/rutas"
import type { DefinicionHerramienta, LlamadaHerramienta, MensajeLLM, ProveedorLLM, RespuestaLLM } from "./adapter"

// Proveedor determinista (LLM_PROVIDER=simulado): sigue el flujo del prompt con un guion fijo.
// Sirve para probar front y ciclo sin clave, y demuestra que el ciclo no depende del proveedor.

type Resultado = { ok: boolean; error?: string; data?: Record<string, unknown> }
type Control = { regla: string; estado: string; detalle: string }
type Hallazgo = { regla: string; codigo: string; mensaje: string; accion_sugerida: string }

const ICONOS: Record<string, string> = { ok: "✅", bloqueo: "⛔", confirmacion: "⚠️", derivado: "ℹ️", no_aplica: "—" }

function parsear(contenido: string): Resultado {
  try {
    return JSON.parse(contenido) as Resultado
  } catch {
    return { ok: false, error: contenido }
  }
}

/** Mensajes desde el último mensaje del usuario: lo que ya pasó en este turno. */
function turnoActual(mensajes: MensajeLLM[]) {
  const inicio = mensajes.findLastIndex((m) => m.rol === "usuario")
  const usuario = mensajes[inicio]
  const texto = usuario?.rol === "usuario" ? usuario.texto : ""
  const resultados = new Map<string, Resultado>()
  for (const m of mensajes.slice(inicio)) {
    if (m.rol !== "asistente") continue
    for (const llamada of m.llamadas) {
      const r = mensajes.flatMap((x) => (x.rol === "herramientas" ? x.resultados : [])).find((x) => x.id === llamada.id)
      if (r) resultados.set(llamada.nombre, parsear(r.contenido))
    }
  }
  return { texto, resultados }
}

function casoMencionado(mensajes: MensajeLLM[]): string | null {
  for (const m of [...mensajes].reverse()) {
    const caso = m.rol === "usuario" ? casosEnTexto(m.texto)[0] : undefined
    if (caso) return caso
  }
  return null
}

function siguientePaso(caso: string, texto: string, hechos: Map<string, Resultado>): LlamadaHerramienta | null {
  const llamar = (nombre: string, argumentos: Record<string, unknown>) => ({ id: `sim_${nombre}_${Date.now()}`, nombre, argumentos })
  if (/\[Sistema\] El usuario confirmó/.test(texto)) return hechos.has("oc_crear") ? null : llamar("oc_crear", { caso, confirmado: true })
  if (/\[Sistema\] El usuario NO confirmó/.test(texto)) return null
  if (!hechos.has("oc_leer_paquete")) return llamar("oc_leer_paquete", { caso })
  if (!hechos.get("oc_leer_paquete")?.ok) return null
  if (!hechos.has("oc_validar")) return llamar("oc_validar", { caso })
  const apta = hechos.get("oc_validar")?.data?.apta === true
  if (apta && !hechos.has("oc_construir_payload")) return llamar("oc_construir_payload", { caso })
  if (apta && !hechos.has("oc_generar_evidencia")) return llamar("oc_generar_evidencia", { caso })
  const noCrear = /no la crees|no crear|hasta que (yo )?(lo )?confirme/i.test(texto)
  if (!hechos.has("oc_crear") && !noCrear) {
    const orden = hechos.get("oc_construir_payload")?.data?.orden
    return llamar("oc_crear", orden ? { caso, payload: orden } : { caso })
  }
  return null
}

function redactar(caso: string, texto: string, hechos: Map<string, Resultado>): string {
  const lectura = hechos.get("oc_leer_paquete")
  if (lectura && !lectura.ok) return `⛔ No pude leer el paquete de **${caso}**: ${lectura.error}`
  const crear = hechos.get("oc_crear")
  if (/\[Sistema\] El usuario NO confirmó/.test(texto)) return `Entendido: **no** creo la OC de ${caso}. Queda registrada como pendiente en control.`
  const lineas: string[] = []

  const v = hechos.get("oc_validar")?.data
  if (crear?.ok && crear.data) {
    const d = crear.data
    const evidencia = d.evidencia as { ruta?: string; ruta_pdf?: string } | undefined
    lineas.push(d.idempotente ? `♻️ La OC **${d.numero_oc}** ya existía para ${caso}.` : `✅ OC **${d.numero_oc}** creada (${d.total_formateado}).`)
    if (evidencia) lineas.push(`Evidencia: \`${evidencia.ruta}\` y \`${evidencia.ruta_pdf}\`.`)
    if (d.retroactiva) lineas.push("Quedó marcada **retroactiva = true** en `out/control.csv`.")
  }
  if (v) {
    const bloqueos = (v.bloqueos as Hallazgo[]) ?? []
    const confirmaciones = (v.confirmaciones as Hallazgo[]) ?? []
    if (!crear?.ok) lineas.push(bloqueos.length ? `⛔ **${caso}** está bloqueada.` : confirmaciones.length ? `⏸️ **${caso}** requiere tu confirmación.` : `Validación de ${caso} lista.`)
    const total = hechos.get("oc_construir_payload")?.data?.total_formateado
    if (total) lineas.push(`Total de la OC: **${String(total)}**.`)
    lineas.push("", "| Regla | Estado | Detalle |", "|---|---|---|")
    for (const c of (v.controles as Control[]) ?? []) lineas.push(`| ${c.regla} | ${ICONOS[c.estado] ?? c.estado} | ${c.detalle} |`)
    if (bloqueos.length) lineas.push("", "**Acción sugerida**", ...bloqueos.map((b) => `- ${b.regla}: ${b.accion_sugerida}`))
    if (confirmaciones.length && !crear?.ok) {
      lineas.push("", "**Confirmaciones**", ...confirmaciones.map((c) => `- ${c.regla}: ${c.mensaje}`))
      lineas.push("", `¿Confirmas crear la OC de ${caso} con estas excepciones? Responde «confirmo» o «cancelar».`)
    }
  } else if (crear && !crear.ok) {
    lineas.push(`⚠️ ${crear.error}`)
  }
  return lineas.join("\n") || "Dime qué solicitud proceso, por ejemplo: «procesa sol-001»."
}

export class ProveedorSimulado implements ProveedorLLM {
  readonly nombre = "simulado"
  readonly modelo = "guion-determinista"
  readonly configurado = true

  async enviar(mensajes: MensajeLLM[], _herramientas: DefinicionHerramienta[]): Promise<RespuestaLLM> {
    const caso = casoMencionado(mensajes)
    const { texto, resultados } = turnoActual(mensajes)
    const paso = caso ? siguientePaso(caso, texto, resultados) : null
    if (paso) return { texto: "", llamadas: [paso], fin: "herramientas", uso: { entrada: 0, salida: 0 } }
    return { texto: caso ? redactar(caso, texto, resultados) : redactar("", texto, new Map()), llamadas: [], fin: "fin_turno", uso: { entrada: 0, salida: 0 } }
  }
}
