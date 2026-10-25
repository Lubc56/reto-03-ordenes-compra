// Parámetros de negocio. Cambiar una política (tolerancias, sociedad, numeración)
// se hace aquí, sin tocar herramientas ni servidor.

export const TOLERANCIA_COTIZACION = 0.02 // RC5: 2 % entre cotización y solicitud
export const TOLERANCIA_TOTAL = 1 // RC10: ± 1 unidad monetaria en cantidad × valor_unitario

export const SOCIEDAD = "1000"
export const ORGANIZACION_COMPRAS = "1000"

export const MAX_DESCRIPCION_SAP = 40 // texto breve de la posición en SAP
export const PASO_POSICION = 10 // posiciones 10, 20, 30…

export const NUMERO_OC_INICIAL = 4500000001

// RC6/RC7: de dónde se derivan los valores ausentes
export const FUENTE_DERIVADOS = "maestro.proveedores" as const
