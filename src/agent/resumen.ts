// Resumen de una línea por llamada a herramienta, para el historial visible del chat.

function obtener(datos: unknown, ruta: string): unknown {
  return ruta.split(".").reduce<unknown>((actual, clave) => {
    if (typeof actual !== "object" || actual === null) return undefined
    return (actual as Record<string, unknown>)[clave]
  }, datos)
}

const largo = (valor: unknown) => (Array.isArray(valor) ? valor.length : 0)
const texto = (valor: unknown) => (valor === undefined || valor === null ? "—" : String(valor))

const RESUMENES: Record<string, (data: unknown) => string> = {
  oc_leer_paquete: (d) => {
    const faltantes = obtener(d, "faltantes")
    const faltan = Array.isArray(faltantes) && faltantes.length ? ` · faltan: ${faltantes.join(", ")}` : ""
    return `${texto(obtener(d, "solicitud.solicitud_id"))} · ${texto(obtener(d, "solicitud.proveedor_nombre"))}${obtener(d, "factura") ? " · trae factura" : ""}${faltan}`
  },
  oc_validar: (d) =>
    `apta=${texto(obtener(d, "apta"))} · ${largo(obtener(d, "bloqueos"))} bloqueo(s) · ${largo(obtener(d, "confirmaciones"))} confirmación(es)${obtener(d, "retroactiva") ? " · RETROACTIVA" : ""}`,
  oc_construir_payload: (d) => `total ${texto(obtener(d, "total_formateado"))} · ${texto(obtener(d, "trazabilidad_ruta"))}`,
  oc_generar_evidencia: (d) => `${texto(obtener(d, "ruta_pdf"))} · sha256 ${texto(obtener(d, "sha256")).slice(0, 12)}…`,
  oc_crear: (d) =>
    obtener(d, "idempotente") ? `OC ${texto(obtener(d, "numero_oc"))} (ya existía)` : `OC ${texto(obtener(d, "numero_oc"))} creada`,
}

export function resumirResultado(nombre: string, resultado: string): { ok: boolean; resumen: string; datos: unknown } {
  let parsed: unknown
  try {
    parsed = JSON.parse(resultado)
  } catch {
    return { ok: false, resumen: "respuesta no JSON", datos: resultado }
  }
  if (obtener(parsed, "ok") !== true) {
    const error = texto(obtener(parsed, "error")).split("\n")[0] ?? ""
    return { ok: false, resumen: error, datos: parsed }
  }
  const data = obtener(parsed, "data")
  return { ok: true, resumen: RESUMENES[nombre]?.(data) ?? "ok", datos: data }
}
