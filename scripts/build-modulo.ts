// Genera modulo/ desde las mismas fuentes que usa la aplicación (sin copias divergentes):
//   agent/prompt.md               → modulo/agent.md
//   src/knowledge/ordenes-compra  → modulo/skill/ordenes-compra/SKILL.md
//   src/tools/oc.ts               → modulo/tools/oc.ts (re-export)
// Uso: npm run modulo        (genera)
//      npm run modulo -- --check   (falla si modulo/ no está sincronizado)

import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { rutaConocimiento, rutaPrompt } from "../src/agent/prompt"

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const AVISO = "<!-- Generado por scripts/build-modulo.ts. No editar: edita la fuente y ejecuta npm run modulo. -->"

async function piezas(): Promise<Record<string, string>> {
  const prompt = (await readFile(rutaPrompt(raiz), "utf8")).trim()
  const conocimiento = (await readFile(rutaConocimiento(raiz), "utf8")).trim()
  return {
    "modulo/agent.md": `---
description: Prepara, valida (RC1–RC10) y crea órdenes de compra en SAP a partir del paquete del correo; devuelve excepciones al humano.
mode: primary
permission:
  edit: deny
  bash: deny
---
${AVISO}

${prompt}
`,
    "modulo/skill/ordenes-compra/SKILL.md": `---
name: ordenes-compra
description: Conocimiento del proceso de órdenes de compra de Periferia (actores, maestros, reglas RC1–RC10, OC retroactivas, payload y salidas). Úsalo al procesar o explicar una OC.
---
${AVISO}

${conocimiento}
`,
    "modulo/tools/oc.ts": `// Generado por scripts/build-modulo.ts: las mismas herramientas que usa la aplicación.
// Cada export es { description, args (zod), execute(args, ctx) }; el nombre para el modelo es oc_<export>.
export * from "../../src/tools/oc"
`,
  }
}

async function main() {
  const verificar = process.argv.includes("--check")
  const desincronizados: string[] = []
  for (const [relativa, contenido] of Object.entries(await piezas())) {
    const destino = path.join(raiz, relativa)
    if (verificar) {
      const actual = await readFile(destino, "utf8").catch(() => null)
      if (actual !== contenido) desincronizados.push(relativa)
      continue
    }
    await mkdir(path.dirname(destino), { recursive: true })
    await writeFile(destino, contenido, "utf8")
    console.log(`✔ ${relativa}`)
  }
  if (desincronizados.length) {
    console.error(`modulo/ desincronizado: ${desincronizados.join(", ")}. Ejecuta npm run modulo.`)
    process.exit(1)
  }
  if (verificar) console.log("modulo/ sincronizado con las fuentes de la aplicación")
}

main()
