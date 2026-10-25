import { readFile } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { rutaMaestros } from "./rutas"
import {
  CentroCostoSchema,
  CondicionPagoSchema,
  IndicadorIvaSchema,
  ProveedorSchema,
  type Maestros,
  type Proveedor,
} from "./tipos"
import { exito, fallo, mensajeDe, normalizarNit, normalizarTexto, parsearJson, type Resultado } from "./util"

async function leerMaestro<T>(raiz: string, archivo: string, esquema: z.ZodType<T>): Promise<Resultado<T[]>> {
  try {
    const texto = await readFile(path.join(rutaMaestros(raiz), archivo), "utf8")
    return parsearJson(texto, z.array(esquema), `maestros/${archivo}`)
  } catch (error) {
    return fallo(`No se pudo leer el maestro ${archivo}: ${mensajeDe(error)}`)
  }
}

/** Se leen en cada llamada: son pequeños y así un cambio en el maestro aplica de inmediato. */
export async function cargarMaestros(raiz: string): Promise<Resultado<Maestros>> {
  const [proveedores, centros, indicadoresIva, condicionesPago] = await Promise.all([
    leerMaestro(raiz, "proveedores.json", ProveedorSchema),
    leerMaestro(raiz, "centros-costo.json", CentroCostoSchema),
    leerMaestro(raiz, "indicadores-iva.json", IndicadorIvaSchema),
    leerMaestro(raiz, "condiciones-pago.json", CondicionPagoSchema),
  ])
  if (!proveedores.ok) return proveedores
  if (!centros.ok) return centros
  if (!indicadoresIva.ok) return indicadoresIva
  if (!condicionesPago.ok) return condicionesPago
  return exito({
    proveedores: proveedores.data,
    centros: centros.data,
    indicadoresIva: indicadoresIva.data,
    condicionesPago: condicionesPago.data,
  })
}

export type BusquedaProveedor = { proveedor: Proveedor; criterio: "nit" | "nombre" } | null

/** RC1: por NIT; si no hay NIT, por nombre normalizado. */
export function buscarProveedor(maestros: Maestros, nit: string | undefined, nombre: string): BusquedaProveedor {
  if (nit) {
    const objetivo = normalizarNit(nit)
    const proveedor = maestros.proveedores.find((p) => normalizarNit(p.nit) === objetivo)
    return proveedor ? { proveedor, criterio: "nit" } : null
  }
  const objetivo = normalizarTexto(nombre)
  const proveedor = maestros.proveedores.find((p) => normalizarTexto(p.nombre) === objetivo)
  return proveedor ? { proveedor, criterio: "nombre" } : null
}
