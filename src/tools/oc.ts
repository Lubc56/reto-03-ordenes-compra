import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import * as confirmaciones from "../domain/confirmaciones"
import { registrarControl, type FilaControl } from "../domain/control"
import { contenidoEvidencia, escribirEvidencia, sha256 } from "../domain/evidencia"
import { cargarMaestros } from "../domain/maestros"
import { leerPaquete } from "../domain/paquete"
import { construirOrden, totalOrden } from "../domain/payload"
import { relativa, rutaSalida, rutaSalidaCaso } from "../domain/rutas"
import type { OrdenCompra, Paquete } from "../domain/tipos"
import { exito, fallo, formatearMonto, type Resultado } from "../domain/util"
import { validarPaquete, type Validacion } from "../domain/validacion"
import { crearSap, enSerie } from "../sap/mock"
import { definirHerramienta, responder, type ContextoHerramienta } from "./contrato"

// Cada export es una herramienta; el modelo la ve como oc_<export>.
// Los argumentos paquete/derivados/payload se aceptan por contrato, pero los valores
// siempre se recalculan desde fixtures: el modelo no puede alterar montos ni códigos.

const argCaso = z.string().describe("Nombre de la carpeta del caso en fixtures/reto-03/solicitudes/, p. ej. sol-001")
const objetoOpcional = (que: string) =>
  z
    .record(z.string(), z.unknown())
    .optional()
    .describe(`${que} Opcional: la herramienta recalcula desde los archivos y solo lo usa para detectar alteraciones.`)

type Caso = { paquete: Paquete; validacion: Validacion }

async function prepararCaso(raiz: string, caso: string): Promise<Resultado<Caso>> {
  const paquete = await leerPaquete(raiz, caso)
  if (!paquete.ok) return paquete
  const maestros = await cargarMaestros(raiz)
  if (!maestros.ok) return maestros
  return exito({ paquete: paquete.data, validacion: validarPaquete(paquete.data, maestros.data) })
}

async function guardarJson(ruta: string, datos: unknown) {
  await mkdir(path.dirname(ruta), { recursive: true })
  await writeFile(ruta, JSON.stringify(datos, null, 2) + "\n", "utf8")
}

/** Compara los valores de la solicitud que el modelo envió con los del archivo. */
function diferenciasPaquete(real: Paquete, recibido: Record<string, unknown> | undefined): string[] {
  const solicitud = recibido?.solicitud
  if (!solicitud || typeof solicitud !== "object") return []
  return Object.entries(solicitud)
    .filter(([campo, valor]) => campo in real.solicitud && real.solicitud[campo as keyof Paquete["solicitud"]] !== valor)
    .map(([campo]) => `solicitud.${campo}`)
}

const CriticosSchema = z.object({
  referencia: z.object({ solicitud_id: z.string() }).partial().optional(),
  proveedor: z.object({ codigo_sap: z.string(), nit: z.string() }).partial().optional(),
  moneda: z.string().optional(),
  condiciones_pago: z.string().optional(),
  posiciones: z
    .array(
      z
        .object({
          cantidad: z.number(),
          precio_unitario: z.number(),
          centro_costo: z.string(),
          subarea: z.string(),
          indicador_iva: z.string(),
        })
        .partial(),
    )
    .optional(),
})

/** Campos críticos del payload recibido que no coinciden con el payload calculado. */
function diferenciasPayload(real: OrdenCompra, recibido: Record<string, unknown>): string[] {
  const parsed = CriticosSchema.safeParse(recibido)
  if (!parsed.success) return ["payload con formato inválido"]
  const r = parsed.data
  const difiere = (valor: unknown, esperado: unknown) => valor !== undefined && valor !== esperado
  const diferencias = [
    difiere(r.referencia?.solicitud_id, real.referencia.solicitud_id) && "referencia.solicitud_id",
    difiere(r.proveedor?.codigo_sap, real.proveedor.codigo_sap) && "proveedor.codigo_sap",
    difiere(r.proveedor?.nit, real.proveedor.nit) && "proveedor.nit",
    difiere(r.moneda, real.moneda) && "moneda",
    difiere(r.condiciones_pago, real.condiciones_pago) && "condiciones_pago",
  ]
  r.posiciones?.forEach((p, i) => {
    const esperada = real.posiciones[i]
    if (!esperada) return diferencias.push(`posiciones[${i}] no existe`)
    for (const campo of ["cantidad", "precio_unitario", "centro_costo", "subarea", "indicador_iva"] as const) {
      if (difiere(p[campo], esperada[campo])) diferencias.push(`posiciones[${i}].${campo}`)
    }
  })
  return diferencias.filter((d): d is string => Boolean(d))
}

const codigos = (hallazgos: Array<{ codigo: string }>) => hallazgos.map((h) => h.codigo)

function filaControl(
  { paquete, validacion }: Caso,
  resultado: FilaControl["resultado"],
  numeroOc: string | null = null,
): FilaControl {
  return {
    solicitud_id: paquete.solicitud.solicitud_id,
    resultado,
    numero_oc: numeroOc,
    retroactiva: validacion.retroactiva,
    bloqueos: codigos(validacion.bloqueos),
    confirmaciones: codigos(validacion.confirmaciones),
    ts: new Date().toISOString(),
  }
}

// ── Herramientas ────────────────────────────────────────────────────────────

export const leer_paquete = definirHerramienta({
  description:
    "Lee y normaliza el paquete de un caso (correo, solicitud, cotización, aprobación y factura si existe); lo que falte viene en null y se lista en faltantes.",
  args: { caso: argCaso },
  execute: ({ caso }, ctx) => responder(() => leerPaquete(ctx.directory, caso)),
})

export const validar = definirHerramienta({
  description:
    "Aplica las reglas de control RC1–RC10 contra los maestros y devuelve apta, bloqueos, confirmaciones, derivados, retroactiva y el estado de cada control.",
  args: { caso: argCaso, paquete: objetoOpcional("Paquete devuelto por oc_leer_paquete.") },
  execute: ({ caso, paquete }, ctx) =>
    responder(async () => {
      const preparado = await prepararCaso(ctx.directory, caso)
      if (!preparado.ok) return preparado
      const { validacion: v, paquete: real } = preparado.data
      if (v.apta && v.confirmaciones.length > 0) {
        confirmaciones.registrarPendiente(ctx.sessionId, caso, codigos(v.confirmaciones))
      }
      await guardarJson(path.join(rutaSalidaCaso(ctx.directory, caso), "validacion.json"), v)
      const alteraciones = diferenciasPaquete(real, paquete)
      return exito({
        caso,
        solicitud_id: real.solicitud.solicitud_id,
        ...v,
        ...(alteraciones.length ? { advertencias: [`Se ignoraron valores alterados: ${alteraciones.join(", ")}`] } : {}),
      })
    }),
})

export const construir_payload = definirHerramienta({
  description:
    "Construye la orden de compra exactamente como quedaría en SAP (validada con zod) y guarda su trazabilidad campo a campo en out/<caso>/trazabilidad.json.",
  args: {
    caso: argCaso,
    paquete: objetoOpcional("Paquete devuelto por oc_leer_paquete."),
    derivados: objetoOpcional("Derivados devueltos por oc_validar."),
  },
  execute: ({ caso }, ctx) =>
    responder(async () => {
      const preparado = await prepararCaso(ctx.directory, caso)
      if (!preparado.ok) return preparado
      const { paquete, validacion } = preparado.data
      if (!paquete.aprobacion) return fallo("No se puede construir la OC: falta la aprobación (RC2).")

      const hash = sha256(contenidoEvidencia(paquete.solicitud.solicitud_id, paquete.aprobacion))
      const construida = construirOrden(paquete, validacion, hash)
      if (!construida.ok) return fallo(construida.error, { bloqueos: validacion.bloqueos })

      const dir = rutaSalidaCaso(ctx.directory, caso)
      const rutaPayload = path.join(dir, "payload.json")
      const rutaTraza = path.join(dir, "trazabilidad.json")
      await guardarJson(rutaPayload, construida.data.orden)
      await guardarJson(rutaTraza, construida.data.trazabilidad)
      const total = totalOrden(construida.data.orden)
      return exito({
        orden: construida.data.orden,
        total,
        total_formateado: formatearMonto(total, construida.data.orden.moneda),
        confirmaciones_pendientes: codigos(validacion.confirmaciones),
        payload_ruta: relativa(ctx.directory, rutaPayload),
        trazabilidad_ruta: relativa(ctx.directory, rutaTraza),
        trazabilidad: construida.data.trazabilidad,
      })
    }),
})

export const generar_evidencia = definirHerramienta({
  description:
    "Genera la evidencia de aprobación (out/<caso>/aprobacion.txt y aprobacion.pdf) con encabezados, cuerpo y sha256 del contenido.",
  args: { caso: argCaso },
  execute: ({ caso }, ctx) =>
    responder(async () => {
      const paquete = await leerPaquete(ctx.directory, caso)
      if (!paquete.ok) return paquete
      const { aprobacion, solicitud } = paquete.data
      if (!aprobacion) return fallo("No hay correo de aprobación en el paquete: pídelo al solicitante.")
      const evidencia = await escribirEvidencia(rutaSalidaCaso(ctx.directory, caso), solicitud.solicitud_id, aprobacion)
      return exito({
        ruta: relativa(ctx.directory, evidencia.txt),
        ruta_pdf: relativa(ctx.directory, evidencia.pdf),
        sha256: evidencia.sha256,
      })
    }),
})

async function crearOrden(caso: string, payload: Record<string, unknown> | undefined, confirmado: boolean, ctx: ContextoHerramienta): Promise<Resultado<unknown>> {
  const raiz = ctx.directory
  const dirSalida = rutaSalida(raiz)
  const preparado = await prepararCaso(raiz, caso)
  if (!preparado.ok) return preparado
  const datos = preparado.data
  const { paquete, validacion } = datos
  const sap = crearSap(raiz)

  // Idempotencia: la misma solicitud nunca genera dos OC
  const existente = await sap.buscarOrdenPorReferencia(paquete.solicitud.solicitud_id)
  if (existente) {
    await registrarControl(dirSalida, filaControl(datos, "existente", existente.numero_oc))
    const fecha = "fecha" in existente && typeof existente.fecha === "string" ? existente.fecha : null
    return exito({ numero_oc: existente.numero_oc, fecha, idempotente: true, mensaje: "La OC ya existía para esta solicitud." })
  }

  if (!validacion.apta) {
    await registrarControl(dirSalida, filaControl(datos, "bloqueada"))
    return fallo(`OC no creada: ${validacion.bloqueos.length} bloqueo(s). Devolver al humano con la acción sugerida.`, {
      resultado: "bloqueada",
      bloqueos: validacion.bloqueos,
    })
  }

  if (!paquete.aprobacion) return fallo("OC no creada: falta la aprobación.")
  const evidencia = await escribirEvidencia(rutaSalidaCaso(raiz, caso), paquete.solicitud.solicitud_id, paquete.aprobacion)
  const construida = construirOrden(paquete, validacion, evidencia.sha256)
  if (!construida.ok) return construida

  const alteraciones = payload ? diferenciasPayload(construida.data.orden, payload) : []
  if (alteraciones.length) {
    await registrarControl(dirSalida, filaControl(datos, "rechazada"))
    return fallo(`OC no creada: el payload recibido no coincide con el validado (${alteraciones.join(", ")}). Usa el de oc_construir_payload sin modificarlo.`)
  }

  if (validacion.confirmaciones.length > 0) {
    const humanoConfirmo = !confirmaciones.confirmacionEstricta() || confirmaciones.estaOtorgada(ctx.sessionId, caso)
    if (!confirmado || !humanoConfirmo) {
      confirmaciones.registrarPendiente(ctx.sessionId, caso, codigos(validacion.confirmaciones))
      await registrarControl(dirSalida, filaControl(datos, "pendiente_confirmacion"))
      return fallo(
        confirmado
          ? "OC no creada: el usuario todavía no ha confirmado en el chat. Termina el turno con la pregunta de confirmación."
          : "OC no creada: requiere confirmación humana. Termina el turno preguntando al usuario si confirma cada excepción.",
        { resultado: "pendiente_confirmacion", requiere_confirmacion: true, confirmaciones: validacion.confirmaciones },
      )
    }
  }

  const confirmadoPor = validacion.confirmaciones.length ? `analista (sesión ${ctx.sessionId})` : null
  const orden: OrdenCompra = {
    ...construida.data.orden,
    excepciones: construida.data.orden.excepciones.map((e) => ({ ...e, confirmado_por: confirmadoPor })),
  }
  const creada = await sap.crearOrden(orden)
  confirmaciones.cerrar(ctx.sessionId, caso)
  await guardarJson(path.join(rutaSalidaCaso(raiz, caso), "payload.json"), orden)
  await registrarControl(dirSalida, filaControl(datos, "creada", creada.numero_oc))
  return exito({
    numero_oc: creada.numero_oc,
    fecha: creada.fecha,
    idempotente: false,
    retroactiva: validacion.retroactiva,
    total_formateado: formatearMonto(totalOrden(orden), orden.moneda),
    excepciones_confirmadas: codigos(orden.excepciones),
    evidencia: { ruta: relativa(raiz, evidencia.txt), ruta_pdf: relativa(raiz, evidencia.pdf), sha256: evidencia.sha256 },
  })
}

export const crear = definirHerramienta({
  description:
    "Crea la OC en SAP (simulado) solo si es apta y, si tiene confirmaciones, el usuario las confirmó; es idempotente por solicitud_id y registra cada intento en out/control.csv.",
  args: {
    caso: argCaso,
    payload: objetoOpcional("Orden devuelta por oc_construir_payload, sin modificar."),
    confirmado: z
      .boolean()
      .optional()
      .describe("true solo si el usuario confirmó explícitamente las excepciones en su último mensaje."),
  },
  execute: ({ caso, payload, confirmado }, ctx) =>
    responder(() => enSerie(() => crearOrden(caso, payload, confirmado === true, ctx))),
})
