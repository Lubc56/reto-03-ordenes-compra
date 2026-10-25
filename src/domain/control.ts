import { appendFile, mkdir } from "node:fs/promises"
import path from "node:path"
import { leerTextoOpcional } from "./util"

export type ResultadoControl = "creada" | "existente" | "bloqueada" | "pendiente_confirmacion" | "rechazada"

export type FilaControl = {
  solicitud_id: string
  resultado: ResultadoControl
  numero_oc: string | null
  retroactiva: boolean
  bloqueos: string[]
  confirmaciones: string[]
  ts: string
}

const COLUMNAS = ["solicitud_id", "resultado", "numero_oc", "retroactiva", "bloqueos", "confirmaciones", "ts"] as const

const celda = (valor: string) => (/[",\n]/.test(valor) ? `"${valor.replace(/"/g, '""')}"` : valor)

/** HU-5: cada intento (creada, bloqueada, pendiente…) agrega una fila a out/control.csv. */
export async function registrarControl(dirSalida: string, fila: FilaControl): Promise<void> {
  const ruta = path.join(dirSalida, "control.csv")
  await mkdir(dirSalida, { recursive: true })
  const existe = (await leerTextoOpcional(ruta)) !== null
  const valores = [
    fila.solicitud_id,
    fila.resultado,
    fila.numero_oc ?? "",
    String(fila.retroactiva),
    fila.bloqueos.join("|"),
    fila.confirmaciones.join("|"),
    fila.ts,
  ].map(celda)
  await appendFile(ruta, `${existe ? "" : COLUMNAS.join(",") + "\n"}${valores.join(",")}\n`, "utf8")
}
