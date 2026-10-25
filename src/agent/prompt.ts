import { readFile } from "node:fs/promises"
import path from "node:path"

// Comportamiento (agent/prompt.md) + conocimiento (src/knowledge/*.md).
// Se leen en cada turno: editar el prompt o el conocimiento no requiere reiniciar ni tocar código.

export const rutaPrompt = (raiz: string) => path.join(raiz, "agent", "prompt.md")
export const rutaConocimiento = (raiz: string) => path.join(raiz, "src", "knowledge", "ordenes-compra.md")

export async function construirSistema(raiz: string): Promise<string> {
  const [prompt, conocimiento] = await Promise.all([
    readFile(rutaPrompt(raiz), "utf8"),
    readFile(rutaConocimiento(raiz), "utf8"),
  ])
  return `${prompt.trim()}\n\n---\n\n# Conocimiento del proceso\n\n${conocimiento.trim()}\n`
}
