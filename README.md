# Agente conversacional · Órdenes de Compra SAP

Reto técnico 03 (Perxia 2.0 · Periferia IT Group). Un agente de chat que lee el paquete de una solicitud de compra, lo valida contra los maestros (RC1–RC10), construye la OC con trazabilidad, genera la evidencia de aprobación (txt y pdf con sha256) y la crea en un SAP simulado. Las excepciones las devuelve al humano con una acción sugerida.

- **Link de prueba:** _pendiente de despliegue (ver "Desplegar")_
- **Clave de acceso:** _si se define `ACCESS_KEY`, se indica aquí_
- **Planteamiento de la solución:** [SOLUCION.md](SOLUCION.md)

## Requisitos

Node 20+ (probado con Node 24). También corre con Bun.

## Levantar en local (un comando)

```bash
npm install && npm run dev
```

Abre http://localhost:3000. Sin clave, el chat explica que falta `ANTHROPIC_API_KEY`. Para probar el chat sin clave usa el proveedor determinista:

```bash
LLM_PROVIDER=simulado npm run dev
```

Con modelo real, copia `.env.example` a `.env`, pega tu `ANTHROPIC_API_KEY` y vuelve a ejecutar `npm run dev` (el `.env` se carga automáticamente y está en `.gitignore`).

## Demo sin modelo

```bash
npm install && npm run demo
```

Equivale a `bun install && bun run demo.ts`. Procesa los 6 casos llamando directamente a las herramientas: imprime `apta`, bloqueos, confirmaciones, derivados, `retroactiva` y el número de OC o el motivo. Muestra la idempotencia (sol-001 dos veces) y la confirmación explícita de sol-004. Limpia `out/` al inicio.

| Caso | Resultado esperado |
|---|---|
| sol-001 | ✅ OC 4500000001 creada sin intervención |
| sol-002 | ⛔ RC1 proveedor inexistente |
| sol-003 | ⛔ RC2 aprobador sin autoridad en CC-2020 · RC3 sin tope suficiente en el centro |
| sol-004 | ⏸️ RC5 cotización 6 % sobre la solicitud → creada tras confirmar (4500000002) |
| sol-005 | ⏸️ RC8 factura anterior a la solicitud · `retroactiva = true` en control |
| sol-006 | ⏸️ RC6 IVA derivado (C1) · RC7 condiciones derivadas (Z030) · proveedor por nombre |

## Variables de entorno

Ver [.env.example](.env.example).

| Variable | Uso | Por defecto |
|---|---|---|
| `LLM_PROVIDER` | `anthropic` o `simulado` | `anthropic` |
| `ANTHROPIC_API_KEY` | Clave del modelo (solo backend) | — |
| `LLM_MODEL` / `LLM_EFFORT` | Modelo y esfuerzo de razonamiento | `claude-opus-5-5` / `medium` |
| `LLM_TIMEOUT_MS` | Timeout por llamada al proveedor | `90000` |
| `MAX_ITERACIONES` | Tope herramienta → modelo por turno | `25` |
| `MAX_TOKENS_SESION` / `MAX_TOKENS_GLOBAL` | Topes de gasto | `400000` / `3000000` |
| `ACCESS_KEY` | Protege el chat con una clave | sin protección |
| `PORT` | Puerto HTTP | `3000` |

## API

| Método | Ruta | Cuerpo / respuesta |
|---|---|---|
| `POST` | `/api/chat` | `{ sessionId?, message, decision?: "confirmar" \| "cancelar" }` → `{ ok, sessionId, reply, toolCalls[], needsConfirmation, pendientes[], iteraciones, uso, usoSesion, error? }` |
| `GET` | `/api/sessions/:id` | `{ ok, id, creada, eventos[], uso, pendientes[] }` |
| `GET` | `/api/health` | `{ ok, provider, model, configurado, accesoProtegido, herramientas[] }` (sin claves) |

Si `ACCESS_KEY` está definida, `/api/chat` y `/api/sessions` exigen la cabecera `x-access-key`.

## Estructura

```
agent/prompt.md               comportamiento (system prompt)
src/knowledge/                conocimiento del proceso
src/tools/oc.ts               herramientas oc_* (zod) · ejecución
src/domain/                   lectura, reglas RC1–RC10, payload, evidencia, control
src/sap/                      interfaz SapAdapter y SAP simulado (out/sap/)
src/llm/                      interfaz ProveedorLLM, Anthropic y simulado
src/agent/                    ciclo del agente, sesiones, confirmación humana
src/server.ts                 API HTTP + front estático
web/                          chat (HTML/CSS/JS sin build)
modulo/                       bonus: agente empaquetado (generado con npm run modulo)
demo.ts                       verificación sin modelo
fixtures/                     entregados por Periferia (solo lectura)
out/                          generado en ejecución (no se versiona)
```

## Desplegar (Render)

1. En Render: **New → Blueprint** y elige este repositorio (usa `render.yaml`: Node 22, `npm ci` y `npm start`).
2. El blueprint arranca con `LLM_PROVIDER=simulado` (funciona sin clave). Para usar Claude, en las variables del servicio cambia `LLM_PROVIDER` a `anthropic` y agrega `ANTHROPIC_API_KEY` (opcionalmente `ACCESS_KEY`).
3. Verifica `https://<servicio>.onrender.com/api/health`.

Alternativa con contenedor: el `Dockerfile` sirve para Render (runtime Docker), Fly.io o Railway.

El plan gratuito duerme tras 15 min sin uso; el primer request tarda unos segundos. `out/` es efímero en ese plan, y es suficiente para la demo.

## Scripts

| Script | Qué hace |
|---|---|
| `npm run dev` | Servidor con recarga |
| `npm start` | Servidor |
| `npm run demo` | Los 6 casos sin modelo |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run modulo` | Regenera `modulo/` desde las fuentes (`-- --check` para verificar) |
