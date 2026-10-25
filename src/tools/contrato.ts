import type { z } from "zod"
import { fallo, mensajeDe, type Resultado } from "../domain/util"

// Contrato de herramientas (PRD 6.2): description + args zod + execute(args, ctx) → string.

export type ContextoHerramienta = { directory: string; sessionId: string }

export type Herramienta<A extends z.ZodRawShape> = {
  description: string
  args: A
  execute(args: z.infer<z.ZodObject<A>>, ctx: ContextoHerramienta): Promise<string>
}

/** Identidad tipada: infiere los tipos de `execute` a partir de `args`. */
export const definirHerramienta = <A extends z.ZodRawShape>(herramienta: Herramienta<A>) => herramienta

/** Serializa { ok, data } | { ok: false, error } y garantiza que execute nunca lance. */
export async function responder(trabajo: () => Promise<Resultado<unknown>>): Promise<string> {
  try {
    return JSON.stringify(await trabajo())
  } catch (error) {
    return JSON.stringify(fallo(`Error inesperado en la herramienta: ${mensajeDe(error)}`))
  }
}
