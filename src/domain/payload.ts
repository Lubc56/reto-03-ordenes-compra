import { MAX_DESCRIPCION_SAP, ORGANIZACION_COMPRAS, PASO_POSICION, SOCIEDAD } from "./reglas"
import { OrdenCompraSchema, type OrdenCompra, type Paquete } from "./tipos"
import { exito, fallo, type Resultado } from "./util"
import type { Validacion } from "./validacion"
import { z } from "zod"

export type Fuente =
  | "solicitud"
  | "cotizacion"
  | "correo"
  | "aprobacion"
  | "evidencia"
  | "maestro.proveedores"
  | "derivado"

export type Traza = { campo: string; valor: string | number | null; fuente: Fuente; detalle?: string }

type Unidad = OrdenCompra["posiciones"][number]["unidad"]

/** Texto breve SAP: corta en límite de palabra sin superar 40 caracteres. */
export function textoBreve(descripcion: string, maximo = MAX_DESCRIPCION_SAP): string {
  const limpio = descripcion.replace(/\s+/g, " ").trim()
  if (limpio.length <= maximo) return limpio
  const corte = limpio.slice(0, maximo + 1)
  const ultimoEspacio = corte.lastIndexOf(" ")
  const cortado = ultimoEspacio > maximo / 2 ? corte.slice(0, ultimoEspacio) : limpio.slice(0, maximo)
  // Sin conectores colgantes: "…de arquitectura de" → "…de arquitectura"
  return cortado.replace(/[,;:\s]+$/, "").replace(/(\s+(de|del|la|las|el|los|para|por|con|en|y|a))+$/i, "")
}

/** Horas → H; mensualidades → MES; el resto, unidades. */
export function derivarUnidad(descripcion: string): Unidad {
  if (/\bhoras?\b/i.test(descripcion)) return "H"
  if (/\b(mensual(idad)?(es)?|por mes)\b/i.test(descripcion)) return "MES"
  return "UN"
}

/** HU-3: payload de la OC con trazabilidad campo a campo. Solo se construye si la validación es apta. */
export function construirOrden(
  paquete: Paquete,
  validacion: Validacion,
  evidenciaSha256: string,
): Resultado<{ orden: OrdenCompra; trazabilidad: Traza[] }> {
  if (!validacion.apta || !validacion.proveedor) {
    return fallo(
      `No se construye la OC: hay ${validacion.bloqueos.length} bloqueo(s): ${validacion.bloqueos.map((b) => b.codigo).join(", ")}.`,
    )
  }
  const { solicitud: s, correo, cotizacion, aprobacion } = paquete
  if (!aprobacion) return fallo("No se construye la OC: falta la aprobación.")

  const d = validacion.derivados
  const indicadorIva = s.indicador_iva ?? d.indicador_iva?.valor
  const condicionesPago = s.condiciones_pago ?? d.condiciones_pago?.valor
  if (!indicadorIva || !condicionesPago) return fallo("No se construye la OC: falta indicador de IVA o condiciones de pago.")

  const descripcion = textoBreve(s.descripcion)
  const unidad = derivarUnidad(s.descripcion)

  const borrador = {
    referencia: { solicitud_id: s.solicitud_id, correo_id: correo.id, cotizacion_ref: cotizacion?.numero ?? null },
    sociedad: SOCIEDAD,
    organizacion_compras: ORGANIZACION_COMPRAS,
    proveedor: validacion.proveedor,
    moneda: s.moneda,
    condiciones_pago: condicionesPago,
    aprobador: { email: aprobacion.de, fecha_aprobacion: aprobacion.fecha, evidencia_sha256: evidenciaSha256 },
    posiciones: [
      {
        numero: PASO_POSICION,
        descripcion,
        cantidad: s.cantidad,
        unidad,
        precio_unitario: s.valor_unitario,
        centro_costo: s.centro_costo,
        subarea: s.subarea,
        indicador_iva: indicadorIva,
      },
    ],
    excepciones: validacion.confirmaciones.map((c) => ({ codigo: c.codigo, detalle: c.mensaje, confirmado_por: null })),
  }

  const parsed = OrdenCompraSchema.safeParse(borrador)
  if (!parsed.success) return fallo(`El payload no cumple el esquema de OC:\n${z.prettifyError(parsed.error)}`)

  const traza = (campo: string, valor: Traza["valor"], fuente: Fuente, detalle?: string): Traza =>
    detalle ? { campo, valor, fuente, detalle } : { campo, valor, fuente }
  const fuenteDe = (informado: boolean): Fuente => (informado ? "solicitud" : "maestro.proveedores")

  const trazabilidad: Traza[] = [
    traza("referencia.solicitud_id", s.solicitud_id, "solicitud"),
    traza("referencia.correo_id", correo.id, "correo"),
    traza("referencia.cotizacion_ref", cotizacion?.numero ?? null, "cotizacion"),
    traza("sociedad", SOCIEDAD, "derivado", "constante de configuración (src/domain/reglas.ts)"),
    traza("organizacion_compras", ORGANIZACION_COMPRAS, "derivado", "constante de configuración (src/domain/reglas.ts)"),
    traza("proveedor.codigo_sap", validacion.proveedor.codigo_sap, "maestro.proveedores"),
    traza("proveedor.nit", validacion.proveedor.nit, "maestro.proveedores", s.proveedor_nit ? "coincide con la solicitud" : "la solicitud no traía NIT"),
    traza("proveedor.nombre", validacion.proveedor.nombre, "maestro.proveedores"),
    traza("moneda", s.moneda, "solicitud"),
    traza("condiciones_pago", condicionesPago, fuenteDe(Boolean(s.condiciones_pago)), s.condiciones_pago ? undefined : "RC7: derivado del proveedor"),
    traza("aprobador.email", aprobacion.de, "aprobacion"),
    traza("aprobador.fecha_aprobacion", aprobacion.fecha, "aprobacion"),
    traza("aprobador.evidencia_sha256", evidenciaSha256, "evidencia", "sha256 del correo de aprobación"),
    traza("posiciones[0].numero", PASO_POSICION, "derivado", "primera posición"),
    traza("posiciones[0].descripcion", descripcion, "solicitud", descripcion === s.descripcion ? undefined : `truncada a ${MAX_DESCRIPCION_SAP} caracteres desde: "${s.descripcion}"`),
    traza("posiciones[0].cantidad", s.cantidad, "solicitud"),
    traza("posiciones[0].unidad", unidad, "derivado", "regla de unidad por texto de la descripción"),
    traza("posiciones[0].precio_unitario", s.valor_unitario, "solicitud", "valor_unitario (el aprobado)"),
    traza("posiciones[0].centro_costo", s.centro_costo, "solicitud"),
    traza("posiciones[0].subarea", s.subarea, "solicitud"),
    traza("posiciones[0].indicador_iva", indicadorIva, fuenteDe(Boolean(s.indicador_iva)), s.indicador_iva ? undefined : "RC6: derivado del proveedor, requiere confirmación"),
  ]

  return exito({ orden: parsed.data, trazabilidad })
}

export const totalOrden = (orden: OrdenCompra) =>
  orden.posiciones.reduce((suma, p) => suma + p.cantidad * p.precio_unitario, 0)
