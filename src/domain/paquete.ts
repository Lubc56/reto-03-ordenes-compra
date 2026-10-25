import { readdir } from "node:fs/promises"
import path from "node:path"
import { nombreCasoValido, rutaCaso, rutaSolicitudes } from "./rutas"
import { AprobacionArchivoSchema, CorreoArchivoSchema, SolicitudSchema, type Paquete } from "./tipos"
import {
  exito,
  fallo,
  leerTextoOpcional,
  mensajeDe,
  normalizarNit,
  parsearJson,
  parsearMonto,
  sumarDias,
  type Resultado,
} from "./util"

type Cotizacion = NonNullable<Paquete["cotizacion"]>
type Factura = NonNullable<Paquete["factura"]>
type Aprobacion = NonNullable<Paquete["aprobacion"]>

const capturar = (texto: string, regex: RegExp): string | null => regex.exec(texto)?.[1]?.trim() ?? null

export function parsearCotizacion(texto: string): Resultado<Cotizacion> {
  const total = /^TOTAL[^:\n]*:\s*(COP|USD)\s*([\d.,]+)/im.exec(texto)
  if (!total) return fallo("Cotización ilegible: no se encontró la línea TOTAL con moneda y valor.")
  const valor = parsearMonto(total[2]!)
  if (!Number.isFinite(valor)) return fallo(`Cotización ilegible: el total "${total[2]}" no es numérico.`)

  const fecha = capturar(texto, /^Fecha:\s*(\d{4}-\d{2}-\d{2})/m)
  const diasValidez = capturar(texto, /Validez de la oferta:\s*(\d+)\s*d[ií]as/i)
  const nit = capturar(texto, /^NIT:\s*([\d.\-]+)/m)
  const iva = capturar(texto, /^IVA\s*(\d+(?:[.,]\d+)?)\s*%/m)
  return exito({
    numero: capturar(texto, /^COTIZACI[ÓO]N\s+(\S+)/im),
    fecha,
    proveedor: capturar(texto, /^Proveedor:\s*(.+)$/m) ?? "",
    nit: nit ? normalizarNit(nit) : null,
    total: valor,
    moneda: total[1]!.toUpperCase(),
    iva_tasa: iva ? parsearMonto(iva) : null,
    validez_hasta: fecha && diasValidez ? sumarDias(fecha, Number(diasValidez)) : null,
    texto,
  })
}

export function parsearFactura(texto: string): Resultado<Factura> {
  const numero = capturar(texto, /FACTURA[^\n]*?No\.?\s*(\S+)/i)
  const fecha = capturar(texto, /Fecha de emisi[óo]n:\s*(\d{4}-\d{2}-\d{2})/i)
  const total = capturar(texto, /^TOTAL:\s*(?:COP|USD)\s*([\d.,]+)/im)
  if (!numero || !fecha || !total) return fallo("Factura ilegible: se requieren número, fecha de emisión y TOTAL.")
  return exito({ numero, fecha, total: parsearMonto(total) })
}

/** "Aprobado" explícito y sin negación ("no aprobado", "rechazado"). */
export function esAprobacionExplicita(cuerpo: string): boolean {
  if (/\bno\s+(est[aá]\s+)?aprobad[oa]\b|\brechazad[oa]\b/i.test(cuerpo)) return false
  return /\baprobad[oa]\b/i.test(cuerpo)
}

function parsearAprobacion(texto: string): Resultado<Aprobacion> {
  const archivo = parsearJson(texto, AprobacionArchivoSchema, "aprobacion.json")
  if (!archivo.ok) return archivo
  const a = archivo.data
  return exito({
    de: a.de,
    para: a.para,
    cc: a.cc ?? [],
    asunto: a.asunto,
    fecha: a.fecha,
    aprobado: esAprobacionExplicita(a.cuerpo),
    texto: a.cuerpo,
  })
}

/** Lee un adjunto opcional: null si no existe, error si existe pero es ilegible. */
async function leerOpcional<T>(
  ruta: string,
  parser: (texto: string) => Resultado<T>,
): Promise<Resultado<T | null>> {
  const texto = await leerTextoOpcional(ruta)
  return texto === null ? exito(null) : parser(texto)
}

export async function listarCasos(raiz: string): Promise<string[]> {
  try {
    const entradas = await readdir(rutaSolicitudes(raiz), { withFileTypes: true })
    return entradas.filter((e) => e.isDirectory()).map((e) => e.name).sort()
  } catch {
    return []
  }
}

async function validarCaso(raiz: string, caso: string): Promise<string | null> {
  if (!nombreCasoValido(caso)) return `Nombre de caso inválido: "${caso}". Usa el nombre de la carpeta, p. ej. sol-001.`
  const casos = await listarCasos(raiz)
  if (!casos.includes(caso)) return `No existe el caso "${caso}". Casos disponibles: ${casos.join(", ") || "ninguno"}.`
  return null
}

/** HU-1: lee y normaliza el paquete. Correo y solicitud son obligatorios; el resto puede faltar. */
export async function leerPaquete(raiz: string, caso: string): Promise<Resultado<Paquete>> {
  try {
    const errorCaso = await validarCaso(raiz, caso)
    if (errorCaso) return fallo(errorCaso)
    const dir = rutaCaso(raiz, caso)

    const [correoTxt, solicitudTxt] = await Promise.all([
      leerTextoOpcional(path.join(dir, "correo.json")),
      leerTextoOpcional(path.join(dir, "solicitud.json")),
    ])
    const obligatoriosFaltantes = [correoTxt === null && "correo.json", solicitudTxt === null && "solicitud.json"]
      .filter((f): f is string => Boolean(f))
    if (correoTxt === null || solicitudTxt === null) {
      return fallo(
        `Paquete incompleto: falta ${obligatoriosFaltantes.join(" y ")}. Pide al solicitante que reenvíe el correo con el Excel de solicitud.`,
        { faltantes: obligatoriosFaltantes },
      )
    }

    const correo = parsearJson(correoTxt, CorreoArchivoSchema, "correo.json")
    if (!correo.ok) return correo
    const solicitud = parsearJson(solicitudTxt, SolicitudSchema, "solicitud.json")
    if (!solicitud.ok) return solicitud

    const [cotizacion, aprobacion, factura] = await Promise.all([
      leerOpcional(path.join(dir, "cotizacion.txt"), parsearCotizacion),
      leerOpcional(path.join(dir, "aprobacion.json"), parsearAprobacion),
      leerOpcional(path.join(dir, "factura.txt"), parsearFactura),
    ])
    if (!cotizacion.ok) return cotizacion
    if (!aprobacion.ok) return aprobacion
    if (!factura.ok) return factura

    const anunciaFactura = correo.data.adjuntos.some((a) => a.toLowerCase().startsWith("factura"))
    const faltantes = [
      cotizacion.data === null && "cotizacion.txt",
      aprobacion.data === null && "aprobacion.json",
      anunciaFactura && factura.data === null && "factura.txt",
    ].filter((f): f is string => Boolean(f))

    const { id, de, asunto, fecha } = correo.data
    return exito({
      correo: { id, de, asunto, fecha },
      solicitud: solicitud.data,
      cotizacion: cotizacion.data,
      aprobacion: aprobacion.data,
      factura: factura.data,
      faltantes,
    })
  } catch (error) {
    return fallo(`Error leyendo el paquete ${caso}: ${mensajeDe(error)}`)
  }
}
