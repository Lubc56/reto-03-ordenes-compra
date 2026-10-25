import { buscarProveedor, type BusquedaProveedor } from "./maestros"
import { FUENTE_DERIVADOS, TOLERANCIA_COTIZACION, TOLERANCIA_TOTAL } from "./reglas"
import type { Aprobador, CentroCosto, Maestros, Paquete } from "./tipos"
import { formatearMonto, normalizarTexto, soloFecha } from "./util"

export type CodigoRegla = "RC1" | "RC2" | "RC3" | "RC4" | "RC5" | "RC6" | "RC7" | "RC8" | "RC9" | "RC10"
export type Estado = "ok" | "bloqueo" | "confirmacion" | "derivado" | "no_aplica"

export type Hallazgo = {
  regla: CodigoRegla
  codigo: string
  mensaje: string
  accion_sugerida: string
  valores?: Record<string, string | number | null>
}

export type Derivado = { valor: string; descripcion: string; fuente: typeof FUENTE_DERIVADOS; motivo: string }
export type Derivados = { indicador_iva?: Derivado; condiciones_pago?: Derivado; proveedor_nit?: Derivado }

export type Control = { regla: CodigoRegla; descripcion: string; estado: Estado; detalle: string }

export type Validacion = {
  apta: boolean
  bloqueos: Hallazgo[]
  confirmaciones: Hallazgo[]
  derivados: Derivados
  retroactiva: boolean
  controles: Control[]
  proveedor: { codigo_sap: string; nit: string; nombre: string } | null
}

type Contexto = {
  paquete: Paquete
  maestros: Maestros
  busqueda: BusquedaProveedor
  centro: CentroCosto | null
  aprobador: Aprobador | null // aprobador del correo, solo si está autorizado en el centro
}

type Evaluacion = {
  estado: Estado
  detalle: string
  hallazgo?: Omit<Hallazgo, "regla">
  derivado?: { campo: keyof Derivados; valor: Derivado }
}

const ok = (detalle: string): Evaluacion => ({ estado: "ok", detalle })
const noAplica = (detalle: string): Evaluacion => ({ estado: "no_aplica", detalle })
const bloqueo = (hallazgo: Omit<Hallazgo, "regla">): Evaluacion => ({ estado: "bloqueo", detalle: hallazgo.mensaje, hallazgo })
const confirmacion = (hallazgo: Omit<Hallazgo, "regla">): Evaluacion => ({
  estado: "confirmacion",
  detalle: hallazgo.mensaje,
  hallazgo,
})

const mismoEmail = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()
const listarAprobadores = (aprobadores: Aprobador[]) =>
  aprobadores.map((a) => `${a.nombre ?? a.email} <${a.email}> (tope ${formatearMonto(a.tope)})`).join("; ")

// ── Reglas ──────────────────────────────────────────────────────────────────

function rc1Proveedor({ paquete, busqueda }: Contexto): Evaluacion {
  const s = paquete.solicitud
  if (!busqueda) {
    const id = s.proveedor_nit ? `NIT ${s.proveedor_nit}` : `nombre "${s.proveedor_nombre}"`
    return bloqueo({
      codigo: "PROVEEDOR_NO_EXISTE",
      mensaje: `El proveedor ${s.proveedor_nombre} (${id}) no existe en el maestro de proveedores.`,
      accion_sugerida:
        "Solicitar a Maestros la creación del proveedor en SAP (RUT y certificación bancaria) o confirmar con el solicitante si debe usarse un proveedor ya registrado.",
      valores: { proveedor: s.proveedor_nombre, nit: s.proveedor_nit ?? null },
    })
  }
  const p = busqueda.proveedor
  if (!p.activo) {
    return bloqueo({
      codigo: "PROVEEDOR_INACTIVO",
      mensaje: `El proveedor ${p.nombre} (código SAP ${p.codigo_sap}) está inactivo.`,
      accion_sugerida: "Pedir a Maestros la reactivación del proveedor o elegir un proveedor activo con nueva cotización.",
      valores: { codigo_sap: p.codigo_sap },
    })
  }
  return ok(`${p.nombre} · código SAP ${p.codigo_sap} · encontrado por ${busqueda.criterio}`)
}

function rc2Aprobacion({ paquete, centro, aprobador, maestros }: Contexto): Evaluacion {
  const a = paquete.aprobacion
  if (!a) {
    return bloqueo({
      codigo: "APROBACION_AUSENTE",
      mensaje: "El paquete no trae el correo de aprobación del líder.",
      accion_sugerida: "Pedir al solicitante que reenvíe el correo de aprobación del líder del centro de costo.",
    })
  }
  if (!a.aprobado) {
    return bloqueo({
      codigo: "APROBACION_NO_EXPLICITA",
      mensaje: `El correo de ${a.de} no contiene una aprobación explícita ("Aprobado").`,
      accion_sugerida: "Solicitar al líder una respuesta explícita con la palabra \"Aprobado\".",
    })
  }
  if (!centro) return noAplica("No se puede verificar: el centro de costo no existe (ver RC4).")
  if (aprobador) return ok(`Aprobado por ${aprobador.nombre ?? aprobador.email}, aprobador de ${centro.centro_costo}`)

  const otrosCentros = maestros.centros
    .filter((c) => c.aprobadores.some((ap) => mismoEmail(ap.email, a.de)))
    .map((c) => `${c.centro_costo} (${c.nombre ?? ""})`)
  const pista = otrosCentros.length
    ? ` Ese aprobador sí está autorizado en ${otrosCentros.join(", ")}: verificar si la compra pertenece a ese centro de costo.`
    : ""
  return bloqueo({
    codigo: "APROBADOR_NO_AUTORIZADO",
    mensaje: `${a.de} no es aprobador del centro ${centro.centro_costo} (${centro.nombre ?? ""}).`,
    accion_sugerida: `Solicitar la aprobación a un aprobador de ${centro.centro_costo}: ${listarAprobadores(centro.aprobadores)}.${pista}`,
    valores: { aprobador: a.de, centro_costo: centro.centro_costo },
  })
}

function rc3Tope({ paquete, centro, aprobador }: Contexto): Evaluacion {
  const total = paquete.solicitud.valor_total
  const moneda = paquete.solicitud.moneda
  if (!centro) return noAplica("Centro de costo inexistente (ver RC4).")
  const conTope = centro.aprobadores.filter((ap) => ap.tope >= total)

  if (!aprobador) {
    if (conTope.length > 0) return noAplica("El aprobador no está autorizado en el centro (ver RC2).")
    const maximo = Math.max(...centro.aprobadores.map((ap) => ap.tope))
    return bloqueo({
      codigo: "MONTO_SIN_APROBADOR_CON_TOPE",
      mensaje: `Ningún aprobador de ${centro.centro_costo} tiene tope para ${formatearMonto(total, moneda)} (máximo ${formatearMonto(maximo, moneda)}).`,
      accion_sugerida: "Escalar a la dirección para una aprobación extraordinaria o revisar el centro de costo imputado.",
      valores: { valor_total: total, tope_maximo: maximo },
    })
  }
  if (total > aprobador.tope) {
    return bloqueo({
      codigo: "MONTO_SUPERA_TOPE",
      mensaje: `${formatearMonto(total, moneda)} supera el tope de ${aprobador.email} (${formatearMonto(aprobador.tope, moneda)}).`,
      accion_sugerida: conTope.length
        ? `Solicitar la aprobación a: ${listarAprobadores(conTope)}.`
        : "Escalar a la dirección: ningún aprobador del centro cubre el monto.",
      valores: { valor_total: total, tope: aprobador.tope },
    })
  }
  return ok(`${formatearMonto(total, moneda)} ≤ tope ${formatearMonto(aprobador.tope, moneda)} de ${aprobador.email}`)
}

function rc4Subarea({ paquete, centro, maestros }: Contexto): Evaluacion {
  const s = paquete.solicitud
  if (!centro) {
    return bloqueo({
      codigo: "CENTRO_COSTO_NO_EXISTE",
      mensaje: `El centro de costo ${s.centro_costo} no existe en el maestro.`,
      accion_sugerida: `Confirmar con el solicitante el centro correcto. Centros válidos: ${maestros.centros.map((c) => c.centro_costo).join(", ")}.`,
    })
  }
  const pertenece = centro.subareas.some((sa) => normalizarTexto(sa) === normalizarTexto(s.subarea))
  if (!pertenece) {
    return bloqueo({
      codigo: "SUBAREA_INVALIDA",
      mensaje: `La subárea "${s.subarea}" no pertenece a ${centro.centro_costo}.`,
      accion_sugerida: `Corregir la subárea con el solicitante. Subáreas de ${centro.centro_costo}: ${centro.subareas.join(", ")}.`,
    })
  }
  return ok(`${s.subarea} pertenece a ${centro.centro_costo} (${centro.nombre ?? ""})`)
}

function rc5Cotizacion({ paquete }: Contexto): Evaluacion {
  const s = paquete.solicitud
  const c = paquete.cotizacion
  if (!c) {
    return confirmacion({
      codigo: "COTIZACION_AUSENTE",
      mensaje: "El paquete no trae cotización del proveedor.",
      accion_sugerida: "Confirmar que se crea la OC sin cotización o pedir la cotización al solicitante.",
    })
  }
  const diferencia = Math.abs(c.total - s.valor_total) / s.valor_total
  const porcentaje = Math.round(diferencia * 10000) / 100
  if (diferencia > TOLERANCIA_COTIZACION) {
    return confirmacion({
      codigo: "DIFERENCIA_COTIZACION",
      mensaje: `La cotización (${formatearMonto(c.total, c.moneda)}) difiere ${porcentaje} % de la solicitud (${formatearMonto(s.valor_total, s.moneda)}); el máximo es ${TOLERANCIA_COTIZACION * 100} %.`,
      accion_sugerida:
        "Confirmar que la OC se crea por el valor de la solicitud (el aprobado) o pedir al solicitante que ajuste la solicitud y la aprobación al valor cotizado.",
      valores: {
        valor_solicitud: s.valor_total,
        valor_cotizacion: c.total,
        diferencia: c.total - s.valor_total,
        porcentaje,
      },
    })
  }
  return ok(`Cotización ${formatearMonto(c.total, c.moneda)} vs solicitud ${formatearMonto(s.valor_total, s.moneda)} (${porcentaje} %)`)
}

function rc6Iva({ paquete, maestros, busqueda }: Contexto): Evaluacion {
  const indicador = paquete.solicitud.indicador_iva
  if (indicador) {
    const existe = maestros.indicadoresIva.find((i) => i.codigo === indicador)
    if (existe) return ok(`${indicador} (${existe.descripcion}) informado en la solicitud`)
    return bloqueo({
      codigo: "INDICADOR_IVA_INVALIDO",
      mensaje: `El indicador de IVA ${indicador} no existe en el maestro.`,
      accion_sugerida: `Corregir el indicador. Válidos: ${maestros.indicadoresIva.map((i) => `${i.codigo} (${i.descripcion})`).join(", ")}.`,
    })
  }
  if (!busqueda) return noAplica("No informado y no derivable: proveedor no identificado (ver RC1).")

  const codigo = busqueda.proveedor.indicador_iva_default
  const maestro = maestros.indicadoresIva.find((i) => i.codigo === codigo)
  const descripcion = maestro?.descripcion ?? codigo
  const tasaCotizacion = paquete.cotizacion?.iva_tasa ?? null
  const coincide = maestro && tasaCotizacion !== null ? Math.round(maestro.tasa * 100) === tasaCotizacion : null
  const nota =
    coincide === null ? "" : coincide ? ` La cotización informa IVA ${tasaCotizacion} %, consistente.` : ` Ojo: la cotización informa IVA ${tasaCotizacion} %.`
  return {
    ...confirmacion({
      codigo: "IVA_DERIVADO",
      mensaje: `La solicitud no informa indicador de IVA; se deriva del proveedor ${busqueda.proveedor.nombre} el indicador ${codigo} (${descripcion}).${nota}`,
      accion_sugerida: `Confirmar el indicador ${codigo} o indicar el correcto.`,
      valores: { indicador_derivado: codigo, iva_cotizacion: tasaCotizacion },
    }),
    derivado: {
      campo: "indicador_iva",
      valor: { valor: codigo, descripcion, fuente: FUENTE_DERIVADOS, motivo: "indicador_iva ausente en la solicitud" },
    },
  }
}

function rc7CondicionesPago({ paquete, maestros, busqueda }: Contexto): Evaluacion {
  const codigo = paquete.solicitud.condiciones_pago
  if (codigo) {
    const existe = maestros.condicionesPago.find((c) => c.codigo === codigo)
    if (existe) return ok(`${codigo} (${existe.descripcion}) informado en la solicitud`)
    return bloqueo({
      codigo: "CONDICION_PAGO_INVALIDA",
      mensaje: `La condición de pago ${codigo} no existe en el maestro.`,
      accion_sugerida: `Corregir la condición. Válidas: ${maestros.condicionesPago.map((c) => `${c.codigo} (${c.descripcion})`).join(", ")}.`,
    })
  }
  if (!busqueda) return noAplica("No informada y no derivable: proveedor no identificado (ver RC1).")

  const derivada = busqueda.proveedor.condiciones_pago_default
  const descripcion = maestros.condicionesPago.find((c) => c.codigo === derivada)?.descripcion ?? derivada
  return {
    estado: "derivado",
    detalle: `No informada; se deriva ${derivada} (${descripcion}) del proveedor. Solo se informa.`,
    derivado: {
      campo: "condiciones_pago",
      valor: { valor: derivada, descripcion, fuente: FUENTE_DERIVADOS, motivo: "condiciones_pago ausente en la solicitud" },
    },
  }
}

function rc8Retroactiva({ paquete }: Contexto): Evaluacion {
  const f = paquete.factura
  const fechaSolicitud = paquete.solicitud.fecha_solicitud
  if (!f) return ok("Sin factura en el paquete")
  if (f.fecha >= fechaSolicitud) return ok(`Factura ${f.numero} (${f.fecha}) posterior a la solicitud`)
  return confirmacion({
    codigo: "OC_RETROACTIVA",
    mensaje: `La factura ${f.numero} (${f.fecha}) es anterior a la solicitud (${fechaSolicitud}): la OC se crea después de recibir la factura.`,
    accion_sugerida:
      "Confirmar la creación para permitir la radicación de la factura. Quedará marcada retroactiva = true en control.csv para medición.",
    valores: { factura: f.numero, fecha_factura: f.fecha, fecha_solicitud: fechaSolicitud },
  })
}

function rc9FechaAprobacion({ paquete }: Contexto): Evaluacion {
  const a = paquete.aprobacion
  const fechaSolicitud = paquete.solicitud.fecha_solicitud
  if (!a) return noAplica("Sin aprobación (ver RC2).")
  const fechaAprobacion = soloFecha(a.fecha)
  if (fechaAprobacion >= fechaSolicitud) return ok(`Aprobación ${fechaAprobacion} ≥ solicitud ${fechaSolicitud}`)
  return confirmacion({
    codigo: "APROBACION_ANTERIOR_A_SOLICITUD",
    mensaje: `La aprobación (${fechaAprobacion}) es anterior a la fecha de la solicitud (${fechaSolicitud}).`,
    accion_sugerida: "Confirmar que la aprobación corresponde a esta solicitud o pedir una aprobación actualizada.",
    valores: { fecha_aprobacion: fechaAprobacion, fecha_solicitud: fechaSolicitud },
  })
}

function rc10Total({ paquete }: Contexto): Evaluacion {
  const s = paquete.solicitud
  const calculado = s.cantidad * s.valor_unitario
  if (Math.abs(calculado - s.valor_total) <= TOLERANCIA_TOTAL) {
    return ok(`${s.cantidad} × ${formatearMonto(s.valor_unitario, s.moneda)} = ${formatearMonto(s.valor_total, s.moneda)}`)
  }
  return bloqueo({
    codigo: "VALOR_TOTAL_INCONSISTENTE",
    mensaje: `cantidad × valor_unitario = ${formatearMonto(calculado, s.moneda)}, pero valor_total = ${formatearMonto(s.valor_total, s.moneda)}.`,
    accion_sugerida: "Pedir al solicitante que corrija el Excel de solicitud (cantidad, valor unitario o total).",
    valores: { calculado, valor_total: s.valor_total },
  })
}

const REGLAS: Array<{ regla: CodigoRegla; descripcion: string; evaluar: (c: Contexto) => Evaluacion }> = [
  { regla: "RC1", descripcion: "Proveedor existe y está activo", evaluar: rc1Proveedor },
  { regla: "RC2", descripcion: "Aprobación explícita de un aprobador del centro", evaluar: rc2Aprobacion },
  { regla: "RC3", descripcion: "Valor dentro del tope del aprobador", evaluar: rc3Tope },
  { regla: "RC4", descripcion: "Subárea pertenece al centro de costo", evaluar: rc4Subarea },
  { regla: "RC5", descripcion: "Cotización vs solicitud ≤ 2 %", evaluar: rc5Cotizacion },
  { regla: "RC6", descripcion: "Indicador de IVA", evaluar: rc6Iva },
  { regla: "RC7", descripcion: "Condiciones de pago", evaluar: rc7CondicionesPago },
  { regla: "RC8", descripcion: "Factura anterior a la solicitud (retroactiva)", evaluar: rc8Retroactiva },
  { regla: "RC9", descripcion: "Aprobación posterior a la solicitud", evaluar: rc9FechaAprobacion },
  { regla: "RC10", descripcion: "cantidad × valor unitario = valor total", evaluar: rc10Total },
]

function construirContexto(paquete: Paquete, maestros: Maestros): Contexto {
  const s = paquete.solicitud
  const busqueda = buscarProveedor(maestros, s.proveedor_nit, s.proveedor_nombre)
  const centro = maestros.centros.find((c) => c.centro_costo === s.centro_costo) ?? null
  const correoAprobador = paquete.aprobacion?.de
  const aprobador = correoAprobador
    ? (centro?.aprobadores.find((ap) => mismoEmail(ap.email, correoAprobador)) ?? null)
    : null
  return { paquete, maestros, busqueda, centro, aprobador }
}

/** HU-2: aplica RC1–RC10. Función pura: mismo paquete y maestros → mismo resultado. */
export function validarPaquete(paquete: Paquete, maestros: Maestros): Validacion {
  const contexto = construirContexto(paquete, maestros)
  const bloqueos: Hallazgo[] = []
  const confirmaciones: Hallazgo[] = []
  const derivados: Derivados = {}
  const controles: Control[] = []

  for (const { regla, descripcion, evaluar } of REGLAS) {
    const evaluacion = evaluar(contexto)
    controles.push({ regla, descripcion, estado: evaluacion.estado, detalle: evaluacion.detalle })
    if (evaluacion.hallazgo && evaluacion.estado === "bloqueo") bloqueos.push({ regla, ...evaluacion.hallazgo })
    if (evaluacion.hallazgo && evaluacion.estado === "confirmacion") confirmaciones.push({ regla, ...evaluacion.hallazgo })
    if (evaluacion.derivado) derivados[evaluacion.derivado.campo] = evaluacion.derivado.valor
  }

  const p = contexto.busqueda?.proveedor
  if (p && contexto.busqueda?.criterio === "nombre") {
    derivados.proveedor_nit = {
      valor: p.nit,
      descripcion: p.nombre,
      fuente: FUENTE_DERIVADOS,
      motivo: "la solicitud no trae NIT; proveedor identificado por nombre",
    }
  }

  return {
    apta: bloqueos.length === 0,
    bloqueos,
    confirmaciones,
    derivados,
    retroactiva: confirmaciones.some((c) => c.codigo === "OC_RETROACTIVA"),
    controles,
    proveedor: p ? { codigo_sap: p.codigo_sap, nit: p.nit, nombre: p.nombre } : null,
  }
}
