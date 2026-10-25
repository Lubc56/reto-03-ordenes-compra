import path from "node:path"

// Todas las rutas se resuelven desde ctx.directory (raíz del proyecto), nunca absolutas.

export const rutaSolicitudes = (raiz: string) => path.join(raiz, "fixtures", "reto-03", "solicitudes")
export const rutaMaestros = (raiz: string) => path.join(raiz, "fixtures", "reto-03", "maestros")
export const rutaCaso = (raiz: string, caso: string) => path.join(rutaSolicitudes(raiz), caso)

export const rutaSalida = (raiz: string) => path.join(raiz, "out")
export const rutaSalidaCaso = (raiz: string, caso: string) => path.join(rutaSalida(raiz), caso)
export const rutaSap = (raiz: string) => path.join(rutaSalida(raiz), "sap")

/** Evita path traversal: un caso es un nombre de carpeta simple (sol-001). */
export function nombreCasoValido(caso: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(caso)
}

/** Casos mencionados en un texto, con el identificador completo: "sol-001321321" no es "sol-001". */
export function casosEnTexto(texto: string): string[] {
  return [...texto.matchAll(/\bsol-[A-Za-z0-9_-]+/gi)].map((m) => m[0].toLowerCase())
}

/** Ruta relativa a la raíz, para mostrar al usuario sin exponer rutas absolutas. */
export const relativa = (raiz: string, ruta: string) => path.relative(raiz, ruta).split(path.sep).join("/")
