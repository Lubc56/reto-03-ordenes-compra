// Verificación sin modelo: llama directamente a las herramientas para los 6 casos.
//   npm run demo    (o: bun install && bun run demo.ts)

import { readFile, rm } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import * as confirmaciones from "./src/domain/confirmaciones"
import { listarCasos } from "./src/domain/paquete"
import type { ContextoHerramienta } from "./src/tools/contrato"
import * as oc from "./src/tools/oc"

const raiz = path.dirname(fileURLToPath(import.meta.url))
const ctx: ContextoHerramienta = { directory: raiz, sessionId: "demo" }

type Respuesta = { ok: boolean; error?: string; detalle?: unknown; data?: Record<string, unknown> }
const leer = (json: string): Respuesta => JSON.parse(json)

type Hallazgo = { regla: string; codigo: string; mensaje: string; accion_sugerida: string }
type ValidacionDemo = { apta: boolean; retroactiva: boolean; bloqueos: Hallazgo[]; confirmaciones: Hallazgo[]; derivados: Record<string, { valor: string; motivo: string }> }

const lista = (items: string[]) => (items.length ? items.map((i) => `\n      · ${i}`).join("") : " —")

function imprimirValidacion(v: ValidacionDemo) {
  console.log(`  apta: ${v.apta ? "sí" : "NO"}   retroactiva: ${v.retroactiva ? "SÍ" : "no"}`)
  console.log(`  bloqueos:${lista(v.bloqueos.map((b) => `${b.regla} ${b.codigo}: ${b.mensaje}\n        → ${b.accion_sugerida}`))}`)
  console.log(`  confirmaciones:${lista(v.confirmaciones.map((c) => `${c.regla} ${c.codigo}: ${c.mensaje}`))}`)
  console.log(`  derivados:${lista(Object.entries(v.derivados).map(([campo, d]) => `${campo} = ${d.valor} (${d.motivo})`))}`)
}

function imprimirCreacion(r: Respuesta) {
  if (r.ok && r.data) {
    const marca = r.data.idempotente ? "♻️  OC existente (idempotente)" : "✅ OC creada"
    console.log(`  resultado: ${marca} ${r.data.numero_oc}`)
    const evidencia = r.data.evidencia
    if (evidencia && typeof evidencia === "object" && "ruta_pdf" in evidencia) console.log(`  evidencia: ${String(evidencia.ruta_pdf)}`)
    return
  }
  const pendiente = typeof r.detalle === "object" && r.detalle !== null && "requiere_confirmacion" in r.detalle
  console.log(`  resultado: ${pendiente ? "⏸️  pendiente de confirmación" : "⛔"} ${r.error}`)
}

async function procesar(caso: string): Promise<void> {
  const paquete = leer(await oc.leer_paquete.execute({ caso }, ctx))
  if (!paquete.ok || !paquete.data) return console.log(`  ⛔ ${paquete.error}`)
  const solicitud = paquete.data.solicitud as { solicitud_id: string; proveedor_nombre: string; valor_total: number }
  console.log(`  ${solicitud.solicitud_id} · ${solicitud.proveedor_nombre} · COP ${solicitud.valor_total.toLocaleString("es-CO")}`)

  const validacion = leer(await oc.validar.execute({ caso }, ctx))
  if (!validacion.ok || !validacion.data) return console.log(`  ⛔ ${validacion.error}`)
  imprimirValidacion(validacion.data as ValidacionDemo)

  const payload = leer(await oc.construir_payload.execute({ caso }, ctx))
  if (payload.ok && payload.data) console.log(`  payload: ${payload.data.total_formateado} · trazabilidad en ${payload.data.trazabilidad_ruta}`)
  if (validacion.data.apta) await oc.generar_evidencia.execute({ caso }, ctx)

  imprimirCreacion(leer(await oc.crear.execute({ caso, payload: payload.data?.orden as Record<string, unknown> | undefined }, ctx)))
}

async function main() {
  await rm(path.join(raiz, "out"), { recursive: true, force: true }) // determinismo: out/ limpio
  console.log("Demo · Órdenes de compra SAP (sin modelo de lenguaje)\n")

  for (const caso of await listarCasos(raiz)) {
    console.log(`━━ ${caso} ${"━".repeat(60)}`)
    await procesar(caso)
    console.log()
  }

  console.log(`━━ Idempotencia: sol-001 por segunda vez ${"━".repeat(32)}`)
  imprimirCreacion(leer(await oc.crear.execute({ caso: "sol-001" }, ctx)))

  console.log(`\n━━ Confirmación explícita de sol-004 ${"━".repeat(36)}`)
  imprimirCreacion(leer(await oc.crear.execute({ caso: "sol-004", confirmado: true }, ctx)))
  console.log('  analista: "Confirmo, crea la OC por el valor de la solicitud"')
  confirmaciones.otorgar(ctx.sessionId, ["sol-004"])
  imprimirCreacion(leer(await oc.crear.execute({ caso: "sol-004", confirmado: true }, ctx)))

  console.log(`\n━━ out/control.csv ${"━".repeat(54)}`)
  console.log(await readFile(path.join(raiz, "out", "control.csv"), "utf8"))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
