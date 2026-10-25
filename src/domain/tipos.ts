import { z } from "zod"
import { MAX_DESCRIPCION_SAP, ORGANIZACION_COMPRAS, PASO_POSICION, SOCIEDAD } from "./reglas"

// Mensajes de validación de zod en español
z.config(z.locales.es())

const fechaISO = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "fecha en formato AAAA-MM-DD")

export const MonedaSchema = z.enum(["COP", "USD"])

// ── Archivos de entrada (fixtures) ──────────────────────────────────────────

export const CorreoArchivoSchema = z.object({
  id: z.string().min(1),
  de: z.string().min(1),
  asunto: z.string(),
  fecha: z.string().min(1),
  cuerpo: z.string(),
  adjuntos: z.array(z.string()),
})

export const SolicitudSchema = z.object({
  solicitud_id: z.string().min(1),
  solicitante: z.string().min(1),
  proveedor_nombre: z.string().min(1),
  proveedor_nit: z.string().min(1).optional(),
  descripcion: z.string().min(1),
  centro_costo: z.string().min(1),
  subarea: z.string().min(1),
  cantidad: z.number().positive(),
  valor_unitario: z.number().nonnegative(),
  valor_total: z.number().positive(),
  moneda: MonedaSchema,
  indicador_iva: z.string().min(1).optional(),
  condiciones_pago: z.string().min(1).optional(),
  fecha_solicitud: fechaISO,
})
export type Solicitud = z.infer<typeof SolicitudSchema>

export const AprobacionArchivoSchema = z.object({
  de: z.string().min(1),
  para: z.string(),
  cc: z.array(z.string()).optional(),
  fecha: z.string().min(1),
  asunto: z.string(),
  cuerpo: z.string(),
})

// ── Maestros ────────────────────────────────────────────────────────────────

export const ProveedorSchema = z.object({
  codigo_sap: z.string(),
  nit: z.string(),
  nombre: z.string(),
  condiciones_pago_default: z.string(),
  indicador_iva_default: z.string(),
  activo: z.boolean(),
})
export type Proveedor = z.infer<typeof ProveedorSchema>

export const AprobadorSchema = z.object({
  email: z.string(),
  nombre: z.string().optional(),
  tope: z.number(),
})
export type Aprobador = z.infer<typeof AprobadorSchema>

export const CentroCostoSchema = z.object({
  centro_costo: z.string(),
  nombre: z.string().optional(),
  subareas: z.array(z.string()),
  aprobadores: z.array(AprobadorSchema),
})
export type CentroCosto = z.infer<typeof CentroCostoSchema>

export const IndicadorIvaSchema = z.object({ codigo: z.string(), descripcion: z.string(), tasa: z.number() })
export type IndicadorIva = z.infer<typeof IndicadorIvaSchema>

export const CondicionPagoSchema = z.object({ codigo: z.string(), descripcion: z.string(), dias: z.number() })
export type CondicionPago = z.infer<typeof CondicionPagoSchema>

export type Maestros = {
  proveedores: Proveedor[]
  centros: CentroCosto[]
  indicadoresIva: IndicadorIva[]
  condicionesPago: CondicionPago[]
}

// ── Paquete normalizado (PRD 7.2) ───────────────────────────────────────────

export const PaqueteSchema = z.object({
  correo: z.object({ id: z.string(), de: z.string(), asunto: z.string(), fecha: z.string() }),
  solicitud: SolicitudSchema,
  cotizacion: z
    .object({
      numero: z.string().nullable(),
      fecha: z.string().nullable(),
      proveedor: z.string(),
      nit: z.string().nullable(),
      total: z.number(),
      moneda: z.string(),
      iva_tasa: z.number().nullable(),
      validez_hasta: z.string().nullable(),
      texto: z.string(),
    })
    .nullable(),
  aprobacion: z
    .object({
      de: z.string(),
      para: z.string(),
      cc: z.array(z.string()),
      asunto: z.string(),
      fecha: z.string(),
      aprobado: z.boolean(),
      texto: z.string(),
    })
    .nullable(),
  factura: z.object({ numero: z.string(), fecha: z.string(), total: z.number() }).nullable(),
  faltantes: z.array(z.string()),
})
export type Paquete = z.infer<typeof PaqueteSchema>

// ── Orden de compra (PRD 7.4) ───────────────────────────────────────────────

export const PosicionSchema = z.object({
  numero: z.number().int().positive().multipleOf(PASO_POSICION),
  descripcion: z.string().min(1).max(MAX_DESCRIPCION_SAP),
  cantidad: z.number().positive(),
  unidad: z.enum(["UN", "H", "MES"]),
  precio_unitario: z.number().nonnegative(),
  centro_costo: z.string().min(1),
  subarea: z.string().min(1),
  indicador_iva: z.string().min(1),
})

export const OrdenCompraSchema = z.object({
  referencia: z.object({
    solicitud_id: z.string().min(1),
    correo_id: z.string().min(1),
    cotizacion_ref: z.string().nullable(),
  }),
  sociedad: z.literal(SOCIEDAD),
  organizacion_compras: z.literal(ORGANIZACION_COMPRAS),
  proveedor: z.object({ codigo_sap: z.string().min(1), nit: z.string().min(1), nombre: z.string().min(1) }),
  moneda: MonedaSchema,
  condiciones_pago: z.string().min(1),
  aprobador: z.object({
    email: z.string().min(1),
    fecha_aprobacion: z.string().min(1),
    evidencia_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  posiciones: z.array(PosicionSchema).min(1),
  excepciones: z.array(
    z.object({ codigo: z.string(), detalle: z.string(), confirmado_por: z.string().nullable() }),
  ),
})
export type OrdenCompra = z.infer<typeof OrdenCompraSchema>
