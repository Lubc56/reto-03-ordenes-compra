import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { PDFDocument, StandardFonts } from "pdf-lib"
import type { Paquete } from "./tipos"

type Aprobacion = NonNullable<Paquete["aprobacion"]>

export const sha256 = (texto: string) => createHash("sha256").update(texto, "utf8").digest("hex")

/** Contenido canónico de la evidencia: encabezados + cuerpo. El sha256 se calcula sobre esto. */
export function contenidoEvidencia(solicitudId: string, a: Aprobacion): string {
  return [
    `EVIDENCIA DE APROBACIÓN · ${solicitudId}`,
    "",
    `De: ${a.de}`,
    `Para: ${a.para}`,
    ...(a.cc.length ? [`CC: ${a.cc.join(", ")}`] : []),
    `Fecha: ${a.fecha}`,
    `Asunto: ${a.asunto}`,
    "",
    a.texto,
  ].join("\n")
}

function envolver(linea: string, ancho: number): string[] {
  if (linea.length <= ancho) return [linea]
  const lineas: string[] = []
  let actual = ""
  for (const palabra of linea.split(" ")) {
    if ((actual + " " + palabra).trim().length > ancho) {
      lineas.push(actual)
      actual = palabra
    } else {
      actual = (actual + " " + palabra).trim()
    }
  }
  return actual ? [...lineas, actual] : lineas
}

async function generarPdf(contenido: string, hash: string, fecha: Date): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  // Fechas fijas = PDF reproducible entre ejecuciones
  pdf.setCreationDate(fecha)
  pdf.setModificationDate(fecha)
  pdf.setTitle("Evidencia de aprobación")
  const fuente = await pdf.embedFont(StandardFonts.Helvetica)
  const negrita = await pdf.embedFont(StandardFonts.HelveticaBold)
  const pagina = pdf.addPage([595, 842]) // A4

  let y = 790
  const lineas = [...contenido.split("\n").flatMap((l) => envolver(l, 90)), "", "SHA-256 del contenido:", hash]
  lineas.forEach((linea, i) => {
    pagina.drawText(linea, { x: 50, y, size: i === 0 ? 13 : 10, font: i === 0 ? negrita : fuente })
    y -= i === 0 ? 24 : 15
  })
  return pdf.save()
}

/** HU-4: escribe out/<caso>/aprobacion.txt (P0) y aprobacion.pdf (P1) con el mismo contenido y hash. */
export async function escribirEvidencia(dirSalidaCaso: string, solicitudId: string, a: Aprobacion) {
  const contenido = contenidoEvidencia(solicitudId, a)
  const hash = sha256(contenido)
  await mkdir(dirSalidaCaso, { recursive: true })
  const txt = path.join(dirSalidaCaso, "aprobacion.txt")
  const pdf = path.join(dirSalidaCaso, "aprobacion.pdf")
  await writeFile(txt, `${contenido}\n\n---\nsha256: ${hash}\n`, "utf8")
  const fecha = new Date(a.fecha)
  await writeFile(pdf, await generarPdf(contenido, hash, Number.isNaN(fecha.getTime()) ? new Date(0) : fecha))
  return { txt, pdf, sha256: hash }
}
