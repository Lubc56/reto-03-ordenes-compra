import { appendFile, mkdir } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { rutaSalida } from "../domain/rutas"
import { mensajeDe } from "../domain/util"
import type { DefinicionHerramienta } from "../llm/adapter"
import type { ContextoHerramienta } from "../tools/contrato"
import * as oc from "../tools/oc"

// Registro de herramientas: nombre = <archivo>_<export>. Agregar un archivo en
// src/tools y listarlo aquí basta para exponerlo al modelo.
const MODULOS = { oc }

// Sintaxis de método = parámetros bivariantes: acepta cualquier Herramienta<A>
interface HerramientaGenerica {
  description: string
  args: z.ZodRawShape
  execute(args: Record<string, unknown>, ctx: ContextoHerramienta): Promise<string>
}

type Registrada = { nombre: string; herramienta: HerramientaGenerica; esquema: z.ZodObject<z.ZodRawShape> }

function registrar(): Map<string, Registrada> {
  const mapa = new Map<string, Registrada>()
  for (const [archivo, modulo] of Object.entries(MODULOS)) {
    for (const [exportado, herramienta] of Object.entries(modulo)) {
      const nombre = `${archivo}_${exportado}`
      mapa.set(nombre, { nombre, herramienta, esquema: z.object(herramienta.args) })
    }
  }
  return mapa
}

const REGISTRO = registrar()

/** Definiciones neutrales (JSON Schema) para cualquier proveedor LLM. */
export function definiciones(): DefinicionHerramienta[] {
  return [...REGISTRO.values()].map(({ nombre, herramienta, esquema }) => {
    const { $schema: _omitido, ...json } = z.toJSONSchema(esquema)
    return { nombre, descripcion: herramienta.description, parametros: { ...json, type: "object" } }
  })
}

export type EjecucionHerramienta = { nombre: string; argumentos: unknown; resultado: string; ok: boolean; ms: number }

async function registrarLog(raiz: string, sessionId: string, ejecucion: EjecucionHerramienta) {
  const linea = {
    ts: new Date().toISOString(),
    sessionId,
    tipo: "tool_call",
    herramienta: ejecucion.nombre,
    argumentos: ejecucion.argumentos,
    ok: ejecucion.ok,
    ms: ejecucion.ms,
    resultado: ejecucion.resultado.slice(0, 4000),
  }
  await mkdir(rutaSalida(raiz), { recursive: true })
  await appendFile(path.join(rutaSalida(raiz), "log.jsonl"), JSON.stringify(linea) + "\n", "utf8")
}

/** Valida los argumentos con zod antes de ejecutar; los errores vuelven al modelo como { ok: false }. */
export async function ejecutarHerramienta(
  nombre: string,
  argumentos: unknown,
  ctx: ContextoHerramienta,
): Promise<EjecucionHerramienta> {
  const inicio = Date.now()
  const registrada = REGISTRO.get(nombre)
  let resultado: string
  if (!registrada) {
    resultado = JSON.stringify({ ok: false, error: `Herramienta desconocida: ${nombre}. Disponibles: ${[...REGISTRO.keys()].join(", ")}` })
  } else {
    const parsed = registrada.esquema.safeParse(argumentos ?? {})
    resultado = parsed.success
      ? await registrada.herramienta.execute(parsed.data, ctx)
      : JSON.stringify({ ok: false, error: `Argumentos inválidos para ${nombre}:\n${z.prettifyError(parsed.error)}` })
  }
  const ok = esOk(resultado)
  const ejecucion = { nombre, argumentos, resultado, ok, ms: Date.now() - inicio }
  await registrarLog(ctx.directory, ctx.sessionId, ejecucion).catch((error) =>
    console.error(`No se pudo escribir log.jsonl: ${mensajeDe(error)}`),
  )
  return ejecucion
}

function esOk(resultado: string): boolean {
  try {
    const parsed: unknown = JSON.parse(resultado)
    return typeof parsed === "object" && parsed !== null && "ok" in parsed && parsed.ok === true
  } catch {
    return false
  }
}
