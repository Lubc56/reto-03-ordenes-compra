import { appendFile, mkdir } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { cargarMaestros } from "../domain/maestros"
import { NUMERO_OC_INICIAL } from "../domain/reglas"
import { rutaSap } from "../domain/rutas"
import { OrdenCompraSchema, type OrdenCompra } from "../domain/tipos"
import { leerTextoOpcional, normalizarNit } from "../domain/util"
import type { SapAdapter } from "./adapter"

const RegistroSchema = z.object({ numero_oc: z.string(), fecha: z.string(), orden: OrdenCompraSchema })
type Registro = z.infer<typeof RegistroSchema>

/** SAP simulado sobre archivos: out/sap/ordenes.jsonl (una OC por línea). */
export class SapMock implements SapAdapter {
  constructor(private readonly raiz: string) {}

  private get archivo() {
    return path.join(rutaSap(this.raiz), "ordenes.jsonl")
  }

  private async registros(): Promise<Registro[]> {
    const texto = await leerTextoOpcional(this.archivo)
    if (!texto) return []
    return texto
      .split("\n")
      .filter((linea) => linea.trim())
      .flatMap((linea) => {
        const parsed = RegistroSchema.safeParse(JSON.parse(linea))
        return parsed.success ? [parsed.data] : []
      })
  }

  async consultarProveedor(nit: string) {
    const maestros = await cargarMaestros(this.raiz)
    if (!maestros.ok) return null
    const proveedor = maestros.data.proveedores.find((p) => normalizarNit(p.nit) === normalizarNit(nit))
    return proveedor ? { codigo_sap: proveedor.codigo_sap, activo: proveedor.activo } : null
  }

  async crearOrden(orden: OrdenCompra) {
    const registros = await this.registros()
    const registro: Registro = {
      numero_oc: String(NUMERO_OC_INICIAL + registros.length),
      fecha: new Date().toISOString(),
      orden,
    }
    await mkdir(path.dirname(this.archivo), { recursive: true })
    await appendFile(this.archivo, JSON.stringify(registro) + "\n", "utf8")
    return { numero_oc: registro.numero_oc, fecha: registro.fecha }
  }

  async buscarOrdenPorReferencia(solicitud_id: string) {
    const registro = (await this.registros()).find((r) => r.orden.referencia.solicitud_id === solicitud_id)
    return registro ? { numero_oc: registro.numero_oc, fecha: registro.fecha } : null
  }
}

/** Punto único para elegir adaptador; el real se conectaría aquí sin tocar herramientas. */
export function crearSap(raiz: string): SapAdapter {
  return new SapMock(raiz)
}

// Serializa "buscar si existe → crear" para que dos peticiones simultáneas no dupliquen la OC.
let cola: Promise<unknown> = Promise.resolve()
export function enSerie<T>(trabajo: () => Promise<T>): Promise<T> {
  const siguiente = cola.then(trabajo, trabajo)
  cola = siguiente.catch(() => undefined)
  return siguiente
}
