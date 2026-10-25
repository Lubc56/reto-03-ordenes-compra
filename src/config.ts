import { z } from "zod"

// Toda la configuración sale de variables de entorno (ver .env.example).
// La clave del modelo solo se lee aquí y nunca se expone en respuestas ni logs.

const entero = (valor: string | undefined, porDefecto: number) => {
  const n = Number(valor)
  return Number.isInteger(n) && n > 0 ? n : porDefecto
}

const EsfuerzoSchema = z.enum(["low", "medium", "high", "xhigh", "max"]).catch("medium")
export type Esfuerzo = z.infer<typeof EsfuerzoSchema>

try {
  process.loadEnvFile() // .env local opcional; no pisa variables ya definidas
} catch {
  // sin .env: se usan las variables del entorno (Render, Docker…)
}

const env = process.env

const proveedor = env.LLM_PROVIDER?.trim() || "anthropic"

// Modelo por defecto de cada proveedor; LLM_MODEL lo reemplaza
const MODELO_POR_DEFECTO: Record<string, string> = {
  anthropic: "claude-opus-5-5",
  gemini: "gemini-flash-latest", // alias oficial de Google al Flash más reciente
  simulado: "guion-determinista",
}

export const config = {
  puerto: entero(env.PORT, 3000),
  claveAcceso: env.ACCESS_KEY?.trim() || null,
  llm: {
    proveedor,
    modelo: env.LLM_MODEL?.trim() || MODELO_POR_DEFECTO[proveedor] || "",
    esfuerzo: EsfuerzoSchema.parse(env.LLM_EFFORT ?? "medium"),
    maxTokensRespuesta: entero(env.LLM_MAX_TOKENS, 16000),
    timeoutMs: entero(env.LLM_TIMEOUT_MS, 90_000),
    claveAnthropic: env.ANTHROPIC_API_KEY?.trim() || null,
    claveGemini: env.GEMINI_API_KEY?.trim() || null,
    // Proveedor "compatible" (Groq, Ollama…) y URL alternativa para Gemini
    urlBase: env.LLM_BASE_URL?.trim() || null,
    claveCompatible: env.LLM_API_KEY?.trim() || null,
  },
  agente: {
    maxIteraciones: entero(env.MAX_ITERACIONES, 25),
    maxTokensSesion: entero(env.MAX_TOKENS_SESION, 400_000),
    maxTokensGlobal: entero(env.MAX_TOKENS_GLOBAL, 3_000_000),
    maxLongitudMensaje: 4000,
  },
}

export type Config = typeof config
